"""Exercise the adapter against the official SDK's JSON-RPC transport."""

import json
import tempfile
import unittest
from pathlib import Path

import httpx

from agentpolyfill_a2a.agent import STRUCTURED, AdapterError, Agent
from agentpolyfill_a2a.server import EXT, REV, Adapter

URL = "https://agent.example"
META = {
    "io.modelcontextprotocol/protocolVersion": REV,
    "io.modelcontextprotocol/clientCapabilities": {"extensions": {EXT: {}}, "elicitation": {"form": {}}},
}


class Remote:
    def __init__(self):
        self.requests = []
        self.extensions = [{"uri": STRUCTURED}]
        self.messages = []
        self.binding = URL + "/rpc"
        self.task = {"id": "remote", "contextId": "context", "status": {"state": "TASK_STATE_WORKING"}}
        self.immediate = False

    def ask(self, number, request_id=None, repeated=False):
        tag = {"type": "input_schema", "id": request_id or f"read-{number}"}
        schema = {
            "title": "read",
            "type": "object",
            "properties": {
                "option": {"type": "string", "oneOf": [{"const": "once", "title": "Allow once"}]},
                "seq": {"type": "integer", "const": number},
            },
            "required": ["option", "seq"],
        }
        self.task["status"] = {
            "state": "TASK_STATE_INPUT_REQUIRED",
            "message": {
                "messageId": "reissued" if repeated else f"prompt-{number}",
                "role": "ROLE_AGENT",
                "parts": [
                    {"data": {"toolCall": {"id": "read"}}},
                    {"text": "Allow this read?"},
                    {"data": schema, "metadata": {STRUCTURED: tag}},
                ],
            },
        }

    def http(self, request):
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "name": "Reader",
                    "version": "1",
                    "description": "Read two swatches",
                    "supportedInterfaces": [
                        {"url": self.binding, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
                    ],
                    "capabilities": {"extensions": self.extensions},
                    "defaultInputModes": ["text/plain"],
                    "defaultOutputModes": ["text/plain"],
                    "skills": [],
                },
            )
        call = json.loads(request.content)
        if call["method"] == "SendMessage":
            self.messages.append(call["params"]["message"])
            result = {"task": self.task}
            if self.immediate:
                result = {
                    "message": {"messageId": "answer", "role": "ROLE_AGENT", "parts": [{"text": "Ready."}]}
                }
        elif call["method"] == "GetTask":
            result = self.task
        elif call["method"] == "CancelTask":
            self.task["status"] = {"state": "TASK_STATE_CANCELED"}
            result = self.task
        else:
            raise AssertionError(call["method"])
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": call["id"], "result": result})


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.remote = Remote()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.remote.http))
        self.addAsyncCleanup(self.http.aclose)
        self.reconnect()

    def reconnect(self):
        self.adapter = Adapter(Agent(self.http, URL), Path(self.dir.name))
        self.addCleanup(self.adapter.db.close)

    async def call(self, method, **params):
        return await self.adapter.dispatch(method, {"_meta": META, **params})

    async def start(self):
        return await self.call("tools/call", name="delegate", arguments={"message": "Read two swatches."})

    async def test_two_questions_replay_and_artifact(self):
        created = await self.start()
        self.assertEqual(created["resultType"], "task")
        handle = created["taskId"]

        async def poll():
            return await self.call("tasks/get", taskId=handle)

        async def answer(key, choice="once"):
            return await self.call(
                "tasks/update",
                taskId=handle,
                inputResponses={key: {"action": "accept", "content": {"option": choice}}},
            )

        self.remote.ask(1)
        view = await poll()
        (first,) = view["inputRequests"]
        form = view["inputRequests"][first]["params"]["requestedSchema"]
        self.assertEqual(list(form["properties"]), ["option"])
        self.assertEqual(form["required"], ["option"])
        self.assertNotIn("title", form)
        self.assertEqual(form["properties"]["option"]["oneOf"][0]["title"], "Allow once")
        with self.assertRaises(AdapterError):
            await answer(first, "made-up")
        await answer(first)
        self.reconnect()
        await answer(first)  # The agent can acknowledge a send before its next transition.
        self.assertEqual(len(self.remote.messages), 2)

        self.remote.ask(2)
        (second,) = (await poll())["inputRequests"]
        self.assertNotEqual(first, second)
        await answer(first)
        self.assertEqual(len(self.remote.messages), 2)
        self.assertEqual(list((await poll())["inputRequests"]), [second])
        await answer(second)
        replies = self.remote.messages[1:]
        for seq, msg in enumerate(replies, 1):
            self.assertEqual(
                msg["parts"],
                [
                    {
                        "data": {"seq": seq, "option": "once"},
                        "metadata": {STRUCTURED: {"type": "structured_input", "id": f"read-{seq}"}},
                    }
                ],
            )
            self.assertEqual(
                (msg["taskId"], msg["contextId"], msg["extensions"]), ("remote", "context", [STRUCTURED])
            )
        self.assertNotEqual(replies[0]["messageId"], replies[1]["messageId"])
        self.remote.task.update(
            status={"state": "TASK_STATE_COMPLETED"},
            artifacts=[{"artifactId": "swatch", "parts": [{"text": "blue / green"}]}],
        )
        self.assertEqual((await poll())["result"]["content"], [{"type": "text", "text": "blue / green"}])
        self.assertTrue(
            all(r.headers["A2A-Extensions"] == STRUCTURED for r in self.remote.requests if r.method == "POST")
        )

    async def test_legacy_catalog_allows_discovery_without_delegation(self):
        await self.adapter.dispatch("initialize", {"protocolVersion": "2025-11-25"})
        catalog = await self.adapter.dispatch("tools/list", {})
        self.assertEqual([tool["name"] for tool in catalog["tools"]], ["delegate"])
        with self.assertRaises(AdapterError) as denied:
            await self.adapter.dispatch("tools/call", {"name": "delegate", "arguments": {"message": "X"}})
        self.assertEqual(denied.exception.code, -32021)
        self.assertFalse(self.remote.requests)

    async def test_unknown_protocol_version_returns_supported_versions_without_sending(self):
        meta = {**META, "io.modelcontextprotocol/protocolVersion": "2099-01-01"}
        for method in ("server/discover", "tools/list", "tools/call", "tasks/update"):
            with self.subTest(method=method), self.assertRaises(AdapterError) as denied:
                await self.adapter.dispatch(method, {"_meta": meta})
            self.assertEqual(denied.exception.code, -32022)
            self.assertEqual(denied.exception.data, {"supported": [REV], "requested": "2099-01-01"})
        self.assertFalse(self.remote.requests)

    async def test_capability_gate_and_immediate_reply(self):
        with self.assertRaises(AdapterError):
            await self.adapter.dispatch("tools/call", {"name": "delegate", "arguments": {"message": "X"}})
        self.assertFalse(self.remote.requests)
        self.remote.immediate = True
        self.assertEqual(
            await self.start(), {"resultType": "complete", "content": [{"type": "text", "text": "Ready."}]}
        )

    async def test_card_cannot_retarget_credentials(self):
        self.remote.binding = "https://another.example/rpc"
        with self.assertRaises(AdapterError):
            await self.start()
        self.assertEqual([r.url.host for r in self.remote.requests], ["agent.example"])

    async def test_text_reply_and_out_of_band_auth(self):
        handle = (await self.start())["taskId"]
        status = {
            "state": "TASK_STATE_INPUT_REQUIRED",
            "message": {"messageId": "plain", "role": "ROLE_AGENT", "parts": [{"text": "Which city?"}]},
        }
        self.remote.task["status"] = status
        (plain,) = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        await self.call(
            "tasks/update",
            taskId=handle,
            inputResponses={plain: {"action": "accept", "content": {"reply": "Vienna"}}},
        )
        self.assertEqual(self.remote.messages[-1]["parts"], [{"text": "Vienna"}])
        self.remote.task["status"] = {"state": "TASK_STATE_AUTH_REQUIRED"}
        (auth,) = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        sent = len(self.remote.messages)
        await self.call(
            "tasks/update",
            taskId=handle,
            inputResponses={auth: {"action": "accept", "content": {"reply": "unused"}}},
        )
        self.assertEqual(len(self.remote.messages), sent)

    async def test_direct_message_on_continuation_and_optional_request_id(self):
        handle = (await self.start())["taskId"]
        self.remote.ask(1)
        schema = self.remote.task["status"]["message"]["parts"][-1]
        del schema["metadata"][STRUCTURED]["id"]
        (key,) = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        self.remote.immediate = True
        await self.call(
            "tasks/update",
            taskId=handle,
            inputResponses={key: {"action": "accept", "content": {"option": "once"}}},
        )
        self.assertEqual(
            self.remote.messages[-1]["parts"][0]["metadata"], {STRUCTURED: {"type": "structured_input"}}
        )

    async def test_closed_question_and_explicit_cancellation(self):
        handle = (await self.start())["taskId"]
        self.remote.ask(1)
        (first,) = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        with self.assertRaises(AdapterError):
            await self.call("tasks/update", taskId=handle, inputResponses={first: {"action": "decline"}})
        self.assertEqual(len(self.remote.messages), 1)
        self.remote.ask(1, request_id="read-1", repeated=True)
        (second,) = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        self.assertNotEqual(first, second)
        await self.call("tasks/cancel", taskId=handle)
        self.assertEqual((await self.call("tasks/get", taskId=handle))["status"], "cancelled")

    async def test_unreviewable_question_does_not_send_a_continuation(self):
        handle = (await self.start())["taskId"]
        self.remote.ask(1)
        parts = self.remote.task["status"]["message"]["parts"]
        parts[-1]["data"]["properties"]["option"]["pattern"] = "^once$"
        snapshot = await self.call("tasks/get", taskId=handle)
        key, = snapshot["inputRequests"]
        self.assertEqual(snapshot["inputRequests"][key]["params"]["requestedSchema"]["properties"], {})
        await self.call("tasks/update", taskId=handle, inputResponses={key: {"action": "accept", "content": {}}})
        self.assertEqual(len(self.remote.messages), 1)

    async def test_unrequested_fields_are_never_forwarded(self):
        handle = (await self.start())["taskId"]
        self.remote.ask(1)
        key, = (await self.call("tasks/get", taskId=handle))["inputRequests"]
        with self.assertRaises(AdapterError):
            await self.call("tasks/update", taskId=handle, inputResponses={
                key: {"action": "accept", "content": {"option": "once", "unused": "sample"}}
            })
        self.assertEqual(len(self.remote.messages), 1)

    async def test_schema_from_unadvertised_extension_stays_pending(self):
        self.remote.extensions = []
        self.remote.ask(1)
        task = await self.start()
        key, = task["inputRequests"]
        self.assertIn("did not advertise", task["inputRequests"][key]["params"]["message"])
        await self.call("tasks/update", taskId=task["taskId"], inputResponses={
            key: {"action": "accept", "content": {}}
        })
        self.assertEqual(len(self.remote.messages), 1)
