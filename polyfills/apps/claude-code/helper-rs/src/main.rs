//! The mcp-apps-cli helper, in Rust (see PORT.md). It speaks the protocol
//! the Node helper (`mod/helper/helper.mjs`) does: JSON lines on stdout, and
//! HTTP requests carrying a token over a Unix socket (or loopback TCP). It
//! hosts views over Chrome's debugging pipe. Renderer and picture encoding
//! ports meet the host through the explicit seams in seams.rs.

mod chrome;
mod fetch_browser;
mod config;
mod mcp;
mod out;
mod server;
mod sse;
mod terminal;
mod tmp;
mod alt;
mod input;
mod page;
mod policy;
mod seams;
mod store;
mod lines;
mod snap;
mod verdict;
mod views;
#[cfg(windows)]
mod win;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde_json::json;

/// What the helper was started with.
#[derive(Clone, Debug, Default)]
pub struct Args {
    /// `--mcp-config` values: files, or JSON inline.
    pub mcp_config: Vec<String>,
    /// `--cwd`: where `.mcp.json` and relative config files are found.
    pub cwd: Option<PathBuf>,
    /// `--socket`: the socket path, instead of one in the temporary folder.
    pub socket: Option<PathBuf>,
}

fn parse_args() -> Args {
    let mut args = Args::default();
    let words: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < words.len() {
        match words[i].as_str() {
            "--mcp-config" => {
                i += 1;
                while i < words.len() && !words[i].starts_with("--") {
                    args.mcp_config.push(words[i].clone());
                    i += 1;
                }
                continue;
            }
            "--cwd" if i + 1 < words.len() => {
                args.cwd = Some(PathBuf::from(&words[i + 1]));
                i += 1;
            }
            "--socket" if i + 1 < words.len() => {
                args.socket = Some(PathBuf::from(&words[i + 1]));
                i += 1;
            }
            word if word.starts_with("--mcp-config=") => {
                args.mcp_config.push(word["--mcp-config=".len()..].to_string());
            }
            _ => {}
        }
        i += 1;
    }
    args
}

/// Everything the routes share.
pub struct Helper {
    pub args: Args,
    pub cwd: PathBuf,
    pub token: String,
    pub mcp: mcp::Clients,
    pub chrome: Arc<chrome::Chrome>,
    pub views: views::Views,
}

fn main() -> Result<()> {
    // `--reap <helper pid> <chrome pid>`: the watcher started beside Chrome
    // (see tmp::reap); nothing else of the helper runs in it.
    let words: Vec<String> = std::env::args().collect();
    if words.get(1).map(String::as_str) == Some("--reap") {
        let pid = |i: usize| words.get(i).and_then(|w| w.parse::<i32>().ok()).unwrap_or(0);
        tmp::reap(pid(2), pid(3));
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run())
}

async fn run() -> Result<()> {
    let args = parse_args();
    let cwd = args.cwd.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    tmp::sweep_old();
    let helper = Arc::new(Helper {
        mcp: mcp::Clients::new(args.clone(), cwd.clone()),
        chrome: Arc::new(chrome::Chrome::new()),
        views: views::Views::new(),
        token: tmp::random_hex(32)?,
        args,
        cwd,
    });

    let listening = server::listen(helper.clone()).await?;
    let mut ready = json!({
        "type": "ready",
        "token": helper.token,
        "pid": std::process::id(),
        "images": terminal::image_capable(),
        "swapEveryDraw": terminal::swap_every_draw(),
        "truecolor": terminal::truecolor(),
        // The person's settings for the mod, from the environment Claude Code
        // runs in: a hook sees only the session's own variables, the helper all.
        "env": {
            "CLAUDE_CODE_NO_FLICKER": std::env::var("CLAUDE_CODE_NO_FLICKER").ok(),
            "MCP_APPS_CLI_SLEEP_S": std::env::var("MCP_APPS_CLI_SLEEP_S").ok(),
            "TMUX": std::env::var("TMUX").ok(),
        },
    });
    // `socket` (a Unix socket's path) or `url` (loopback TCP).
    ready[listening.0] = json!(listening.1);
    out::emit(&ready);
    if let (Ok(file), "socket") = (std::env::var("MCP_APPS_CLI_SOCKET_FILE"), listening.0) {
        // A test aid (bench/session.py): the socket and its token, for the person only.
        tmp::write_private(&PathBuf::from(file), &format!("{}\n{}\n", listening.1, helper.token));
    }

    // Leave with the claude process that started us, or on a signal.
    let parent = tmp::Parent::current();
    let mut signals = tmp::Signals::new()?;
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
    let mut released = false;
    loop {
        tokio::select! {
            _ = signals.recv() => break,
            _ = tick.tick() => {
                if parent.gone() { break; }
                // Quiet for a while (views paused, out of sight, or still):
                // what busier moments allocated goes back, once.
                let quiet = out::quiet_for() >= std::time::Duration::from_secs(4);
                if quiet && !released { tmp::release_memory(); }
                released = quiet;
            }
        }
    }
    shutdown(&helper).await;
    Ok(())
}

/// Closes Chrome, removes this helper's temporary folder and socket, and exits.
async fn shutdown(helper: &Helper) {
    helper.views.shutdown().await;
    helper.chrome.close().await;
    helper.mcp.close_all().await;
    tmp::remove_own();
    server::remove_socket();
    std::process::exit(0);
}
