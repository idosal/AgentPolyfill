"""Run from the installed Python environment. Pass the official a2a-serve v0.1.0 executable."""

import json
import os
import shlex
import sqlite3
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REV = "2026-07-28"


def exercise(serve, base):
    work, home = base / "agent", base / "home"
    work.mkdir()
    home.mkdir()
    env = {"HOME": str(home), "PATH": os.defpath, "XDG_CONFIG_HOME": str(home / ".config")}

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
        command = [
            str(Path(sys.executable).parent / "agentpolyfill-a2a"),
            "--url",
            url,
            "--serve-credentials",
            str(serve),
            "--state-dir",
            str(home / "routing"),
            "--antigravity",
        ]

        def call(params, owner="origin"):
            meta = {
                "io.modelcontextprotocol/protocolVersion": REV,
                "antigravity.google/conversation_id": owner,
                "io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}}},
            }
            request = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "_meta": meta,
                    "name": "delegate",
                    "arguments": {"message": "Create a swatch."},
                    **params,
                },
            }
            response = subprocess.check_output(
                command, input=json.dumps(request) + "\n", env=env, text=True, timeout=40
            )
            return json.loads(response)

        def reply(token, key, value):
            return {"requestState": token, "inputResponses": {key: {"action": "accept", "content": value}}}

        token = call({})["result"]["requestState"]
        call(reply(token, "start", {"send": False}))
        assert remote_count() == 0
        token = call({})["result"]["requestState"]
        assert "error" in call(reply(token, "start", {"send": True}), "other")
        form1 = call(reply(token, "start", {"send": True}))["result"]["inputRequests"]
        (first,) = form1
        assert "first.txt" in form1[first]["params"]["message"]

        def await_next(params, previous):
            import time

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
        assert remote_count() == 1
        print("Passed decline, two questions, stale reply, conversation isolation, restart and artifact.")
    finally:
        cli("stop")


if __name__ == "__main__":
    with TemporaryDirectory(prefix="a2a-", dir="/tmp") as directory:
        exercise(Path(sys.argv[1]).resolve(strict=True), Path(directory))
