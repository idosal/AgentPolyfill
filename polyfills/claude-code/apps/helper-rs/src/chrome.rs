//! Chrome, driven over its debugging pipe (`--remote-debugging-pipe`: it
//! reads commands on fd 3 and writes answers and events on fd 4, each a JSON
//! object ended by a NUL). Started as the Node helper starts it (the flags
//! Playwright gives, and ours); closed after a while with no view; and when
//! it stops (it crashed, was killed), the next view starts it again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::out::log;

/// Playwright's own `--disable-features` list (Chrome keeps only the last
/// such flag, so ours repeats it), then ours: the address bar's popup page
/// Chrome preloads for every page (a renderer of its own, never shown), and
/// the local-network checks (a server on localhost serves its own app).
const DISABLED_FEATURES: &[&str] = &[
    "AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "HttpsUpgrades",
    "HttpsFirstBalancedModeAutoEnable", "LensOverlay", "MediaRouter", "PaintHolding",
    "ThirdPartyStoragePartitioning", "AvoidCorsURLLoaderRestartOnRedirect", "TcpPortRandomizationWin",
    "OptimizationHints", "NetworkTimeServiceQuerying", "AimEnabled", "PreconnectToSearch",
    "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion",
    "WebUIOmniboxPopup",
];

/// The switches Playwright starts Chrome with, as the Node helper runs it.
const PLAYWRIGHT_SWITCHES: &[&str] = &[
    "--disable-field-trial-config", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-back-forward-cache", "--disable-breakpad",
    "--disable-component-extensions-with-background-pages", "--disable-component-update",
    "--no-default-browser-check", "--disable-default-apps", "--disable-dev-shm-usage",
    "--disable-edgeupdater", "--disable-extensions",
    "--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies",
    "--allow-pre-commit-input", "--disable-hang-monitor", "--disable-ipc-flooding-protection",
    "--disable-popup-blocking", "--disable-prompt-on-repost", "--disable-renderer-backgrounding",
    "--disable-updater-scheduler", "--force-color-profile=srgb", "--metrics-recording-only",
    "--no-first-run", "--password-store=basic", "--use-mock-keychain", "--no-service-autorun",
    "--disable-search-engine-choice-screen", "--unsafely-disable-devtools-self-xss-warnings",
    "--enable-unsafe-swiftshader", "--edge-skip-compat-layer-relaunch", "--disable-stack-profiler",
    "--disable-infobars", "--disable-sync", "--do-not-de-elevate", "--headless", "--hide-scrollbars",
    "--mute-audio",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

/// The running browser: its process and its debugging pipe.
pub struct Browser {
    process: Mutex<Process>,
    writer: Mutex<tokio::fs::File>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    /// Every event Chrome sends (with its `sessionId`, if any), to each
    /// subscriber in order, none lost (see Events).
    pub events: Events,
    stopped: AtomicBool,
}

impl Browser {
    /// Sends a command and waits for its answer. `session`: a target's
    /// flat session, absent for the browser itself.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if self.stopped.load(Ordering::SeqCst) { bail!("Chrome stopped"); }
            pending.insert(id, tx);
        }
        let mut bytes = serde_json::to_vec(&message)?;
        bytes.push(0);
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = async { writer.write_all(&bytes).await?; writer.flush().await }.await {
                self.pending.lock().await.remove(&id);
                return Err(error).context("writing to Chrome");
            }
        }
        // A command Chrome never answers fails, rather than hold whatever
        // waits on it (a view, a request from the mod) for good.
        match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
            Ok(answer) => answer.map_err(|_| anyhow!("Chrome stopped"))?,
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow!("Chrome didn't answer {method}"))
            }
        }
    }
}

/// The longest any one command may take.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Chrome's events, to every subscriber, each with a queue of its own: a
/// subscriber that falls behind (a busy page) gets every event later, never
/// fewer. (A bounded broadcast dropped events for one that lagged, and a
/// lost Fetch.requestPaused or attachedToTarget left a page waiting for good.)
#[derive(Default)]
pub struct Events {
    subscribers: std::sync::Mutex<Vec<mpsc::UnboundedSender<Value>>>,
}

impl Events {
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }

    pub fn send(&self, event: Value) {
        // Subscribers gone (their page closed) are dropped as they're found.
        self.subscribers.lock().unwrap().retain(|tx| tx.send(event.clone()).is_ok());
    }
}

/// The browser, started on demand.
pub struct Chrome {
    browser: Mutex<Option<Arc<Browser>>>,
    /// Views open in it: it isn't idle while there are any.
    pub views: std::sync::atomic::AtomicUsize,
    idle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Chrome {
    pub fn new() -> Self {
        Self { browser: Mutex::new(None), views: Default::default(), idle: Mutex::new(None) }
    }

    /// The running browser, started if it isn't.
    pub async fn browser(self: &Arc<Self>) -> Result<Arc<Browser>> {
        let mut slot = self.browser.lock().await;
        if let Some(browser) = slot.as_ref() {
            return Ok(browser.clone());
        }
        let browser = launch(self.clone()).await?;
        *slot = Some(browser.clone());
        drop(slot);
        self.note_views().await;
        Ok(browser)
    }

    /// With no view open, Chrome is closed after `MCP_APPS_CLI_CHROME_IDLE_S`
    /// seconds (60; 0 keeps it), and started again by the next view (each
    /// MCP call starts it ahead, see /prewarm, so a view seldom waits for it).
    pub async fn note_views(self: &Arc<Self>) {
        let mut idle = self.idle.lock().await;
        if let Some(timer) = idle.take() {
            timer.abort();
        }
        let wait = std::env::var("MCP_APPS_CLI_CHROME_IDLE_S").ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(60.0);
        if self.views.load(Ordering::Relaxed) > 0 || wait <= 0.0 || self.browser.lock().await.is_none() {
            return;
        }
        let me = self.clone();
        *idle = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
            let idle_browser = {
                let mut slot = me.browser.lock().await;
                if me.views.load(Ordering::SeqCst) == 0 { slot.take() } else { None }
            };
            if let Some(browser) = idle_browser {
                log("no views for a while: Chrome closed");
                // Cancelling a later idle timer must not interrupt a close
                // already in flight (clearTimeout in Node doesn't do that).
                tokio::spawn(async move { Self::close_browser(&browser).await; });
            }
        }));
    }

    /// Closes the browser, politely and then not.
    pub async fn close(&self) {
        let Some(browser) = self.browser.lock().await.take() else { return };
        Self::close_browser(&browser).await;
    }

    async fn close_browser(browser: &Browser) {
        let polite = browser.send("Browser.close", json!({}), None);
        let _ = tokio::time::timeout(Duration::from_secs(2), polite).await;
        browser.process.lock().await.kill().await;
    }

    /// Chrome stopped by itself: forgotten, so the next view starts it again.
    async fn stopped(&self, which: &Arc<Browser>) {
        let mut slot = self.browser.lock().await;
        if slot.as_ref().is_some_and(|b| Arc::ptr_eq(b, which)) {
            *slot = None;
        }
    }

    pub async fn running(&self) -> bool {
        self.browser.lock().await.is_some()
    }

    /// The running browser, if there is one; never starts it.
    pub async fn current(&self) -> Option<Arc<Browser>> {
        self.browser.lock().await.clone()
    }
}

/// The browser to run: `MCP_APPS_CLI_CHROME`, else Google Chrome where it's
/// installed, else another Chromium-based browser that is (Edge comes with
/// Windows; Chromium, Edge or Brave elsewhere).
pub(crate) fn executable() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("MCP_APPS_CLI_CHROME") {
        return Ok(PathBuf::from(path));
    }
    let home = crate::tmp::home().unwrap_or_default();
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"]
            .iter()
            .flat_map(|app| {
                let inside = format!("{app}.app/Contents/MacOS/{app}");
                [PathBuf::from("/Applications").join(&inside), home.join("Applications").join(&inside)]
            })
            .collect()
    } else if cfg!(target_os = "windows") {
        let bases: Vec<PathBuf> =
            ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
        [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]
            .iter()
            .flat_map(|exe| bases.iter().map(move |base| base.join(exe)))
            .collect()
    } else {
        let mut found: Vec<PathBuf> = vec!["/opt/google/chrome/chrome".into()];
        for name in ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"] {
            if let Some(paths) = std::env::var_os("PATH") {
                found.extend(std::env::split_paths(&paths).map(|p| p.join(name)));
            }
        }
        found
    };
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .or_else(|| headless_shell(&home, crate::fetch_browser::dir()))
        .ok_or_else(|| anyhow!("app views need Google Chrome or another Chromium-based browser (Edge, Chromium, Brave), Chrome for Testing's headless shell (as Puppeteer or Playwright fetch it), or MCP_APPS_CLI_CHROME set to one, and none was found"))
}

/// The oldest headless shell used: it doesn't update itself, and an old
/// one would render apps with flaws long fixed in Chrome.
const SHELL_MIN_MAJOR: u32 = 152;

/// Where no Chromium browser is installed: Chrome for Testing's headless
/// shell as Puppeteer or Playwright fetched it, the newest found (at least
/// SHELL_MIN_MAJOR). Same engine and isolation as Chrome (see `shell_args`),
/// about 60 MB lighter a view, and it starts in a third of the time.
fn headless_shell(home: &Path, fetched: Option<PathBuf>) -> Option<PathBuf> {
    let (folder, binary) = if cfg!(target_os = "macos") {
        (if cfg!(target_arch = "aarch64") { "chrome-headless-shell-mac-arm64" } else { "chrome-headless-shell-mac-x64" }, "chrome-headless-shell")
    } else if cfg!(windows) {
        ("chrome-headless-shell-win64", "chrome-headless-shell.exe")
    } else {
        (if cfg!(target_arch = "aarch64") { "chrome-headless-shell-linux-arm64" } else { "chrome-headless-shell-linux64" }, "chrome-headless-shell")
    };
    let playwright = if cfg!(target_os = "macos") {
        home.join("Library/Caches/ms-playwright")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("ms-playwright")
    } else {
        home.join(".cache/ms-playwright")
    };
    let mut found: Vec<PathBuf> = Vec::new();
    let mut look = |root: PathBuf, prefix: &str| {
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            if entry.file_name().to_string_lossy().starts_with(prefix) { found.push(entry.path().join(folder).join(binary)); }
        }
    };
    // One fetched for the person (fetch_browser.rs), then Puppeteer's and Playwright's.
    if let Some(fetched) = fetched { look(fetched, ""); }
    look(home.join(".cache/puppeteer/chrome-headless-shell"), "");
    look(playwright, "chromium_headless_shell-");
    found.into_iter()
        .filter(|p| p.is_file())
        .filter_map(|p| shell_major(&p).map(|major| (major, p)))
        .filter(|(major, _)| *major >= SHELL_MIN_MAJOR)
        .max_by_key(|(major, _)| *major)
        .map(|(major, p)| { log(format!("no Chrome installed: Chrome for Testing's headless shell {major} at {}", p.display())); p })
}

/// A headless shell's major version, from what it says it is.
pub(crate) fn shell_major(path: &Path) -> Option<u32> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace().find_map(|word| word.split('.').next()?.parse::<u32>().ok().filter(|_| word.contains('.')))
}

/// What a headless shell needs to match Chrome: every site in a process of
/// its own (Chrome's default, not the shell's), and on macOS the GPU (else
/// 3D draws in software, at a quarter of the pictures a second).
fn shell_args(exe: &Path) -> Vec<String> {
    let shell = exe.file_name().is_some_and(|n| n.to_string_lossy().starts_with("chrome-headless-shell"));
    if !shell { return Vec::new(); }
    let mut args = vec!["--site-per-process".to_string()];
    if cfg!(target_os = "macos") { args.push("--use-angle=metal".into()); }
    args
}

async fn launch(chrome: Arc<Chrome>) -> Result<Arc<Browser>> {
    crate::tmp::sweep_old();
    // A new context can open while an idle browser is still shutting down.
    // Never share that browser's profile/SingletonLock with its successor.
    let profile = crate::tmp::own_dir().join(format!("profile-{}", crate::tmp::random_hex(8)?));
    crate::store::private_folder(&profile)?;
    let mut args: Vec<String> = PLAYWRIGHT_SWITCHES.iter().map(|s| s.to_string()).collect();
    args.push(format!("--disable-features={}", DISABLED_FEATURES.join(",")));
    // GPU rasterization draws anti-aliased edges a little differently from
    // one screenshot to the next, so an idle page looked changed.
    args.push("--disable-gpu-rasterization".into());
    // WebRTC is taken from every frame (js/no_webrtc.js); should that ever
    // miss one, it has no UDP of its own to reach past the CSP with either.
    args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
    args.extend(std::env::var("MCP_APPS_CLI_CHROME_ARGS").unwrap_or_default().split_whitespace().map(str::to_string));
    if std::env::var("MCP_APPS_CLI_NO_SANDBOX").as_deref() == Ok("1") {
        args.push("--no-sandbox".into());
    }
    args.push(format!("--user-data-dir={}", profile.display()));
    args.push("--no-startup-window".into());

    let exe = executable()?;
    // A shell fetched for the person is kept current (fetch_browser.rs).
    crate::fetch_browser::keep_current(&exe);
    // First, so the person's own flags (MCP_APPS_CLI_CHROME_ARGS) win.
    for arg in shell_args(&exe).into_iter().rev() { args.insert(0, arg); }
    let (process, writer, reader) = spawn(&exe, args, &crate::tmp::own_dir())?;
    let browser = Arc::new(Browser {
        process: Mutex::new(process),
        writer: Mutex::new(tokio::fs::File::from_std(writer)),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        events: Events::default(),
        stopped: AtomicBool::new(false),
    });
    tokio::spawn(read_pipe(chrome, browser.clone(), tokio::fs::File::from_std(reader), profile));
    let version = match tokio::time::timeout(Duration::from_secs(20), browser.send("Browser.getVersion", json!({}), None)).await {
        Ok(Ok(version)) => version,
        result => {
            browser.process.lock().await.kill().await;
            return Err(match result { Ok(Err(e)) => e, _ => anyhow!("Chrome didn't answer") });
        }
    };
    log(format!("Chrome {}", version.get("product").and_then(Value::as_str).unwrap_or("?")));
    Ok(browser)
}

/// Chrome's process: stopped and waited for. (On Windows, `win::ChromeProcess`.)
#[cfg(unix)]
struct Process(tokio::process::Child);

#[cfg(unix)]
impl Process {
    async fn kill(&mut self) {
        let _ = self.0.kill().await;
    }

    async fn exited_within(&mut self, wait: Duration) -> bool {
        tokio::time::timeout(wait, self.0.wait()).await.is_ok()
    }
}

#[cfg(windows)]
use crate::win::ChromeProcess as Process;

/// Starts Chrome on its debugging pipe, its temporary files in `tmp`: the
/// process, the pipe end for our commands, the one for its answers.
#[cfg(windows)]
fn spawn(exe: &Path, args: Vec<String>, tmp: &Path) -> Result<(Process, std::fs::File, std::fs::File)> {
    crate::win::spawn_chrome(exe, args, tmp)
}

#[cfg(unix)]
fn spawn(exe: &Path, mut args: Vec<String>, tmp: &Path) -> Result<(Process, std::fs::File, std::fs::File)> {
    use std::os::fd::AsRawFd;
    args.push("--remote-debugging-pipe".into());
    // Two pipes: Chrome reads our commands on fd 3 and writes on fd 4.
    let (to_chrome_read, to_chrome_write) = pipe()?;
    let (from_chrome_read, from_chrome_write) = pipe()?;
    let (fd3, fd4) = (to_chrome_read.as_raw_fd(), from_chrome_write.as_raw_fd());
    let mut command = tokio::process::Command::new(exe);
    command
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("TMPDIR", tmp)
        .kill_on_drop(true);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd3, 3) < 0 || libc::dup2(fd4, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().context("starting Chrome")?;
    // Chrome outlives a helper ended outright (Claude Code ends it so when it
    // quits; Chrome doesn't stop when its pipe closes): a watcher beside it
    // stops it as soon as the helper is gone.
    if let Some(pid) = child.id() {
        crate::tmp::start_reaper(pid as i32);
    }
    // The child has its ends now; ours of those go, so the pipe closes with it.
    drop(to_chrome_read);
    drop(from_chrome_write);
    Ok((Process(child), std::fs::File::from(to_chrome_write), std::fs::File::from(from_chrome_read)))
}

/// Answers and events from Chrome, until the pipe closes (Chrome stopped).
async fn read_pipe(chrome: Arc<Chrome>, browser: Arc<Browser>, reader: tokio::fs::File, profile: PathBuf) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(0, &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() == Some(&0) {
            buf.pop();
        }
        let Ok(message) = serde_json::from_slice::<Value>(&buf) else { continue };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(tx) = browser.pending.lock().await.remove(&id) {
                let answer = match message.get("error") {
                    Some(error) => Err(anyhow!("{}", error.get("message").and_then(Value::as_str).unwrap_or("CDP error"))),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(answer);
            }
        } else {
            browser.events.send(message);
        }
    }
    // Every command waiting gets its error; the views in it are gone.
    browser.stopped.store(true, Ordering::SeqCst);
    for (_, tx) in browser.pending.lock().await.drain() {
        let _ = tx.send(Err(anyhow!("Chrome stopped")));
    }
    chrome.stopped(&browser).await;
    browser.events.send(json!({ "method": "Helper.disconnected" }));
    {
        let mut process = browser.process.lock().await;
        if !process.exited_within(Duration::from_secs(2)).await {
            process.kill().await;
        }
    }
    let _ = std::fs::remove_dir_all(profile);
    log("Chrome disconnected");
}

/// A pipe whose two ends close on exec (dup2 in the child clears that for
/// the copies Chrome gets), moved above fd 10 so they can't be 3 or 4.
#[cfg(unix)]
fn pipe() -> Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
    use std::os::fd::FromRawFd;
    let mut fds = [0; 2];
    // SAFETY: fds has room for the two descriptors pipe writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        bail!("pipe: {}", std::io::Error::last_os_error());
    }
    let mut moved = [0; 2];
    for (i, fd) in fds.iter().enumerate() {
        // SAFETY: fd is a descriptor we just made.
        moved[i] = unsafe { libc::fcntl(*fd, libc::F_DUPFD_CLOEXEC, 10) };
        unsafe { libc::close(*fd) };
        if moved[i] < 0 {
            bail!("fcntl: {}", std::io::Error::last_os_error());
        }
    }
    // SAFETY: both are descriptors we own from here on.
    Ok(unsafe { (std::os::fd::OwnedFd::from_raw_fd(moved[0]), std::os::fd::OwnedFd::from_raw_fd(moved[1])) })
}

#[cfg(all(test, unix))]
mod shell_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_shell(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("chrome-headless-shell");
        std::fs::write(&path, format!("#!/bin/sh\necho 'Google Chrome for Testing {version}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_newest_headless_shell_is_found_and_an_old_one_is_not() {
        let home = std::env::temp_dir().join(format!("shell-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let folder = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") { "chrome-headless-shell-mac-arm64" } else { "chrome-headless-shell-mac-x64" }
        } else if cfg!(target_arch = "aarch64") { "chrome-headless-shell-linux-arm64" } else { "chrome-headless-shell-linux64" };
        let playwright = if cfg!(target_os = "macos") { home.join("Library/Caches/ms-playwright") } else { home.join(".cache/ms-playwright") };
        assert_eq!(headless_shell(&home, None), None);
        fake_shell(&home.join(".cache/puppeteer/chrome-headless-shell/old-140.0.1.2").join(folder), "140.0.1.2");
        assert_eq!(headless_shell(&home, None), None, "older than SHELL_MIN_MAJOR");
        fake_shell(&home.join(".cache/puppeteer/chrome-headless-shell/mac-153.0.8010.36").join(folder), "153.0.8010.36");
        fake_shell(&playwright.join("chromium_headless_shell-1200").join(folder), "157.0.1.2");
        let found = headless_shell(&home, None).unwrap();
        assert!(found.starts_with(&playwright), "the newest: {}", found.display());
        // One fetched for the person (fetch_browser.rs) counts too, newest first.
        let fetched = home.join("fetched");
        fake_shell(&fetched.join("158.0.8127.36").join(folder), "158.0.8127.36");
        assert!(headless_shell(&home, Some(fetched.clone())).unwrap().starts_with(&fetched));
        assert!(shell_args(&found).contains(&"--site-per-process".to_string()));
        assert!(shell_args(Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
