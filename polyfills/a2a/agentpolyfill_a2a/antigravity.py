"""Antigravity's active-turn fallback, using MCP 2026-07-28 multi-round requests."""

import asyncio
import hashlib
import time
from uuid import uuid4

from .agent import AdapterError
from .tasks import snapshot

RESUME = {
    "name": "resume_delegation",
    "description": "Read progress, answer a pending question, or retrieve the artifact of this chat's A2A delegation.",
    "inputSchema": {
        "type": "object",
        "properties": {"delegation": {"type": "string"}},
        "required": ["delegation"],
        "additionalProperties": False,
    },
}
CONFIRM = {
    "type": "object",
    "properties": {"send": {"type": "boolean", "title": "Send this message"}},
    "required": ["send"],
}


def complete(text):
    return {"resultType": "complete", "content": [{"type": "text", "text": text}]}


class Foreground:
    def __init__(self, adapter):
        self.adapter = adapter
        self.db = adapter.db
        self.db.execute("""CREATE TABLE IF NOT EXISTS foreground (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, endpoint TEXT NOT NULL,
            digest TEXT NOT NULL, created INTEGER NOT NULL, stage TEXT NOT NULL, task TEXT)""")

    async def call(self, params):
        meta = params["_meta"]
        owner = meta.get("antigravity.google/conversation_id")
        caps = meta.get("io.modelcontextprotocol/clientCapabilities", {})
        elicitation = caps.get("elicitation") if isinstance(caps, dict) else None
        if (
            not isinstance(owner, str)
            or not owner
            or not isinstance(elicitation, dict)
            or "form" not in elicitation
        ):
            raise AdapterError(
                "Antigravity must supply the originating conversation and form capability.", -32021
            )
        owner = hashlib.sha256(owner.encode()).hexdigest()
        endpoint = self.adapter.agent.url
        args = params.get("arguments")
        if not isinstance(args, dict):
            raise AdapterError("Expected tool arguments.")
        tool = params.get("name")
        token = params.get("requestState")
        responses = params.get("inputResponses", {})
        if not isinstance(responses, dict):
            raise AdapterError("Invalid form responses.")
        if tool == "delegate":
            message = args.get("message")
            if (
                set(args) != {"message"}
                or not isinstance(message, str)
                or not message.strip()
                or len(message) > 8000
            ):
                raise AdapterError("Supply a message of 1 to 8000 characters for review.")
            digest = hashlib.sha256(message.encode()).hexdigest()
            if token is None:
                if responses:
                    raise AdapterError("Missing form state.")
                token = str(uuid4())
                with self.db:
                    self.db.execute("DELETE FROM foreground WHERE stage='new' AND created < unixepoch()-600")
                    self.db.execute(
                        "INSERT INTO foreground VALUES (?,?,?,?,unixepoch(),'new',NULL)",
                        (token, owner, endpoint, digest),
                    )
                return {
                    "resultType": "input_required",
                    "requestState": token,
                    "inputRequests": {
                        "start": {
                            "method": "elicitation/create",
                            "params": {
                                "mode": "form",
                                "requestedSchema": CONFIRM,
                                "message": f"Send the following message to {endpoint}?\n\n{message}",
                            },
                        }
                    },
                }
        elif tool == RESUME["name"] and set(args) == {"delegation"}:
            if token is not None and token != args["delegation"]:
                raise AdapterError("Continuation and delegation differ.")
            token = args["delegation"]
            digest = None
        else:
            raise AdapterError("Unknown tool or arguments.")
        if not isinstance(token, str):
            raise AdapterError("Invalid delegation.")
        row = self.db.execute(
            "SELECT * FROM foreground WHERE id=? AND owner=? AND endpoint=?", (token, owner, endpoint)
        ).fetchone()
        if not row or (digest is not None and digest != row["digest"]):
            raise AdapterError("This continuation does not match the conversation, agent and message.")
        if row["stage"] == "new":
            if tool != "delegate" or set(responses) != {"start"} or not isinstance(responses["start"], dict):
                raise AdapterError("The original start confirmation is required.")
            reply = responses["start"]
            approved = (
                reply.get("action") == "accept"
                and reply.get("content") == {"send": True}
                and reply["content"]["send"] is True
            )
            with self.db:
                claimed = self.db.execute(
                    "UPDATE foreground SET stage=? WHERE id=? AND stage='new' AND created >= unixepoch()-600",
                    ("sending" if approved else "closed", token),
                ).rowcount
            if not claimed:
                raise AdapterError("The start confirmation expired or was already used.")
            if not approved:
                return complete("Delegation declined.")
            # Persist the claim before network I/O. An ambiguous delivery must never start a second job.
            result = await self.adapter.start(args)
            handle = result.get("taskId")
            with self.db:
                self.db.execute(
                    "UPDATE foreground SET stage=?, task=? WHERE id=?",
                    ("active" if handle else "closed", handle, token),
                )
            if not handle:
                return result
        elif row["stage"] == "active":
            handle = row["task"]
        else:
            raise AdapterError("The start was already used. Check the agent before starting another job.")
        record = self.db.execute(
            "SELECT * FROM tasks WHERE handle=? AND endpoint=?", (handle, endpoint)
        ).fetchone()
        if not record:
            raise AdapterError("The local delegation record is unavailable.")
        # Do not apply the initial approval, a closed form, or an old question to a later prompt.
        if responses and "start" not in responses:
            if any(not isinstance(a, dict) or a.get("action") != "accept" for a in responses.values()):
                return complete(f"Question left open. Use resume_delegation with {token} to return to it.")
            await self.adapter.update(record, responses)
        deadline = time.monotonic() + 12
        while True:
            view = snapshot(await self.adapter.agent.get(record["remote"]), record)
            if view["status"] == "completed":
                return view["result"]
            if view["status"] in {"failed", "cancelled"}:
                return {
                    **complete(view.get("error", {}).get("message") or "The task was cancelled."),
                    "isError": True,
                }
            if view["status"] == "input_required":
                return {
                    "resultType": "input_required",
                    "requestState": token,
                    "inputRequests": view["inputRequests"],
                }
            if time.monotonic() >= deadline:
                return complete(
                    f"The agent is still working. Use resume_delegation with {token} to check this task."
                )
            await asyncio.sleep(view["pollIntervalMs"] / 1000)
