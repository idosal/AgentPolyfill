//! A view's isolated Chrome context and flat CDP sessions. Metadata events
//! are processed in order; requests that can call back into the host never
//! block the CDP event reader. Every OOP iframe is initialized before resume.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::chrome::Browser;
use crate::policy::{Origins, origin};

pub enum Event {
    Binding { session: String, context: i64, call: Value, allowed: bool },
    /// The page said it changed (`__cliChanged`, from the change hook), or
    /// that its store was written to (`store`).
    Changed { store: bool },
    /// Chrome drew a new frame of the page (its screencast): what changed
    /// may be something no hook saw (an animated image, a worker's canvas).
    Painted,
    Closed(&'static str),
}

#[derive(Clone, Debug)]
pub struct Context {
    pub session: String,
    pub id: i64,
    pub frame: String,
    pub origin: String,
}

#[derive(Default)]
struct Frame {
    parent: Option<String>,
    url: String,
}

#[derive(Default)]
struct State {
    /// Its network (see `network`): WebSockets open and requests in flight,
    /// by session and request id, and when any of it last moved.
    sockets: HashSet<String>,
    inflight: HashSet<String>,
    net_at: u64,
    main: String,
    frames: HashMap<String, Frame>,
    contexts: HashMap<(String, i64), Context>,
    sessions: HashSet<String>,
    /// Dedicated workers' sessions (paused with the page).
    workers: HashSet<String>,
    visited: HashSet<String>,
    bootstrap: Option<String>,
    paused: bool,
    scheme: String,
    window: Option<i64>,
}

impl State {
    fn record_tree(&mut self, tree: &Value, main_session: bool, parent: Option<&str>) {
        let f = &tree["frame"];
        let Some(id) = f["id"].as_str() else { return };
        let parent = f["parentId"].as_str().or(parent);
        if main_session && parent.is_none() { self.main = id.into(); }
        let frame = self.frames.entry(id.into()).or_default();
        if let Some(parent) = parent { frame.parent = Some(parent.into()); }
        frame.url = f["url"].as_str().unwrap_or("").into();
        let at = origin(&frame.url);
        if at.starts_with("http://") || at.starts_with("https://") { self.visited.insert(at); }
        for child in tree["childFrames"].as_array().into_iter().flatten() {
            self.record_tree(child,false,Some(id));
        }
    }

    fn host_binding(&self, session: &str, page_session: &str, id: i64, host: &str) -> bool {
        session == page_session && self.contexts.get(&(session.to_string(),id))
            .is_some_and(|c| c.frame == self.main && c.origin == host)
    }

    fn protected_navigation(&self, frame: &str) -> bool {
        // Unknown frame ancestry must not be a way past the navigation
        // boundary. frameAttached normally precedes its Fetch pause.
        frame == self.main || self.frames.get(frame).is_none_or(|f|f.parent.as_ref() == Some(&self.main))
    }
}

pub struct Page {
    pub browser: Arc<Browser>,
    pub context_id: String,
    pub session: String,
    pub origins: Origins,
    target: String,
    owns_context: bool,
    state: Mutex<State>,
    scripts: Vec<&'static str>,
    /// The view's page and its CSP, always set together: given when the
    /// page is made, or when a view takes a page made ahead (`set_view`).
    view_doc: Mutex<(Arc<str>, String)>,
    host: Arc<str>,
    event_tx: mpsc::UnboundedSender<Event>,
    stopped: AtomicBool,
    stop: Notify,
    pause_turn: tokio::sync::Mutex<()>,
}

impl Page {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(browser: Arc<Browser>, origins: Origins, html: Arc<str>, host: Arc<str>, csp: String,
        image: bool, clipboard: bool, width: f64, height: f64, theme: &str, local_network: bool,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Event>)> {
        let context_id = browser.send("Target.createBrowserContext", json!({"disposeOnDetach":true}), None).await?["browserContextId"]
            .as_str().ok_or_else(|| anyhow!("Chrome didn't create a context"))?.to_string();
        // Chrome's local-network checks stay on: a page that isn't local may
        // not reach this machine or its network, even by a public name that
        // resolves there (the CSP judges names, not addresses). A view of a
        // server on this machine or its network (or a stdio server) may: it
        // reaches that server, which its CSP names.
        if local_network {
            browser.send("Browser.grantPermissions", json!({
                "permissions":["localNetworkAccess","localNetwork","loopbackNetwork"],"browserContextId":context_id,
            }), None).await?;
        }
        let created = async {
            let target = browser.send("Target.createTarget", json!({"url":"about:blank","browserContextId":context_id}), None).await?;
            let events = browser.events.subscribe();
            let attached = browser.send("Target.attachToTarget", json!({"targetId":target["targetId"],"flatten":true}), None).await?;
            let session = attached["sessionId"].as_str().ok_or_else(|| anyhow!("no page session"))?.to_string();
            let (tx, rx) = mpsc::unbounded_channel();
            let mut scripts = vec![
                include_str!("../js/binding.js"),
                include_str!("../js/canvas_text_hook.js"), include_str!("../js/change_hook.js"),
                include_str!("../js/store_hook.js"), include_str!("../js/no_webrtc.js"),
            ];
            if image { scripts.push(include_str!("../js/instant_transitions.js")); }
            if clipboard { scripts.push(include_str!("../js/clipboard_hook.js")); }
            let page = Arc::new(Self {
                browser: browser.clone(), context_id: context_id.clone(), session: session.clone(), origins,
                target: target["targetId"].as_str().unwrap_or("").into(), owns_context: true,
                state: Mutex::new(State { sessions: HashSet::from([session.clone()]), scheme:theme.into(), ..State::default() }),
                scripts, view_doc: Mutex::new((html, csp)), host, event_tx: tx, stopped: AtomicBool::new(false), stop: Notify::new(),
                pause_turn:tokio::sync::Mutex::new(()),
            });
            tokio::spawn(watch(Arc::downgrade(&page), events));
            let initialized = async {
                page.initialize_session(&session).await?;
                let tree = page.send("Page.getFrameTree", json!({})).await?;
                if let Some(frame) = tree["frameTree"]["frame"]["id"].as_str() {
                    page.state.lock().unwrap().main = frame.into();
                }
                page.metrics(width, height, if image { 2.0 } else { 1.0 }).await?;
                page.media(theme).await
            }.await;
            if let Err(e) = initialized { page.close().await; return Err(e); }
            Ok::<_, anyhow::Error>((page, rx))
        }.await;
        if created.is_err() {
            let _ = browser.send("Target.disposeBrowserContext", json!({"browserContextId":context_id}), None).await;
        }
        created
    }

    /// A temporary blank page in this same context, for an origin no longer
    /// represented by a live frame. Playwright storageState also visits such
    /// origins: navigating a nested frame must not lose its last writes.
    async fn scratch(&self) -> Result<Arc<Self>> {
        let target = self.browser.send("Target.createTarget", json!({"url":"about:blank","browserContextId":self.context_id}), None).await?;
        let target = target["targetId"].as_str().ok_or_else(|| anyhow!("no storage target"))?.to_string();
        let result = async {
            let events = self.browser.events.subscribe();
            let attached = self.browser.send("Target.attachToTarget", json!({"targetId":target,"flatten":true}), None).await?;
            let session = attached["sessionId"].as_str().ok_or_else(|| anyhow!("no storage session"))?.to_string();
            let (tx, _) = mpsc::unbounded_channel();
            let page = Arc::new(Self {
                browser:self.browser.clone(),context_id:self.context_id.clone(),session:session.clone(),origins:self.origins.clone(),
                target:target.clone(),owns_context:false,
                state:Mutex::new(State {sessions:HashSet::from([session.clone()]),..State::default()}),
                scripts:Vec::new(),view_doc:Mutex::new((Arc::from(""),String::new())),host:Arc::from(""),event_tx:tx,
                stopped:AtomicBool::new(false),stop:Notify::new(),
                pause_turn:tokio::sync::Mutex::new(()),
            });
            tokio::spawn(watch(Arc::downgrade(&page),events));
            if let Err(e) = page.initialize_session(&session).await { page.close().await; return Err(e); }
            Ok::<_,anyhow::Error>(page)
        }.await;
        if result.is_err() { let _ = self.browser.send("Target.closeTarget",json!({"targetId":target}),None).await; }
        result
    }

    async fn initialize_session(&self, session: &str) -> Result<()> {
        for method in ["Page.enable", "Runtime.enable", "Inspector.enable", "Network.enable"] {
            self.browser.send(method, json!({}), Some(session)).await?;
        }
        let tree = self.browser.send("Page.getFrameTree",json!({}),Some(session)).await?;
        self.state.lock().unwrap().record_tree(&tree["frameTree"],session == self.session,None);
        if session == self.session && self.owns_context {
            self.browser.send("Emulation.setFocusEmulationEnabled",json!({"enabled":true}),Some(session)).await?;
            if let Ok(window) = self.send("Browser.getWindowForTarget",json!({"targetId":self.target})).await {
                self.state.lock().unwrap().window = window["windowId"].as_i64();
            }
        }
        // Headless Chrome's defaults differ from a regular Chrome window.
        // These are the platform defaults Playwright applies to the helper.
        let fonts: Value = serde_json::from_str(include_str!("../js/fonts.json"))?;
        let platform = if cfg!(target_os="macos") {"mac"} else if cfg!(windows) {"win"} else {"linux"};
        self.browser.send("Page.setFontFamilies",fonts[platform].clone(),Some(session)).await?;
        // Interception also disables caching, as Playwright routes do.
        self.browser.send("Network.setCacheDisabled", json!({"cacheDisabled":true}), Some(session)).await?;
        self.browser.send("Runtime.addBinding", json!({"name":"__cliHost"}), Some(session)).await?;
        self.browser.send("Runtime.addBinding", json!({"name":"__cliChanged"}), Some(session)).await?;
        for script in &self.scripts {
            self.browser.send("Page.addScriptToEvaluateOnNewDocument", json!({"source":script,"runImmediately":true}), Some(session)).await?;
        }
        self.browser.send("Fetch.enable", json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}), Some(session)).await?;
        self.browser.send("Target.setAutoAttach", json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}), Some(session)).await?;
        // Chrome says when it draws a new frame: tiny frames, only a signal
        // (see Event::Painted). A Chrome without it keeps the timed backstop.
        if session == self.session && self.owns_context && std::env::var("MCP_APPS_CLI_PAINTS").map_or(true, |v| v != "0") {
            let _ = self.browser.send("Page.startScreencast", json!({"format":"jpeg","quality":1,"maxWidth":16,"maxHeight":16,"everyNthFrame":1}), Some(session)).await;
        }
        let scheme = self.state.lock().unwrap().scheme.clone();
        if !scheme.is_empty() {
            self.browser.send("Emulation.setEmulatedMedia", json!({"media":"","features":[{"name":"prefers-color-scheme","value":scheme}]}), Some(session)).await?;
        }
        Ok(())
    }

    pub async fn send(&self, method: &str, params: Value) -> Result<Value> {
        self.browser.send(method, params, Some(&self.session)).await
    }

    /// The view a page made ahead is for: its HTML and CSP, served from now
    /// on (the page has loaded no view yet).
    pub fn set_view(&self, html: Arc<str>, csp: String) {
        *self.view_doc.lock().unwrap() = (html, csp);
    }

    /// Its network now: WebSockets open, requests in flight (a stream, a
    /// long poll), and milliseconds since any of it moved.
    pub fn network(&self) -> (usize, usize, u64) {
        let s = self.state.lock().unwrap();
        (s.sockets.len(), s.inflight.len(), crate::views::now().saturating_sub(s.net_at))
    }

    /// Closed (by `close`): no use to a view.
    pub fn is_closed(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub async fn metrics(&self, width: f64, height: f64, dpr: f64) -> Result<()> {
        let window = self.state.lock().unwrap().window;
        if let Some(window) = window {
            self.send("Browser.setWindowBounds",json!({"windowId":window,"bounds":{"width":width.ceil() as u32,"height":height.ceil() as u32}})).await?;
        }
        self.send("Emulation.setDeviceMetricsOverride", json!({
            "width":width.ceil() as u32,"height":height.ceil() as u32,"deviceScaleFactor":dpr,"mobile":false,
            "screenWidth":width.ceil() as u32,"screenHeight":height.ceil() as u32,
            "screenOrientation":{"angle":0,"type":"landscapePrimary"},
        })).await?;
        Ok(())
    }

    pub async fn media(&self, scheme: &str) -> Result<()> {
        let sessions = {
            let mut state = self.state.lock().unwrap();
            state.scheme = scheme.into();
            state.sessions.iter().cloned().collect::<Vec<_>>()
        };
        for session in sessions {
            self.browser.send("Emulation.setEmulatedMedia", json!({"media":"","features":[{"name":"prefers-color-scheme","value":scheme}]}), Some(&session)).await?;
        }
        Ok(())
    }

    /// Evaluates in a context. `gesture`: as if the person had just acted
    /// (a select opened, a key handled for them); never otherwise, or the app
    /// would hold user activation, which gates clipboard writes, popups and
    /// fullscreen, all along (Playwright's evaluations always grant it).
    pub async fn eval_context_as(&self, context: &Context, expression: &str, gesture: bool) -> Result<Value> {
        let result = self.browser.send("Runtime.evaluate", json!({
            "expression":expression,"contextId":context.id,"awaitPromise":true,"returnByValue":true,"userGesture":gesture,
        }), Some(&context.session)).await?;
        if !result["exceptionDetails"].is_null() {
            bail!("{}", result["exceptionDetails"]["exception"]["description"].as_str()
                .or(result["exceptionDetails"]["text"].as_str()).unwrap_or("page evaluation failed"));
        }
        Ok(result["result"]["value"].clone())
    }

    pub async fn eval_context(&self, context: &Context, expression: &str) -> Result<Value> {
        self.eval_context_as(context, expression, false).await
    }

    pub fn main_context(&self) -> Option<Context> {
        let state = self.state.lock().unwrap();
        state.contexts.values().find(|c| c.session == self.session && c.frame == state.main).cloned()
    }

    pub fn app_context(&self) -> Option<Context> {
        let state = self.state.lock().unwrap();
        state.contexts.values().find(|c| {
            c.origin == self.origins.view && state.frames.get(&c.frame).is_some_and(|f|
                f.parent.as_ref() == Some(&state.main) && origin(&f.url) == self.origins.view)
        }).cloned()
    }

    pub async fn eval(&self, expression: &str) -> Result<Value> {
        let context = self.main_context().ok_or_else(|| anyhow!("host page has no execution context"))?;
        self.eval_context(&context, expression).await
    }

    pub async fn app_eval(&self, expression: &str) -> Result<Value> {
        let context = self.app_context().ok_or_else(|| anyhow!("the view's frame never loaded"))?;
        self.eval_context(&context, expression).await
    }

    /// In the app's frame, on the person's behalf (see `eval_context_as`).
    pub async fn app_eval_input(&self, expression: &str) -> Result<Value> {
        let context = self.app_context().ok_or_else(|| anyhow!("the view's frame never loaded"))?;
        self.eval_context_as(&context, expression, true).await
    }

    pub async fn navigate(&self, url: &str) -> Result<()> {
        // Old execution contexts must not satisfy the readiness check below.
        self.state.lock().unwrap().contexts.retain(|(session, _), _| session != &self.session);
        let result = self.send("Page.navigate", json!({"url":url})).await?;
        if let Some(error) = result["errorText"].as_str() { bail!("{error}"); }
        for _ in 0..600 {
            if let Some(context) = self.main_context() {
                if self.eval_context(&context, "document.readyState").await.is_ok_and(|s| s == "complete") {
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        bail!("host page never loaded")
    }

    /// Restore in a blank document at each saved origin before loading any
    /// app code. Awaiting an async init script would NOT block HTML parsing.
    /// No network request for these bootstrap documents is ever continued.
    pub async fn restore(&self, state: &Value) -> Result<()> {
        if state["cookies"].as_array().is_some_and(|a| !a.is_empty()) {
            let cookies: Vec<_> = state["cookies"].as_array().unwrap().iter().map(crate::store::cookie_to_cdp).collect();
            self.browser.send("Storage.setCookies", json!({"browserContextId":self.context_id,"cookies":cookies}), None).await?;
        }
        for saved in state["origins"].as_array().into_iter().flatten() {
            let Some(at) = saved["origin"].as_str() else { continue };
            if !at.starts_with("http://") && !at.starts_with("https://") { continue; }
            let url = format!("{}/__cli_restore", at.trim_end_matches('/'));
            self.state.lock().unwrap().bootstrap = Some(url.clone());
            self.navigate(&url).await?;
            self.eval(&format!("(new ({})(\"chromium\")).restore({saved})", crate::store::SCRIPT)).await?;
        }
        self.state.lock().unwrap().bootstrap = None;
        Ok(())
    }

    pub async fn storage(&self) -> Result<Value> {
        let cookies = self.browser.send("Storage.getCookies", json!({"browserContextId":self.context_id}), None).await?["cookies"].clone();
        let cookies: Vec<_> = cookies.as_array().into_iter().flatten().map(crate::store::cookie_from_cdp).collect();
        let (contexts, visited) = {
            let state = self.state.lock().unwrap();
            (state.contexts.values().cloned().collect::<Vec<_>>(), state.visited.clone())
        };
        let mut seen = HashSet::new();
        let mut origins = Vec::new();
        for context in contexts {
            if !(context.origin.starts_with("http://") || context.origin.starts_with("https://")) || seen.contains(&context.origin) { continue; }
            // Utility world: an app cannot replace the storage methods used
            // to save its state, nor read the serialization helper's values.
            let collected = async {
                let isolated = self.browser.send("Page.createIsolatedWorld", json!({"frameId":context.frame,"worldName":"cli-store"}), Some(&context.session)).await?;
                let utility = Context { id: isolated["executionContextId"].as_i64().ok_or_else(|| anyhow!("no storage context"))?, ..context.clone() };
                self.eval_context(&utility, &format!("(new ({})(\"chromium\")).collect({{indexedDB:true}})", crate::store::SCRIPT)).await
            }.await;
            if let Ok(mut data) = collected {
                seen.insert(context.origin.clone());
                data["origin"] = json!(context.origin);
                origins.push(data);
            }
        }
        let missing: Vec<_> = visited.difference(&seen).collect();
        if !missing.is_empty() {
            let scratch = self.scratch().await?;
            let result = async {
                for at in missing {
                    let url = format!("{at}/__cli_storage");
                    scratch.state.lock().unwrap().bootstrap = Some(url.clone());
                    scratch.navigate(&url).await?;
                    let mut data = scratch.eval(&format!("(new ({})(\"chromium\")).collect({{indexedDB:true}})",crate::store::SCRIPT)).await?;
                    data["origin"] = json!(at);
                    origins.push(data);
                }
                Ok::<_,anyhow::Error>(())
            }.await;
            scratch.close().await;
            result?;
        }
        Ok(json!({"cookies":cookies,"origins":origins}))
    }

    pub async fn ax_tree(&self) -> Result<Value> {
        let context = self.app_context().ok_or_else(|| anyhow!("no app frame"))?;
        self.browser.send("Accessibility.getFullAXTree", json!({"frameId":context.frame}), Some(&context.session)).await
    }

    pub async fn answer(&self, session: &str, context: i64, call: &Value, answer: Result<Value>) {
        let (ok, value) = match answer { Ok(v) => (true,v), Err(e) => (false,json!(e.to_string())) };
        let expression = format!("window.__cliHost.__answer({}, {ok}, {value})", call["id"]);
        let _ = self.browser.send("Runtime.evaluate", json!({"expression":expression,"contextId":context}), Some(session)).await;
    }

    pub async fn pause(&self, paused: bool) -> Result<()> {
        let _turn = self.pause_turn.lock().await;
        let sessions = {
            let mut state = self.state.lock().unwrap();
            if state.paused == paused { return Ok(()); }
            state.paused = paused;
            // Its workers too: a worker runs on while its page is paused
            // (a spinning one kept a core busy out of sight).
            state.sessions.iter().chain(state.workers.iter()).cloned().collect::<Vec<_>>()
        };
        let result = async {
            for session in &sessions {
                if paused {
                    self.browser.send("Debugger.enable", json!({}), Some(session)).await?;
                    self.browser.send("Debugger.pause", json!({}), Some(session)).await?;
                } else {
                    let _ = self.browser.send("Debugger.disable", json!({}), Some(session)).await;
                }
            }
            Ok::<_, anyhow::Error>(())
        }.await;
        if result.is_err() {
            for session in &sessions { let _ = self.browser.send("Debugger.disable", json!({}), Some(session)).await; }
            self.state.lock().unwrap().paused = false;
        }
        result
    }

    pub async fn close(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) { return; }
        self.stop.notify_waiters();
        if self.owns_context {
            let _ = self.browser.send("Target.disposeBrowserContext", json!({"browserContextId":self.context_id}), None).await;
        } else {
            let _ = self.browser.send("Target.closeTarget", json!({"targetId":self.target}), None).await;
        }
    }

    async fn intercept(&self, session: &str, params: Value) -> Result<()> {
        let id = &params["requestId"];
        let url = params["request"]["url"].as_str().unwrap_or("");
        let at = origin(url);
        let bootstrap = self.state.lock().unwrap().bootstrap.as_deref() == Some(url);
        let (html, policy) = self.view_doc.lock().unwrap().clone();
        // A view document with no CSP set (a tab made ahead, before a view
        // took it) is never served: it fails closed, not open.
        if !bootstrap && at == self.origins.view && policy.is_empty() {
            crate::out::log("view document refused: its CSP isn't set");
            self.browser.send("Fetch.failRequest", json!({"requestId":id,"errorReason":"BlockedByClient"}), Some(session)).await?;
            return Ok(());
        }
        let body = if bootstrap { Some(("<!doctype html><html><head></head><body></body></html>", false)) }
            else if at == self.origins.view { Some((&*html, true)) }
            else if at == self.origins.host { Some((&*self.host, false)) }
            else { None };
        if let Some((body, with_policy)) = body {
            let mut headers = vec![json!({"name":"Content-Type","value":"text/html; charset=utf-8"})];
            if with_policy { headers.push(json!({"name":"Content-Security-Policy","value":policy})); }
            self.browser.send("Fetch.fulfillRequest", json!({"requestId":id,"responseCode":200,"responseHeaders":headers,"body":B64.encode(body)}), Some(session)).await?;
        } else {
            let ours = {
                let s = self.state.lock().unwrap();
                let frame = params["frameId"].as_str().unwrap_or("");
                s.protected_navigation(frame)
            };
            if params["resourceType"] == "Document" && ours {
                crate::out::log(format!("navigation away refused ({})", url.chars().take(120).collect::<String>()));
                self.browser.send("Fetch.failRequest", json!({"requestId":id,"errorReason":"BlockedByClient"}), Some(session)).await?;
            } else {
                self.browser.send("Fetch.continueRequest", json!({"requestId":id}), Some(session)).await?;
            }
        }
        Ok(())
    }

    fn event(self: &Arc<Self>, event: Value) {
        let method = event["method"].as_str().unwrap_or("");
        let session = event["sessionId"].as_str().unwrap_or("").to_string();
        if method == "Helper.disconnected" {
            let _ = self.event_tx.send(Event::Closed("Chrome stopped"));
            self.stop.notify_waiters();
            return;
        }
        if !self.state.lock().unwrap().sessions.contains(&session) { return; }
        let p = &event["params"];
        match method {
            "Target.attachedToTarget" => {
                let Some(child) = p["sessionId"].as_str().map(str::to_string) else { return };
                if p["targetInfo"]["type"] == "worker" {
                    // A dedicated worker: paused with its page (see `pause`).
                    self.state.lock().unwrap().workers.insert(child.clone());
                    let me = self.clone();
                    tokio::spawn(async move {
                        let _turn = me.pause_turn.lock().await;
                        let _ = me.browser.send("Runtime.runIfWaitingForDebugger", json!({}), Some(&child)).await;
                        if me.state.lock().unwrap().paused {
                            let _ = me.browser.send("Debugger.enable", json!({}), Some(&child)).await;
                            let _ = me.browser.send("Debugger.pause", json!({}), Some(&child)).await;
                        }
                    });
                    return;
                }
                if p["targetInfo"]["type"] != "iframe" {
                    let browser = self.browser.clone();
                    tokio::spawn(async move { let _ = browser.send("Runtime.runIfWaitingForDebugger", json!({}), Some(&child)).await; });
                    return;
                }
                self.state.lock().unwrap().sessions.insert(child.clone());
                let me = self.clone();
                tokio::spawn(async move {
                    let result = me.initialize_session(&child).await;
                    if let Err(e) = result {
                        crate::out::log(format!("iframe initialization: {e}"));
                        // Never run a frame without the navigation interceptor
                        // and NO_WEBRTC hook installed successfully.
                        let _ = me.event_tx.send(Event::Closed("could not initialize the app's frame"));
                        return;
                    }
                    // Serialize with /shown and whileAwake: an iframe that
                    // attaches during a quick hide/show must not pause late.
                    let _turn = me.pause_turn.lock().await;
                    let _ = me.browser.send("Runtime.runIfWaitingForDebugger", json!({}), Some(&child)).await;
                    if me.state.lock().unwrap().paused {
                        let _ = me.browser.send("Debugger.enable", json!({}), Some(&child)).await;
                        let _ = me.browser.send("Debugger.pause", json!({}), Some(&child)).await;
                    }
                });
            }
            "Target.detachedFromTarget" => {
                if let Some(child) = p["sessionId"].as_str() {
                    let mut s = self.state.lock().unwrap();
                    s.sessions.remove(child);
                    s.workers.remove(child);
                    s.contexts.retain(|(session, _), _| session != child);
                }
            }
            "Runtime.executionContextCreated" => {
                let c = &p["context"];
                if c["auxData"]["isDefault"] != true { return; }
                if let (Some(id), Some(frame)) = (c["id"].as_i64(), c["auxData"]["frameId"].as_str()) {
                    self.state.lock().unwrap().contexts.insert((session.clone(), id), Context {
                        session, id, frame:frame.into(), origin:c["origin"].as_str().unwrap_or("").into(),
                    });
                }
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = p["executionContextId"].as_i64() { self.state.lock().unwrap().contexts.remove(&(session,id)); }
            }
            "Runtime.executionContextsCleared" => { self.state.lock().unwrap().contexts.retain(|(s,_),_| s != &session); }
            "Page.frameAttached" => {
                if let Some(id) = p["frameId"].as_str() {
                    self.state.lock().unwrap().frames.entry(id.into()).or_default().parent = p["parentFrameId"].as_str().map(str::to_string);
                }
            }
            "Page.frameNavigated" => {
                let f = &p["frame"];
                if let Some(id) = f["id"].as_str() {
                    let mut s = self.state.lock().unwrap();
                    if f["parentId"].is_null() && session == self.session { s.main = id.into(); }
                    let frame = s.frames.entry(id.into()).or_default();
                    if let Some(parent) = f["parentId"].as_str() { frame.parent = Some(parent.into()); }
                    frame.url = f["url"].as_str().unwrap_or("").into();
                    let at = origin(&frame.url);
                    if at.starts_with("http://") || at.starts_with("https://") { s.visited.insert(at); }
                }
            }
            "Page.frameDetached" if p["reason"] != "swap" => {
                if let Some(frame) = p["frameId"].as_str() {
                    let mut s = self.state.lock().unwrap();
                    s.frames.remove(frame); s.contexts.retain(|_,c| c.frame != frame);
                }
            }
            "Fetch.requestPaused" => {
                let (me, params) = (self.clone(), p.clone());
                tokio::spawn(async move { if let Err(e) = me.intercept(&session, params).await { crate::out::log(format!("interception: {e}")); } });
            }
            "Runtime.bindingCalled" if p["name"] == "__cliHost" => {
                let Some(context) = p["executionContextId"].as_i64() else { return };
                let Ok(call) = serde_json::from_str(p["payload"].as_str().unwrap_or("")) else { return };
                let allowed = {
                    let s = self.state.lock().unwrap();
                    s.host_binding(&session,&self.session,context,&self.origins.host)
                };
                let _ = self.event_tx.send(Event::Binding { session, context, call, allowed });
            }
            // A hint from any frame of the page: it only brings a capture, or
            // a store save, sooner.
            "Runtime.bindingCalled" if p["name"] == "__cliChanged" => {
                let _ = self.event_tx.send(Event::Changed { store: p["payload"] == "store" });
            }
            "Inspector.targetCrashed" => { let _ = self.event_tx.send(Event::Closed("the app's page crashed")); }
            // Its own network, for whoever asks whether it's quiet (`network`).
            "Network.requestWillBeSent" | "Network.loadingFinished" | "Network.loadingFailed"
            | "Network.webSocketCreated" | "Network.webSocketClosed" | "Network.webSocketFrameReceived"
            | "Network.webSocketFrameSent" | "Network.eventSourceMessageReceived" | "Network.dataReceived" => {
                let key = format!("{session}/{}", p["requestId"].as_str().unwrap_or(""));
                let mut s = self.state.lock().unwrap();
                match method {
                    "Network.requestWillBeSent" => { s.inflight.insert(key); }
                    "Network.loadingFinished" | "Network.loadingFailed" => { s.inflight.remove(&key); }
                    "Network.webSocketCreated" => { s.sockets.insert(key); }
                    "Network.webSocketClosed" => { s.sockets.remove(&key); }
                    _ => {}
                }
                s.net_at = crate::views::now();
            }
            "Page.screencastFrame" => {
                let browser = self.browser.clone();
                let id = p["sessionId"].clone();
                tokio::spawn(async move { let _ = browser.send("Page.screencastFrameAck",json!({"sessionId":id}),Some(&session)).await; });
                let _ = self.event_tx.send(Event::Painted);
            }
            "Page.javascriptDialogOpening" => {
                // Playwright dismisses dialogs without a listener, accepting
                // only beforeunload so an app cannot hold navigation open.
                let browser = self.browser.clone();
                let accept = p["type"] == "beforeunload";
                tokio::spawn(async move { let _ = browser.send("Page.handleJavaScriptDialog",json!({"accept":accept}),Some(&session)).await; });
            }
            "Runtime.consoleAPICalled" if p["type"] == "error" => {
                let text = p["args"].as_array().into_iter().flatten().filter_map(|a| a["value"].as_str()).collect::<Vec<_>>().join(" ");
                crate::out::log(crate::alt::plain_text(&text).chars().take(500).collect::<String>());
            }
            _ => {}
        }
    }
}

async fn watch(page: Weak<Page>, mut events: tokio::sync::mpsc::UnboundedReceiver<Value>) {
    loop {
        let Some(me) = page.upgrade() else { return };
        if me.stopped.load(Ordering::SeqCst) { return; }
        tokio::select! {
            _ = me.stop.notified() => return,
            // Every event, in order: the stream drops none (chrome::Events).
            event = events.recv() => match event {
                Some(event) => me.event(event),
                None => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_uses_cdp_context_not_page_supplied_identity() {
        let mut state = State { main:"main".into(),..State::default() };
        for (session,id,frame,origin) in [
            ("page",1,"main","http://host.mcp-app.localhost"),
            ("page",2,"app","http://mcp-app.localhost"),
            ("page",3,"app","http://host.mcp-app.localhost"),
            ("oop",1,"main","http://host.mcp-app.localhost"),
        ] {
            state.contexts.insert((session.into(),id),Context {session:session.into(),id,frame:frame.into(),origin:origin.into()});
        }
        let host = "http://host.mcp-app.localhost";
        assert!(state.host_binding("page","page",1,host));
        assert!(!state.host_binding("page","page",2,host));
        assert!(!state.host_binding("page","page",3,host));
        assert!(!state.host_binding("oop","page",1,host));
        assert!(!state.host_binding("page","page",99,host));
    }
    #[test]
    fn top_and_direct_child_navigation_is_protected() {
        let mut state = State {main:"main".into(),..State::default()};
        state.frames.insert("app".into(),Frame {parent:Some("main".into()),url:"http://mcp-app.localhost/".into()});
        state.frames.insert("embedded".into(),Frame {parent:Some("app".into()),url:"https://example.com/".into()});
        assert!(state.protected_navigation("main"));
        assert!(state.protected_navigation("app"));
        assert!(state.protected_navigation("unknown"));
        assert!(!state.protected_navigation("embedded"));
    }
}
