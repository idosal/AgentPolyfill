"""The Hermes half of mcp-skills with a stand-in ctx: what it registers and what it asks Hermes.

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
import unittest.mock
from pathlib import Path

# Never the user's own Hermes: if Hermes is importable here, it reads this empty home.
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="mcp-skills-unit-")
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
    spec = importlib.util.spec_from_file_location("mcp_skills_plugin", PLUGIN / "__init__.py",
                                                  submodule_search_locations=[str(PLUGIN)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mcp_skills_plugin"] = mod
    spec.loader.exec_module(mod)
    return mod


class Handle:
    def __init__(self, log, name):
        self.log, self.name = log, name

    def dispose(self):
        self.log.append(("dispose", self.name))


class State:
    """Hermes's ctx.state: profile-scoped JSON values."""

    def __init__(self):
        self.data, self.broken, self.unwritable = {}, False, False

    def get(self, key, default=None):
        if self.broken:
            raise RuntimeError("Cannot parse plugin state state.json")
        return json.loads(json.dumps(self.data.get(key, default)))

    def set(self, key, value):
        if self.unwritable:
            raise OSError("No space left on device")
        if self.broken:
            raise RuntimeError("Cannot parse plugin state state.json")
        self.data[key] = json.loads(json.dumps(value))


class Ctx:
    def __init__(self):
        self.tools, self.hooks, self.sections, self.skills, self.log = {}, {}, {}, {}, []
        self.settings, self.commands, self.state = {}, {}, State()

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = (toolset, schema, handler)
        return object()

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_system_prompt_section(self, id, content, **kw):
        self.sections[id] = content

    def register_skill(self, name, path, description=""):
        self.skills[name] = (str(path), description)
        self.log.append(("register", name))
        return Handle(self.log, name)

    def on_unload(self, cb):
        pass


class FakeHelper:
    closed = False

    def __init__(self, answers):
        self.answers, self.asked = answers, []

    def request(self, method, params, timeout=0):
        self.asked.append((method, params))
        return self.answers[method](params) if callable(self.answers.get(method)) else self.answers.get(method)


class Plugin(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        self.mod = load()
        self.ctx = Ctx()
        orig = self.mod.Runtime.__init__

        def init(rt, ctx, home, _orig=orig, _home=self.home):
            _orig(rt, ctx, _home)
            self.rt = rt
        self.mod.Runtime.__init__ = init
        self.mod.register(self.ctx)

    def stub(self, name):
        d = self.home / "mcp-skills" / "stubs" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text("---\nname: x\n---\n")
        return str(d / "SKILL.md")

    def test_registers_the_four_tools_and_its_hooks(self):
        self.assertEqual(sorted(self.ctx.tools), ["list_skill_directory", "list_skills", "load_skill", "read_skill_file"])
        self.assertEqual(sorted(self.ctx.hooks), ["on_session_open", "pre_llm_call", "pre_tool_call"])
        self.assertIn("SEP-2640", self.ctx.sections["mcp-skills"])

    def test_stubs_registered_and_let_go_and_only_its_own(self):
        a, b = self.stub("docs-a"), self.stub("docs-b")
        outside = self.home / "elsewhere" / "SKILL.md"
        outside.parent.mkdir(parents=True)
        outside.write_text("x")
        self.rt.register_stubs([{"name": "docs-a", "path": a, "server": "docs", "uri": "skill://a/SKILL.md"},
                                {"name": "docs-b", "path": b, "server": "docs", "uri": "skill://b/SKILL.md"},
                                {"name": "evil", "path": str(outside), "server": "docs", "uri": "skill://e/SKILL.md"}])
        self.assertEqual(sorted(self.ctx.skills), ["docs-a", "docs-b"])
        self.rt.register_stubs([{"name": "docs-a", "path": a, "server": "docs", "uri": "skill://a/SKILL.md"}])
        self.assertIn(("dispose", "docs-b"), self.ctx.log)
        self.assertEqual(self.ctx.log.count(("register", "docs-a")), 1)

    def test_load_is_put_to_hermes_with_the_helpers_rule_key(self):
        self.rt.helper = FakeHelper({"prepare_load": {"message": "Load the skill?", "rule_key": "mcp-skills:load:docs:abc:skill://a/SKILL.md@123"}})
        d = self.ctx.hooks["pre_tool_call"](tool_name="load_skill", args={"server": "docs", "uri": "skill://a/SKILL.md"}, session_id="k")
        self.assertEqual(d, {"action": "approve", "message": "Load the skill?", "rule_key": "mcp-skills:load:docs:abc:skill://a/SKILL.md@123"})
        self.rt.helper = FakeHelper({"prepare_load": {"refuse": "no such skill"}})
        d = self.ctx.hooks["pre_tool_call"](tool_name="load_skill", args={"server": "docs", "uri": "skill://z/SKILL.md"}, session_id="k")
        self.assertEqual(d["action"], "block")
        self.assertIn("no such skill", d["message"])

    def test_another_servers_resource_needs_a_yes_every_time(self):
        self.rt.hold("k", "docs")
        pre = self.ctx.hooks["pre_tool_call"]
        self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "x"}, session_id="k"))
        one = pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k", tool_call_id="c1")
        two = pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k", tool_call_id="c2")
        self.assertEqual(one["action"], "approve")
        self.assertIn('"docs"', one["message"])
        self.assertIn("other", one["message"])
        self.assertNotEqual(one["rule_key"], two["rule_key"])
        self.assertIsNone(pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k-none"))

    def test_what_a_session_loaded_outlives_the_helper_and_the_gateway(self):
        self.rt.hold("k", "docs")
        again = self.mod.Runtime(self.ctx, self.home)  # a new gateway, a new helper: read from disk
        self.assertEqual(again.held_servers("k"), ["docs"])
        self.rt.helper = None  # no helper at all: the question is still asked
        d = self.ctx.hooks["pre_tool_call"](tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k")
        self.assertEqual(d["action"], "approve")

    def test_X8_fails_closed_when_what_a_session_loaded_cant_be_read(self):
        self.rt.hold("k", "docs")
        self.ctx.state.broken = True
        pre = self.ctx.hooks["pre_tool_call"]
        for server in ("docs", "other"):
            d = pre(tool_name=f"mcp__{server}__read_resource", args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "approve", server)
            self.assertIn("can't tell", d["message"])
        self.assertEqual(self.rt.held_servers("k"), None)

    def test_without_a_session_key(self):
        pre = self.ctx.hooks["pre_tool_call"]
        self.rt.helper = FakeHelper({"prepare_load": {"message": "Load?", "rule_key": "k"}})
        with unittest.mock.patch.object(self.mod, "_session_key", lambda kwargs: ""):
            d = pre(tool_name="load_skill", args={"server": "docs", "uri": "skill://a/SKILL.md"})
            self.assertEqual(d["action"], "block")
            self.assertIn("which session", d["message"])
            self.assertIsNone(pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}), "nothing loaded anywhere: nothing to ask")
            self.rt.hold("k", "docs")
            self.assertEqual(pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"})["action"], "approve")

    def test_X5_X8_refused_where_hermes_approves_without_asking(self):
        self.rt.hold("k", "docs")
        self.rt.helper = FakeHelper({"prepare_load": {"message": "Load?", "rule_key": "k"}})
        pre = self.ctx.hooks["pre_tool_call"]
        with unittest.mock.patch.object(self.mod, "approvals_bypassed", lambda key: "Hermes approves without asking in this session (YOLO, /yolo or approvals.mode: off)"):
            d = pre(tool_name="load_skill", args={"server": "docs", "uri": "skill://a/SKILL.md"}, session_id="k")
            self.assertEqual(d["action"], "block")
            self.assertIn("X5", d["message"])
            d = pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "block")
            self.assertIn("X8", d["message"])
            self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "res://d"}, session_id="k"), "the skill's own server: no question, nothing refused")
        self.assertEqual(self.rt.helper.asked, [], "nothing prepared while refused")

    def test_a_turned_off_skill_spelled_another_way_stays_off(self):
        listed = "skill://acme/refunds/SKILL.md"
        self.rt.stubs = [{"name": "docs-refunds", "server": "docs", "uri": listed}]
        self.rt.helper = FakeHelper({"prepare_load": {"message": "Load?", "rule_key": "k", "uri": listed}})
        pre = self.ctx.hooks["pre_tool_call"]
        with unittest.mock.patch.object(self.mod, "_disabled_names", lambda: {"mcp-skills:docs-refunds"}):
            d = pre(tool_name="load_skill", args={"server": "docs", "uri": "skill://acme/refunds/./SKILL.md"}, session_id="k")
        self.assertEqual(d["action"], "block")
        self.assertIn("skills.disabled", d["message"])

    def test_after_a_failed_save_every_read_is_asked_about_until_one_works(self):
        self.ctx.state.unwritable = True
        self.rt.hold("k", "docs")
        self.assertIsNone(self.rt.held_servers("other"), "a restart would forget it: can't tell")
        self.assertTrue(self.rt.anything_held())
        self.ctx.state.unwritable = False
        self.rt.hold("k2", "notes")
        self.assertEqual(self.rt.held_servers("other"), [], "saved again: told")
        self.assertEqual(sorted(self.ctx.state.data["held"]), ["k", "k2"], "what the failed save left out is saved too")

    def test_resource_reads_named_as_hermes_names_them(self):
        # Hermes shortens a tool name past 64 characters, and names that sanitize alike share a tool name.
        long_name = "other-server-with-a-name-long-enough-to-clamp"
        self.rt.hold("k", "a.b")
        pre = self.ctx.hooks["pre_tool_call"]
        config = {"mcp_servers": {"a.b": {}, "a_b": {}, long_name: {}, "x" * 60: {}}}
        with unittest.mock.patch.object(self.mod._servers, "raw_config", lambda: config):
            shortened = self.mod.hermes_tool_name(long_name, "read_resource")
            self.assertEqual(len(shortened), 64)
            d = pre(tool_name=shortened, args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "approve", "a read from a long-named server is asked about")
            self.assertIn(long_name, d["message"])
            d = pre(tool_name="mcp__a_b__read_resource", args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "approve", "a.b and a_b can't be told apart: asked")
            self.assertIn("same name", d["message"])
            unknown = "mcp__" + "z" * 50 + "_0123abcd"
            self.assertEqual(len(unknown), 64)
            d = pre(tool_name=unknown, args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "approve", "a shortened name it can't place may be a read: asked")
            other_tool = self.mod.hermes_tool_name("x" * 60, "search")
            self.assertIsNone(pre(tool_name=other_tool, args={}, session_id="k"), "another tool of a server it knows")
            # A server it doesn't know, named as a known one's prefix and more: its shortened read looks
            # like the known server's other tool, but a read passes a uri, so it's asked about.
            lookalike = self.mod.hermes_tool_name(long_name + "__and-more", "read_resource")
            self.assertTrue(lookalike.startswith(f"mcp__{long_name.replace('-', '_')}__"[:55]))
            d = pre(tool_name=lookalike, args={"uri": "res://o"}, session_id="k")
            self.assertEqual(d["action"], "approve", "a look-alike read from a server it doesn't know is asked about")
        self.rt.hold("k2", "docs")
        self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "res://d"}, session_id="k2"))

    def test_telling_that_hermes_approves_without_asking(self):
        # Hermes's own gate predicate (tools/hermes/shared/test_servers.py has the cases).
        self.assertEqual(self.mod.approvals_bypassed("k"), "")
        with hermes_approval(yolo=True):
            self.assertIn("approves without asking", self.mod.approvals_bypassed("k"))

    def test_X13b_the_person_reads_a_skill_first_with_a_command(self):
        show = self.ctx.commands["mcp-skills"]
        self.rt.helper = FakeHelper({"preview": lambda p: {"text": f"The SKILL.md of {p['uri']} from {p['server']}"}})
        self.assertEqual(show("show docs skill://a/SKILL.md"), "The SKILL.md of skill://a/SKILL.md from docs")
        self.assertIn("Usage", show(""))
        self.assertIn("Usage", show("show docs"))
        self.rt.helper = FakeHelper({"preview": {"refuse": "no MCP server named \"x\" serves skills here"}})
        self.assertIn("can't show it", show("show x skill://a/SKILL.md"))

    def test_a_changed_configuration_starts_the_helper_again(self):
        h = FakeHelper({})
        h.close = lambda: setattr(h, "closed", True)
        self.rt.helper, self.rt.started_with = h, ({"docs": {"url": "https://d.example/mcp"}}, {})
        self.rt.wanted = lambda: ({"docs": {"url": "https://d.example/mcp"}}, {})
        self.assertFalse(self.rt.restart_if_changed())
        self.rt.wanted = lambda: ({}, {"docs": "it is not named for this plugin"})
        with unittest.mock.patch.object(self.mod._helper, "spawn", lambda *a, **k: None):
            self.ctx.hooks["pre_llm_call"](session_id="k")
        self.assertTrue(h.closed)
        self.assertIsNone(self.rt.helper)

    def test_each_cross_server_read_has_a_key_no_other_can_match(self):
        self.rt.hold("k", "docs")
        self.rt.hold("k2", "docs")
        pre = self.ctx.hooks["pre_tool_call"]
        a = pre(tool_name="mcp__other__read_resource", args={"uri": "res://o"}, session_id="k", tool_call_id="call_0")
        b = pre(tool_name="mcp__other__read_resource", args={"uri": "res://p"}, session_id="k2", tool_call_id="call_0")
        self.assertNotEqual(a["rule_key"], b["rule_key"])

    def test_a_served_skill_is_not_read_past_load_skill(self):
        a = self.stub("docs-a")
        self.rt.register_stubs([{"name": "docs-a", "path": a, "server": "docs", "uri": "skill://acme/a/SKILL.md"}])
        pre = self.ctx.hooks["pre_tool_call"]
        for uri in ("skill://acme/a/SKILL.md", "skill://acme/a/references/x.md", "skill://other/b/SKILL.md"):
            d = pre(tool_name="mcp__docs__read_resource", args={"uri": uri}, session_id="k")
            self.assertEqual(d["action"], "block", uri)
            self.assertIn("load_skill", d["message"])
        self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "res://docs/plain.txt"}, session_id="k"))

    def test_V4_a_skill_loaded_by_its_uri_alone_is_not_read_past_load_skill_either(self):
        # Not listed, and not a skill:// URI: the session loaded it, so its files go through read_skill_file.
        self.rt.hold("k", "docs", "https://docs.example/skills/unlisted/SKILL.md")
        pre = self.ctx.hooks["pre_tool_call"]
        d = pre(tool_name="mcp__docs__read_resource", args={"uri": "https://docs.example/skills/unlisted/refs/a.md"}, session_id="k")
        self.assertEqual(d["action"], "block")
        self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "https://docs.example/other.txt"}, session_id="k"))
        self.assertIsNone(pre(tool_name="mcp__docs__read_resource", args={"uri": "https://docs.example/skills/unlisted/refs/a.md"}, session_id="k2"),
                          "another session loaded nothing")

    def test_a_skill_turned_off_in_hermes_is_refused(self):
        a = self.stub("docs-a")
        self.rt.register_stubs([{"name": "docs-a", "path": a, "server": "docs", "uri": "skill://a/SKILL.md"}])
        self.mod._disabled_names = lambda: {"mcp-skills:docs-a"}
        d = self.ctx.hooks["pre_tool_call"](tool_name="read_skill_file", args={"server": "docs", "skill": "skill://a/SKILL.md", "path": "x"})
        self.assertEqual(d["action"], "block")
        self.assertIn("skills.disabled", d["message"])


if __name__ == "__main__":
    unittest.main()
