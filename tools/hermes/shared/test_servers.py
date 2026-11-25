"""Which servers a Hermes form may connect to: tools/hermes/shared/_servers.py, without Hermes.

    python3 -m unittest discover -s tools/hermes/shared -p 'test_*.py'
"""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _helper  # noqa: E402
import _servers  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from approval_stub import hermes_approval  # noqa: E402

GRANTED = ["local", "remote", "oauth", "off", "cert", "sse", "unset", "native", "ident"]
CONFIG = {"plugins": {"entries": {"p": {"settings": {"servers": GRANTED}, "allow_gateway_injection": True}}}}


class Servers(unittest.TestCase):
    def read(self, servers, standdown=None, granted=GRANTED):
        return _servers.read_servers("p", granted, standdown=standdown, servers=servers)

    def test_local_and_remote(self):
        out, skipped = self.read({
            "local": {"command": "node", "args": ["s.js", 3], "env": {"K": "v"}, "cwd": "/w"},
            "remote": {"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}},
        })
        self.assertEqual(out["local"], {"command": "node", "args": ["s.js", "3"], "env": {"K": "v"}, "cwd": "/w"})
        self.assertEqual(out["remote"], {"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}})
        self.assertEqual(skipped, {})

    def test_left_alone_with_a_reason(self):
        out, skipped = self.read({
            "oauth": {"url": "https://x.example/mcp", "auth": "oauth"},
            "off": {"command": "x", "enabled": False},
            "cert": {"url": "https://x.example/mcp", "client_cert": "/c.pem"},
            "sse": {"url": "https://x.example/sse"},
            "unset": {"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer ${MISSING_TOKEN}"}},
            "ident": {"url": "https://x.example/mcp", "identity_header": {"name": "X-User", "value_from": "profile"}},
            "nobody": {"command": "x"},
        })
        self.assertEqual(out, {})
        self.assertIn("auth: oauth", skipped["oauth"])
        self.assertIn("enabled: false", skipped["off"])
        self.assertIn("client certificate", skipped["cert"])
        self.assertIn("SSE", skipped["sse"])
        self.assertIn("${MISSING_TOKEN}", skipped["unset"])
        self.assertIn("identity header", skipped["ident"])
        self.assertIn("plugins.entries.p.settings.servers", skipped["nobody"])
        self.assertIn(".env", skipped["unset"])
        self.assertIn("doesn't read", skipped["unset"])

    def test_nothing_without_a_grant(self):
        out, skipped = self.read({"local": {"command": "x"}}, granted=[])
        self.assertEqual(out, {})
        self.assertIn("settings.servers", skipped["local"])

    def test_names(self):
        # ctx.get_config("servers"): a list of names, anything else grants nothing ("*" is a name like any other).
        self.assertEqual(_servers.names(["a", 1, None, {"b": 1}]), ["a", "1"])
        self.assertEqual(_servers.names("a"), [])
        self.assertEqual(_servers.names(None), [])
        out, _ = self.read({"local": {"command": "x"}}, granted=_servers.names(["*"]))
        self.assertEqual(out, {})

    def test_env_references_are_never_filled_in(self):
        # Hermes keeps secrets in .env and fills ${VAR} itself; the plugin reads config.yaml as written and leaves such a server alone.
        for cfg in ({"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer ${env:TOKEN}"}},
                    {"url": "https://x.example/${PATH_PART}"},
                    {"command": "x", "env": {"KEY": "${KEY}"}},
                    {"command": "${BIN}"}):
            out, skipped = self.read({"local": cfg})
            self.assertEqual(out, {}, cfg)
            self.assertIn(".env", skipped["local"])

    def test_standdown_comes_first(self):
        out, skipped = self.read({"native": {"url": "https://x.example/mcp", "events": True}},
                                 standdown=lambda n, c: "Hermes does it" if c.get("events") else None)
        self.assertEqual(out, {})
        self.assertEqual(skipped["native"], "Hermes does it")

    def test_static_identity_header_is_a_header(self):
        out, _ = self.read({"ident": {"url": "https://x.example/mcp", "identity_header": {"name": "X-User", "value": "me"}}})
        self.assertEqual(out["ident"]["headers"], {"X-User": "me"})

    def test_injection_grant(self):
        self.assertTrue(_servers.injection_allowed(CONFIG, "p"))
        self.assertFalse(_servers.injection_allowed({}, "p"))


class HelperEnv(unittest.TestCase):
    def test_provider_keys_are_not_passed_on(self):
        env = _helper.helper_env({"PATH": "/bin", "OPENAI_API_KEY": "k", "GITHUB_TOKEN": "t", "MCP_EVENTS_BATCH_MS": "1", "HOME": "/h",
                                  "GEMINI_KEY": "g", "AWS_CREDENTIALS": "c", "DATABASE_URL": "postgres://u:p@h/db", "NODE_EXTRA_CA_CERTS": "/ca.pem"})
        # An allowlist: a key under any name stays out.
        self.assertEqual(env, {"PATH": "/bin", "MCP_EVENTS_BATCH_MS": "1", "HOME": "/h", "NODE_EXTRA_CA_CERTS": "/ca.pem"})

    def test_node_version_is_checked(self):
        path, why = _helper.find_node({"PATH": "/nonexistent"})
        self.assertIsNone(path)
        self.assertIn("Node 20", why)


class ProfileQuestionsAndHelper(unittest.TestCase):
    def test_threads_keep_the_callers_profile(self):
        import contextvars
        import threading
        var = contextvars.ContextVar("profile", default="main")
        var.set("secondary")
        seen, done = [], threading.Event()
        _helper.spawn(lambda: (seen.append(var.get()), done.set()))
        done.wait(5)
        self.assertEqual(seen, ["secondary"])

    def test_nothing_is_read_outside_the_plugins_profile(self):
        import types
        import tempfile
        mod = types.ModuleType("hermes_constants")
        here, other = tempfile.mkdtemp(), tempfile.mkdtemp()
        import shutil
        self.addCleanup(shutil.rmtree, here, True)
        self.addCleanup(shutil.rmtree, other, True)
        mod.get_hermes_home = lambda: other
        sys.modules["hermes_constants"] = mod
        try:
            with self.assertRaises(RuntimeError):
                _servers.check_profile(here)
            mod.get_hermes_home = lambda: here
            _servers.check_profile(here)
        finally:
            del sys.modules["hermes_constants"]

    def test_question_text_is_whole_and_shows_no_hidden_characters(self):
        self.assertNotIn("\u202e", _servers.shown("a\u202eb\u200bc\x1b[2J"))
        with self.assertRaises(ValueError):
            _servers.shown("x" * 5000)

    def test_a_helper_that_stops_reading_is_ended_and_no_caller_waits_past_its_deadline(self):
        import time
        h = _helper.Helper(Path("60"), node="/bin/sleep", env={"PATH": "/bin:/usr/bin"}, on_request=lambda m, p: None)
        start = time.monotonic()
        try:
            for _ in range(_helper.MAX_QUEUED + 200):
                try:
                    h.request("x", {"pad": "y" * 65536}, timeout=0.2)
                except (TimeoutError, _helper.HelperGone):
                    pass
                if h.closed:
                    break
            self.assertTrue(h.closed, "the stuck helper was ended")
            self.assertLess(time.monotonic() - start, 60)
            with self.assertRaises(_helper.HelperGone):
                h.request("x", {}, timeout=1)
        finally:
            h.kill()


class ApprovalsBypassed(unittest.TestCase):
    """Hermes's own gate predicate, with a stand-in for its approval modules (approval_stub.py)."""

    def setUp(self):
        env = patch.dict(os.environ, {"HERMES_PLUGIN_HOST_PROCESS": ""})
        env.start()
        self.addCleanup(env.stop)

    def test_asks_in_an_ordinary_session(self):
        with hermes_approval():
            self.assertEqual(_servers.approvals_bypassed("k"), "")

    def test_yolo_and_hermes_z(self):
        # _yolo_active() is --yolo, the current session's /yolo and an unattended (hermes -z) turn.
        with hermes_approval(yolo=True):
            self.assertIn("approves without asking", _servers.approvals_bypassed("k"))
            self.assertIn("hermes -z", _servers.approvals_bypassed(""))

    def test_approvals_mode_off(self):
        with hermes_approval(mode="off"):
            self.assertIn("approves without asking", _servers.approvals_bypassed("k"))

    def test_the_named_sessions_yolo(self):
        with hermes_approval(session_yolo=("k",)):
            self.assertIn("approves without asking", _servers.approvals_bypassed("k"))
            self.assertEqual(_servers.approvals_bypassed("other"), "")

    def test_cant_tell_is_refused(self):
        # No Hermes to ask (another version, or none): refused, not taken as "it asks".
        with patch.dict(sys.modules, {"tools": None}):
            self.assertIn("can't tell", _servers.approvals_bypassed("k"))

    def test_the_plugin_host_process_is_refused(self):
        with hermes_approval(), patch.dict(os.environ, {"HERMES_PLUGIN_HOST_PROCESS": "1"}):
            self.assertIn("plugin host process", _servers.approvals_bypassed("k"))


if __name__ == "__main__":
    unittest.main()
