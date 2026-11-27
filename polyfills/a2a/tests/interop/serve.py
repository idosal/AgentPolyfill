"""Run from the installed Python environment. Pass the official a2a-serve v0.1.0 executable."""

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
import tomllib

from codex_chat import exercise_chat
from pathlib import Path
from tempfile import TemporaryDirectory

REV = "2026-07-28"


def wire(command, env, method, params):
    # A separate real stdio process per request also checks persisted routing.
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    output = subprocess.check_output(command, input=json.dumps(request) + "\n", env=env, text=True, timeout=40)
    return json.loads(output)


def check_tasks(command, env):
    meta = {
        "io.modelcontextprotocol/protocolVersion": REV,
        "io.modelcontextprotocol/clientCapabilities": {"extensions": {"io.modelcontextprotocol/tasks": {}}},
    }

    def call(method, **params):
        response = wire(command, env, method, {"_meta": meta, **params})
        assert "result" in response, response
        return response["result"]

    created = call("tools/call", name="delegate", arguments={"message": "Create a second swatch."})
    assert created["resultType"] == "task"
    handle = created["taskId"]

    def poll(status, previous=None):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = call("tasks/get", taskId=handle)
            if result["status"] == status and previous not in result.get("inputRequests", {}):
                return result
            time.sleep(0.25)
        raise AssertionError(f"Serve did not reach {status} for the expected question.")

    answer = {"action": "accept", "content": {"option": "once"}}
    first_form = poll("input_required")["inputRequests"]
    first, = first_form
    assert "first.txt" in first_form[first]["params"]["message"]
    call("tasks/update", taskId=handle, inputResponses={first: answer})
    second_form = poll("input_required", first)["inputRequests"]
    second, = second_form
    assert "second.txt" in second_form[second]["params"]["message"]
    call("tasks/update", taskId=handle, inputResponses={first: answer})
    assert list(call("tasks/get", taskId=handle)["inputRequests"]) == [second]
    call("tasks/update", taskId=handle, inputResponses={second: answer})
    assert poll("completed")["result"]["content"][0]["text"] == "Artifact: BLUE GREEN"


def marketplace_directory(source, env, home):
    for args in (["marketplace", "add", source], ["add", "a2a@agent-polyfill"]):
        subprocess.run(["codex", "plugin", *args], env=env, cwd=home, check=True)
    servers = json.loads(subprocess.check_output(["codex", "mcp", "list", "--json"], env=env, cwd=home))
    active = {s["name"]: s["transport"] for s in servers if s["enabled"]}
    assert "mcp-tasks" not in active
    directory = active["a2a-directory"]
    root = Path(directory["cwd"]).resolve()
    assert root.is_relative_to(home / ".codex/plugins/cache/agent-polyfill/a2a")
    return [directory["command"], str(root / directory["args"][0])]


def exercise(serve, base, marketplace=None):
    work, home = base / "agent", base / "home"
    work.mkdir()
    home.mkdir()
    env = {"HOME": str(home), "PATH": os.defpath, "XDG_CONFIG_HOME": str(home / ".config")}

    env["CODEX_HOME"] = str(home / ".codex")
    if marketplace:
        (home / ".codex").mkdir()
        env.update(PATH=str(serve.parent) + os.pathsep + os.environ["PATH"], GIT_TERMINAL_PROMPT="0",
                   CODEX_DISABLE_UPDATE_CHECK="1", OTEL_SDK_DISABLED="true")
        for key in ("UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "UV_OFFLINE", "TMPDIR"):
            if key in os.environ:
                env[key] = os.environ[key]

    def cli(*args):
        return subprocess.check_output([serve, *args], cwd=work, env=env, text=True, timeout=45)

    def remote_count():
        with sqlite3.connect(f"file:{work}/.a2a/state/server.db?mode=ro", uri=True) as db:
            return db.execute("SELECT count(*) FROM tasks").fetchone()[0]

    worker = shlex.join([sys.executable, str(Path(__file__).with_name("worker.py"))])
    cli(
        "start",
        "acp",
        "--name",
        "test",
        "--command",
        worker,
        "--sandbox",
        "local",
        "--private",
        "none",
        "--public",
        "none",
        "--detach",
    )
    try:
        url = cli("status", "--url=local").strip()
        invitation = json.loads(cli("pair", "invite", "test-caller", "-o", "json"))
        cli("pair", "join", url, invitation["code"])
        package = Path(__file__).resolve().parents[2]
        def configured(name):
            profile = tomllib.loads((home / ".codex/config.toml").read_text())["mcp_servers"]
            entry = profile[name]
            return [entry["command"], *entry["args"]]

        if marketplace:
            directory_cmd = marketplace_directory(marketplace, env, home)
        else:
            subprocess.run([sys.executable, str(package / "configure.py"), "codex"], env=env, check=True)
            directory_cmd = configured("a2a-directory")

        def listing():
            return wire(directory_cmd, env, "tools/call", {"name": "list_agents"})

        initial = json.loads(listing()["result"]["content"][0]["text"])
        assert initial["agents"] == []
        settings_cmd = shlex.split(initial["manageLocally"])
        prior = 0
        if marketplace:
            exercise_chat(home, env, url, remote_count)
            prior = 1
        commands = [["add", "control", "--url", "http://127.0.0.1:1"]]
        if not marketplace:
            commands.append(["add", "swatch", "--url", url, "--serve-credentials", str(serve)])
        for args in commands:
            subprocess.run([*settings_cmd, *args], env=env, cwd=base, check=True)
        directory = listing()
        agents = json.loads(directory["result"]["content"][0]["text"])["agents"]
        assert agents == [{"name": "control", "url": "http://127.0.0.1:1"}, {"name": "swatch", "url": url}]
        assert remote_count() == prior
        command = configured("swatch")

        def call(params, owner="origin"):
            meta = {
                "io.modelcontextprotocol/protocolVersion": REV,
                "antigravity.google/conversation_id": owner,
                "io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}}},
            }
            return wire(
                [*command, "--antigravity"], env, "tools/call",
                {"_meta": meta, "name": "delegate", "arguments": {"message": "Create a swatch."}, **params},
            )

        def reply(token, key, value):
            return {"requestState": token, "inputResponses": {key: {"action": "accept", "content": value}}}

        token = call({})["result"]["requestState"]
        call(reply(token, "start", {"send": False}))
        assert remote_count() == prior
        token = call({})["result"]["requestState"]
        assert "error" in call(reply(token, "start", {"send": True}), "other")
        form1 = call(reply(token, "start", {"send": True}))["result"]["inputRequests"]
        (first,) = form1
        assert "first.txt" in form1[first]["params"]["message"]

        def await_next(params, previous):
            for _ in range(12):
                result = call(params)["result"]
                if previous not in result.get("inputRequests", {}):
                    return result
                time.sleep(0.25)
                params = {"requestState": token}
            raise AssertionError("Serve did not advance after the answer.")

        second_form = await_next(reply(token, first, {"option": "once"}), first)["inputRequests"]
        (second,) = second_form
        assert "second.txt" in second_form[second]["params"]["message"]
        assert list(call(reply(token, first, {"option": "once"}))["result"]["inputRequests"]) == [second]
        assert "error" in call(reply(token, second, {"option": "once"}), "other")
        result = await_next(reply(token, second, {"option": "once"}), second)
        assert result["content"][0]["text"] == "Artifact: BLUE GREEN"
        assert remote_count() == prior + 1
        check_tasks(command, env)
        assert remote_count() == prior + 2
        if marketplace:
            subprocess.run(["codex", "plugin", "remove", "a2a@agent-polyfill"], env=env, cwd=home, check=True)
            metadata = {"_meta": {"io.modelcontextprotocol/protocolVersion": REV}}
            discover = wire(command, env, "server/discover", metadata)["result"]
            assert not discover["capabilities"]
            assert wire(command, env, "tools/list", metadata)["result"]["tools"] == []
            assert "error" in wire(command, env, "tasks/get", {**metadata, "taskId": "former-task"})
            assert remote_count() == prior + 2
            print("Clean marketplace install, real delegation and uninstall passed.")
        print("Native Tasks and active-turn interop passed. Verified decline, two questions, stale reply, conversation isolation, restart and artifact.")
    finally:
        cli("stop")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("serve", type=Path)
    parser.add_argument("--marketplace", help="Install from this local path or public owner/repo")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="a2a-", dir=os.environ.get("A2A_TEST_TMP", "/tmp")) as directory:
        exercise(args.serve.resolve(strict=True), Path(directory).resolve(), args.marketplace)
