"""A run through Hermes's shared gateway (what ``hermes``, the TUI and Desktop attach to): a watch,
then an event waking the idle session. Scripted model, fixture server, isolated home.

    $HERMES_PYTHON test/e2e_shared_gateway.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools" / "hermes"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import World, hermes_paths, wait_for  # noqa: E402
from shared_gateway import SharedGateway  # noqa: E402
from e2e_test import ENV, emit, fixture_methods, fixture_server  # noqa: E402


def main() -> int:
    d = Path(tempfile.mkdtemp(prefix="mcp-events-e2e-"))
    cfg, upstream = fixture_server(d)
    w = World({"mcp-events": ROOT / "plugin"}, mcp_servers={"tickets": cfg},
              entries={"mcp-events": {"settings": {"servers": ["tickets"]}, "allow_gateway_injection": True}})
    py, src = hermes_paths()
    gw = None
    try:
        gw = SharedGateway(py, src, w.dir, w._answer, env=ENV)
        print("attached:", gw.attach["url"].split("?")[0], gw.attach.get("state"))
        try:
            gw.request("client.capabilities", {"server_requests": True})
        except Exception as exc:  # noqa: BLE001
            print("client.capabilities:", exc)
        sid = gw.request("session.create", {}, timeout=180)["session_id"]
        w.rules(
            {"when": {"last_role": "user", "contains": "watch new tickets"},
             "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created", "note": "tell me"}}},
            {"when": {"last_role": "user", "contains": "[mcp-events]"}, "reply": {"tool": "get_event", "args": {}, "capture": {"id": r"\b(e\d+)\b"}}},
            {"when": {"last_role": "tool", "contains": "Crash on save"}, "reply": {"text": "A new ticket: Crash on save."}},
        )
        n = len(gw.events)
        gw.request("prompt.submit", {"session_id": sid, "submission_id": str(uuid.uuid4()), "text": "watch new tickets please"}, timeout=180)
        try:
            gw.wait_event(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid, 120, start=n)
        except TimeoutError:
            print("model requests:", len(w.requests()), "answers:", w.answers, "events:", sorted({e.get("type") for e in gw.events}))
            print("dir:", w.dir)
            raise
        print("approvals:", len([1 for m, _ in w.answers if m == "approval"]), '(approval.request, answered "once")')
        print("watch:", (w.tool_texts("Watching") or ["(none)"])[0][:100])
        wait_for(lambda: "events/stream" in fixture_methods(upstream), 30, "the push stream")
        time.sleep(1)
        n = len(gw.events)
        emit(upstream, "ticket.created", {"title": "Crash on save"})
        _, done = gw.wait_event(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid, 90, start=n)
        print("woken turn:", done["payload"]["text"])
        wake = [u for u in w.user_messages() if u.startswith("[mcp-events]")]
        print("wake message:", wake[0].splitlines()[1] if wake else "(none)")
        return 0 if done["payload"]["text"] == "A new ticket: Crash on save." else 1
    finally:
        if gw is not None:
            gw.close()
        w.close()
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
