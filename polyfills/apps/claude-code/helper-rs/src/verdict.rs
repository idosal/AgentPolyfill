//! Claude Code's verdict on a server, asked of the mod for each request the
//! helper writes to it (from 0.1.3; model/AppsViews.tla, FixAtSend). The
//! helper says `{"type":"check","id":N,"server":S}` on its stdout; the mod
//! asks `$.mcp.connect(S)` then and answers on /reply with
//! `{"allow":true,"epoch":E}` or `{"allow":false}`. The epoch is how many
//! times the mod has heard no for that server: see `mcp::Clients::revoke`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::out::emit;

/// How long a check waits for the mod's answer: none in time is a no.
const CHECK_TIMEOUT_MS: u64 = 30_000;

static NEXT: AtomicU64 = AtomicU64::new(1);
static WAITING: LazyLock<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = LazyLock::new(Default::default);

/// An id for a request to the mod: one sequence for checks and views' requests alike.
pub fn next_id() -> u64 {
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Asks the mod whether Claude Code uses `server` now: the epoch of its yes,
/// or None (a no, or no answer in time).
pub async fn ask(server: &str) -> Option<u64> {
    let id = next_id();
    let (sender, receiver) = oneshot::channel();
    WAITING.lock().unwrap().insert(id, sender);
    emit(&json!({"type": "check", "id": id, "server": server}));
    let answer = tokio::time::timeout(Duration::from_millis(CHECK_TIMEOUT_MS), receiver).await;
    WAITING.lock().unwrap().remove(&id);
    yes(&answer.ok()?.ok()?)
}

/// The epoch of a yes in the mod's answer (a reply's `result`): none for a no.
/// An answer that names no epoch (an older driver of the helper) is of the
/// first, refused once the server has been revoked.
pub fn yes(answer: &Value) -> Option<u64> {
    (answer["allow"] == true).then(|| answer["epoch"].as_u64().unwrap_or(0))
}

/// The mod's answer to check `id`; false if no check waits for it.
pub fn answer(id: u64, result: Value) -> bool {
    let waiting = WAITING.lock().unwrap().remove(&id);
    waiting.is_some_and(|sender| sender.send(result).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_check_gets_the_epoch_of_a_yes_and_nothing_for_a_no() {
        for (result, expected) in [
            (json!({"allow": true, "epoch": 3}), Some(3)),
            (json!({"allow": true}), Some(0)),
            (json!({"allow": false, "epoch": 3}), None),
            (json!({"allow": "true"}), None),
            (Value::Null, None),
        ] {
            let asked = tokio::spawn(ask("s"));
            // The check is waiting once its id is taken; answer the newest.
            let id = loop {
                let waiting: Vec<u64> = WAITING.lock().unwrap().keys().copied().collect();
                if let Some(id) = waiting.into_iter().max() {
                    break id;
                }
                tokio::task::yield_now().await;
            };
            assert!(answer(id, result.clone()));
            assert_eq!(asked.await.unwrap(), expected, "{result}");
            // Answered once: a second answer finds nothing waiting.
            assert!(!answer(id, json!({"allow": true})));
        }
    }
}
