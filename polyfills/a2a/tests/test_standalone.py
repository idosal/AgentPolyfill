import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from agentpolyfill_a2a.agent import (
    MAX_RESPONSE_BYTES,
    AdapterError,
    Agent,
    limit_response,
)
from agentpolyfill_a2a.antigravity import Foreground
from agentpolyfill_a2a.reviewed import Reviewed
from agentpolyfill_a2a.server import REV, Adapter
from test_adapter import URL, Remote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import configure


class SetupTest(unittest.TestCase):
    def test_profile_merge_idempotence_collision_and_native(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"HOME": tmp}, clear=True):
            home = Path(tmp)
            for host in configure.HOSTS:
                mode = "native" if host in {"claude", "copilot", "antigravity"} else "auto"
                with self.subTest(host=host):
                    configure.setup(host, "demo", URL, mode)
                    files = {p: p.read_bytes() for p in home.rglob("*") if p.is_file()}
                    configure.setup(host, "demo", URL, mode)
                    self.assertEqual(files, {p: p.read_bytes() for p in files})
                    with self.assertRaises(configure.SetupError):
                        configure.setup(host, "demo", "https://other.example", mode)
                    self.assertEqual(files, {p: p.read_bytes() for p in files})
            configure.remove("codex", "demo")
            self.assertIn("mcp-tasks", configure.Config(home / ".codex/config.toml").data["mcp_servers"])
            configure.remove("codex", "demo")
            pi = json.loads((home / ".pi/agent/settings.json").read_text())
            self.assertEqual(len(pi["packages"]), 1)
            hermes = configure.Config(home / ".hermes/config.yaml").data
            self.assertEqual(hermes["plugins"]["entries"]["mcp-tasks"]["settings"]["servers"], ["demo"])

    def test_codex_preserves_existing_plugin_and_other_configuration(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"CODEX_HOME": tmp}):
            path = Path(tmp) / "config.toml"
            path.write_text('# keep this\n[plugins."mcp-tasks@agent-polyfill"]\nenabled = true\n')
            configure.setup("codex", "demo", URL, "auto")
            self.assertIn("# keep this", path.read_text())
            self.assertEqual(set(configure.Config(path).data["mcp_servers"]), {"demo"})


class ForegroundTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.remote = Remote()
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.remote.http))
        self.addAsyncCleanup(self.http.aclose)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.adapter = Adapter(Agent(self.http, URL), Path(folder.name), antigravity=True)
        self.addCleanup(self.adapter.db.close)

    async def call(self, owner="owner", message="hello", **params):
        meta = {
            "io.modelcontextprotocol/protocolVersion": REV,
            "antigravity.google/conversation_id": owner,
            "io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}}},
        }
        return await self.adapter.dispatch(
            "tools/call", {"_meta": meta, "name": "delegate", "arguments": {"message": message}, **params}
        )

    async def test_decline_replay_owner_and_artifact(self):
        token = (await self.call())["requestState"]

        def answer(key, values):
            return {"requestState": token, "inputResponses": {key: {"action": "accept", "content": values}}}

        await self.call(**answer("start", {"send": False}))
        with self.assertRaises(AdapterError):
            await self.call(**answer("start", {"send": True}))
        token = (await self.call())["requestState"]
        for fraud in ({"owner": "other"}, {"message": "different"}):
            with self.assertRaises(AdapterError):
                await self.call(**fraud, **answer("start", {"send": True}))
        self.assertFalse(self.remote.requests)
        self.remote.ask(1)
        first = next(iter((await self.call(**answer("start", {"send": True})))["inputRequests"]))
        self.assertEqual(len(self.remote.messages), 1)
        await self.call(**answer(first, {"option": "once"}))
        self.remote.ask(2)
        # Reconnect on the same persisted routing database and retry both earlier responses.
        self.adapter.foreground = Foreground(self.adapter)
        second = next(iter((await self.call(**answer("start", {"send": True})))["inputRequests"]))
        self.assertNotEqual(first, second)
        with self.assertRaises(AdapterError):
            await self.call(owner="other", **answer(second, {"option": "once"}))
        view = await self.call(**answer(first, {"option": "once"}))
        self.assertEqual(list(view["inputRequests"]), [second])
        self.assertEqual(len(self.remote.messages), 2)
        await self.call(**answer(second, {"option": "once"}))
        self.remote.task.update(
            status={"state": "TASK_STATE_COMPLETED"},
            artifacts=[{"artifactId": "one", "parts": [{"text": "sample"}]}],
        )
        result = await self.call(requestState=token)
        self.assertEqual(result["content"][0]["text"], "sample")

    async def test_review_ticket_must_belong_to_the_chat_that_made_the_proposal(self):
        review = Reviewed(self.adapter.foreground, ["hook", "redeem"])
        meta = {
            "antigravity.google/conversation_id": "origin",
            "io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}}},
        }
        prepare = {"name": "delegate", "arguments": {"message": "Create a swatch."}, "_meta": meta}
        result = await review.call(prepare)
        proposal = json.loads(result["content"][0]["text"].split("\n", 1)[1])
        reply = {
            "name": proposal["nextTool"],
            "arguments": {**proposal["arguments"], "agentpolyfill_ticket": "local-host-receipt"},
            "_meta": meta,
        }
        # Emulate a successfully redeemed receipt issued in a different chat.
        receipt = MagicMock(stdout=json.dumps({"ok": True, "conversationId": "other"}))
        with (
            patch("agentpolyfill_a2a.reviewed.subprocess.run", return_value=receipt),
            self.assertRaisesRegex(AdapterError, "in this conversation"),
        ):
            await review.call(reply)
        self.assertFalse(self.remote.requests)

    async def test_bounded_stream_without_length(self):
        closed = []

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                for _ in range(3):
                    yield bytes(MAX_RESPONSE_BYTES // 2)

            async def aclose(self):
                closed.append(True)

        async def response(req):
            return httpx.Response(200, stream=Stream())

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(response), event_hooks={"response": [limit_response]}
        ) as http:
            with self.assertRaises(AdapterError):
                await http.get(URL)
        self.assertEqual(closed, [True])
        for headers in ({"content-length": str(MAX_RESPONSE_BYTES + 1)}, {"content-encoding": "gzip"}):
            with self.assertRaises(AdapterError):
                await limit_response(httpx.Response(200, headers=headers))


class CredentialTest(unittest.TestCase):
    def test_bearer_file_permissions_size_and_rotation(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "credential"
            file.write_text("first-token\n")
            file.chmod(0o600)
            agent = Agent(None, URL, bearer_file=file)
            self.assertEqual(agent.headers()["Authorization"], "Bearer first-token")
            file.write_text("second-token")
            self.assertEqual(agent.headers()["Authorization"], "Bearer second-token")
            file.chmod(0o644)
            with self.assertRaises(AdapterError):
                agent.headers()
            file.chmod(0o600)
            file.write_text("a" * 8193)
            with self.assertRaises(AdapterError):
                agent.headers()
            file.unlink()
            os.mkfifo(file, mode=0o600)
            with self.assertRaises(AdapterError):
                agent.headers()


class ApprovalHookTest(unittest.TestCase):
    def test_only_the_reviewed_tool_and_arguments_can_redeem_once(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("The Antigravity approval hook requires Node 22.18+")
        script = Path(configure.HERE) / "antigravity/approval.mjs"
        with tempfile.TemporaryDirectory() as state:

            def run(mode, body):
                result = subprocess.run(
                    [node, str(script), mode, "swatch", state],
                    input=json.dumps(body),
                    text=True,
                    capture_output=True,
                    check=True,
                )
                return json.loads(result.stdout)

            args = {"delegation": "opaque", "destination": URL, "message": "Create a swatch."}
            tool = "confirm_delegation"
            event = {"conversationId": "owner", "toolCall": {"name": f"mcp_swatch_{tool}", "args": args}}

            def approved():
                card = run("check", event)
                self.assertEqual(card["decision"], "force_ask")
                self.assertIn(args["destination"], card["reason"])
                self.assertIn(args["message"], card["reason"])
                return {**args, **card["overwrite"]}

            def redeem(arguments, name=tool):
                return run("redeem", {"tool": name, "args": arguments})

            self.assertFalse(redeem(args).get("ok"))
            self.assertFalse(redeem({**approved(), "message": "different"}).get("ok"))
            self.assertFalse(redeem(approved(), "answer_delegation").get("ok"))
            same = approved()
            receipt = redeem(same)
            self.assertTrue(receipt["ok"])
            self.assertEqual(receipt["conversationId"], "owner")
            self.assertFalse(redeem(same).get("ok"))


class DisabledTest(unittest.TestCase):
    def test_disabled_entry_has_no_tools_and_creates_no_local_state(self):
        import subprocess

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            requests = [
                {"jsonrpc": "2.0", "id": i, "method": method, "params": {}}
                for i, method in enumerate(("server/discover", "tools/list", "tools/call"))
            ]
            process = subprocess.run(
                [str(Path(sys.executable).parent / "agentpolyfill-a2a"), "--disabled",
                 "--url", "http://127.0.0.1:1", "--state-dir", str(state)],
                input="".join(json.dumps(msg) + "\n" for msg in requests),
                text=True, capture_output=True, check=True, timeout=10,
            )
            discover, listed, call = map(json.loads, process.stdout.splitlines())
            self.assertFalse(discover["result"]["capabilities"])
            self.assertEqual(listed["result"]["tools"], [])
            self.assertIn("error", call)
            self.assertFalse(state.exists())
