import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import configure
import manage


class ConnectionSettingsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"HOME": self.temp.name, "PATH": os.environ["PATH"]}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def settings(self, host, *args, script="manage.py", check=True):
        return subprocess.run([sys.executable, str(PACKAGE / script), host, *args],
                              capture_output=True, text=True, check=check, timeout=30)

    def directory(self, host):
        base, path = configure.host_path(host)
        entries = configure.Config(path).data[configure.section(host)]
        name, _ = configure.directory_settings(host, entries, base, path)
        return configure.argv_of(entries[name])

    def query(self, command):
        request = {"id": 1, "jsonrpc": "2.0", "method": "tools/call", "params": {"name": "list_agents"}}
        response = subprocess.check_output(command, text=True, input=json.dumps(request) + "\n", timeout=10)
        return json.loads(json.loads(response)["result"]["content"][0]["text"])

    def test_lifecycle_for_every_host(self):
        for host in configure.HOSTS:
            with self.subTest(host=host):
                # Antigravity hook installation is covered separately by the actual CLI run.
                mode = "native" if host == "antigravity" else "auto"
                configure.setup(host, None, None, mode, install_directory=True)
                command = self.directory(host)
                self.assertEqual(self.query(command)["agents"], [])
                configure.setup(host, "design", "https://design.example", None)
                configure.setup(host, "research", "https://research.example", None)
                manage.edit(host, "design", "https://new.example")
                self.assertEqual(self.query(command)["agents"], [
                    {"name": "design", "url": "https://new.example"},
                    {"name": "research", "url": "https://research.example"}])
                configure.remove(host, "design")
                self.assertEqual(self.query(command)["agents"], [{"name": "research", "url": "https://research.example"}])
                configure.remove(host, "research")
                self.assertEqual(self.query(command)["agents"], [])

    def test_edit_credentials_and_protect_unrelated_config(self):
        token = (self.home / "private.token").resolve()
        token.write_text("SYNTHETIC")
        token.chmod(0o600)
        base, path = configure.host_path("codex")
        path.parent.mkdir()
        path.write_text('[mcp_servers.other]\ncommand = "unrelated"\n')
        # An entry created before the management feature, including the future directory name.
        configure.setup("codex", "a2a-directory", "https://one.example", "native", token_file=token)
        self.settings("codex", "--tasks", "existing", script="configure.py")
        command = self.directory("codex")
        for value in (str(token), "SYNTHETIC", "other"):
            self.assertNotIn(value, str(self.query(command)["agents"]))
        self.settings("codex", "edit", "a2a-directory", "--url", "https://one.example/")
        def entry():
            return configure.Config(path).data["mcp_servers"]["a2a-directory"]["args"]
        self.assertIn(str(token), entry())
        self.settings("codex", "edit", "a2a-directory", "--url", "https://one.example/another-agent")
        self.assertNotIn("--bearer-file", entry())
        self.settings("codex", "edit", "a2a-directory", "--bearer-file", str(token))
        self.assertIn(str(token), entry())
        self.settings("codex", "edit", "a2a-directory", "--clear-auth")
        self.assertNotIn(str(token), entry())
        before = path.read_bytes()
        for args in (("edit", "other", "--url", "https://new.example"), ("remove", "other"),
                     ("remove", "a2a-directory-2"), ("add", "other", "--url", "https://new.example"),
                     ("edit", "a2a-directory", "--url", "http://public.example")):
            self.assertNotEqual(self.settings("codex", *args, check=False).returncode, 0)
            self.assertEqual(path.read_bytes(), before)
        self.settings("codex", "add", "extra", "--url", "https://second.example")
        self.assertNotIn("mcp-tasks", configure.Config(path).data["mcp_servers"])

    def test_adding_a_connection_does_not_reinstall_shared_host_integration(self):
        self.settings("codex", script="configure.py")
        _, path = configure.host_path("codex")
        config = configure.Config(path)
        config.data["mcp_servers"]["mcp-tasks"] = {"command": "separately-managed-tasks"}
        config.data["mcp_servers"]["a2a-directory"]["startup_timeout_sec"] = 60
        config.save()
        self.settings("codex", "add", "design", "--url", "https://design.example")
        entries = configure.Config(path).data["mcp_servers"]
        self.assertEqual(entries["mcp-tasks"], {"command": "separately-managed-tasks"})
        self.assertEqual(entries["a2a-directory"]["startup_timeout_sec"], 60)

    def test_terminal_menu_and_stand_down(self):
        self.settings("codex", script="configure.py")
        answers = ["add", "demo", "https://demo.example", "", "edit", "demo", "https://updated.example", "", "quit"]
        with (patch.object(sys, "argv", ["agents", "codex"]), patch.object(sys.stdin, "isatty", return_value=True),
              patch("builtins.input", side_effect=answers)):
            manage.main()
        info = self.query(self.directory("codex"))
        self.assertEqual(info["agents"], [{"name": "demo", "url": "https://updated.example"}])
        # The path suggested in chat must work even when copied to another shell.
        other = {**os.environ, "CODEX_HOME": str(self.home / "other profile")}
        listed = subprocess.check_output([*shlex.split(info["manageLocally"]), "list"], env=other, text=True)
        self.assertIn("https://updated.example", listed)
        self.assertNotEqual(self.settings("codex", "--remove", script="configure.py", check=False).returncode, 0)
        self.settings("codex", "remove", "demo")
        self.settings("codex", "--remove", script="configure.py")
        self.settings("codex", "--remove", script="configure.py")
        _, path = configure.host_path("codex")
        self.assertEqual(set(configure.Config(path).data["mcp_servers"]), {"mcp-tasks"})

    def test_antigravity_cannot_write_to_another_home(self):
        with (patch.dict(os.environ, {"ANTIGRAVITY_CONFIG_DIR": str(self.home / "elsewhere")}),
              patch("configure.subprocess.run") as cli,
              self.assertRaisesRegex(configure.SetupError, "Antigravity HOME")):
            configure.setup("antigravity", "design", "https://design.example", "auto")
        cli.assert_not_called()
        self.assertFalse((self.home / ".gemini").exists())

    def test_parallel_adds_and_live_catalog(self):
        self.settings("codex", script="configure.py")
        command = self.directory("codex")
        with subprocess.Popen(command, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as directory:
            try:
                def read():
                    directory.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_agents"}}\n')
                    directory.stdin.flush()
                    return json.loads(json.loads(directory.stdout.readline())["result"]["content"][0]["text"])["agents"]
                self.assertEqual(read(), [])
                adds = [subprocess.Popen([sys.executable, str(PACKAGE / "manage.py"), "codex", "add", name,
                                          "--url", f"https://{name}.example"], stdout=subprocess.DEVNULL)
                        for name in ("one", "two")]
                self.assertEqual([p.wait(timeout=30) for p in adds], [0, 0])
                self.assertEqual([a["name"] for a in read()], ["one", "two"])
            finally:
                directory.stdin.close()
                directory.wait(timeout=10)
