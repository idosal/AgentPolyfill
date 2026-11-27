"""Verify the live directory through a signed-out Codex app-server. No model turn is needed."""

import json
import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]


def exercise(profile):
    codex = shutil.which("codex")
    env = {"HOME": str(profile), "CODEX_HOME": str(profile / "codex"), "PATH": os.environ["PATH"],
           "OTEL_SDK_DISABLED": "true", "CODEX_DISABLE_UPDATE_CHECK": "1",
           "GIT_ALLOW_PROTOCOL": "file", "GIT_TERMINAL_PROMPT": "0",
           "HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1",
           "NO_PROXY": "localhost,127.0.0.1,::1"}
    # The shell installer and package build are exercised separately in CI.
    python = str(PACKAGE / ".venv/bin/python")
    subprocess.run([python, str(PACKAGE / "configure.py"), "codex"], env=env, check=True)
    args = [codex, "app-server", "-c", 'model_provider="fixture"',
            "-c", 'model_providers.fixture.name="Local fixture"',
            "-c", 'model_providers.fixture.base_url="http://127.0.0.1:1/v1"',
            "-c", 'model_providers.fixture.wire_api="responses"']
    with subprocess.Popen(args, env=env, cwd=profile, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, start_new_session=True) as proc:
        request_id = 0

        def request(method, params):
            nonlocal request_id
            request_id += 1
            proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
            for line in proc.stdout:
                reply = json.loads(line)
                if reply.get("id") == request_id:
                    if "error" in reply:
                        raise RuntimeError(f"{method}: {reply['error']}")
                    return reply["result"]
            raise RuntimeError("Codex app-server closed before replying")

        def names(thread):
            result = request("mcpServer/tool/call", {"threadId": thread, "server": "a2a-directory",
                                                     "tool": "list_agents", "arguments": {}})
            return json.loads(result["content"][0]["text"])["agents"]

        def settings(*command):
            subprocess.run([str(PACKAGE / "agents"), "codex", *command], env=env, check=True)

        try:
            request("initialize", {"clientInfo": {"name": "a2a-interop", "version": "1"},
                                   "capabilities": {"experimentalApi": True}})
            proc.stdin.write('{"method":"initialized"}\n')
            proc.stdin.flush()
            thread = request("thread/start", {"cwd": str(profile), "ephemeral": True})["thread"]["id"]
            assert names(thread) == []
            settings("add", "research", "--url", "https://research.example")
            settings("add", "design", "--url", "https://design.example")
            assert [a["name"] for a in names(thread)] == ["design", "research"]
            settings("edit", "design", "--url", "https://updated.example")
            settings("remove", "research")
            assert names(thread) == [{"name": "design", "url": "https://updated.example"}]
            request("config/mcpServer/reload", {})
            fresh = request("thread/start", {"cwd": str(profile), "ephemeral": True})["thread"]["id"]
            data = request("mcpServerStatus/list", {"threadId": fresh})["data"]
            tools = {server["name"]: server["tools"] for server in data}
            assert "delegate" in tools["design"] and "research" not in tools
            print("Live Codex directory passed: empty, two agents, edit, remove, and remaining delegation tool.")
        finally:
            # The npm launcher can outlive or orphan helper processes that write to CODEX_HOME.
            # Give the server EOF, then stop remaining children in this fixture's own process group.
            proc.stdin.close()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    signal.alarm(90)
    with tempfile.TemporaryDirectory() as tmp:
        exercise(Path(tmp))
