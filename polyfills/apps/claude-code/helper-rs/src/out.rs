//! What the helper says: JSON lines on stdout for the mod, and log lines on
//! stderr (Claude Code's debug log).

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

static STDOUT: Mutex<()> = Mutex::new(());
/// When the helper last said anything (milliseconds since the epoch).
static LAST: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// How long since the helper last said anything (a frame, a request).
pub fn quiet_for() -> Duration {
    Duration::from_millis(now_ms().saturating_sub(LAST.load(Ordering::Relaxed)))
}

/// One message to the mod, on a line of its own.
pub fn emit(message: &Value) {
    LAST.store(now_ms(), Ordering::Relaxed);
    let _held = STDOUT.lock();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

/// A line for Claude Code's debug log.
pub fn log(text: impl AsRef<str>) {
    let _ = writeln!(std::io::stderr().lock(), "[mcp-apps-cli] {}", text.as_ref());
}
