"""mcp-skills in a real Hermes (the pinned release, isolated home, scripted model).

The MCP servers are the Claude Code form's fixture skills server (written by hand from SEP-2640,
sharing no code with the client), over stdio. Run with the pinned Hermes's Python
(tools/hermes/setup.sh):

    $HERMES_PYTHON test/e2e_test.py -v
"""

from __future__ import annotations

import atexit
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
sys.path.insert(0, str(REPO / "tools" / "hermes"))

from harness import World, wait_for  # noqa: E402

FIXTURE = ROOT.parent / "core" / "test-fixtures" / "fixture-skills-server.ts"
NODE = shutil.which("node")


def load_plugin():
    """The plugin's Python half, imported here (its naming function), not in Hermes."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("mcp_skills_e2e_plugin", ROOT / "plugin" / "__init__.py",
                                                  submodule_search_locations=[str(ROOT / "plugin")])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def skill_md(name: str, body: str = "") -> str:
    return f"---\nname: {name}\ndescription: What {name} does.\n---\n\n# {name}\n\n{body or f'Body of {name}.'}\n"


def skill(path: str, files: dict | None = None, body: str = "") -> dict:
    name = path.split("/")[-1]
    root = f"skill://{path}"
    allf = {"SKILL.md": skill_md(name, body), **(files or {})}
    entry = {"uri": f"{root}/SKILL.md", "frontmatter": {"name": name, "description": f"What {name} does."},
             "resources": [{"uri": f"{root}/{p}", "digest": "sha256:" + hashlib.sha256(t.encode()).hexdigest(), "size": len(t.encode())}
                           for p, t in allf.items()]}
    return {"entry": entry, "files": {f"{root}/{p}": {"text": t} for p, t in allf.items()}}


class Fixture:
    def __init__(self, skills: list[dict], **extra):
        self.dir = Path(tempfile.mkdtemp(prefix="skills-fixture-"))
        atexit.register(shutil.rmtree, self.dir, True)
        self.scenario = self.dir / "scenario.json"
        self.log = self.dir / "requests.jsonl"
        self.write(skills, **extra)

    def write(self, skills: list[dict], **extra) -> None:
        files: dict = {}
        for s in skills:
            files.update(s["files"])
        self.scenario.write_text(json.dumps({"listed": [s["entry"] for s in skills], "files": files, **extra}))

    @property
    def config(self) -> dict:
        return {"command": NODE, "args": ["--no-warnings", str(FIXTURE)],
                "env": {"FIXTURE_SCENARIO": str(self.scenario), "FIXTURE_LOG": str(self.log)}}

    def methods(self) -> list[tuple[str, dict]]:
        if not self.log.exists():
            return []
        out = []
        for line in self.log.read_text().splitlines():
            try:
                m = json.loads(line)
            except ValueError:
                continue
            m = m.get("m", m) if isinstance(m, dict) else {}
            if isinstance(m, dict) and m.get("method"):
                out.append((m["method"], m.get("params") or {}))
        return out

    def reads(self) -> list[str]:
        return [p.get("uri", "") for m, p in self.methods() if m == "resources/read"]


REFUNDS = "skill://acme/refunds/SKILL.md"


class SkillsInHermes(unittest.TestCase):
    def make(self, servers: dict, allow: list[str], **kw) -> World:
        w = World({"mcp-skills": ROOT / "plugin"}, mcp_servers={n: f.config for n, f in servers.items()},
                  entries={"mcp-skills": {"settings": {"servers": allow}}}, **kw)
        self.addCleanup(w.close)
        return w

    def system_prompt(self, w: World, last_user: str) -> str:
        for rq in reversed(w.requests()):
            if not rq["tools"]:  # Hermes's own side requests (a session's title) carry no tools
                continue
            msgs = rq["messages"]
            users = [m for m in msgs if m.get("role") == "user"]
            if users and last_user in str(users[-1].get("content")):
                return next((str(m.get("content")) for m in msgs if m.get("role") == "system"), "")
        return ""

    def stubs_written(self, w: World) -> list:
        idx = w.hermes_home / "mcp-skills" / "stubs" / "index.json"
        return json.loads(idx.read_text()) if idx.exists() else []

    def test_listed_loaded_after_approval_and_files_read(self):
        docs = Fixture([skill("acme/refunds", {"references/POLICY.md": "Refund within 30 days."})])
        w = self.make({"docs": docs}, ["docs"])
        w.start()
        sid = w.session()
        w.turn(sid, "hello")  # the first turn starts the helper (as opening a session does on the shared gateway)
        wait_for(lambda: self.stubs_written(w), 30, "the stubs")
        self.assertEqual([s["name"] for s in self.stubs_written(w)], ["docs-refunds"])
        # Hermes lists a skill registered while it runs from the next session on.
        sid2 = w.session()
        w.turn(sid2, "hello again")
        self.assertIn("mcp-skills:docs-refunds", self.system_prompt(w, "hello again"))
        self.assertFalse(docs.reads(), "nothing of a skill is fetched to list it")

        w.rules(
            {"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}},
            {"when": {"last_role": "tool", "contains": "Body of refunds"},
             "reply": {"tool": "read_skill_file", "args": {"server": "docs", "skill": REFUNDS, "path": "references/POLICY.md"}}},
            {"when": {"last_role": "tool", "contains": "30 days"}, "reply": {"text": "Refunds within 30 days."}},
        )
        done = w.turn(sid2, "how do refunds work?")
        self.assertEqual(done["payload"]["text"], "Refunds within 30 days.")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 1, w.answers)
        self.assertIn('"refunds"', approvals[0]["description"])
        self.assertIn('"docs"', approvals[0]["description"])
        self.assertTrue(any(k.startswith("plugin_rule:mcp-skills:load:docs:") for k in approvals[0]["pattern_keys"]))
        self.assertIn(REFUNDS, docs.reads())

    def test_declined_load_fetches_nothing(self):
        docs = Fixture([skill("acme/refunds")])
        w = self.make({"docs": docs}, ["docs"])
        w.approve = lambda m, p: "deny"
        w.start()
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}})
        w.turn(sid, "refund question")
        self.assertEqual(len([1 for m, _ in w.answers if m == "approval"]), 1)
        self.assertFalse(w.tool_results("Body of refunds"))
        self.assertFalse(docs.reads(), "a declined skill is not fetched")

    def test_always_covers_one_version_only(self):
        docs = Fixture([skill("acme/refunds")])
        w = self.make({"docs": docs}, ["docs"])
        w.approve = lambda m, p: "always"
        w.start()
        load = {"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}}
        w.rules(dict(load))
        w.turn(w.session(), "refund one")
        w.rules(dict(load))
        w.turn(w.session(), "refund two")
        self.assertEqual(len([1 for m, _ in w.answers if m == "approval"]), 1, "an unchanged skill approved always is not asked about again")
        # The server changes the skill: its digest changes, and the user is asked again.
        docs.write([skill("acme/refunds", body="A changed body.")], ttlMs=0)
        import time
        time.sleep(10.5)  # a listing is read again at most every ten seconds
        w.rules(dict(load))
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "list"}, "reply": {"tool": "list_skills", "args": {}}})
        w.turn(sid, "list skills")  # reads the listing again (its freshness hint has run out)
        w.rules(dict(load))
        w.turn(sid, "refund three")
        self.assertEqual(len([1 for m, _ in w.answers if m == "approval"]), 2, w.answers)
        self.assertTrue(w.tool_results("A changed body."))

    def test_cross_server_resource_read_is_asked_every_time(self):
        docs = Fixture([skill("acme/refunds")])
        other = Fixture([], files={"res://other/secret.txt": {"text": "other server data"}})
        w = self.make({"docs": docs, "other": other}, ["docs"])
        decisions = iter(["once", "deny", "once"])
        w.approve = lambda m, p: next(decisions)
        w.start()
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}},
            {"when": {"last_role": "user", "contains": "read other"}, "reply": {"tool": "mcp__other__read_resource", "args": {"uri": "res://other/secret.txt"}}, "sticky": True},
        )
        w.turn(sid, "refund please")
        w.turn(sid, "read other now")
        w.turn(sid, "read other again")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 3, w.answers)
        self.assertIn('"docs"', approvals[1]["description"])
        self.assertIn("other", approvals[1]["description"])
        self.assertNotEqual(approvals[1]["pattern_keys"], approvals[2]["pattern_keys"], "each read has a key of its own")
        self.assertEqual(sum(1 for u in other.reads() if u == "res://other/secret.txt"), 1, "the denied read never reached the server")

    def test_a_long_server_name_is_asked_about_too(self):
        # Hermes shortens a tool name past 64 characters (mcp__<55>_<8 hex>): the read is still put to the user.
        long_name = "other-server-with-a-name-long-enough-to-clamp"
        from tools.mcp_tool_schema import mcp_prefixed_tool_name  # Hermes's own naming
        tool = mcp_prefixed_tool_name(long_name, "read_resource")
        self.assertNotIn("read_resource", tool, "the name is shortened")
        self.assertEqual(tool, load_plugin().hermes_tool_name(long_name, "read_resource"), "the plugin names it as Hermes does")
        docs = Fixture([skill("acme/refunds")])
        other = Fixture([], files={"res://other/secret.txt": {"text": "other server data"}})
        w = self.make({"docs": docs, long_name: other}, ["docs"])
        decisions = iter(["once", "deny"])
        w.approve = lambda m, p: next(decisions)
        w.start()
        sid = w.session()
        w.rules(
            {"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}},
            {"when": {"last_role": "user", "contains": "read other"}, "reply": {"tool": tool, "args": {"uri": "res://other/secret.txt"}}},
        )
        w.turn(sid, "refund please")
        w.turn(sid, "read other now")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 2, w.answers)
        self.assertIn(long_name, approvals[1]["description"])
        self.assertFalse([u for u in other.reads() if u == "res://other/secret.txt"], "the denied read never reached the server")

    def test_X13b_read_first_with_the_command_the_model_never_sees_it(self):
        docs = Fixture([skill("acme/refunds", {"references/POLICY.md": "Refund within 30 days."})])
        w = self.make({"docs": docs}, ["docs"])
        w.approve = lambda m, p: "deny"
        w.start()
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}})
        w.turn(sid, "refund question")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 1, w.answers)
        self.assertIn(f"/mcp-skills show docs {REFUNDS}", approvals[0]["description"])
        # The person reads it with the plugin's command: Hermes shows the answer to them only.
        r = w.gw.request("command.dispatch", {"session_id": sid, "name": "mcp-skills", "arg": f"show docs {REFUNDS}"})
        self.assertEqual(r.get("type"), "plugin", r)
        self.assertIn("Body of refunds", r["output"])
        self.assertIn("checked against its digest", r["output"])
        self.assertEqual(docs.reads(), [REFUNDS], "only the SKILL.md, because the person asked")
        w.rules({"when": {"last_role": "user", "contains": "thanks"}, "reply": {"text": "ok"}})
        w.turn(sid, "thanks")
        seen = json.dumps([rq["messages"] for rq in w.requests()])
        self.assertNotIn("Body of refunds", seen, "the model never sees what the command showed")

    def test_X5_no_load_where_hermes_approves_without_asking(self):
        docs = Fixture([skill("acme/refunds")])
        w = self.make({"docs": docs}, ["docs"], extra_config={"approvals": {"mode": "off"}})
        w.start()
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}})
        w.turn(sid, "refund question")
        self.assertFalse([1 for m, _ in w.answers if m == "approval"], "Hermes asks nobody with approvals off")
        refused = w.tool_texts("X5")
        self.assertTrue(refused, w.tool_texts())
        self.assertIn("approves without asking", refused[0])
        self.assertFalse(docs.reads())

    def test_listed_from_the_first_session_after_a_restart_and_disabled_refused(self):
        docs = Fixture([skill("acme/refunds")])
        w = self.make({"docs": docs}, ["docs"])
        w.start()
        w.turn(w.session(), "hello")
        wait_for(lambda: self.stubs_written(w), 30, "the stubs")
        w.stop()
        w.start()
        sid = w.session()
        w.turn(sid, "first words")
        self.assertIn("mcp-skills:docs-refunds", self.system_prompt(w, "first words"))
        w.stop()
        cfg = dict(w.config)
        cfg["skills"] = {"disabled": ["mcp-skills:docs-refunds"]}
        w.write_config(cfg)
        w.start()
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "refund"}, "reply": {"tool": "load_skill", "args": {"server": "docs", "uri": REFUNDS}}})
        w.turn(sid, "refund please")
        self.assertFalse([1 for m, _ in w.answers if m == "approval"])
        self.assertTrue(w.tool_results("skills.disabled"), w.tool_results())
        self.assertFalse(docs.reads())


if __name__ == "__main__":
    unittest.main()
