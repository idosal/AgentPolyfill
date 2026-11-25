"""The Hermes half of mcp-events with a stand-in ctx: what it registers and what it asks Hermes.

    python3 -m unittest discover -s test -p 'test_*.py'
"""

import atexit
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Never the user's own Hermes: if Hermes is importable here, it reads this empty home.
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="mcp-events-unit-")
atexit.register(shutil.rmtree, os.environ["HERMES_HOME"], True)
os.environ["HOME"] = os.environ["HERMES_HOME"]
os.environ.pop("HERMES_PLUGIN_HOST_PROCESS", None)

# How Hermes would answer approvals: by default it asks (approval_stub.py stands in for its modules).
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "tools" / "hermes"))
from approval_stub import hermes_approval  # noqa: E402
_ASKS = hermes_approval()
_ASKS.start()
atexit.register(_ASKS.stop)

PLUGIN = Path(__file__).resolve().parents[1] / "plugin"


def load():
    spec = importlib.util.spec_from_file_location("mcp_events_plugin", PLUGIN / "__init__.py",
                                                  submodule_search_locations=[str(PLUGIN)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mcp_events_plugin"] = mod
    spec.loader.exec_module(mod)
    return mod


class Ctx:
    def __init__(self):
        self.tools, self.hooks, self.sections, self.injected, self.unload = {}, {}, {}, [], []
        self.inject_result = True
        self.settings = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = (toolset, schema, handler)
        return object()

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_system_prompt_section(self, id, content, **kw):
        self.sections[id] = content

    def on_unload(self, cb):
        self.unload.append(cb)

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.injected.append((session_key, content))
        return self.inject_result


class Plugin(unittest.TestCase):
    def setUp(self):
        self.mod = load()
        self.ctx = Ctx()
        self.rt = self.mod.register(self.ctx)

    def test_registers_the_six_tools_and_its_hooks(self):
        self.assertEqual(sorted(self.ctx.tools), sorted(["list_event_types", "watch_event", "unwatch_event", "list_watches", "get_event", "recent_events"]))
        self.assertTrue(all(t[0] == "mcp-events" for t in self.ctx.tools.values()))
        self.assertEqual(sorted(self.ctx.hooks), ["on_session_open", "pre_llm_call", "pre_tool_call"])
        self.assertIn("SEP-3415", self.ctx.sections["mcp-events"])

    def test_a_changed_configuration_starts_the_helper_again(self):
        # Read again at each turn: a server granted, revoked, or now left to Hermes (events: true).
        class Helper:
            closed = False

            def close(self):
                self.closed = True
        h = Helper()
        self.rt.helper, self.rt.started_with = h, ({"t": {"command": "x", "args": []}}, {})
        self.rt.wanted = lambda: ({"t": {"command": "x", "args": []}}, {})
        self.ctx.hooks["pre_llm_call"](user_message="hello", session_id="s1")
        self.assertIs(self.rt.helper, h)
        self.assertFalse(h.closed)
        self.rt.wanted = lambda: ({}, {"t": "Hermes handles this server's events itself (events: true)"})
        self.ctx.hooks["pre_llm_call"](user_message="hello again", session_id="s1")
        self.assertTrue(h.closed)
        self.assertIsNone(self.rt.helper)

    def test_the_grant_is_the_plugins_own_setting(self):
        # plugins.entries.mcp-events.settings.servers, read with ctx.get_config; not Hermes's mcp_allowlist.
        seen = {}
        from unittest.mock import patch
        stub = patch.object(self.mod._servers, "read_servers", lambda plugin, granted, **kw: (seen.setdefault("granted", granted), ({}, {}))[1])
        stub.start()
        self.addCleanup(stub.stop)
        self.ctx.settings["servers"] = ["tickets"]
        self.assertEqual(self.rt.wanted(), ({}, {}))
        self.assertEqual(seen["granted"], ["tickets"])

    def test_starting_and_stopping_a_watch_go_through_hermes_approval(self):
        pre = self.ctx.hooks["pre_tool_call"]
        d = pre(tool_name="watch_event", args={"server": "s", "event": "e.x", "arguments": {"p": 1}, "note": "do it"})
        self.assertEqual(d["action"], "approve")
        self.assertTrue(d["rule_key"].startswith("mcp-events:watch:s:"))
        self.assertIn('event type "e.x" on the MCP server "s"', d["message"])
        self.assertIn('{"p": 1}', d["message"])
        self.assertIn("do it", d["message"])
        self.assertEqual(pre(tool_name="unwatch_event", args={"watch": "w-1"})["action"], "approve")

    def test_no_watch_where_hermes_approves_without_asking(self):
        pre = self.ctx.hooks["pre_tool_call"]
        with hermes_approval(yolo=True):
            d = pre(tool_name="watch_event", args={"server": "s", "event": "e.x"}, session_id="s1")
            self.assertEqual(d["action"], "block")
            self.assertIn("isn't started", d["message"])
            self.assertIn("hermes -z", d["message"])
            self.assertEqual(pre(tool_name="unwatch_event", args={"watch": "w-1"}, session_id="s1")["action"], "approve",
                             "stopping a watch is still put to Hermes")
        self.assertEqual(pre(tool_name="watch_event", args={"server": "s", "event": "e.x"}, session_id="s1")["action"], "approve")

    def test_a_kept_approval_covers_that_exact_watch_only(self):
        pre = self.ctx.hooks["pre_tool_call"]
        base = {"server": "s", "event": "e.x", "arguments": {"project": "public"}, "note": "tell me"}
        key = pre(tool_name="watch_event", args=base)["rule_key"]
        self.assertEqual(key, pre(tool_name="watch_event", args=dict(base))["rule_key"])
        for change in ({"arguments": {"project": "private"}}, {"note": "delete it"}, {"maxAgeMs": 1}, {"event": "e.y"}):
            self.assertNotEqual(key, pre(tool_name="watch_event", args={**base, **change})["rule_key"], change)
        self.assertNotEqual(pre(tool_name="unwatch_event", args={"watch": "w-1"})["rule_key"],
                            pre(tool_name="unwatch_event", args={"watch": "w-2"})["rule_key"])

    def test_a_kept_approval_covers_the_server_as_configured(self):
        from unittest.mock import patch
        pre = self.ctx.hooks["pre_tool_call"]
        watch = {"server": "s", "event": "e.x"}
        with patch.object(self.rt, "entry_of", lambda server: {"url": "https://a.example/mcp"}):
            first = pre(tool_name="watch_event", args=watch, session_id="s1")["rule_key"]
        with patch.object(self.rt, "entry_of", lambda server: {"url": "https://elsewhere.example/mcp"}):
            self.assertNotEqual(first, pre(tool_name="watch_event", args=watch, session_id="s1")["rule_key"],
                                "the same name pointed elsewhere is asked about again")

    def test_only_the_call_asked_about_runs(self):
        # Hermes applies another plugin's change to a call after the question.
        pre = self.ctx.hooks["pre_tool_call"]
        asked = {"server": "s", "event": "e.x", "note": "tell me"}
        self.assertEqual(pre(tool_name="watch_event", args=asked, session_id="s1")["action"], "approve")
        changed = json.loads(self.rt.call("watch_event", {**asked, "note": "delete everything"}, {"session_id": "s1"}))
        self.assertIn("isn't the one Hermes asked", changed.get("error", ""))
        self.rt.ensure = lambda: None  # no helper here: the call gets past the check and stops there
        same = json.loads(self.rt.call("watch_event", dict(asked), {"session_id": "s1"}))
        self.assertNotIn("isn't the one Hermes asked", json.dumps(same))
        again = json.loads(self.rt.call("watch_event", dict(asked), {"session_id": "s1"}))
        self.assertIn("isn't the one Hermes asked", again.get("error", ""), "one question, one call")

    def test_the_question_shows_everything_or_is_not_asked(self):
        pre = self.ctx.hooks["pre_tool_call"]
        long = {"server": "s", "event": "e.x", "arguments": {"pad": "x" * 3000, "include_private": True}}
        self.assertEqual(pre(tool_name="watch_event", args=long)["action"], "block")
        d = pre(tool_name="watch_event", args={"server": "s", "event": "e.x", "note": "ok\u202egnp.exe\u200b\x1b[2J"})
        self.assertEqual(d["action"], "approve")
        for hidden in ("\u202e", "\u200b", "\x1b"):
            self.assertNotIn(hidden, d["message"])
        for name in ("list_event_types", "list_watches", "get_event", "recent_events", "terminal"):
            self.assertIsNone(pre(tool_name=name, args={}))

    def test_events_true_servers_are_left_to_hermes(self):
        self.assertIn("events: true", self.mod.standdown("x", {"events": True}))
        self.assertIn("events: true", self.mod.standdown("x", {"events": "yes"}))
        self.assertIsNone(self.mod.standdown("x", {"events": False}))
        self.assertIsNone(self.mod.standdown("x", {}))

    def test_a_wake_is_an_injected_message_to_that_session(self):
        rt = self.mod.Runtime(self.ctx, None)
        self.assertEqual(rt._on_request("wake", {"session": "k1", "text": "[mcp-events] hi"}), {"ok": True})
        self.assertEqual(self.ctx.injected, [("k1", "[mcp-events] hi")])
        self.ctx.inject_result = False
        r = rt._on_request("wake", {"session": "k1", "text": "x"})
        self.assertFalse(r["ok"])
        self.assertTrue("did not take" in r["why"] or "allow_gateway_injection" in r["why"], r["why"])
        self.assertFalse(rt._on_request("wake", {"session": "", "text": "x"})["ok"])
        with self.assertRaises(ValueError):
            rt._on_request("other", {})

    def test_without_node_the_tools_say_so(self):
        rt = self.mod.Runtime(self.ctx, Path("/nonexistent"))
        orig = self.mod._helper.find_node
        self.mod._helper.find_node = lambda env=None: (None, "Node 20 or newer is needed")
        try:
            out = json.loads(rt.call("list_watches", {}, {"session_id": "k"}))
        finally:
            self.mod._helper.find_node = orig
        self.assertIn("Node 20", out["error"])

    def test_its_own_wakes_are_not_the_person_writing(self):
        rt_calls = []
        self.mod.Runtime.spoke = lambda self, key: rt_calls.append(key)
        pre = self.ctx.hooks["pre_llm_call"]
        pre(user_message="[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)", session_id="k")
        pre(user_message="hello", session_id="k")
        # A delegate_task child's turn: the model wrote its goal, so it isn't the person writing.
        pre(user_message="look into it", session_id="k", parent_session_id="parent")
        import time
        time.sleep(0.2)
        self.assertEqual(rt_calls, ["k"])


if __name__ == "__main__":
    unittest.main()
