"""Exercise marketplace tools through a signed-out Codex app-server in the same chat."""
import json
import re
import shlex
import signal
import os
import subprocess
import time
from contextlib import contextmanager


@contextmanager
def chat(profile, env):
    args = ["codex", "app-server", "-c", 'model_provider="fixture"',
            "-c", 'model_providers.fixture.name="Local fixture"',
            "-c", 'model_providers.fixture.base_url="http://127.0.0.1:1/v1"',
            "-c", 'model_providers.fixture.wire_api="responses"']
    with subprocess.Popen(args, cwd=profile, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, start_new_session=True) as proc:
        sequence = 0

        def send(value):
            proc.stdin.write(json.dumps(value) + "\n")
            proc.stdin.flush()

        def request(method, params, form=None):
            nonlocal sequence
            sequence += 1
            key = sequence
            send({"id": key, "method": method, "params": params})
            for line in proc.stdout:
                msg = json.loads(line)
                if msg.get("method") == "mcpServer/elicitation/request":
                    assert form, msg
                    send({"id": msg["id"], "result": form(msg["params"])})
                elif "method" not in msg and msg.get("id") == key:
                    assert "result" in msg, msg
                    return msg["result"]
            raise RuntimeError("Codex closed unexpectedly")

        try:
            request("initialize", {"clientInfo": {"name": "a2a-chat-test", "version": "1"},
                                   "capabilities": {"experimentalApi": True}})
            send({"method": "initialized"})
            def thread():
                return request("thread/start", {"cwd": str(profile), "ephemeral": True})["thread"]["id"]
            owner, other = thread(), thread()
            def call(tool, arguments, form=None, *, session=owner):
                reply = request("mcpServer/tool/call", {"threadId": session, "server": "a2a-directory",
                                "tool": tool, "arguments": arguments}, form)
                return "\n".join(block.get("text", "") for block in reply["content"])
            yield call, other
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def exercise_chat(home, env, url, remote_count):
    def approve(expected, values):
        def answer(form):
            message = form.get("message", "")
            assert all(part in message for part in expected), form
            return {"action": "accept", "content": values}
        return answer

    save = {"decision": "save"}
    with chat(home, env) as (call, other):
        listing = lambda: json.loads(call("list_agents", {}))["agents"]
        assert listing() == []
        # These entries must fail before ever reaching a user form.
        assert "Unexpected agent setting" in call("add_agent", {"name":"sample", "url":"https://one.example.org",
                                                               "bearer_file":"/example/private"})
        assert "reserved" in call("add_agent", {"name":"a2a-directory", "url":"https://one.example.org"})
        add = {"name": "sample", "url": "https://one.example.org"}
        call("add_agent", add, lambda _: {"action": "decline"})
        assert listing() == []
        assert "saved" in call("add_agent", add, approve(["sample", add["url"]], save))
        # A response for a form shown before a concurrent operator edit cannot overwrite that edit.
        settings = shlex.split(json.loads(call("list_agents", {}))["manageLocally"])
        def concurrent_edit(form):
            subprocess.run([*settings, "edit", "sample", "--url", "https://concurrent.example.org"],
                           env=env, check=True)
            return approve([add["url"], "https://stale.example.org"], save)(form)
        message = call("edit_agent", {"name": "sample", "url": "https://stale.example.org"}, concurrent_edit)
        assert "changed while" in message and listing()[0]["url"] == "https://concurrent.example.org"
        assert "saved" in call("edit_agent", {"name": "sample", "url": "https://two.example.org"},
                               approve(["https://concurrent.example.org", "https://two.example.org"], save))
        assert "removed" in call("remove_agent", {"name": "sample"}, approve(["https://two.example.org"], save))
        assert listing() == []
        agent = {"name": "swatch", "url": url, "auth": "serve"}
        assert "saved" in call("add_agent", agent, approve(["swatch", url, "Serve pairing"], save))
        assert listing() == [{"name": "swatch", "url": url}]
        assert remote_count() == 0
        args = {"agent": "swatch", "message": "Return the swatch."}
        start = call("delegate", args, approve([url, args["message"]], {"decision": "no"}))
        assert "not to start" in start, start
        assert remote_count() == 0
        start = call("delegate", args, approve([url, args["message"]], {"decision": "start"}))
        task = re.search(r"Started task (t-[0-9a-f]{6})", start)
        assert task, start
        handle = {"task": task[1]}
        assert "no task" in call("get_task", handle, session=other)
        for filename in ("first.txt", "second.txt"):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if "waiting for" in call("get_task", handle):
                    break
                time.sleep(0.25)
            answer = call("provide_task_input", handle, approve([filename], {"option": "once"}))
            assert "Sent 1 answer" in answer, answer
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            call("get_task", handle)
            if "Artifact: BLUE GREEN" in call("get_task_result", handle):
                break
            time.sleep(0.25)
        else:
            raise AssertionError("The originating chat did not receive the artifact.")
        assert remote_count() == 1
        print("Single install in Codex: reviewed model-defined connections, same-chat delegation, two questions and artifact.")
