"""Fake-ctx unit scenarios, imported by both forms (no Hermes installation needed)."""
import copy
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from approval_stub import hermes_approval  # noqa: E402


class FakeCtx:
    def __init__(self, taken=()):
        self.tools, self.hooks, self.sections, self.unloads = {}, {}, {}, []
        self.taken = taken
    def register_tool(self, **kw):
        if kw["name"] in self.taken:
            return None
        self.tools[kw["name"]] = kw
        return object()
    def register_hook(self, name, fn):
        self.hooks[name] = fn
    def register_system_prompt_section(self, name, text):
        self.sections[name] = text
    def on_unload(self, fn):
        self.unloads.append(fn)


class UnitScenarios:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.cfg = self.home / "config.yaml"
        self.cfg.write_text(json.dumps({"model": {"api_key": "${EXISTING_KEY}"}, "mcp_servers": {"personal": {"url": "https://own.example/mcp"}}}))
        self.saved = []
        config = types.ModuleType("hermes_cli.config")
        config.get_config_path = lambda: self.cfg
        config.require_readable_config_before_write = lambda *_: json.loads(self.cfg.read_text())
        def save(value, merge_existing=False):
            self.saved.append(copy.deepcopy(value))
            if merge_existing:  # as Hermes's _merge_partial_save: the given keys over the file as it is
                live = json.loads(self.cfg.read_text())
                for k, v in value.items():
                    live[k] = {**live.get(k, {}), **v} if isinstance(v, dict) and isinstance(live.get(k), dict) else v
                value = live
            self.cfg.write_text(json.dumps(value))
        config.save_config = save
        self.config_api = config
        cli = types.ModuleType("hermes_cli"); cli.config = config
        state = types.ModuleType("hermes_constants"); state.get_hermes_home = lambda: self.home
        gateway = types.ModuleType("gateway"); session = types.ModuleType("gateway.session_context")
        session.get_session_env = lambda *_: ""
        self.modules = patch.dict(sys.modules, {"hermes_cli": cli, "hermes_cli.config": config, "hermes_constants": state, "gateway": gateway, "gateway.session_context": session})
        self.modules.start(); self.addCleanup(self.modules.stop)
        self.env = patch.dict(os.environ, {"MCP_SERVER_CARDS_DISABLED": "", "ARD_DISCOVERY_DISABLED": "", "HERMES_PLUGIN_HOST_PROCESS": ""})
        self.env.start(); self.addCleanup(self.env.stop)
        self.asks = hermes_approval()  # Hermes asks, by default
        self.asks.start(); self.addCleanup(self.asks.stop)
        spec = importlib.util.spec_from_file_location("form_" + self.PLUGIN.replace('-', '_'), self.ROOT / "plugin/__init__.py", submodule_search_locations=[str(self.ROOT / "plugin")])
        self.mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.mod
        spec.loader.exec_module(self.mod)
        self.ctx = FakeCtx()
        self.rt = self.mod.register(self.ctx)
        self.addCleanup(self.rt.close)
        self.plan = {"name": "docs", "entry": {"url": "https://docs.example/mcp", "headers": {"X-API-Key": "${MCP_DOCS__KEY_ABCDEFGHIJKLMNOP}"}, "enabled": True}, "envVars": [{"name": "MCP_DOCS__KEY_ABCDEFGHIJKLMNOP"}], "card": "com.example/docs", "provenance": "listed in example.com's catalog"}
        self.calls = []
        def request(method, key, **kw):
            self.calls.append((method, key, kw))
            if not key:
                raise ValueError("No calling session")
            if method == "prepare_add": return copy.deepcopy(self.plan)
            if method == "probe_auth": return {"oauth": False}
            if method == "prepare_search": return {"query": getattr(self, "plan_query", "my exact query"), "endpoint": "https://registry.example/search", "referral": False, "additional": []}
            return {"text": "found servers"}
        self.request = patch.object(self.rt, "request", side_effect=request)
        self.request.start(); self.addCleanup(self.request.stop)
        self.args = {"identifier": "docs", "domain": "example.com", "url": self.plan["entry"]["url"]}

    def pre(self, name=None, args=None, **kw):
        return self.rt.pre(tool_name=name or self.rt.add, args=self.args if args is None else args, session_id="s1", **kw)

    def call(self, name=None, args=None, session="s1"):
        return json.loads(self.rt.call(name or self.rt.add, self.args if args is None else args, {"session_id": session}))

    def test_registration_schemas_and_gate_names(self):
        self.assertEqual(len(self.ctx.tools), 4 if self.PLUGIN == "ard-discovery" else 3)
        for name, t in self.ctx.tools.items():
            self.assertEqual(t["schema"]["name"], name)
            self.assertEqual(t["toolset"], self.PLUGIN)
            self.assertIn("parameters", t["schema"])
        self.assertIsNone(self.pre("unrelated_tool"))

    def test_no_preparation_or_changed_arguments_cannot_write(self):
        self.assertIn("error", self.call())
        self.pre()
        self.assertIn("error", self.call(args={**self.args, "name": "another"}))
        self.assertFalse(self.saved)

    def test_approval_description_shows_the_whole_entry(self):
        d = self.pre()
        self.assertEqual(d["action"], "approve")
        # The exact change: each header with its value (a secret only as its ${VAR} reference),
        # the transport and every other setting.
        for text in ["docs", self.plan["entry"]["url"], "X-API-Key: ${MCP_DOCS__KEY_ABCDEFGHIJKLMNOP}",
                     "Transport: streamable HTTP", "enabled: true", str(self.cfg), "To undo:", self.rt.remove]:
            self.assertIn(text, d["message"])
        self.assertTrue(d["rule_key"].startswith(self.PLUGIN + ":add:docs:"))
        self.assertEqual(len(d["rule_key"].rsplit(":", 1)[1]), 64, "the whole digest")
        self.assertFalse(self.saved)
        self.assertEqual([c[0] for c in self.calls], ["prepare_add"])
        first = d["rule_key"]
        for change in ({"card": "com.example/other"}, {"provenance": "listed by a registry"}):
            self.plan.update(change)
            self.rt.pending.clear()
            self.assertNotEqual(self.pre()["rule_key"], first, change)

    def test_add_preserves_references_and_unrelated_config(self):
        self.pre()
        result = self.call()
        self.assertIn("result", result)
        self.assertIn("/reload-mcp", result["result"])
        cfg = json.loads(self.cfg.read_text())
        self.assertEqual(cfg["model"]["api_key"], "${EXISTING_KEY}")
        self.assertIn("personal", cfg["mcp_servers"])
        self.assertEqual(cfg["mcp_servers"]["docs"]["headers"], self.plan["entry"]["headers"])
        record = json.loads(self.rt.config.record.read_text())
        self.assertIn("fingerprint", record["docs"])
        self.assertNotIn("headers", record["docs"])
        self.assertFalse((self.home / ".env").exists())
        self.assertIn("error", self.call(), "preparation is single-use")

    def test_name_collision_and_race_never_overwrite(self):
        self.plan["name"] = "personal"
        self.assertEqual(self.pre()["action"], "block")
        self.plan["name"] = "docs"
        self.pre()
        cfg = json.loads(self.cfg.read_text()); cfg["mcp_servers"]["docs"] = {"url": "https://own.example/changed"}
        self.cfg.write_text(json.dumps(cfg))
        self.assertIn("error", self.call())
        self.assertFalse(self.saved)

    def test_remove_ownership_and_changed_entry(self):
        self.assertEqual(self.pre(self.rt.remove, {"name": "personal"})["action"], "block")
        self.pre(); self.call()
        d = self.pre(self.rt.remove, {"name": "docs"})
        self.assertEqual(d["action"], "approve")
        cfg = json.loads(self.cfg.read_text()); cfg["mcp_servers"]["docs"]["enabled"] = False
        self.cfg.write_text(json.dumps(cfg))
        self.assertIn("error", self.call(self.rt.remove, {"name": "docs"}))
        self.assertIn("docs", json.loads(self.cfg.read_text())["mcp_servers"])

    def test_remove_approved_entry_only(self):
        self.pre(); self.call()
        self.pre(self.rt.remove, {"name": "docs"})
        self.assertIn("result", self.call(self.rt.remove, {"name": "docs"}))
        self.assertEqual(list(json.loads(self.cfg.read_text())["mcp_servers"]), ["personal"])
        self.assertEqual(json.loads(self.rt.config.record.read_text()), {})

    def test_config_failure_and_corrupt_record_fail_closed(self):
        self.pre()
        with patch.object(self.config_api, "save_config", side_effect=ValueError("write refused")):
            error = self.call()["error"]
            self.assertIn("couldn't save config.yaml", error)
            self.assertNotIn("write refused", error, "Hermes's own text isn't passed on")
        self.assertEqual(json.loads(self.rt.config.record.read_text()), {})
        self.rt.config.record.write_text("invalid JSON")
        self.pre()
        self.assertIn("error", self.call())
        self.assertFalse(self.saved)

    def test_no_cross_session_preparation(self):
        self.pre()
        self.assertIn("error", self.call(session="s2"))
        self.assertFalse(self.saved)

    def test_disabled_registers_nothing(self):
        flag = "ARD_DISCOVERY_DISABLED" if self.PLUGIN == "ard-discovery" else "MCP_SERVER_CARDS_DISABLED"
        ctx = FakeCtx()
        with patch.dict(os.environ, {flag: "1"}): self.mod.register(ctx)
        self.assertFalse(ctx.tools)
        self.assertFalse(ctx.hooks)

    def test_missing_node_and_helper_failure_fail_closed(self):
        self.request.stop()
        helpers = sys.modules[self.mod.__name__ + "._helper"]
        with patch.object(helpers, "find_node", return_value=(None, "Node missing")):
            self.assertEqual(self.pre()["action"], "block")
        with patch.object(self.rt, "request", side_effect=RuntimeError("helper stopped")):
            self.assertEqual(self.pre()["action"], "block")
            self.assertIn("error", self.call())
        self.assertFalse(self.saved)

    def test_registered_name_collision_is_not_gated(self):
        ctx = FakeCtx(taken=[self.rt.add])
        other = self.mod.register(ctx)
        self.addCleanup(other.close)
        self.assertIsNone(other.pre(tool_name=self.rt.add, args=self.args, session_id="s1"))

    def test_no_search_or_addition_where_hermes_approves_without_asking(self):
        with hermes_approval(yolo=True):
            d = self.pre()
            self.assertEqual(d["action"], "block")
            self.assertIn("Nothing was added", d["message"])
            self.assertIn("hermes -z", d["message"])
            if self.PLUGIN == "ard-discovery":
                d = self.pre("ard_search", {"query": "my exact query"})
                self.assertEqual(d["action"], "block")
                self.assertIn("Nothing was sent", d["message"])
            self.assertEqual(self.calls, [], "nothing prepared, nothing sent")
            d = self.pre(self.rt.remove, {"name": "personal"})
            self.assertNotIn("without asking", (d or {}).get("message", ""), "a removal is still put to Hermes")
        self.assertEqual(self.pre()["action"], "approve")

    def test_a_config_error_never_reaches_the_model_verbatim(self):
        # Hermes's error quotes the YAML parser, which can quote a line of config.yaml: a secret, a path.
        def unreadable(*_):
            raise RuntimeError(f"Your settings file ({self.cfg}) has a formatting error (line 3), so this change was not saved. "
                               'Details: found duplicate key "api_key" with value "sk-live-SECRET123"')
        with patch.object(self.config_api, "require_readable_config_before_write", unreadable):
            d = self.pre()
        self.assertEqual(d["action"], "block")
        self.assertNotIn("SECRET123", d["message"])
        self.assertNotIn(str(self.cfg), d["message"])
        self.assertIn("hermes config check", d["message"])
        def unsaved(*_, **__):
            raise RuntimeError('could not save: duplicate key "api_key" with value "sk-live-SECRET123"')
        d = self.pre()
        self.assertEqual(d["action"], "approve")
        with patch.object(self.config_api, "save_config", unsaved):
            out = self.call()
        self.assertNotIn("SECRET123", json.dumps(out))
        self.assertIn("couldn't save config.yaml", json.dumps(out))

    def test_search_has_per_registry_gate_without_a_post(self):
        if self.PLUGIN != "ard-discovery":
            self.assertIsNone(self.pre("ard_search", {"query": "my exact query"}))
            return
        d = self.pre("ard_search", {"query": "my exact query"})
        self.assertEqual(d["action"], "approve")
        # Keyed by the whole request: a kept approval covers these words to this endpoint only.
        self.assertTrue(d["rule_key"].startswith("ard-discovery:search:registry.example:"))
        self.assertGreater(len(d["rule_key"]), len("ard-discovery:search:registry.example:") + 20)
        self.assertIn("my exact query", d["message"])
        self.assertIn("this exact query", d["message"])
        first = d["rule_key"]
        self.rt.pending.clear()
        self.plan_query = "other words"
        self.assertNotEqual(self.pre("ard_search", {"query": "other words"})["rule_key"], first)
        self.assertEqual([c[0] for c in self.calls], ["prepare_search", "prepare_search"])
