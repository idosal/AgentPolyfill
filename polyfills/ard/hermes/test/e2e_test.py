import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools/hermes"))
from card_e2e import CardScenarios
from card_fixture import CardFixture
from harness import World


class ArdInHermes(CardScenarios, unittest.TestCase):
    ROOT = ROOT
    PLUGIN = "ard-discovery"

    def test_no_search_where_hermes_approves_without_asking(self):
        f = CardFixture()
        self.addCleanup(f.close)
        w = World({"ard-discovery": ROOT / "plugin"}, extra_config={"approvals": {"mode": "off"}})
        self.addCleanup(w.close)
        w.start()
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "search registry"}, "reply": {"tool": "ard_search", "args": {"query": "find local tools", "registry": f.url + "/registry"}}})
        w.turn(sid, "search registry")
        self.assertFalse([1 for m, _ in w.answers if m == "approval"], "Hermes asks nobody with approvals off")
        self.assertFalse(f.posts("/registry/search"), "no word of the query reaches the registry")
        refused = [t for t in w.tool_results() if "Nothing was sent" in t]
        self.assertTrue(refused, w.tool_results())
        self.assertIn("approves without asking", refused[0])

    def test_search_declined_approved_referral_and_add_with_both_plugins(self):
        f = CardFixture()
        self.addCleanup(f.close)
        cards = ROOT.parents[1] / "server-cards/hermes/plugin"
        w = World({"ard-discovery": ROOT / "plugin", "mcp-server-cards": cards})
        self.addCleanup(w.close)
        w.start()
        sid = w.session()
        query = "find local tools"
        w.rules(
            {"when": {"last_role": "user", "contains": "search registry"}, "reply": {"tool": "ard_search", "args": {"query": query, "registry": f.url + "/registry"}}, "sticky": True},
            {"when": {"last_role": "user", "contains": "search referral"}, "reply": {"tool": "ard_search", "args": {"query": query, "registry": f.url + "/referral", "referral": True}}, "sticky": True},
            {"when": {"last_role": "user", "contains": "add found"}, "reply": {"tool": "ard_add_mcp_server", "args": {"identifier": "plain", "url": f.url + "/mcp"}}, "sticky": True},
        )
        w.approve = lambda *_: "deny"
        w.turn(sid, "search registry")
        self.assertFalse(f.posts("/registry/search"))
        w.approve = lambda *_: "once"
        w.turn(sid, "search registry, approved")
        self.assertEqual(len(f.posts("/registry/search")), 1)
        self.assertEqual(f.posts("/registry/search")[0]["query"]["text"], query)
        self.assertFalse(f.posts("/referral"), "no query is sent to referrals without another approval")
        result = w.tool_results("Registry search")[0]
        self.assertIn("NOT CONFIRMED", result)
        self.assertIn("ard_add_mcp_server", result)
        approval = [p for m, p in w.answers if m == "approval"][-1]
        self.assertIn(query, approval["description"])
        self.assertIn("plugin_rule:ard-discovery:search:127.0.0.1:", " ".join(approval["pattern_keys"]))
        w.approve = lambda *_: "deny"
        w.turn(sid, "search referral")
        self.assertFalse(f.posts("/referral"))
        w.approve = lambda *_: "once"
        w.turn(sid, "search referral, approved")
        self.assertEqual(len(f.posts("/referral")), 1)
        w.turn(sid, "add found")
        self.assertEqual(self.saved(w)["mcp_servers"]["plain"]["url"], f.url + "/mcp")
        names = w.requests()[-1]["tools"]
        self.assertIn("add_mcp_server", names)
        self.assertIn("ard_add_mcp_server", names)
        self.assertIn("remove_mcp_server", names)
        self.assertIn("ard_remove_mcp_server", names)
        w.rules({"when": {"last_role": "user", "contains": "wrong owner"}, "reply": {"tool": "remove_mcp_server", "args": {"name": "plain"}}})
        n = len(w.answers)
        w.turn(sid, "wrong owner")
        self.assertIn("plain", self.saved(w)["mcp_servers"])
        self.assertEqual(len(w.answers), n)


if __name__ == "__main__":
    unittest.main()
