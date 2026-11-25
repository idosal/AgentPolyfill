"""mcp-events in a real Hermes (the pinned release, isolated home, scripted model).

The MCP server is the Claude Code form's fixture events server (written by hand from SEP-3415,
sharing no code with the client), over stdio, as Hermes's config.yaml names it. Run with the
pinned Hermes's Python (tools/hermes/setup.sh):

    $HERMES_PYTHON -m unittest discover -s test -p 'e2e_test.py' -v
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
sys.path.insert(0, str(REPO / "tools" / "hermes"))

from harness import World, wait_for  # noqa: E402

FIXTURE = ROOT.parent / "claude-code" / "test" / "fixture-events-server.ts"
NODE = shutil.which("node")


def fixture_server(dirpath: Path, **env) -> tuple[dict, Path]:
    upstream = dirpath / f"upstream-{uuid.uuid4().hex[:6]}.jsonl"
    upstream.write_text("")
    log = upstream.with_suffix(".log")
    cfg = {"command": NODE, "args": ["--no-warnings", str(FIXTURE)],
           "env": {"FIXTURE_UPSTREAM": str(upstream), "FIXTURE_LOG": str(log), "FIXTURE_HEARTBEAT_MS": "1000",
                   "FIXTURE_POLL_MS": "300", **env}}
    return cfg, upstream


def emit(upstream: Path, name: str, data: dict) -> str:
    eid = f"evt_{uuid.uuid4().hex[:8]}"
    with upstream.open("a") as f:
        f.write(json.dumps({"eventId": eid, "name": name, "timestamp": datetime.now(timezone.utc).isoformat(), "data": data}) + "\n")
    return eid


def fixture_methods(upstream: Path) -> list[str]:
    log = upstream.with_suffix(".log")
    if not log.exists():
        return []
    out = []
    for line in log.read_text().splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("dir") == "in" and isinstance(r.get("m"), dict) and r["m"].get("method"):
            out.append(r["m"]["method"])
    return out


ENV = {"MCP_EVENTS_BATCH_MS": "200", "MCP_EVENTS_DEV": "1"}


class EventsInHermes(unittest.TestCase):
    def tmp(self) -> Path:
        import tempfile
        d = Path(tempfile.mkdtemp(prefix="mcp-events-e2e-"))
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def make(self, servers: dict, allow: list[str], injection: bool = True, **kw) -> World:
        entries = {"mcp-events": {"settings": {"servers": allow}, "allow_gateway_injection": injection}}
        w = World({"mcp-events": ROOT / "plugin"}, mcp_servers=servers, entries=entries, **kw)
        self.addCleanup(w.close)
        return w

    def test_watch_by_push_wakes_the_idle_session(self):
        d = self.tmp()
        cfg, upstream = fixture_server(d)
        w = self.make({"tickets": cfg}, ["tickets"])
        w.start(ENV)
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "what can I watch"}, "reply": {"tool": "list_event_types", "args": {}}},
            {"when": {"last_role": "user", "contains": "watch new tickets"},
             "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created", "note": "tell me the title"}}},
            {"when": {"last_role": "user", "contains": "[mcp-events]"}, "reply": {"tool": "get_event", "args": {}, "capture": {"id": r"\b(e\d+)\b"}}},
            {"when": {"last_role": "tool", "contains": "Crash on save"}, "reply": {"text": "A new ticket: Crash on save."}},
        )
        w.turn(sid, "what can I watch?")
        listing = w.tool_results("ticket.created")
        self.assertTrue(listing, w.tool_results())
        self.assertIn("deploy.finished", listing[0])

        w.turn(sid, "watch new tickets please")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 1, w.answers)
        self.assertIn("ticket.created", approvals[0]["description"])
        self.assertTrue(any(k.startswith("plugin_rule:mcp-events:watch:tickets:") for k in approvals[0]["pattern_keys"]), approvals[0])
        watched = w.tool_results("Watching tickets / ticket.created")
        self.assertTrue(watched, w.tool_results())
        self.assertIn("by push", watched[0])

        # The session is idle. An event arrives; the plugin wakes the session, which reads it.
        wait_for(lambda: "events/stream" in fixture_methods(upstream) or "events/subscribe" in fixture_methods(upstream), 20, "the push stream")
        time.sleep(1.0)
        n = len(w.gw.events)
        emit(upstream, "ticket.created", {"title": "Crash on save", "priority": "high"})
        done = w.wait_turn(sid, n, 60)
        self.assertEqual(done["payload"]["text"], "A new ticket: Crash on save.")
        wake = [u for u in w.user_messages() if u.startswith("[mcp-events]")]
        self.assertEqual(len(wake), 1, w.user_messages())
        self.assertIn("not typed by the user", wake[0])
        self.assertNotIn("Crash on save", wake[0])  # ids only: the payload is read with get_event

    def test_through_tool_search_as_hermes_defers_plugin_tools(self):
        # Hermes's default: plugin tools are reached through tool_search / tool_call, not listed.
        d = self.tmp()
        cfg, upstream = fixture_server(d)
        w = self.make({"tickets": cfg}, ["tickets"], tool_search="on")
        w.start(ENV)
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "watch new tickets"},
             "reply": {"tool": "tool_call", "args": {"calls": [{"name": "watch_event", "arguments": {"server": "tickets", "event": "ticket.created"}}]}}},
            {"when": {"last_role": "user", "contains": "[mcp-events]"}, "reply": {"text": "seen."}},
        )
        w.turn(sid, "watch new tickets")
        tools = next(rq["tools"] for rq in w.requests() if rq["tools"])
        self.assertIn("tool_call", tools)
        self.assertNotIn("watch_event", tools, "deferred, as Hermes does by default")
        self.assertEqual(len([1 for m, _ in w.answers if m == "approval"]), 1, "the approval still applies through tool_call")
        self.assertTrue(w.tool_texts("Watching tickets"), w.tool_texts())
        wait_for(lambda: "events/stream" in fixture_methods(upstream), 20, "the push stream")
        time.sleep(1.0)
        n = len(w.gw.events)
        emit(upstream, "ticket.created", {"title": "found through search"})
        w.wait_turn(sid, n, 60)
        self.assertTrue(any(u.startswith("[mcp-events]") for u in w.user_messages()))

    def test_poll_and_a_declined_watch(self):
        d = self.tmp()
        cfg, upstream = fixture_server(d, FIXTURE_TICKET_DELIVERY="poll")
        w = self.make({"tickets": cfg}, ["tickets"])
        decisions = iter(["deny", "once"])
        w.approve = lambda m, p: next(decisions)
        w.start(ENV)
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "watch tickets"},
             "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created"}}, "sticky": True},
            {"when": {"last_role": "user", "contains": "[mcp-events]"}, "reply": {"text": "noted."}},
        )
        w.turn(sid, "watch tickets")
        self.assertFalse(w.tool_results("Watching tickets"), "a declined watch must not start")
        self.assertFalse(any(m.startswith("events/") and m != "events/list" for m in fixture_methods(upstream)))
        w.turn(sid, "watch tickets, I approve")
        self.assertIn("by poll", w.tool_results("Watching tickets")[0])
        wait_for(lambda: "events/poll" in fixture_methods(upstream), 20, "a poll")
        n = len(w.gw.events)
        emit(upstream, "ticket.created", {"title": "polled"})
        w.wait_turn(sid, n, 60)
        self.assertTrue(any(u.startswith("[mcp-events]") for u in w.user_messages()))

    def test_no_watch_where_hermes_approves_without_asking(self):
        d = self.tmp()
        cfg, upstream = fixture_server(d, FIXTURE_TICKET_DELIVERY="poll")
        w = self.make({"tickets": cfg}, ["tickets"], extra_config={"approvals": {"mode": "off"}})
        w.start(ENV)
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "watch tickets"},
                 "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created"}}})
        w.turn(sid, "watch tickets")
        self.assertFalse([1 for m, _ in w.answers if m == "approval"], "Hermes asks nobody with approvals off")
        refused = w.tool_results("isn't started")
        self.assertTrue(refused, w.tool_results())
        self.assertIn("approves without asking", refused[0])
        self.assertFalse(w.tool_results("Watching tickets"))
        self.assertFalse(any(m.startswith("events/") and m != "events/list" for m in fixture_methods(upstream)))

    def test_no_watch_in_hermes_z(self):
        # hermes -z: an unattended turn, where Hermes approves a plugin's question itself (_yolo_active()).
        d = self.tmp()
        cfg, upstream = fixture_server(d, FIXTURE_TICKET_DELIVERY="poll")
        w = self.make({"tickets": cfg}, ["tickets"])
        w.rules({"when": {"last_role": "user", "contains": "watch tickets"},
                 "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created"}}},
                {"when": {"last_role": "tool"}, "reply": {"text": "done."}})
        r = w.oneshot("watch tickets")
        self.assertEqual(r.returncode, 0, (w.dir / "oneshot-stderr.log").read_text()[-2000:])
        refused = w.tool_results("isn't started")
        self.assertTrue(refused, w.tool_results())
        self.assertIn("approves without asking", refused[0])
        self.assertFalse(w.tool_results("Watching tickets"))
        self.assertFalse(any(m.startswith("events/") and m != "events/list" for m in fixture_methods(upstream)))

    def test_stands_down_and_leaves_ungranted_servers_alone(self):
        d = self.tmp()
        native_cfg, native_up = fixture_server(d)
        native_cfg = {**native_cfg, "events": True}
        other_cfg, other_up = fixture_server(d)
        w = self.make({"native": native_cfg, "other": other_cfg}, ["native"])
        w.start(ENV)
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "list"}, "reply": {"tool": "list_event_types", "args": {}}})
        w.turn(sid, "list event types")
        text = w.tool_results("servers")[0]
        self.assertIn("events: true", text)
        self.assertIn("settings.servers", text)
        # The plugin's own client never spoke events/* to either: Hermes owns the first, nobody granted the second.
        helper_log = (w.hermes_home / "mcp-events" / "mcp-events.log").read_text()
        self.assertNotIn("native:", helper_log)
        self.assertNotIn("other:", helper_log)
        self.assertFalse([m for m in fixture_methods(other_up) if m.startswith("events/")])

    def test_a_server_left_to_hermes_later_is_not_watched_twice(self):
        # The configuration is read again at each turn: once the server says `events: true` (Hermes
        # delivers its events itself), the plugin's helper starts again without it, and its poll stops.
        d = self.tmp()
        cfg, upstream = fixture_server(d, FIXTURE_TICKET_DELIVERY="poll")
        w = self.make({"tickets": cfg}, ["tickets"])
        w.start(ENV)
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "watch tickets"}, "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created"}}},
            {"when": {"last_role": "user", "contains": "what can I watch"}, "reply": {"tool": "list_event_types", "args": {}}},
            {"when": {"last_role": "user", "contains": "[mcp-events]"}, "reply": {"text": "noted."}},
        )
        w.turn(sid, "watch tickets")
        self.assertIn("by poll", w.tool_results("Watching tickets")[0])
        wait_for(lambda: "events/poll" in fixture_methods(upstream), 20, "a poll")

        config = json.loads(json.dumps(w.config))
        config["mcp_servers"]["tickets"]["events"] = True
        w.write_config(config)
        w.turn(sid, "what can I watch now?")
        status = w.tool_results("events: true")
        self.assertTrue(status, w.tool_results())
        log = (w.hermes_home / "mcp-events" / "mcp-events.log").read_text()
        self.assertEqual(log.count("for Hermes started"), 2, log)
        polls = fixture_methods(upstream).count("events/poll")
        time.sleep(3)  # the fixture is polled every 300 ms while a watch runs
        self.assertEqual(fixture_methods(upstream).count("events/poll"), polls, "the plugin still polls a server left to Hermes")

    def test_without_injection_events_are_kept_and_the_reason_given(self):
        d = self.tmp()
        cfg, upstream = fixture_server(d, FIXTURE_TICKET_DELIVERY="poll")
        w = self.make({"tickets": cfg}, ["tickets"], injection=False)
        w.start(ENV)
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "watch"}, "reply": {"tool": "watch_event", "args": {"server": "tickets", "event": "ticket.created"}}},
            {"when": {"last_role": "user", "contains": "status"}, "reply": {"tool": "list_watches", "args": {}}},
            {"when": {"last_role": "user", "contains": "recent"}, "reply": {"tool": "recent_events", "args": {}}},
        )
        w.turn(sid, "watch tickets")
        wait_for(lambda: "events/poll" in fixture_methods(upstream), 20, "a poll")
        emit(upstream, "ticket.created", {"title": "kept"})
        log = w.hermes_home / "mcp-events" / "mcp-events.log"
        wait_for(lambda: "allow_gateway_injection" in log.read_text(), 30, "the failed wake")
        w.turn(sid, "status?")
        self.assertIn("allow_gateway_injection", w.tool_results("Waking this session failed")[0])
        w.turn(sid, "recent events")
        self.assertTrue(w.tool_results("[event e"), w.tool_results())
        self.assertFalse(any(u.startswith("[mcp-events]") for u in w.user_messages()))


if __name__ == "__main__":
    unittest.main()
