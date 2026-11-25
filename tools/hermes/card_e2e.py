"""Shared E2E scenarios; run by each form with a real, isolated pinned Hermes."""
import json
from pathlib import Path
from harness import World
from card_fixture import CardFixture


class CardScenarios:
    """Mixin; subclasses supply ROOT and PLUGIN."""
    def make(self, extra_config=None):
        f = CardFixture()
        self.addCleanup(f.close)
        w = World({self.PLUGIN: self.ROOT / "plugin"}, extra_config=extra_config)
        self.addCleanup(w.close)
        w.start()
        sid = w.session()
        ard = self.PLUGIN == "ard-discovery"
        discover = "ard_discover" if ard else "discover_mcp_servers"
        add = "ard_add_mcp_server" if ard else "add_mcp_server"
        remove = "ard_remove_mcp_server" if ard else "remove_mcp_server"
        w.rules({"when": {"last_role": "user", "contains": "discover"}, "reply": {"tool": discover, "args": {"domain": f.url}}, "sticky": True})
        for name in ["plain", "secret", "oauth", "bad"]:
            url = f.url + ("/mcp" if name in {"plain", "bad"} else "/" + name)
            w.rules({"when": {"last_role": "user", "contains": "add " + name}, "reply": {"tool": add, "args": {"domain": f.url, "identifier": name, "url": url}}, "sticky": True},
                    {"when": {"last_role": "user", "contains": "remove " + name}, "reply": {"tool": remove, "args": {"name": name}}, "sticky": True})
        return f, w, sid

    @staticmethod
    def saved(w):
        from ruamel.yaml import YAML
        return YAML(typ="safe").load((w.hermes_home / "config.yaml").read_text())

    @staticmethod
    def results(w, hint):
        out = []
        for text in w.tool_results():
            try:
                value = json.loads(text)
                text = value.get("result", value.get("error", text)) if isinstance(value, dict) else text
            except ValueError:
                pass
            if hint in text:
                out.append(text)
        return out

    def test_discover_decline_add_reload_and_remove(self):
        f, w, sid = self.make()
        w.turn(sid, "discover servers")
        listing = w.tool_results("MCP servers listed")[0]
        self.assertIn("3 with a valid Server Card", listing)
        self.assertIn("REFUSED", listing)
        self.assertFalse(w.answers)
        w.approve = lambda *_: "deny"
        w.turn(sid, "add plain")
        self.assertNotIn("plain", self.saved(w).get("mcp_servers", {}))
        self.assertFalse(f.posts("/mcp"), "a declined addition must not even probe the endpoint")
        approvals = [p for m, p in w.answers if m == "approval"]
        self.assertEqual(len(approvals), 1, w.answers)
        self.assertIn(f.url + "/mcp", approvals[0]["description"])
        self.assertIn(str(w.hermes_home / "config.yaml"), approvals[0]["description"])
        self.assertIn("Headers: none", approvals[0]["description"])
        self.assertIn("Transport: streamable HTTP", approvals[0]["description"])
        w.approve = lambda *_: "once"
        w.turn(sid, "add plain, I approve")
        self.assertEqual(self.saved(w)["mcp_servers"]["plain"]["url"], f.url + "/mcp", w.tool_results())
        self.assertTrue(self.results(w, 'Added "plain"'), w.tool_results())
        reloaded = w.gw.request("reload.mcp", {"session_id": sid, "confirm": True}, timeout=60)
        self.assertEqual(reloaded["status"], "reloaded", reloaded)
        w.turn(sid, "check tools")
        names = w.requests()[-1]["tools"]
        proof = next((n for n in names if "fixture_proof" in n), None)
        self.assertIsNotNone(proof, names)
        w.rules({"when": {"last_role": "user", "contains": "use proof"}, "reply": {"tool": proof, "args": {}}})
        w.turn(sid, "use proof")
        self.assertTrue(w.tool_results("Connected through Hermes"), w.tool_results())
        # Refused card and a duplicate name must never reach an approval/write.
        n = len(w.answers)
        w.turn(sid, "add bad")
        w.turn(sid, "add plain again")
        self.assertEqual(len(w.answers), n)
        w.approve = lambda *_: "deny"
        w.turn(sid, "remove plain")
        self.assertIn("plain", self.saved(w)["mcp_servers"])
        w.approve = lambda *_: "once"
        w.turn(sid, "remove plain, I approve")
        self.assertNotIn("plain", self.saved(w)["mcp_servers"])
        self.assertEqual(json.loads((w.hermes_home / self.PLUGIN / "added.json").read_text()), {})
        w.gw.request("reload.mcp", {"session_id": sid, "confirm": True}, timeout=60)
        w.turn(sid, "check removed tools")
        self.assertFalse(any("fixture_proof" in n for n in w.requests()[-1]["tools"]))

    def test_secrets_oauth_and_session_isolation(self):
        f, w, sid = self.make()
        w.turn(sid, "discover servers")
        other = w.session()
        w.turn(other, "add secret")
        self.assertFalse(w.answers, "another session cannot add a card it has not seen")
        w.turn(sid, "add secret")
        entry = self.saved(w)["mcp_servers"]["secret"]
        self.assertRegex(entry["headers"]["X-API-Key"], r'^\$\{MCP_SECRET__X_API_KEY_[A-Z2-7]{16}\}$')
        self.assertIn(str(w.hermes_home / ".env"), self.results(w, 'Added "secret"')[0])
        self.assertFalse((w.hermes_home / ".env").exists())
        w.turn(sid, "add oauth")
        self.assertEqual(self.saved(w)["mcp_servers"]["oauth"]["auth"], "oauth")
        self.assertIn("hermes mcp login oauth", self.results(w, 'Added "oauth"')[0])
        self.assertTrue(f.posts("/oauth"))
        self.assertFalse((w.hermes_home / "mcp-tokens").exists())
        w.turn(sid, "remove oauth")
        self.assertNotIn("oauth", self.saved(w)["mcp_servers"])

    def test_no_addition_where_hermes_approves_without_asking(self):
        f, w, sid = self.make(extra_config={"approvals": {"mode": "off"}})
        w.turn(sid, "discover servers")
        w.turn(sid, "add plain")
        self.assertFalse([1 for m, _ in w.answers if m == "approval"], "Hermes asks nobody with approvals off")
        self.assertNotIn("plain", self.saved(w).get("mcp_servers", {}))
        self.assertFalse(f.posts("/mcp"))
        refused = self.results(w, "Nothing was added")
        self.assertTrue(refused, w.tool_results())
        self.assertIn("approves without asking", refused[0])

    def test_no_approval_surface_fails_closed(self):
        f, w, sid = self.make()
        w.turn(sid, "discover servers")
        # The adapter cannot answer this approval request. Return an RPC error,
        # as a surface with no approval UI does, instead of implicitly choosing deny.
        def unavailable(*_):
            raise RuntimeError("No approval surface is available")
        w.gw.answer = unavailable
        w.turn(sid, "add plain")
        self.assertNotIn("plain", self.saved(w).get("mcp_servers", {}))
        self.assertFalse(f.posts("/mcp"))
