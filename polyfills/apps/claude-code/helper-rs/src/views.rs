//! View lifecycle and the mod's route contract. Layout and screenshots share
//! `turn`; input, visibility transitions, and saves have independent queues.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, Notify, mpsc, oneshot};

use crate::{Helper, alt, chrome::Browser, out::{emit, log}, page::{Page, Event}, policy, seams, store, terminal};

/// The page tells the helper when it changes (the change hook: DOM
/// mutations, canvas draw calls, fonts, running animations; its binding,
/// `__cliChanged`) and when its store is written. What the hook can't see (an
/// animated GIF, a caret blinking) the backstop catches: a full capture every
/// FULL_CAPTURE_MS, or BOOST_CAPTURE_MS for BOOST_MS after one found a change
/// nothing announced. The poll also checks the page still answers: one that
/// misses MAX_MISSES checks in a row (a busy loop, a promise that never
/// settles) is closed, rather than hold a core and the view.
const POLL_MS: u64 = 500;
const FULL_CAPTURE_MS: u64 = 3000;
/// The backstop once Chrome says when it paints (Event::Painted): a frame no
/// hook announced brings a capture within BOOST_CAPTURE_MS instead.
const PAINTED_BACKSTOP_MS: u64 = 10_000;
/// Frames Chrome draws this soon after a capture are the capture's own
/// (the viewport fitted for it), not the app's.
const OWN_PAINT_MS: u64 = 150;
/// After three paint-led captures in a row found nothing new, paints rest this long.
const PAINT_REST_MS: u64 = 5000;
const BOOST_CAPTURE_MS: u64 = 500;
const BOOST_MS: u64 = 5000;
const LIVENESS_MS: u64 = 2000;
const LIVENESS_TIMEOUT_MS: u64 = 3000;
const MAX_MISSES: u32 = 3;
const ALT_SETTLE_MS: u64 = 1500;
/// The longest a screenshot holds pointer input back for the page to draw
/// again (see `View::shoot`).
const POINTER_SETTLE_MS: u64 = 250;
const TEARDOWN_MS: u64 = 1500;
const REQUEST_TIMEOUT_MS: u64 = 120_000;
const CONSENT_TIMEOUT_MS: u64 = 600_000;
const MAX_IMAGE_BYTES: usize = 1_500_000;
/// Claude Code draws no tree with more than 2 MiB of Image source (base64):
/// a view's strips together stay under this, else it's taken again smaller,
/// down to MIN_SCALE.
const MAX_STRIP_CHARS: usize = 1_900_000;
const MIN_SCALE: f64 = 0.5;
/// A view's title at most this long.
const MAX_TITLE_CHARS: usize = 80;
/// A cells frame's text: the page's (DOM and canvas), and the canvas's alone
/// with the page's DOM counter, for a frame where only a canvas changed.
const EXTRACT_TEXT: &str = include_str!("../js/extract_text.js");
const CANVAS_TEXT: &str = include_str!("../js/canvas_text.js");
/// Text read anew for this long after input (see TextCache).
const TEXT_AFTER_INPUT_MS: u64 = 300;

/// The DOM text a cells frame read, kept while the page's DOM counter
/// (`__cliDom`) stands still: the next frame reads only the canvas's text.
#[derive(Clone)]
struct TextCache { dom: i64, generation: u64, dom_lines: Value, photos: Value }

/// DOM lines, then the canvas's, as extract_text.js orders them.
fn join_lines(dom: &Value, canvas: &Value) -> Value {
    Value::Array(dom.as_array().into_iter().flatten().chain(canvas.as_array().into_iter().flatten()).cloned().collect())
}
const MAX_DOWNLOAD_FILES: usize = 20;
const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;
const HOST_SCRIPT: &str = include_str!("../../mod/helper/host/host.js");

pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub fn string<'a>(v: &'a Value, key: &str) -> &'a str { v[key].as_str().unwrap_or("") }
pub fn num(v: &Value, key: &str, fallback: f64) -> f64 { v[key].as_f64().filter(|n| n.is_finite()).unwrap_or(fallback) }
fn clamp(n: f64, low: u32, high: u32) -> u32 { n.round().clamp(f64::from(low), f64::from(high)) as u32 }
fn ok() -> Value { json!({"ok":true}) }
fn no_view() -> Value { json!({"ok":false,"error":"no such view"}) }
fn contains(v: &Value, s: &str) -> bool { v.as_array().is_some_and(|a| a.iter().any(|v| v == s)) }

/// A view's request to the mod, waiting for its answer: of that view's page,
/// and of the open (generation) the page is for.
struct Pending { view: Weak<View>, open_gen: String, sender: oneshot::Sender<Result<Value>> }

/// What an /open of an id does when the helper already holds a page for it:
/// the same open asked again gets that page; a page of another open (an
/// earlier generation, one the mod no longer has) is closed, and this open
/// makes its own (model/AppsViews.tla, FixGen).
#[derive(Debug, PartialEq)]
enum PageHeld { Same, Other, None }
fn page_held(page_gen: Option<&str>, open_gen: &str) -> PageHeld {
    match page_gen { Some(g) if g == open_gen => PageHeld::Same, Some(_) => PageHeld::Other, None => PageHeld::None }
}

/// The generation a request about a view names ("" where none is given: a
/// driver of the helper that predates them, whose opens name none either).
fn gen_of(input: &Value) -> &str { input["gen"].as_str().unwrap_or("") }

/// Whether a request about a view is for the open its page is of: anything
/// for another generation is refused.
fn same_open(page_gen: &str, input: &Value) -> bool { page_gen == gen_of(input) }

pub struct Views {
    list: AsyncMutex<Vec<Arc<View>>>,
    opening: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Views closed while still opening: closed as soon as they have opened.
    closed_early: AsyncMutex<std::collections::HashSet<String>>,
    /// The generation of each open under way, by id: a close kept for one
    /// must be of that open.
    under_way: AsyncMutex<HashMap<String, String>>,
    pending: AsyncMutex<HashMap<u64, Pending>>,
    /// UI resources read, by server and URI: the read (its text left out)
    /// and the page's HTML once, shared by every view of the app (the
    /// three.js example's is 10 MB).
    resources: AsyncMutex<HashMap<String, (Value, Arc<str>)>>,
    /// The host page, one per background and scheme (the page script is
    /// most of a megabyte), shared by every view.
    host_pages: Mutex<HashMap<String, Arc<str>>>,
    store_root: Option<PathBuf>,
    image_root: PathBuf,
    /// The cells renderer's colour-pair budget, one for the helper (Claude
    /// Code admits new pairs at a rate across all its Rasters).
    pub render_session: Mutex<mcp_apps_render::Session>,
    /// A tab kept ready for the next view (see `keep_spare`), and whether
    /// one is being made.
    spare: AsyncMutex<Option<Spare>>,
    spare_making: AtomicBool,
}

/// A tab made ahead of the view that will take it: its own context, set up,
/// the host page loaded; `key` says which views it fits (see `spare_key`).
struct Spare { key: String, page: Arc<Page>, rx: mpsc::UnboundedReceiver<Event> }

/// What a spare tab must share with the view that takes it: the host page
/// (its background and scheme), the scripts and pixel ratio of the mode, the
/// reach of its network, and the origins it serves.
fn spare_key(scheme: &str, background: &str, image: bool, local_network: bool, origins: &policy::Origins) -> String {
    format!("{scheme}/{background}/{image}/{local_network}/{}/{}", origins.host, origins.view)
}

/// `MCP_APPS_CLI_SPARE=0`: no tab is kept ready; each view makes its own.
fn spare_on() -> bool {
    std::env::var("MCP_APPS_CLI_SPARE").map_or(true, |v| v != "0")
}

impl Views {
    pub fn new() -> Self {
        let store_root = store::root();
        if let Some(root) = store_root.clone() {
            tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(5)).await; store::prune(&root); });
        }
        Self {
            list: AsyncMutex::new(Vec::new()), opening: AsyncMutex::new(HashMap::new()), closed_early: AsyncMutex::new(Default::default()),
            under_way: AsyncMutex::new(HashMap::new()), pending: AsyncMutex::new(HashMap::new()), resources: AsyncMutex::new(HashMap::new()), host_pages: Mutex::new(HashMap::new()),
            store_root, image_root: crate::tmp::own_dir().join("images"), render_session: Mutex::new(Default::default()),
            spare: AsyncMutex::new(None), spare_making: AtomicBool::new(false),
        }
    }

    async fn get(&self, id: &str) -> Option<Arc<View>> { self.list.lock().await.iter().find(|v| v.id == id).cloned() }

    pub async fn ping(&self) -> Value {
        let list = self.list.lock().await;
        json!({"ok":true,"views":list.iter().map(|v| &v.id).collect::<Vec<_>>(),
            "rowHeights":list.iter().map(|v| v.state.lock().unwrap().cell_h).collect::<Vec<_>>()})
    }

    pub async fn shutdown(&self) {
        let list = self.list.lock().await.clone();
        for view in list { let _ = view.close(false).await; }
        if let Some(spare) = self.spare.lock().await.take() { spare.page.close().await; }
    }

    /// The spare tab, if it fits this view and is of this Chrome; it stays
    /// for a later view otherwise.
    async fn take_spare(&self, key: &str, browser: &Arc<Browser>) -> Option<(Arc<Page>, mpsc::UnboundedReceiver<Event>)> {
        let mut slot = self.spare.lock().await;
        let fits = slot.as_ref().is_some_and(|s| s.key == key && Arc::ptr_eq(&s.page.browser, browser) && !s.page.is_closed());
        if !fits { return None; }
        slot.take().map(|s| (s.page, s.rx))
    }

    /// Keeps one tab ready for the next view: made after each open, and when
    /// Chrome starts ahead of one (/prewarm), for the theme, mode and network
    /// reach the next view most likely has. It costs a small renderer while
    /// Chrome runs, never keeps Chrome running, and never starts it.
    pub fn keep_spare(helper: &Arc<Helper>, scheme: &'static str, image: bool, local_network: bool) {
        if !spare_on() { return; }
        let helper = helper.clone();
        tokio::spawn(async move {
            if helper.views.spare_making.swap(true, Ordering::SeqCst) { return; }
            if let Err(error) = Self::make_spare(&helper, scheme, image, local_network).await {
                log(format!("spare tab: {error:#}"));
            }
            helper.views.spare_making.store(false, Ordering::SeqCst);
        });
    }

    async fn make_spare(helper: &Arc<Helper>, scheme: &'static str, image: bool, local_network: bool) -> Result<()> {
        let Some(browser) = helper.chrome.current().await else { return Ok(()) };
        let theme = policy::theme(scheme);
        let background = string(&theme,"background");
        let origins = policy::origins(None, None);
        let key = spare_key(scheme, background, image, local_network, &origins);
        {
            let mut slot = helper.views.spare.lock().await;
            if slot.as_ref().is_some_and(|s| s.key == key && Arc::ptr_eq(&s.page.browser, &browser) && !s.page.is_closed()) { return Ok(()); }
            // One spare at most: one for another theme, mode or Chrome goes.
            if let Some(old) = slot.take() { tokio::spawn(async move { old.page.close().await; }); }
        }
        let host = helper.views.host_page(background, scheme);
        let host_url = format!("{}/", origins.host);
        let (page, rx) = Page::new(browser, origins, Arc::from(""), host, String::new(), image, false, 800.0, 240.0, scheme, local_network).await?;
        if let Err(error) = page.navigate(&host_url).await { page.close().await; return Err(error); }
        let mut slot = helper.views.spare.lock().await;
        if slot.is_some() || helper.chrome.current().await.is_none_or(|b| !Arc::ptr_eq(&b, &page.browser)) {
            drop(slot);
            page.close().await;
            return Ok(());
        }
        *slot = Some(Spare { key, page, rx });
        Ok(())
    }

    pub(crate) async fn resource(helper: &Arc<Helper>, server: &str, uri: &str) -> Result<(Value, Option<Arc<str>>)> {
        let cache = std::env::var("MCP_APPS_CLI_RESOURCE_CACHE").as_deref() != Ok("0");
        let key = format!("{server}\n{uri}");
        let cached = if cache { helper.views.resources.lock().await.get(&key).cloned() } else { None };
        if let Some((read, html)) = cached {
            let (helper, server, uri) = (helper.clone(), server.to_string(), uri.to_string());
            tokio::spawn(async move {
                if let Ok(read) = helper.mcp.read_resource(&server, json!({"uri":uri}), None).await {
                    let (read, html) = split_html(read);
                    if let Some(html) = html { helper.views.resources.lock().await.insert(key, (read, html)); }
                }
            });
            return Ok((read, Some(html)));
        }
        let (read, html) = split_html(helper.mcp.read_resource(server, json!({"uri":uri}), None).await?);
        if let (true, Some(html)) = (cache, html.as_ref()) {
            helper.views.resources.lock().await.insert(key, (read.clone(), html.clone()));
        }
        Ok((read, html))
    }

    /// The host page for a background and scheme, made once.
    fn host_page(&self, background: &str, scheme: &str) -> Arc<str> {
        let key = format!("{background}/{scheme}");
        self.host_pages.lock().unwrap().entry(key).or_insert_with(|| {
            Arc::from(format!("<!doctype html><html><head><meta charset=\"utf-8\"><style>\nhtml,body{{margin:0;padding:0;background:{background};overflow:hidden;color-scheme:{scheme}}}\niframe{{display:block;border:0;background:transparent}}\n</style></head><body><script>{HOST_SCRIPT}</script></body></html>"))
        }).clone()
    }
}

#[derive(Clone)]
pub struct Image { png: Vec<u8>, placed: Value, scale: f64 }
#[derive(Clone)]
pub struct Press { pub at: u64, pub x: f64, pub y: f64, pub button: String, pub count: u32 }
#[derive(Clone)]
pub struct Held { pub mods: Vec<String>, pub until: u64 }

pub struct State {
    pub image: bool,
    pub cols: u32,
    pub max_rows: u32,
    pub cell_h: f64,
    pub dpr: f64,
    pub display: String,
    pub height: f64,
    pub scale: f64,
    pub scroll: f64,
    pub generation: u64,
    background: u32,
    hash: Vec<u8>,
    rows: u32,
    version: u64,
    stamps: u64,
    files: bool,
    last_image: Option<Image>,
    busy: bool,
    again: bool,
    pub offscreen: bool,
    pub paused: bool,
    framed_off: bool,
    awake: usize,
    pub input_at: u64,
    pub activated_at: u64,
    pub pointer_held: bool,
    pub mouse: (f64, f64),
    pub buttons: u32,
    pub last_press: Option<Press>,
    pub held: HashMap<String, Held>,
    pub hover_at: u64,
    pub hold_for_rest: bool,
    pub rest_until: u64,
    pub held_since: u64,
    pub sweep: bool,
    pub idle_change_at: u64,
    motion: Vec<u64>,
    captured_at: u64,
    /// When the capture running now started: the pace counts from there.
    capture_started: u64,
    /// The page announced a change since the last capture began.
    hinted: bool,
    /// The next capture is the backstop's; until then, backstop captures
    /// come every BOOST_CAPTURE_MS.
    backstop: bool,
    boost_until: u64,
    /// Liveness: when the next check is due, one running, misses in a row.
    alive_check_at: u64,
    checking: bool,
    misses: u32,
    capture_at: Vec<u64>,
    pace_at: Option<u64>,
    describe_at: Option<u64>,
    poll_at: u64,
    store_at: u64,
    store_soon: Option<u64>,
    alt: String,
    /// The app page's title, as last sent.
    title: String,
    text_cache: Option<TextCache>,
    timings: Vec<(u64, u64)>,
    dropped: u32,
    /// The cells renderer's memory of this view (glyphs held still between
    /// frames) and its painter (photo palette, Claude Code's pair slots).
    cell_memory: mcp_apps_render::Memory,
    painter: mcp_apps_render::Painter,
    memory_top: f64,
    /// iTerm2 strips: the encoder's state (out while a job runs), one job at a
    /// time, the latest picture next, and whether a fresh copy of every band
    /// was asked for on the way.
    /// Texts the last cells frame drew on another row than the page (lines.rs).
    pub moved: Vec<crate::lines::Moved>,
    /// The last cells frame's row snap (snap.rs), and its pixels per page pixel.
    pub snapped: Option<(crate::snap::Snap, f64)>,
    strip_state: Option<mcp_apps_pictures::StripState>,
    strip_busy: bool,
    strip_again: bool,
    strip_all: bool,
    /// The base64 characters of each band the mod holds now.
    strip_chars: Vec<usize>,
    /// The most image pixels per CSS pixel this view's pictures take: halved
    /// each time its strips grew past MAX_STRIP_CHARS, until it's resized.
    max_scale: f64,
    /// When `max_scale` was last lowered.
    capped_at: u64,
    /// Chrome paints (Event::Painted): it says so; a frame no capture
    /// explains came; frames until this time are a capture's own.
    painting: bool,
    painted: bool,
    own_paint_until: u64,
    /// Paints since the last capture began; paint-led captures in a row that found nothing.
    paints: u32,
    idle_paints: u32,
    downloading: bool,
}

pub struct View {
    pub id: String,
    /// The open this page is for (the mod's nonce, from /open): carried by
    /// everything said of it, and asked of everything asked of it.
    pub open_gen: String,
    server: String,
    /// The tool's `outputSchema`, kept only where the person turned
    /// "Structured results from text" on for its server (the mod says so at
    /// /open): see `policy::structured_from_text`.
    structured_from_text: Option<Value>,
    helper: Weak<Helper>,
    pub page: Arc<Page>,
    pub state: Mutex<State>,
    pub turn: AsyncMutex<()>,
    /// Held from just before each screenshot until the page has drawn again
    /// after it, and while a pointer or wheel event is sent (see `shoot`).
    pub pointer_gate: Arc<AsyncMutex<()>>,
    pub inputs: AsyncMutex<()>,
    shown_turn: AsyncMutex<()>,
    store_saving: AsyncMutex<()>,
    pub alive: AtomicBool,
    timers: Notify,
    store_file: Option<PathBuf>,
    file_stem: String,
    input_tx: mpsc::UnboundedSender<Value>,
    /// Itself, for tasks it starts (the strip queue).
    me: Weak<View>,
}

impl View {
    /// The model's call's result as this view gets it: as it came, with
    /// structuredContent from its text only where the person asked for that
    /// for this server.
    fn tool_result(&self, raw: &Value) -> Value {
        let mut result = policy::normalize_result(raw);
        if let Some(schema) = &self.structured_from_text { policy::structured_from_text(&mut result, schema); }
        result
    }

    pub fn capture_soon(&self, ms: u64) {
        let mut s = self.state.lock().unwrap();
        let time = now() + ms;
        if !s.capture_at.contains(&time) { s.capture_at.push(time); }
        self.timers.notify_one();
    }

    pub fn describe_soon(&self, ms: u64) {
        let mut s = self.state.lock().unwrap();
        s.describe_at = Some(now() + ms); self.timers.notify_one();
    }

    async fn fit_viewport(&self, again: bool) -> Result<()> {
        let (width, height, dpr) = {
            let s = self.state.lock().unwrap();
            ((f64::from(s.cols) * 8.0 / s.scale).ceil(), (f64::from(s.max_rows) * s.cell_h).ceil().max((s.height / s.scale).ceil()), s.dpr)
        };
        if self.page.eval("[innerWidth, innerHeight]").await.is_ok_and(|v| v[0].as_f64() == Some(width) && v[1].as_f64() == Some(height)) { return Ok(()); }
        if !again { self.state.lock().unwrap().generation += 1; }
        self.page.metrics(width, height, dpr).await
    }

    pub async fn clamp_scroll(&self) -> Result<()> {
        let top = {
            let mut s = self.state.lock().unwrap();
            s.scroll = ((s.scroll / s.cell_h).round() * s.cell_h).max(0.0).min((s.height - f64::from(s.max_rows) * s.cell_h).max(0.0));
            s.scroll
        };
        let _ = self.page.eval(&format!("window.scrollTo(0,{top})")).await;
        Ok(())
    }

    pub async fn page_scroll(&self) -> f64 {
        let top = self.state.lock().unwrap().scroll;
        self.page.eval(&format!("(() => {{ if(Math.round(window.scrollY)!=={top})window.scrollTo(0,{top}); return Math.round(window.scrollY); }})()"))
            .await.ok().and_then(|v| v.as_f64()).unwrap_or(top)
    }

    async fn resize(&self, cols: f64, max_rows: f64, display: &str) -> Result<Value> {
        let _turn = self.turn.lock().await;
        let (w,h,dpr,mode,image) = {
            let mut s = self.state.lock().unwrap();
            s.cols = clamp(cols,20,240);
            if max_rows != 0.0 { s.max_rows = clamp(max_rows,4,80); }
            s.max_scale = 2.0;
            if !display.is_empty() { s.display = display.into(); }
            s.cell_h = terminal::row_height(s.image);
            s.generation += 1;
            (f64::from(s.cols)*8.0,f64::from(s.max_rows)*s.cell_h,s.dpr,s.display.clone(),s.image)
        };
        self.page.metrics(w,h.ceil(),dpr).await?;
        self.page.eval(&format!("window.__setContainer?.({}, {w}, {}, {image})",json!(mode),h.floor())).await?;
        self.clamp_scroll().await?;
        self.state.lock().unwrap().hash.clear();
        self.capture_soon(60);
        Ok(ok())
    }

    async fn set_theme(&self, wanted: &str) -> Result<Value> {
        let scheme = policy::theme_name(wanted);
        let theme = policy::theme(scheme);
        self.state.lock().unwrap().background = u32::from_str_radix(string(&theme,"background").trim_start_matches('#'),16).unwrap_or(0);
        self.page.media(scheme).await?;
        self.page.eval(&format!("window.__setTheme({}, {}, {})",json!(scheme),theme["styles"],theme["background"])).await?;
        // A theme can recolour text with no DOM change (CSS media queries).
        self.state.lock().unwrap().text_cache = None;
        self.capture_soon(60);
        Ok(json!({"ok":true,"theme":scheme}))
    }

    async fn settle_shown(&self) {
        let _turn = self.shown_turn.lock().await;
        let (hidden, offscreen, framed) = {
            let s = self.state.lock().unwrap();
            (s.offscreen && s.awake == 0 && self.alive.load(Ordering::SeqCst),s.offscreen,s.framed_off)
        };
        if !hidden {
            let _ = self.page.pause(false).await;
            self.state.lock().unwrap().paused = false;
        }
        if framed != offscreen && self.alive.load(Ordering::SeqCst) {
            self.state.lock().unwrap().framed_off = offscreen;
            let _ = self.page.eval(&format!("window.__setShown?.({})",!offscreen)).await;
        }
        if hidden {
            self.state.lock().unwrap().paused = true;
            if let Err(e) = self.page.pause(true).await {
                self.state.lock().unwrap().paused = false;
                log(format!("view {}: could not pause its page: {e}",self.id));
            }
        }
    }

    async fn set_shown(&self, shown: bool) {
        {
            let mut s = self.state.lock().unwrap();
            if s.offscreen == !shown { return; }
            s.offscreen = !shown;
        }
        self.settle_shown().await;
        if shown { self.state.lock().unwrap().poll_at = now(); self.timers.notify_one(); }
    }

    async fn forget(self: &Arc<Self>) -> bool {
        let Some(helper) = self.helper.upgrade() else { return false };
        {
            // Emission and forgetting share this lock: a final capture
            // cannot appear on stdout after this view's closed notification.
            let _state = self.state.lock().unwrap();
            if !self.alive.swap(false,Ordering::SeqCst) { return false; }
        }
        self.timers.notify_one();
        helper.views.list.lock().await.retain(|v| !Arc::ptr_eq(v,self));
        self.settle_shown().await;
        {
            let mut pending = helper.views.pending.lock().await;
            let ids: Vec<_> = pending.iter().filter(|(_,p)| p.view.upgrade().is_some_and(|v| Arc::ptr_eq(&v,self))).map(|(id,_)| *id).collect();
            for id in ids { if let Some(p) = pending.remove(&id) { let _ = p.sender.send(Err(anyhow!("the view closed"))); } }
        }
        // The last picture's file stays (kitty and Ghostty draw a closed
        // view, resting or evicted, from it); the helper's folder goes at exit.
        let last = self.state.lock().unwrap().stamps % 3;
        for k in (0..3).filter(|&k| k != last) { let _ = std::fs::remove_file(helper.views.image_root.join(format!("{}-{k}-tty-graphics-protocol.png",self.file_stem))); }
        helper.chrome.views.fetch_sub(1,Ordering::SeqCst);
        helper.chrome.note_views().await;
        true
    }

    async fn drop_view(self: &Arc<Self>, reason: &str) {
        if self.forget().await {
            emit(&json!({"type":"closed","viewId":self.id,"gen":self.open_gen,"reason":reason}));
            self.page.close().await;
        }
    }

    /// A view whose open failed: gone, its page with it. Its store is
    /// neither saved (the page may hold nothing yet) nor deleted: a passing
    /// failure (a slow load) mustn't cost the person what the view kept.
    async fn abandon(self: &Arc<Self>) {
        if self.forget().await { self.page.close().await; }
    }

    async fn close(self: &Arc<Self>, discard: bool) -> Result<Value> {
        if !self.forget().await { return Ok(ok()); }
        let _ = tokio::time::timeout(Duration::from_millis(TEARDOWN_MS), self.page.eval("window.__teardown()")).await;
        if discard {
            let _save = self.store_saving.lock().await;
            if let Some(file) = &self.store_file { let _ = std::fs::remove_file(file); }
        } else { self.save_store(true).await; }
        self.page.close().await;
        Ok(ok())
    }

    async fn save_store(&self, last: bool) {
        let Some(file) = &self.store_file else { return };
        if !last && (!self.alive.load(Ordering::SeqCst) || self.state.lock().unwrap().paused) { return; }
        let lock = if last { self.store_saving.lock().await } else {
            let Ok(lock) = self.store_saving.try_lock() else { return }; lock
        };
        let result = async { store::write(file, &self.page.storage().await?) }.await;
        drop(lock);
        if let Err(e) = result { if self.alive.load(Ordering::SeqCst) { log(format!("store {}: {e}",self.id)); } }
    }

    async fn request(self: &Arc<Self>, method: &str, params: Value, timeout: u64) -> Result<Value> {
        let helper = self.helper.upgrade().ok_or_else(|| anyhow!("the view closed"))?;
        let id = crate::verdict::next_id();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = helper.views.pending.lock().await;
            if !self.alive.load(Ordering::SeqCst) { bail!("the view closed"); }
            pending.insert(id, Pending { view:Arc::downgrade(self),open_gen:self.open_gen.clone(),sender });
        }
        emit(&json!({"type":"request","id":id,"viewId":self.id,"gen":self.open_gen,"method":method,"params":params}));
        let result = tokio::time::timeout(Duration::from_millis(timeout), receiver).await;
        helper.views.pending.lock().await.remove(&id);
        match result { Ok(Ok(r)) => r, Ok(Err(_)) => bail!("the view closed"), Err(_) => bail!("{method} timed out") }
    }

    async fn host_call(self: &Arc<Self>, kind: &str, payload: Value) -> Result<Value> {
        if !self.alive.load(Ordering::SeqCst) { bail!("the view closed"); }
        let helper = self.helper.upgrade().ok_or_else(|| anyhow!("the view closed"))?;
        match kind {
            "size" => {
                let _turn = self.turn.lock().await;
                {
                    let mut s = self.state.lock().unwrap();
                    s.height = num(&payload,"height",s.height);
                    s.scale = num(&payload,"scale",1.0).max(0.001);
                }
                self.fit_viewport(false).await?;
                self.clamp_scroll().await?;
                self.capture_soon(30);
            }
            "initialized" => {
                self.capture_soon(60);
                emit(&json!({"type":"notify","viewId":self.id,"gen":self.open_gen,"method":"ui/app-modes","params":{"modes":payload["modes"]}}));
            }
            "ui/request-display-mode" => {
                let answer = self.request(kind,payload,REQUEST_TIMEOUT_MS).await.unwrap_or(Value::Null);
                let mode = answer["mode"].as_str().map(str::to_string).unwrap_or_else(|| self.state.lock().unwrap().display.clone());
                return Ok(json!({"mode":mode}));
            }
            "tools/call" => {
                let name = string(&payload,"name");
                let discovered = helper.mcp.discover(&self.server,false).await?;
                if discovered["visibility"][name].is_array() && !contains(&discovered["visibility"][name],"app") {
                    bail!("tool {name} is not available to apps");
                }
                let app_only = contains(&discovered["appOnly"],name);
                let consent = self.request("ui/allow-tool",json!({"name":name,"arguments":payload.get("arguments").cloned().unwrap_or(json!({})),"appOnly":app_only}),CONSENT_TIMEOUT_MS)
                    .await.unwrap_or_else(|e| json!({"allow":false,"reason":e.to_string()}));
                let Some(epoch) = crate::verdict::yes(&consent) else {
                    bail!("{}",consent["reason"].as_str().map(str::to_string).unwrap_or_else(||format!("the user declined {name}")));
                };
                if !self.alive.load(Ordering::SeqCst) { bail!("the view closed"); }
                // On the mod's yes, asked of Claude Code right before it came.
                if app_only { return helper.mcp.call_tool(&self.server,payload,Some(epoch)).await; }
                return Ok(policy::normalize_result(&self.request(kind,payload,REQUEST_TIMEOUT_MS).await?));
            }
            "resources/read" => { let epoch = self.server_in_use(kind).await?; return helper.mcp.read_resource(&self.server,payload,Some(epoch)).await }
            "resources/list" => { let epoch = self.server_in_use(kind).await?; return helper.mcp.list_resources(&self.server,payload,Some(epoch)).await }
            "resources/templates/list" => { let epoch = self.server_in_use(kind).await?; return helper.mcp.list_resource_templates(&self.server,payload,Some(epoch)).await }
            "copy" => {
                let text = payload["text"].as_str().map(str::to_string).unwrap_or_default();
                {
                    let mut s = self.state.lock().unwrap();
                    if text.is_empty() || text.encode_utf16().count() > 100_000 || now().saturating_sub(s.activated_at) > 2000 { return Ok(json!({})); }
                    s.activated_at = 0;
                }
                emit(&json!({"type":"notify","viewId":self.id,"gen":self.open_gen,"method":"ui/copy","params":{"text":text}}));
            }
            "ui/message" => return self.request(kind,payload,REQUEST_TIMEOUT_MS).await,
            "ui/open-link" => return self.request(kind,payload,CONSENT_TIMEOUT_MS).await,
            "ui/download-file" => return self.download_files(&payload["contents"]).await,
            "ui/update-model-context" | "log" => emit(&json!({"type":"notify","viewId":self.id,"gen":self.open_gen,"method":kind,"params":payload})),
            _ => bail!("unsupported host call {kind}"),
        }
        Ok(json!({}))
    }

    /// The mod's yes, asked afresh, that Claude Code still uses this view's
    /// server under its name, before the app's own read goes to it (a call of
    /// its tools is asked about with its consent, ui/allow-tool): the epoch
    /// the read then goes on (see mcp.rs).
    async fn server_in_use(self: &Arc<Self>, method: &str) -> Result<u64> {
        let answer = self.request("ui/allow-read",json!({"method":method}),REQUEST_TIMEOUT_MS).await.unwrap_or(Value::Null);
        let Some(epoch) = crate::verdict::yes(&answer) else {
            bail!("{}",answer["reason"].as_str().unwrap_or("Claude Code is not using this server now"));
        };
        if !self.alive.load(Ordering::SeqCst) { bail!("the view closed"); }
        Ok(epoch)
    }

    async fn download_files(self: &Arc<Self>, contents: &Value) -> Result<Value> {
        let Some(contents) = contents.as_array().filter(|c| c.len() <= MAX_DOWNLOAD_FILES) else { return Ok(json!({"isError":true})) };
        {
            let mut s = self.state.lock().unwrap();
            if s.downloading { return Ok(json!({"isError":true})); }
            s.downloading = true;
        }
        let result = self.download_bounded(contents).await;
        self.state.lock().unwrap().downloading = false;
        result
    }

    async fn download_bounded(self: &Arc<Self>, contents: &[Value]) -> Result<Value> {
        use std::io::Write;
        let helper = self.helper.upgrade().ok_or_else(|| anyhow!("the view closed"))?;
        let mut files = Vec::new();
        let mut total = 0;
        for item in contents {
            let resource = match string(item,"type") {
                "resource" => item["resource"].clone(),
                "resource_link" => { let epoch = self.server_in_use("resources/read").await?; helper.mcp.read_resource(&self.server,json!({"uri":item["uri"]}),Some(epoch)).await?["contents"][0].clone() }
                _ => continue,
            };
            if resource.is_null() { continue; }
            total += resource["blob"].as_str().map_or_else(|| string(&resource,"text").len(), |b| b.len()*3/4);
            if total > MAX_DOWNLOAD_BYTES { return Ok(json!({"isError":true})); }
            let bytes = if let Some(b) = resource["blob"].as_str() { B64.decode(b)? } else { string(&resource,"text").as_bytes().to_vec() };
            let base = item["name"].as_str().or(resource["uri"].as_str()).unwrap_or("download").rsplit(['\\','/']).next().unwrap_or("download");
            let mut name: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || "_.- ()".contains(c) { c } else { '_' }).collect();
            if name.starts_with('.') { name = format!("_{}",name.trim_start_matches('.')); }
            name.truncate(name.len().min(120));
            if name.is_empty() { name = "download".into(); }
            files.push((name,bytes));
        }
        if files.is_empty() { return Ok(json!({"isError":true})); }
        let answer = self.request("ui/allow-download",json!({"files":files.iter().map(|(n,b)| json!({"name":n,"size":b.len()})).collect::<Vec<_>>()}),CONSENT_TIMEOUT_MS).await.unwrap_or(Value::Null);
        if answer["allow"] != true || !self.alive.load(Ordering::SeqCst) { return Ok(json!({"isError":true})); }
        let folder = crate::tmp::home().ok_or_else(||anyhow!("no home folder"))?.join("Downloads");
        std::fs::create_dir_all(&folder)?;
        let mut saved = Vec::new();
        for (name,bytes) in files {
            let path = std::path::Path::new(&name);
            let ext = path.extension().map(|s|format!(".{}",s.to_string_lossy())).unwrap_or_default();
            let stem = name.strip_suffix(&ext).unwrap_or(&name);
            let mut target = folder.join(&name);
            let mut n = 0;
            loop {
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
                    Ok(mut file) => {
                        file.write_all(&bytes)?;
                        drop(file);
                        if let Err(e) = store::mark_downloaded(&target) { log(format!("{}: not marked as downloaded: {e}",target.display())); }
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => { n += 1; target = folder.join(format!("{stem} ({n}){ext}")); }
                    Err(e) => return Err(e.into()),
                }
            }
            saved.push(target);
        }
        emit(&json!({"type":"notify","viewId":self.id,"gen":self.open_gen,"method":"ui/downloaded","params":{"files":saved}}));
        Ok(json!({}))
    }

    async fn poll(self: &Arc<Self>) {
        let (check, due) = {
            let mut s = self.state.lock().unwrap();
            if !self.alive.load(Ordering::SeqCst) || s.offscreen || s.paused || self.page.app_context().is_none() { return; }
            let time = now();
            let check = time >= s.alive_check_at && !s.checking;
            if check { s.alive_check_at = time + LIVENESS_MS; s.checking = true; }
            let every = if s.boost_until > time || s.painted { BOOST_CAPTURE_MS } else if s.painting { PAINTED_BACKSTOP_MS } else { FULL_CAPTURE_MS };
            let due = !s.busy && time.saturating_sub(s.captured_at) >= every;
            if due { s.backstop = true; }
            (check, due)
        };
        if due { self.capture().await; }
        if check {
            let answered = tokio::time::timeout(Duration::from_millis(LIVENESS_TIMEOUT_MS), self.page.app_eval("1")).await
                .is_ok_and(|r| r.is_ok());
            let misses = {
                let mut s = self.state.lock().unwrap();
                s.checking = false;
                // Out of sight meanwhile: its page was paused, not hung.
                if answered || s.paused || s.offscreen { s.misses = 0; } else { s.misses += 1; }
                s.misses
            };
            if misses >= MAX_MISSES && self.alive.load(Ordering::SeqCst) {
                log(format!("view {}: its app stopped responding", self.id));
                self.drop_view("the app stopped responding").await;
            }
        }
    }

    /// The page said it changed: captured now, unless a capture runs (it
    /// goes again) or one is paced (it comes soon).
    /// Chrome drew a frame. Unless a capture runs (or just ran, its own
    /// frames) or one is due anyway, the backstop's next comes sooner.
    fn painted(&self) {
        let mut s = self.state.lock().unwrap();
        s.painting = true;
        s.paints += 1;
        if s.busy || now() < s.own_paint_until { return; }
        s.painted = true;
    }

    fn changed(&self, store: bool) {
        let mut s = self.state.lock().unwrap();
        if store {
            if s.store_soon.is_none() { s.store_soon = Some(now() + store::STORE_SOON_MS); }
            drop(s);
            self.timers.notify_one();
            return;
        }
        s.hinted = true;
        if s.paused || s.offscreen { return; }
        if s.busy { s.again = true; return; }
        if s.pace_at.is_some() { return; }
        let time = now();
        if !s.capture_at.contains(&time) { s.capture_at.push(time); }
        drop(s);
        self.timers.notify_one();
    }

    async fn shoot(&self, cols: u32, rows: u32, cell_h: f64, scale: f64) -> Result<Vec<u8>> {
        let _turn = self.turn.lock().await;
        self.fit_viewport(true).await?;
        let (top, dpr) = { let s = self.state.lock().unwrap(); (s.scroll, s.dpr) };
        // `scale` is image pixels per CSS pixel, as the Node helper means it.
        // It shoots in a session of its own, with no pixel-ratio override, so
        // Chrome scales by `scale` alone; this session has the page's ratio
        // (2 for pictures), which Chrome multiplies in: divided out here.
        // After a clipped screenshot Chrome can hit-test the parent of an
        // embedded frame until it has composited again. One animation frame
        // sometimes precedes that update. Hold pointer input for two frames.
        let gate = self.pointer_gate.clone().lock_owned().await;
        let result = self.page.send("Page.captureScreenshot", json!({
            "format":"png","clip":{"x":0,"y":top,"width":f64::from(cols)*8.0,"height":f64::from(rows)*cell_h,"scale":scale/dpr},
            "optimizeForSpeed":true,"captureBeyondViewport":true,
        })).await?;
        let page = self.page.clone();
        tokio::spawn(async move {
            let repaint = page.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))");
            tokio::pin!(repaint);
            // A frozen page may never repaint. Unblock input at the deadline,
            // but let the CDP write and its pending-reply cleanup finish.
            if tokio::time::timeout(Duration::from_millis(POINTER_SETTLE_MS), &mut repaint).await.is_err() {
                drop(gate);
                let _ = repaint.await;
            }
        });
        Ok(B64.decode(string(&result,"data"))?)
    }

    pub async fn capture(&self) {
        {
            let mut s = self.state.lock().unwrap();
            if !self.alive.load(Ordering::SeqCst) || self.page.app_context().is_none() || s.paused { return; }
            if s.image && s.hold_for_rest && s.rest_until > now() && !s.sweep { return; }
            s.sweep = false;
            s.captured_at = now();
            if s.busy { s.again = true; return; }
            s.busy = true;
            s.capture_started = now();
        }
        let (backstop, hinted) = {
            let mut s = self.state.lock().unwrap();
            let taken = (std::mem::take(&mut s.backstop), std::mem::take(&mut s.hinted));
            // The backstop looks for what nothing announced: it reads the text afresh too.
            if taken.0 { s.text_cache = None; }
            taken
        };
        let (paint_led, paints) = { let mut s = self.state.lock().unwrap(); (std::mem::take(&mut s.painted), std::mem::take(&mut s.paints)) };
        let result = self.capture_now().await;
        let changed = result.as_ref().copied().unwrap_or(false);
        {
            let mut s = self.state.lock().unwrap();
            s.own_paint_until = now() + OWN_PAINT_MS;
            // Paints that keep bringing captures of nothing new (a capture's
            // own repaint, late on a heavy page): not heeded for a while.
            if paint_led && !changed {
                s.idle_paints += 1;
                if s.idle_paints >= 3 { s.idle_paints = 0; s.own_paint_until = now() + PAINT_REST_MS; }
            } else if changed { s.idle_paints = 0; }
            // The backstop found a change no paint came for: Chrome stopped
            // saying, and the backstop goes back to its own pace.
            if backstop && changed && !hinted && paints == 0 { s.painting = false; }
        }
        if let Err(e) = result { if self.alive.load(Ordering::SeqCst) { log(format!("capture {}: {e}",self.id)); } }
        let mut s = self.state.lock().unwrap();
        s.busy = false;
        if changed && now().saturating_sub(s.input_at) > 800 {
            s.idle_change_at = now();
            let cutoff = s.idle_change_at.saturating_sub(1000);
            s.motion.retain(|t| *t > cutoff);
            let at = s.idle_change_at; s.motion.push(at);
        }
        // The backstop found a change nothing announced (an animated GIF, a
        // caret): it looks more often for a while.
        if backstop && changed && !hinted { s.boost_until = now() + BOOST_MS; }
        if s.again || changed {
            s.again = false;
            let pace = if !s.image {25} else if terminal::image_files() {30} else {60};
            // Counted from when this capture started: a capture's own time is
            // part of the pace, not added to it.
            s.pace_at = Some(if changed { (s.capture_started + pace).max(now() + 1) } else { now() + 20 });
            self.timers.notify_one();
        }
    }

    /// `MCP_APPS_CLI_TIMINGS=1`: each changed capture's stages (the shot,
    /// and the rest: text, cells, encoding, sending), logged as p50/p95 every
    /// 60 of them.
    fn time(&self, shot: u64, rest: u64) {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if !*ON.get_or_init(|| std::env::var_os("MCP_APPS_CLI_TIMINGS").is_some()) { return; }
        let mut s = self.state.lock().unwrap();
        s.timings.push((shot, rest));
        if s.timings.len() < 60 { return; }
        let p = |v: &mut Vec<u64>, q: f64| { v.sort_unstable(); v[((v.len() - 1) as f64 * q).round() as usize] };
        let (mut a, mut b): (Vec<u64>, Vec<u64>) = s.timings.drain(..).unzip();
        log(format!("timings {}: shot p50 {} ms p95 {} ms; after it p50 {} ms p95 {} ms", self.id, p(&mut a, 0.5), p(&mut a, 0.95), p(&mut b, 0.5), p(&mut b, 0.95)));
    }

    async fn capture_now(&self) -> Result<bool> {
        let (image,generation,cols,height,rows,cell_h,top,scale,_dpr) = {
            let _turn = self.turn.lock().await;
            let s = self.state.lock().unwrap();
            let height = if s.height == 0.0 {120.0} else {s.height};
            let animating = s.motion.iter().filter(|t| now().saturating_sub(**t)<1000).count() >= 3;
            let strips = terminal::strips_on() && !(terminal::image_files() && s.files);
            let sweeping = now().saturating_sub(s.hover_at) < 110 && !strips;
            let moving = !terminal::image_files() && (animating || sweeping || s.pointer_held);
            let scale = (if moving { if strips {s.cell_h.ceil()/s.cell_h} else {1.0} } else {2.0}).min(s.max_scale);
            (s.image,s.generation,s.cols,height,clamp((height/s.cell_h).ceil(),1,s.max_rows),s.cell_h,s.scroll,scale,s.dpr)
        };
        if image {
            let started = now();
            let mut scale = scale;
            let mut png = self.shoot(cols,rows,cell_h,scale).await?;
            let shot = now() - started;
            // A picture that goes to the terminal whole, too big for it: taken
            // again smaller (1x, then MIN_SCALE). Bands (iTerm2) are cut from it
            // here, whatever its size; queue_strips keeps their sum in bounds.
            let strips = { let s = self.state.lock().unwrap(); terminal::strips_on() && !(terminal::image_files() && s.files) };
            while png.len() > MAX_IMAGE_BYTES && !strips && scale > MIN_SCALE {
                scale = if scale > 1.0 {1.0} else {MIN_SCALE};
                png = self.shoot(cols,rows,cell_h,scale).await?;
                if std::env::var_os("MCP_APPS_CLI_TIMINGS").is_some() { log(format!("timings {}: taken again at {scale}x ({} bytes)", self.id, png.len())); }
            }
            {
                let mut s = self.state.lock().unwrap();
                if !self.alive.load(Ordering::SeqCst) || !s.image || s.generation != generation || s.cols != cols { s.again = true; return Ok(false); }
                let hash = Sha256::new().chain_update(&png).chain_update(format!("{top}/{scale}")).finalize().to_vec();
                if hash == s.hash && rows == s.rows { return Ok(false); }
                s.hash = hash; s.rows = rows; s.version += 1;
                let mut placed = json!({"cols":cols,"rows":rows});
                let total = (height/cell_h).ceil() as u32;
                if total > rows { placed["scroll"] = json!({"top":(top/cell_h).round() as u32,"rows":rows,"total":total}); }
                s.last_image = Some(Image { png,placed,scale });
            }
            let sent = now();
            self.send_image(false)?;
            self.time(shot, now() - sent);
            return Ok(true);
        }
        // The text read before and after the screenshot must agree (else the
        // frame is taken again). Unless nothing but a canvas changed since the
        // page's text was last read (a live chart, a 3D scene): its DOM text
        // then stands, and only the canvas's own text and the page's DOM
        // counter are read again, instead of two walks of the DOM.
        let read_canvas = || async { self.page.app_eval(CANVAS_TEXT).await.unwrap_or_else(|_| json!([-1, []])) };
        let canvas_before = read_canvas().await;
        let dom_before = canvas_before[0].as_i64().unwrap_or(-1);
        let cached = {
            let s = self.state.lock().unwrap();
            // Not just after input either: a hover or focus can show text with no DOM change.
            s.text_cache.clone().filter(|c| dom_before >= 0 && c.dom == dom_before && c.generation == generation && now().saturating_sub(s.input_at) > TEXT_AFTER_INPUT_MS)
        };
        let before = match &cached {
            Some(c) => Some(join_lines(&c.dom_lines, &canvas_before[1])),
            None => Some(self.page.app_eval(EXTRACT_TEXT).await?),
        };
        // Playwright's scale:"css" divides CDP's clip scale by the page's
        // device scale, including a 2x image view switched back to cells.
        let started = now();
        let png = self.shoot(cols,rows,cell_h,1.0).await?;
        let shot = now() - started;
        let after_shot = now();
        let mut before = before;
        let reused = match &cached {
            Some(c) => {
                let now_read = read_canvas().await;
                if now_read[0].as_i64() == Some(dom_before) { Some((join_lines(&c.dom_lines, &now_read[1]), c.photos.clone(), dom_before)) }
                // The DOM changed meanwhile: what was read before can't vouch for it.
                else { before = None; None }
            }
            None => None,
        };
        let (mut texts, mut photos, dom_after) = match reused {
            Some(found) => found,
            None => {
                let after = self.page.app_eval(&format!("[{EXTRACT_TEXT}, window.__cliPhotoRects ? window.__cliPhotoRects() : [], window.__cliDom ? window.__cliDom() : -1]")).await?;
                (after[0].clone(), after[1].clone(), after[2].as_i64().unwrap_or(-1))
            }
        };
        {
            let mut s = self.state.lock().unwrap();
            if !self.alive.load(Ordering::SeqCst) || s.image || generation != s.generation || cols != s.cols { s.again = true; return Ok(false); }
            if before.as_ref() != Some(&texts) && s.dropped < 3 { s.dropped += 1; s.again = true; return Ok(false); }
            s.dropped = 0;
            s.text_cache = (dom_after >= 0).then(|| TextCache {
                dom: dom_after, generation,
                dom_lines: Value::Array(texts.as_array().into_iter().flatten().filter(|l| l["source"] != "canvas").cloned().collect()),
                photos: photos.clone(),
            });
        }
        for line in texts.as_array_mut().into_iter().flatten() {
            for k in ["cy","top","bottom"] { if let Some(n) = line[k].as_f64() { line[k] = json!(n-top); } }
        }
        for p in photos.as_array_mut().into_iter().flatten() { if let Some(n) = p["y"].as_f64() { p["y"] = json!(n-top); } }
        let hash = Sha256::new().chain_update(&png).chain_update(texts.to_string()).chain_update(top.to_string()).finalize().to_vec();
        let mut s = self.state.lock().unwrap();
        if !self.alive.load(Ordering::SeqCst) || s.image || s.generation != generation { return Ok(false); }
        if hash == s.hash && rows == s.rows { return Ok(false); }
        if s.memory_top != top { s.cell_memory = Default::default(); s.memory_top = top; }
        // Cells are whole pixels tall (only pictures use half ones).
        let options = json!({"cols":cols,"rows":rows,"cellWidth":8,"cellHeight":cell_h.round() as u64,
            "pageBackground":s.background,"photos":photos,"sextants":terminal::sextants(),"truecolor":terminal::truecolor(),
            "lines":terminal::truecolor() || std::env::var_os("MCP_APPS_CLI_LINES").is_some()});
        if let Ok(dir) = std::env::var("MCP_APPS_CLI_DUMP") {
            let name = if std::env::var_os("MCP_APPS_CLI_DUMP_ALL").is_some() {format!("{}-{:04}",self.id,s.version+1)} else {self.id.clone()};
            let _ = std::fs::write(PathBuf::from(&dir).join(format!("{name}.png")),&png);
            let _ = std::fs::write(PathBuf::from(dir).join(format!("{name}.json")),json!({"texts":texts,"photos":photos,"cols":cols,"rows":rows,"cellHeight":cell_h,"background":s.background}).to_string());
        }
        let frame = compose(&png, &texts, &options, &mut s, &helper_session(&self.helper));
        s.hash = hash; s.rows = rows; s.version += 1;
        // The renderer seam intentionally emits no cells frame, but still
        // receives coherent screenshots, texts, photos and persistent state.
        if let Some(mut frame) = frame {
            if terminal::truecolor() {
                frame["styled"] = frame["lines"].take();
                if let Some(object) = frame.as_object_mut() { object.remove("lines"); object.remove("cells"); }
            }
            let total = (height/cell_h).ceil() as u32;
            if total > rows { frame["scroll"] = json!({"top":(top/cell_h).round() as u32,"rows":rows,"total":total}); }
            emit(&json!({"type":"frame","viewId":self.id,"gen":self.open_gen,"v":s.version,"frame":frame}));
            drop(s);
            self.time(shot, now() - after_shot);
            return Ok(true);
        }
        Ok(true)
    }

    fn send_image(&self, all: bool) -> Result<bool> {
        let helper = self.helper.upgrade().ok_or_else(|| anyhow!("the view closed"))?;
        let mut s = self.state.lock().unwrap();
        if !self.alive.load(Ordering::SeqCst) { return Ok(false); }
        let Some(image) = s.last_image.clone() else { return Ok(false) };
        s.stamps += 1;
        let mut placed = image.placed;
        if terminal::image_files() && s.files {
            crate::tmp::own_private_dir()?;
            store::private_folder(&helper.views.image_root)?;
            let file = helper.views.image_root.join(format!("{}-{}-tty-graphics-protocol.png",self.file_stem,s.stamps%3));
            // Written whole under another name, then renamed over the file:
            // a terminal reading it then gets the old picture or the new
            // one, never half of the new one.
            let temporary = helper.views.image_root.join(format!(".{}-{}.part",self.file_stem,crate::tmp::random_hex(6)?));
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let written = options.open(&temporary).and_then(|mut f| f.write_all(&image.png)).and_then(|()| std::fs::rename(&temporary, &file));
            if written.is_err() { let _ = std::fs::remove_file(&temporary); }
            written?;
            placed["file"] = json!(file); placed["generation"] = json!(s.stamps);
        } else {
            if terminal::strips_on() {
                drop(s);
                self.queue_strips(all);
                return Ok(true);
            }
            placed["png"] = json!(B64.encode(seams::stamp_png(&image.png,s.stamps)));
        }
        emit(&json!({"type":"frame","viewId":self.id,"gen":self.open_gen,"v":s.version,"image":placed}));
        Ok(true)
    }

    /// Sends the latest picture as strips (iTerm2): one job per view at a
    /// time, in order; a picture that comes while one is encoded waits, and
    /// only the latest waiting one is encoded (its bands are compared with
    /// the last ones sent, so nothing is missed). Encoding runs off the
    /// async threads, as the Node helper's worker did.
    fn queue_strips(&self, all: bool) {
        {
            let mut s = self.state.lock().unwrap();
            s.strip_all |= all;
            if s.strip_busy { s.strip_again = true; return; }
            s.strip_busy = true;
        }
        let Some(view) = self.me.upgrade() else { return };
        tokio::spawn(async move {
            loop {
                let job = {
                    let mut s = view.state.lock().unwrap();
                    s.strip_again = false;
                    match (s.last_image.clone(), s.strip_state.take()) {
                        (Some(image), Some(state)) if view.alive.load(Ordering::SeqCst) => {
                            let all = std::mem::take(&mut s.strip_all);
                            Some((image, state, all, s.stamps, s.version))
                        }
                        (_, state) => { s.strip_state = state.or_else(|| Some(Default::default())); None }
                    }
                };
                let Some((image, mut state, all, stamp, version)) = job else { break };
                let rows = image.placed["rows"].as_u64().unwrap_or(0) as usize;
                let top = image.placed["scroll"]["top"].as_i64().unwrap_or(0);
                let png = image.png;
                let (state, result) = tokio::task::spawn_blocking(move || {
                    let job = mcp_apps_pictures::StripJob { png: &png, rows, top, all, stamp, version };
                    let result = mcp_apps_pictures::encode_strips(&mut state, job);
                    (state, result)
                }).await.unwrap_or_else(|_| (Default::default(), Err(mcp_apps_pictures::Error::InvalidInput("the encoder stopped"))));
                let again = {
                    let mut s = view.state.lock().unwrap();
                    s.strip_state = Some(state);
                    match &result {
                        Ok(r) if view.alive.load(Ordering::SeqCst) && s.image && terminal::strips_on() && !(terminal::image_files() && s.files) => {
                            // The bands the mod would hold, the unchanged ones with the new.
                            let mut chars = s.strip_chars.clone();
                            chars.resize(r.strip_count, 0);
                            for strip in &r.strips { if let Some(c) = chars.get_mut(strip.i) { *c = strip.png.len(); } }
                            let total: usize = chars.iter().sum();
                            if total > MAX_STRIP_CHARS && image.scale <= MIN_SCALE {
                                // Too big even at the smallest scale: not sent (Claude Code
                                // would refuse it, and the rows drawn with it); the last stays.
                                s.strip_state = Some(Default::default());
                                log(format!("strips {}: {total} characters even at {}x, not sent", view.id, image.scale));
                            } else if total > MAX_STRIP_CHARS {
                                // More than Claude Code draws: not sent, and taken
                                // again smaller now, every band of it.
                                s.max_scale = (image.scale / 2.0).max(MIN_SCALE);
                                s.strip_state = Some(Default::default());
                                let at = now();
                                s.capped_at = at;
                                s.capture_at.push(at);
                                view.timers.notify_one();
                                log(format!("strips {}: {total} characters at {}x, taken again at {}x", view.id, image.scale, s.max_scale));
                            } else {
                                s.strip_chars = chars;
                                // Taken smaller since: back to 2x once a 2x picture would
                                // fit, as this one's size says (4x the pixels at 2x from 1x,
                                // and no more than 4x the characters), not sooner than 10 s on.
                                if s.max_scale < 2.0 && image.scale >= s.max_scale {
                                    let grown = total as f64 * (2.0 / image.scale).powi(2);
                                    if grown < MAX_STRIP_CHARS as f64 * 0.8 && now().saturating_sub(s.capped_at) > 10_000 {
                                        s.max_scale = 2.0;
                                        let at = now() + 300;
                                        s.capture_at.push(at);
                                        view.timers.notify_one();
                                    }
                                }
                                let mut placed = image.placed.clone();
                                placed["strips"] = json!(r.strips);
                                placed["stripCount"] = json!(r.strip_count);
                                emit(&json!({"type":"frame","viewId":view.id,"gen":view.open_gen,"v":version,"image":placed}));
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log(format!("strips {}: {error}", view.id));
                            // Its state may be partial: everything again, from scratch.
                            s.strip_state = Some(Default::default());
                        }
                    }
                    s.strip_again
                };
                if !again { break; }
            }
            view.state.lock().unwrap().strip_busy = false;
        });
    }

    /// What the view shows, as text: its page's title (any view, for its
    /// header) and, for a picture, its alt from the accessibility tree.
    async fn describe(&self) {
        let image = {
            let s = self.state.lock().unwrap();
            if !self.alive.load(Ordering::SeqCst) || s.offscreen || s.paused || self.page.app_context().is_none() { return; }
            s.image
        };
        let title = tokio::time::timeout(Duration::from_millis(1000), self.page.app_eval("document.title")).await
            .ok().and_then(Result::ok).and_then(|v| v.as_str().map(alt::plain_text)).unwrap_or_default();
        let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
        let text = if image {
            match tokio::time::timeout(Duration::from_millis(1000),self.page.ax_tree()).await {
                Ok(Ok(tree)) => alt::from_tree(&tree),
                _ => String::new(),
            }
        } else { String::new() };
        let mut s = self.state.lock().unwrap();
        if !self.alive.load(Ordering::SeqCst) { return; }
        let mut message = json!({"type":"describe","viewId":self.id,"gen":self.open_gen});
        if !text.is_empty() && text != s.alt { s.alt = text.clone(); message["text"] = json!(text); }
        if title != s.title { s.title = title.clone(); message["title"] = json!(title); }
        if message.as_object().is_some_and(|m| m.len() > 3) { emit(&message); }
    }
}

async fn timers(view: Arc<View>) {
    loop {
        if !view.alive.load(Ordering::SeqCst) { return; }
        let (poll,capture,describe,save,release,next) = {
            let mut s = view.state.lock().unwrap();
            let time = now();
            let poll = time >= s.poll_at;
            if poll { s.poll_at = time+POLL_MS; }
            let capture = s.capture_at.iter().any(|t| *t <= time) || s.pace_at.is_some_and(|t| t <= time);
            s.capture_at.retain(|t| *t > time);
            if s.pace_at.is_some_and(|t| t <= time) { s.pace_at = None; }
            let describe = s.describe_at.is_some_and(|t| t <= time);
            if describe { s.describe_at = None; }
            let save = time >= s.store_at || s.store_soon.is_some_and(|t| t <= time);
            if save { s.store_at = time+store::STORE_SAVE_MS; s.store_soon = None; }
            let release: Vec<_> = s.held.iter().filter(|(_,h)| h.until <= time).map(|(key,_)|key.clone()).collect();
            let next = [Some(s.poll_at),s.capture_at.iter().copied().min(),s.pace_at,s.describe_at,Some(s.store_at),s.store_soon,s.held.values().map(|h|h.until).min()]
                .into_iter().flatten().min().unwrap_or(time+400).saturating_sub(time).max(1);
            (poll,capture,describe,save,release,next)
        };
        if poll { let v = view.clone(); tokio::spawn(async move { v.poll().await; }); }
        if capture { let v = view.clone(); tokio::spawn(async move { v.capture().await; }); }
        if describe { let v = view.clone(); tokio::spawn(async move { v.describe().await; }); }
        if save { let v = view.clone(); tokio::spawn(async move { v.save_store(false).await; }); }
        for key in release { view.release_key(&key).await; }
        tokio::select! { _ = tokio::time::sleep(Duration::from_millis(next)) => {}, _ = view.timers.notified() => {} }
    }
}

async fn events(view: Weak<View>, mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(event) = rx.recv().await {
        let Some(view) = view.upgrade() else { return };
        match event {
            Event::Binding { session,context,call,allowed } => {
                let kind = string(&call,"kind");
                if !allowed || matches!(kind,"size"|"initialized"|"copy"|"log"|"ui/update-model-context") {
                    // These notifications retain CDP arrival order. Spawning
                    // them all could let an old size or report overwrite a
                    // newer one on another Tokio worker. The answer itself
                    // may wait on a paused page, so it is sent independently.
                    let answer = if !allowed {Err(anyhow!("not available to the view"))}
                        else {view.host_call(kind,call["payload"].clone()).await};
                    tokio::spawn(async move { view.page.answer(&session,context,&call,answer).await; });
                } else {
                    tokio::spawn(async move {
                        let answer = view.host_call(string(&call,"kind"),call["payload"].clone()).await;
                        view.page.answer(&session,context,&call,answer).await;
                    });
                }
            }
            Event::Changed { store } => view.changed(store),
            Event::Painted => view.painted(),
            Event::Closed(reason) => { view.drop_view(reason).await; return; }
        }
    }
}

pub async fn open(helper: &Arc<Helper>, options: &Value) -> Result<Value> {
    let (id,open_gen,server) = (string(options,"viewId"),gen_of(options),string(options,"server"));
    let guard = helper.views.opening.lock().await.entry(id.into()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone();
    let opening = guard.lock().await;
    // A close kept from an earlier open of this id is that one's, not this one's.
    helper.views.closed_early.lock().await.remove(id);
    if let Some(page) = helper.views.get(id).await {
        match page_held(Some(&page.open_gen),open_gen) {
            PageHeld::Same => return Ok(json!({"ok":true,"existing":true})),
            _ => { let _ = page.close(false).await; }
        }
    }
    helper.views.under_way.lock().await.insert(id.into(),open_gen.into());
    // A no on its server while it opens (/revoke) closes it: its UI resource
    // read on an earlier yes is shown to no one (model/AppsViews.tla, cut).
    let revoked_before = helper.mcp.revocation(server);
    helper.chrome.views.fetch_add(1,Ordering::SeqCst); // openings also keep Chrome alive
    helper.chrome.note_views().await;
    let result = open_now(helper,options).await;
    helper.chrome.views.fetch_sub(1,Ordering::SeqCst);
    helper.chrome.note_views().await;
    // Closed while it opened: closed now, and not reported as open.
    let closed = helper.views.closed_early.lock().await.remove(id);
    helper.views.under_way.lock().await.remove(id);
    let cut = helper.mcp.revocation(server) > revoked_before;
    if closed || cut {
        if let Some(view) = helper.views.get(id).await { let _ = view.close(false).await; }
    }
    // Done with the id's lock: dropped from the map unless another open waits on it.
    drop(opening);
    {
        let mut map = helper.views.opening.lock().await;
        if Arc::strong_count(&guard) <= 2 { map.remove(id); }
    }
    if closed { return Ok(json!({"ok":false,"error":"closed while it opened"})); }
    if cut && result.as_ref().is_ok_and(|r| r["ok"] == true) { return Ok(json!({"ok":false,"error":format!("Claude Code stopped using {server} while the view opened")})); }
    result
}

async fn open_now(helper: &Arc<Helper>, options: &Value) -> Result<Value> {
    let (id,server,tool) = (string(options,"viewId"),string(options,"server"),string(options,"toolName"));
    let cols = clamp(num(options,"cols",100.0),20,240);
    let max_rows = clamp(num(options,"maxRows",30.0),4,80);
    let image = options["mode"] == "image";
    let cell_h = terminal::row_height(image);
    let scheme = policy::theme_name(string(options,"theme"));
    let theme = policy::theme(scheme);
    let file = helper.views.store_root.as_ref().map(|root|root.join(store::file_name(server,id)));
    // Start Chrome while reading the resource, as Node does. The context
    // needs the resource's domain/CSP; it is made as soon as both are known.
    let (browser,read) = tokio::join!(helper.chrome.browser(),async {
        let discovered = helper.mcp.discover(server,false).await?;
        let entry = &discovered["tools"][tool];
        if entry.is_null() { return Ok((discovered,(Value::Null,None))); }
        let read = Views::resource(helper,server,string(entry,"resourceUri")).await?;
        Ok::<_,anyhow::Error>((discovered,read))
    });
    let (discovered,(read,html)) = read?;
    if discovered["tools"][tool].is_null() {
        return Ok(json!({"ok":false,"error":format!("{server}/{tool} has no UI resource")}));
    }
    let browser = browser?;
    let content = &read["contents"][0];
    let Some(html) = html else { return Ok(json!({"ok":false,"error":format!("resource {} has no content",string(&discovered["tools"][tool],"resourceUri"))})); };
    if let Some(mime) = content["mimeType"].as_str().filter(|m|!m.is_empty()) {
        let valid = mime.to_ascii_lowercase().strip_prefix("text/html;").is_some_and(|m|m.trim_start().starts_with("profile=mcp-app"));
        if !valid { return Ok(json!({"ok":false,"error":format!("resource {} is {mime}, not text/html;profile=mcp-app",string(&discovered["tools"][tool],"resourceUri"))})); }
    }
    let meta = &content["_meta"]["ui"];
    let url = helper.mcp.server_url(server);
    let csp = policy::allowed_csp(&meta["csp"],url.as_deref());
    let mut external = Vec::new();
    for key in policy::CSP_KEYS { for d in csp[key].as_array().into_iter().flatten() { if !external.contains(d) { external.push(d.clone()); } } }
    let origins = policy::origins(url.as_deref(),meta["domain"].as_str());
    let clipboard = !meta["permissions"]["clipboardWrite"].is_null() && meta["permissions"]["clipboardWrite"] != false;
    let host = helper.views.host_page(string(&theme,"background"),scheme);
    log(format!("view {id}: CSP {}",policy::build_csp(&csp)));
    let local_network = helper.mcp.local_network(server);
    let saved = file.as_ref().and_then(|f|store::read(f));
    let started = now();
    // The tab kept ready (see keep_spare), when this view fits it: one whose
    // storage comes back first, or that may write the clipboard, makes its own.
    let key = spare_key(scheme, string(&theme,"background"), image, local_network, &origins);
    let mut spare = if saved.is_none() && !clipboard { helper.views.take_spare(&key, &browser).await } else { None };
    if let Some((page,rx)) = spare.as_mut() {
        // What the tab said before this view had it (its host page's paints)
        // is none of this view's. One that closed meanwhile (its renderer
        // crashed), or that can't take the view's size, is let go: the view
        // makes its own tab, as it would with none kept.
        let mut gone = false;
        while let Ok(event) = rx.try_recv() { if matches!(event, Event::Closed(_)) { gone = true; } }
        let sized = !gone && page.metrics(f64::from(cols)*8.0,f64::from(max_rows)*cell_h,if image {2.0} else {1.0}).await.is_ok();
        if !sized { page.close().await; spare = None; }
    }
    let reused = spare.is_some();
    let (page,rx) = match spare {
        Some((page,rx)) => { page.set_view(html, policy::build_csp(&csp)); (page,rx) }
        None => Page::new(browser,origins,html,host,policy::build_csp(&csp),image,clipboard,f64::from(cols)*8.0,f64::from(max_rows)*cell_h,scheme,local_network).await?,
    };
    if let Some(saved) = saved {
        if let Err(e) = page.restore(&saved).await { page.close().await; return Err(e); }
    }
    let (input_tx,mut input_rx) = mpsc::unbounded_channel();
    let view = Arc::new_cyclic(|me| View {
        me:me.clone(),
        id:id.into(),open_gen:gen_of(options).into(),server:server.into(),helper:Arc::downgrade(helper),page,
        structured_from_text:(options["structuredFromText"] == true).then(|| discovered["definitions"][tool]["outputSchema"].clone()).filter(Value::is_object),
        turn:AsyncMutex::new(()),pointer_gate:Arc::new(AsyncMutex::new(())),inputs:AsyncMutex::new(()),shown_turn:AsyncMutex::new(()),store_saving:AsyncMutex::new(()),
        alive:AtomicBool::new(true),timers:Notify::new(),store_file:file,file_stem:policy::image_file_stem(id),input_tx,
        state:Mutex::new(State {
            image,cols,max_rows,cell_h,dpr:if image {2.0} else {1.0},display:"inline".into(),height:0.0,scale:1.0,scroll:0.0,generation:0,
            background:u32::from_str_radix(string(&theme,"background").trim_start_matches('#'),16).unwrap_or(0),
            hash:Vec::new(),rows:0,version:0,stamps:0,files:true,last_image:None,busy:false,again:false,offscreen:false,paused:false,framed_off:false,awake:0,
            input_at:0,activated_at:0,pointer_held:false,mouse:(0.0,0.0),buttons:0,last_press:None,held:HashMap::new(),hover_at:0,hold_for_rest:false,
            rest_until:0,held_since:0,sweep:false,idle_change_at:0,motion:Vec::new(),captured_at:0,capture_started:0,hinted:false,backstop:false,boost_until:0,alive_check_at:now()+LIVENESS_MS,checking:false,misses:0,
            capture_at:Vec::new(),pace_at:None,describe_at:None,poll_at:now()+POLL_MS,store_at:now()+store::STORE_SAVE_MS,store_soon:None,alt:String::new(),title:String::new(),text_cache:None,timings:Vec::new(),dropped:0,
            cell_memory:Default::default(),painter:Default::default(),memory_top:0.0,downloading:false,
            moved:Vec::new(),snapped:None,strip_state:Some(Default::default()),strip_busy:false,strip_again:false,strip_all:false,strip_chars:Vec::new(),max_scale:2.0,capped_at:0,painting:false,painted:false,own_paint_until:0,paints:0,idle_paints:0,
        }),
    });
    helper.views.list.lock().await.push(view.clone());
    helper.chrome.views.fetch_add(1,Ordering::SeqCst);
    tokio::spawn(events(Arc::downgrade(&view),rx));
    let weak = Arc::downgrade(&view);
    tokio::spawn(async move {
        while let Some(event) = input_rx.recv().await {
            let Some(v) = weak.upgrade().filter(|v| v.alive.load(Ordering::SeqCst)) else { return };
            if let Err(e) = v.input_event(&event).await { log(format!("input {}: {e}",v.id)); }
        }
    });
    let result = async {
        if !reused { view.page.navigate(&format!("{}/",view.page.origins.host)).await?; }
        let hosted = now();
        let mut open = json!({
            "src":format!("{}/view/{}",view.page.origins.view,url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()),
            "sandbox":policy::SANDBOX,"toolName":tool,"toolResult":view.tool_result(&options["toolResult"]),
            "width":cols*8,"maxHeight":f64::from(max_rows)*cell_h,"fit":image,"theme":scheme,"styles":theme["styles"],
            "tool":discovered["definitions"][tool],"userAgent":options["userAgent"].as_str().unwrap_or("Claude Code (mcp-apps-cli)"),
            "csp":csp,"clipboard":clipboard,"border":meta["prefersBorder"] == true,
        });
        // Chrome and Node use the same machine locale/time zone. Read Intl
        // here instead of guessing from LANG (often unset in GUI launches).
        let intl = view.page.eval("Intl.DateTimeFormat().resolvedOptions()").await?;
        open["locale"] = intl["locale"].clone(); open["timeZone"] = intl["timeZone"].clone();
        if options["streaming"] == true {
            if !options["partialInput"].is_null() { open["partialInput"] = options["partialInput"].clone(); }
        } else { open["toolInput"] = options.get("toolInput").filter(|v|!v.is_null()).cloned().unwrap_or(json!({})); }
        {
            let s = view.state.lock().unwrap();
            open["width"] = json!(s.cols*8); open["maxHeight"] = json!(f64::from(s.max_rows)*s.cell_h);
        }
        view.page.eval(&format!("window.__openView({open})")).await?;
        for _ in 0..100 {
            if view.page.app_context().is_some() { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if view.page.app_context().is_none() { bail!("the view's frame never loaded"); }
        for _ in 0..600 {
            if view.page.app_eval("document.readyState").await.is_ok_and(|s|s == "complete") { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let loaded = now();
        let (cols,rows,display) = { let s = view.state.lock().unwrap(); (s.cols,s.max_rows,s.display.clone()) };
        view.resize(f64::from(cols),f64::from(rows),&display).await?;
        if std::env::var_os("MCP_APPS_CLI_TIMINGS").is_some() {
            log(format!("timings {id}: open {} ms: tab and host page {} ms ({}), app {} ms, resize {} ms",
                now() - started, hosted - started, if reused {"kept ready"} else {"made now"}, loaded - hosted, now() - loaded));
        }
        tokio::spawn(timers(view.clone()));
        view.describe_soon(ALT_SETTLE_MS);
        view.capture_soon(150);
        Ok::<_,anyhow::Error>(json!({"ok":true,"cols":cols,"maxRows":rows,"mode":if image {"image"} else {"cells"},"domains":external}))
    }.await;
    if result.is_err() { view.abandon().await; }
    // The next view's tab, made while this one settles.
    else { Views::keep_spare(helper, scheme, image, local_network); }
    result
}

pub async fn route(helper: &Arc<Helper>, path: &str, input: Value) -> Result<Value> {
    if path == "/open" { return open(helper,&input).await; }
    if path == "/reply" {
        let id = input["id"].as_u64().unwrap_or(0);
        let failed = !(input["error"].is_null() || input["error"] == false || input["error"] == "");
        let waiting = helper.views.pending.lock().await.remove(&id);
        let Some(waiting) = waiting else {
            // The mod's verdict on a server, for a check (see verdict.rs).
            if crate::verdict::answer(id, if failed { Value::Null } else { input["result"].clone() }) { return Ok(ok()); }
            return Ok(json!({"ok":false,"error":"unknown request"}));
        };
        // An answer meant for another open of the view than the page that
        // asked: what it says is none of this page's.
        let result = if !same_open(&waiting.open_gen,&input) { Err(anyhow!("the answer was for another open of this view")) }
            else if !failed { Ok(input["result"].clone()) }
            else { Err(anyhow!("{}",input["error"].as_str().map(str::to_string).unwrap_or_else(||input["error"].to_string()))) };
        let _ = waiting.sender.send(result);
        return Ok(ok());
    }
    if path == "/locate" { return locate(helper,string(&input,"text")).await; }
    let view = helper.views.get(string(&input,"viewId")).await;
    let Some(view) = view else {
        // A close for a view still opening: kept, and done once it has opened
        // (see open), rather than lost before the page existed.
        if path == "/close" {
            let id = string(&input,"viewId");
            // Only an open under way, and of this close's generation: an old
            // entry is a view already closed, whose next open must not be
            // closed by this.
            let opening = helper.views.under_way.lock().await.get(id).is_some_and(|open_gen| same_open(open_gen,&input));
            if opening {
                let mut early = helper.views.closed_early.lock().await;
                if early.len() < 256 { early.insert(id.to_string()); }
            }
            return Ok(ok());
        }
        return Ok(if path == "/refresh" {json!({"ok":false})} else {no_view()});
    };
    // Anything for another open of the id than this page's is refused: a
    // close of an earlier one closes nothing of this one.
    if !same_open(&view.open_gen,&input) {
        return Ok(if path == "/close" { ok() } else { json!({"ok":false,"error":"another open of this view"}) });
    }
    // Closing forgets the view first (none of its host calls is answered from
    // then on), and only then wakes its page for the teardown: woken first, a
    // paused page held the close while a consent reply went through.
    if path == "/close" { return view.close(input["discard"] == true).await; }
    // PAGELESS_ROUTES: these do not wake a paused renderer. /shown manages
    // its own transition; /reply settles promises without executing JS here.
    let pageless = matches!(path,"/shown"|"/inline-png"|"/refresh");
    let wake = !pageless && {
        let mut s = view.state.lock().unwrap();
        if s.offscreen || s.paused || s.awake > 0 { s.awake += 1; true } else { false }
    };
    if wake { view.settle_shown().await; }
    let result = route_view(&view,path,&input).await;
    if wake {
        { view.state.lock().unwrap().awake -= 1; }
        view.settle_shown().await;
    }
    result
}

async fn route_view(view: &Arc<View>, path: &str, input: &Value) -> Result<Value> {
    match path {
        "/input" => {
            view.set_shown(true).await;
            {
                let mut s = view.state.lock().unwrap(); s.input_at = now();
                if input["event"]["kind"] == "key" || (input["event"]["kind"] == "pointer" && matches!(string(&input["event"],"type"),"down"|"up")) { s.activated_at = s.input_at; }
            }
            view.describe_soon(2000);
            // Input is handled in turn, after what came before it: a pointer
            // event carries when it arrived, so a double click is counted by
            // the time between the person's presses, however long the one
            // before took to handle (input.rs, MULTI_CLICK_MS).
            let mut event = input["event"].clone();
            if event["kind"] == "pointer" {
                if let Some(fields) = event.as_object_mut() { fields.insert("receivedAt".into(), json!(now())); }
            }
            let _ = view.input_tx.send(event);
        }
        "/shown" => view.set_shown(input["shown"].as_bool().unwrap_or(false)).await,
        "/activity" => {
            let (sockets, inflight, quiet) = view.page.network();
            return Ok(json!({"ok":true,"sockets":sockets,"inflight":inflight,"quietMs":quiet}));
        }
        "/resize" => return view.resize(num(input,"cols",20.0),num(input,"maxRows",0.0),string(input,"display")).await,
        "/theme" => return view.set_theme(string(input,"theme")).await,
        "/args" => {
            if !input["arguments"].is_object() { return Ok(json!({"ok":false,"error":"arguments must be an object"})); }
            view.page.eval(&format!("window.__toolArgs({}, {})",input["arguments"],input["partial"] == true)).await?;
            view.capture_soon(60);
        }
        "/result" => {
            let result = view.tool_result(&input["result"]);
            view.page.eval(&format!("window.__toolResult({result})")).await?;
            view.capture_soon(60); view.describe_soon(ALT_SETTLE_MS);
        }
        "/cancel" => {
            view.page.eval(&format!("window.__toolCancelled({})",json!(input["reason"].as_str().unwrap_or("cancelled")))).await?;
            view.capture_soon(60);
        }
        "/inline-png" => { view.state.lock().unwrap().files = false; return Ok(json!({"ok":view.send_image(false)?})); }
        "/refresh" => {
            let image = view.state.lock().unwrap().image;
            return Ok(json!({"ok":image && view.send_image(true)?}));
        }
        "/close" => return view.close(input["discard"] == true).await,
        "/mode" => {
            let (cols,rows) = { let mut s = view.state.lock().unwrap(); s.image = input["mode"] == "image"; (s.cols,s.max_rows) };
            return view.resize(f64::from(cols),f64::from(rows),"").await;
        }
        _ => bail!("not found"),
    }
    Ok(ok())
}

async fn locate(helper: &Arc<Helper>, text: &str) -> Result<Value> {
    if std::env::var("MCP_APPS_CLI_DEBUG").unwrap_or_default().is_empty() { return Ok(json!({"ok":false,"error":"debug only"})); }
    for view in helper.views.list.lock().await.clone().into_iter().rev() {
        if view.state.lock().unwrap().paused { continue; }
        let hit = view.page.app_eval(&format!(r#"((wanted) => {{
            let best = null;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            for (let el=walker.nextNode(); el; el=walker.nextNode()) {{
                const label=el.tagName==='SELECT'?el.selectedOptions[0]?.text:el.tagName==='INPUT'||el.tagName==='TEXTAREA'?el.value:(el.innerText??'').trim();
                if(label!==wanted && el.getAttribute('title')!==wanted && el.getAttribute('aria-label')!==wanted) continue;
                const r=el.getBoundingClientRect(); if(r.width&&r.height) best={{x:r.left+r.width/2,y:r.top+r.height/2}};
            }} return best;
        }})({})"#,json!(text))).await.unwrap_or(Value::Null);
        if !hit.is_null() {
            let s = view.state.lock().unwrap();
            return Ok(json!({"ok":true,"viewId":view.id,"cellX":(num(&hit,"x",0.0)*s.scale/8.0).floor() as i64,
                "cellY":((num(&hit,"y",0.0)*s.scale-s.scroll)/s.cell_h).floor() as i64}));
        }
    }
    Ok(json!({"ok":false,"error":"not found"}))
}


/// The renderer's pair budget, shared by every view of the helper.
fn helper_session(helper: &Weak<Helper>) -> Option<Arc<Helper>> {
    helper.upgrade()
}

/// A cells frame from a screenshot and the page's texts and photos, through
/// the renderer crate (mcp-apps-render), as the frame message carries it.
fn compose(png: &[u8], texts: &Value, options: &Value, s: &mut State, helper: &Option<Arc<Helper>>) -> Option<Value> {
    let decoded = mcp_apps_pictures::decode_png(png).map_err(|e| log(format!("cells: {e}"))).ok()?;
    let mut image = mcp_apps_render::Image { width: decoded.width as usize, height: decoded.height as usize, data: decoded.data };
    let mut texts: Vec<mcp_apps_render::TextLine> = serde_json::from_value(texts.clone()).map_err(|e| log(format!("cells texts: {e}"))).ok()?;
    let mut opts: mcp_apps_render::Options = serde_json::from_value(options.clone()).map_err(|e| log(format!("cells options: {e}"))).ok()?;
    if image.width == 0 || image.height == 0 || opts.cell_height == 0 { return None; }
    // Long edges onto the cell grid first (see snap.rs); the map is kept,
    // with the picture's pixels to the page's, so a click goes back through it.
    s.snapped = None;
    if crate::snap::on() {
        if let Some(snap) = crate::snap::plan(&image, opts.cell_height, &texts, &opts.photos) {
            crate::snap::apply(&snap, &mut image, &mut texts, &mut opts.photos);
            if s.cell_h > 0.0 { s.snapped = Some((snap, opts.cell_height as f64 / s.cell_h)); }
        }
    }
    // Texts that share a visual line onto one row (see lines.rs); where each
    // moved is kept, so a click on it goes where it is on the page.
    s.moved = if std::env::var("MCP_APPS_CLI_GROUP").map_or(true, |v| v != "0") {
        crate::lines::group_moves(&mut image, &mut texts, opts.cell_width as f64, opts.cell_height as f64)
    } else { Vec::new() };
    let helper = helper.as_ref()?;
    let mut session = helper.views.render_session.lock().unwrap();
    let frame = mcp_apps_render::compose_frame(&image, &texts, &opts, Some(&mut s.cell_memory), Some(&mut s.painter), &mut session);
    serde_json::to_value(frame).ok()
}


/// A resource read's HTML (its text, or its base64 blob decoded), taken out
/// so it's held once: the read keeps everything else (mimeType, _meta).
fn split_html(mut read: Value) -> (Value, Option<Arc<str>>) {
    let content = &mut read["contents"][0];
    let html: Option<Arc<str>> = if let Some(text) = content.get("text").and_then(Value::as_str) {
        Some(Arc::from(text))
    } else if let Some(blob) = content.get("blob").and_then(Value::as_str) {
        B64.decode(blob).ok().map(|bytes| Arc::from(String::from_utf8_lossy(&bytes).as_ref()))
    } else {
        None
    };
    if let Some(object) = content.as_object_mut() {
        object.remove("text");
        object.remove("blob");
    }
    (read, html)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each open of a view has its own generation (model/AppsViews.tla,
    // FixGen; before 0.1.3 the helper matched everything by view id alone).

    #[test]
    fn an_open_takes_only_a_page_of_its_own_generation() {
        assert_eq!(page_held(Some("a"), "a"), PageHeld::Same);
        // A page of an earlier open is closed, and this open makes its own.
        assert_eq!(page_held(Some("a"), "b"), PageHeld::Other);
        assert_eq!(page_held(None, "b"), PageHeld::None);
    }

    #[test]
    fn a_request_is_for_its_page_only_if_it_names_that_pages_generation() {
        assert!(same_open("a", &json!({"viewId": "v", "gen": "a"})));
        assert!(!same_open("a", &json!({"viewId": "v", "gen": "b"})));
        // A request that names none is of no generation: refused by a page that has one.
        assert!(!same_open("a", &json!({"viewId": "v"})));
        assert!(!same_open("a", &json!({"viewId": "v", "gen": 7})));
        // A driver that names none anywhere (its opens neither) is answered as before.
        assert!(same_open("", &json!({"viewId": "v"})));
    }
}
