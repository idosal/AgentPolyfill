"""First-party stdio upstream for the existing AgentPolyfill Tasks client."""

import argparse
import asyncio
import json
import os
import sqlite3
import sys
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from a2a.types import a2a_pb2 as a2a
from a2a.utils.errors import TaskNotCancelableError, TaskNotFoundError

from .agent import AdapterError, Agent, limit_response
from .tasks import content, question, snapshot
from .antigravity import Foreground, RESUME
from .reviewed import ANSWER, CONFIRM, Reviewed

REV = "2026-07-28"
EXT = "io.modelcontextprotocol/tasks"
INFO = {"name": "agentpolyfill-a2a", "version": "0.1.0"}
CAPS = {"tools": {}, "extensions": {EXT: {}}}
TOOL = {
    "name": "delegate",
    "description": "Delegate this message to the configured A2A agent.",
    "inputSchema": {
        "type": "object",
        "properties": {"message": {"type": "string", "minLength": 1}},
        "required": ["message"],
        "additionalProperties": False,
    },
}


class Adapter:
    def __init__(self, agent, state_dir, antigravity=False, approval_command=None):
        self.agent = agent
        self.legacy_initialized = False
        state_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(state_dir / "tasks.sqlite3", timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                handle TEXT PRIMARY KEY, endpoint TEXT NOT NULL, remote TEXT NOT NULL,
                context TEXT NOT NULL, created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS answers (
                handle TEXT, question TEXT, PRIMARY KEY(handle, question));
        """)

        self.foreground = Foreground(self) if antigravity else None
        self.reviewed = Reviewed(self.foreground, approval_command) if approval_command else None

    async def start(self, args):
        if (
            not isinstance(args, dict)
            or set(args) != {"message"}
            or not isinstance(args["message"], str)
            or not args["message"].strip()
        ):
            raise AdapterError("Supply a nonempty message for the configured agent.")
        created = datetime.now(UTC).isoformat()
        message = a2a.Message(
            message_id=str(uuid4()), role=a2a.ROLE_USER, parts=[a2a.Part(text=args["message"])]
        )
        response = await self.agent.send(message)
        kind = response.WhichOneof("payload")
        if kind == "message":
            return content(response.message.parts)
        if kind != "task" or not response.task.id or not response.task.context_id:
            raise AdapterError("The agent did not return a valid message or task.")
        task = response.task
        # Persist only routing information so a restarted Tasks helper can reconnect.
        record = {
            "handle": str(uuid4()),
            "endpoint": self.agent.url,
            "remote": task.id,
            "context": task.context_id,
            "created": created,
        }
        with self.db:
            self.db.execute("INSERT INTO tasks VALUES (:handle,:endpoint,:remote,:context,:created)", record)
        return {**snapshot(task, record, self.agent.structured), "resultType": "task"}

    async def update(self, record, responses):
        if not isinstance(responses, dict):
            raise AdapterError("Expected inputResponses.")
        # Different stdio processes can back the same session after a restart.
        # Serialize the fresh read, reply and receipt across those processes.
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            task = await self.agent.get(record["remote"])
            if task.id != record["remote"] or task.context_id != record["context"]:
                raise AdapterError("The agent returned a different task or context.")
            if task.status.state not in (a2a.TASK_STATE_INPUT_REQUIRED, a2a.TASK_STATE_AUTH_REQUIRED):
                return {}
            q = question(task, self.agent.structured)
            receipt = (record["handle"], q.key)
            if (
                q.key not in responses
                or self.db.execute("SELECT 1 FROM answers WHERE handle=? AND question=?", receipt).fetchone()
            ):
                return {}
            if not isinstance(responses[q.key], dict):
                raise AdapterError("Expected an elicitation response.")
            reply = q.reply(task, responses[q.key])
            if reply is not None:
                result = await self.agent.send(reply)
                kind = result.WhichOneof("payload")
                if kind == "task":
                    matches = result.task.id == task.id and result.task.context_id == task.context_id
                elif kind == "message":
                    matches = result.message.task_id in ("", task.id) and result.message.context_id in (
                        "",
                        task.context_id,
                    )
                else:
                    matches = False
                if not matches:
                    raise AdapterError(
                        "The agent did not acknowledge the continuation on the original task.", -32603
                    )
            self.db.execute("INSERT INTO answers VALUES (?,?)", receipt)
        return {}

    async def dispatch(self, method, params):
        meta = params.get("_meta", {})
        version = meta.get("io.modelcontextprotocol/protocolVersion")
        if version is not None and version != REV:
            raise AdapterError("Unsupported protocol version.", -32022, {"supported": [REV], "requested": version})
        if method == "server/discover":
            return {"supportedVersions": [REV], "capabilities": CAPS, "ttlMs": 0, "cacheScope": "private"}
        if method == "initialize":
            self.legacy_initialized = True
            return {"protocolVersion": "2025-11-25", "serverInfo": INFO, "capabilities": {"tools": {}}}
        if method == "ping":
            return {}
        capabilities = meta.get("io.modelcontextprotocol/clientCapabilities")
        extensions = capabilities.get("extensions") if isinstance(capabilities, dict) else None
        has_tasks = isinstance(extensions, dict) and EXT in extensions
        active_turn = self.foreground and version == REV and not has_tasks
        if method == "tools/list":
            if active_turn:
                return {"tools": [TOOL, RESUME, CONFIRM, ANSWER] if self.reviewed else [TOOL, RESUME], "ttlMs": 0, "cacheScope": "private"}
            if version is None and self.legacy_initialized:
                # Hosts use their ordinary MCP catalog to decide which tools the Tasks client can offer.
                return {"tools": [TOOL]}
            return {
                "tools": [TOOL] if version == REV else [],
                "ttlMs": 0,
                "cacheScope": "private",
            }
        if method not in ("tools/call", "tasks/get", "tasks/update", "tasks/cancel"):
            raise AdapterError("Method not found", -32601)
        if method == "tools/call" and active_turn:
            return await (self.reviewed or self.foreground).call(params)
        if (
            meta.get("io.modelcontextprotocol/protocolVersion") != REV
            or not isinstance(extensions, dict)
            or EXT not in extensions
        ):
            raise AdapterError(
                "An MCP Tasks client is required.",
                -32021,
                {"requiredCapabilities": {"extensions": {EXT: {}}}},
            )
        if method == "tools/call":
            if params.get("name") != "delegate":
                raise AdapterError("Unknown tool.")
            return await self.start(params.get("arguments"))
        handle = params.get("taskId")
        if not isinstance(handle, str):
            raise AdapterError("Expected a task handle.")
        record = self.db.execute(
            "SELECT * FROM tasks WHERE handle=? AND endpoint=?", (handle, self.agent.url)
        ).fetchone()
        if not record:
            raise AdapterError("Unknown task for this agent.")
        if method == "tasks/get":
            task = await self.agent.get(record["remote"])
            return snapshot(task, record, self.agent.structured)
        if method == "tasks/update":
            return await self.update(record, params.get("inputResponses"))
        await self.agent.cancel(record["remote"])
        return {}


async def serve(adapter):
    # Stdio is newline-delimited JSON-RPC; stdout belongs to the transport.
    for line in sys.stdin:
        req_id = None
        try:
            request = json.loads(line)
            if (
                not isinstance(request, dict)
                or request.get("jsonrpc") != "2.0"
                or not isinstance(request.get("method"), str)
            ):
                raise AdapterError("Invalid request", -32600)
            if "id" not in request:
                continue
            req_id = request["id"]
            params = request.get("params", {})
            if not isinstance(params, dict) or not isinstance(params.get("_meta", {}), dict):
                raise AdapterError("Expected request parameters.")
            result = await adapter.dispatch(request["method"], params)
            legacy = adapter.legacy_initialized and "io.modelcontextprotocol/protocolVersion" not in params.get("_meta", {})
            if request["method"] != "initialize" and (not legacy or request["method"] == "server/discover"):
                result = {
                    "resultType": "complete",
                    "_meta": {"io.modelcontextprotocol/serverInfo": INFO},
                    **result,
                }
            response = {"result": result}
        except json.JSONDecodeError:
            response = {"error": {"code": -32700, "message": "Invalid JSON."}}
        except AdapterError as exc:
            error = {"code": exc.code, "message": str(exc)}
            if exc.data:
                error["data"] = exc.data
            response = {"error": error}
        except TaskNotFoundError:
            response = {"error": {"code": -32602, "message": "The agent no longer has this task."}}
        except TaskNotCancelableError:
            response = {"error": {"code": -32603, "message": "The agent cannot cancel this task."}}
        except Exception as exc:  # noqa: BLE001 - isolate each JSON-RPC request at the transport boundary
            # SDK and HTTP exceptions can carry request URLs, headers or response bodies.
            print(f"A2A request failed ({type(exc).__name__})", file=sys.stderr)
            response = {"error": {"code": -32603, "message": f"A2A request failed ({type(exc).__name__})."}}
        print(json.dumps({"jsonrpc": "2.0", "id": req_id, **response}, allow_nan=False), flush=True)


class DisabledAdapter:
    """Keep the stdio handshake usable while a host takes over A2A delegation."""

    legacy_initialized = False

    async def dispatch(self, method, params):
        if method == "initialize":
            self.legacy_initialized = True
            return {"protocolVersion": "2025-11-25", "serverInfo": INFO, "capabilities": {}}
        if method == "server/discover":
            return {"supportedVersions": [REV], "capabilities": {}, "ttlMs": 0, "cacheScope": "private"}
        if method == "tools/list":
            return {"tools": []}
        if method == "ping":
            return {}
        raise AdapterError("A2A delegation is disabled for this agent.", -32601)


def plugin_enabled(path):
    try:
        with path.open("rb") as stream:
            settings = tomllib.load(stream)
        return settings["plugins"]["a2a@agent-polyfill"]["enabled"] is True
    except (OSError, KeyError, TypeError, ValueError):
        return False


async def run(args):
    if args.disabled or (args.codex_plugin_config and not plugin_enabled(args.codex_plugin_config)):
        await serve(DisabledAdapter())
        return
    async with httpx.AsyncClient(timeout=20, follow_redirects=False, headers={"Accept-Encoding": "identity"},
                                 event_hooks={"response": [limit_response]}) as http:
        adapter = Adapter(Agent(http, args.url, args.serve_credentials, args.bearer_env, args.bearer_file), args.state_dir, args.antigravity,
                          [*args.approval_hook, "redeem", args.agent_name, str(args.state_dir)] if args.approval_hook else None)
        try:
            await serve(adapter)
        finally:
            adapter.db.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-plugin-config", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--disabled", action="store_true", help="Stand down without opening the agent or task store")
    parser.add_argument("--url", required=True, help="Configured A2A agent base URL")
    parser.add_argument(
        "--state-dir", type=Path, default=Path.home() / ".local" / "state" / "agentpolyfill-a2a"
    )
    parser.add_argument("--antigravity", action="store_true", help="Use active-turn forms in Antigravity when Tasks is unavailable")
    parser.add_argument("--approval-hook", nargs=2, metavar=("NODE", "SCRIPT"), help="Use the installed Antigravity permission hook")
    parser.add_argument("--agent-name", help="Antigravity MCP server name")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--bearer-file", metavar="PATH", help="Read a bearer token from this owner-only file")
    auth.add_argument(
        "--bearer-env", metavar="NAME", help="Read a bearer token from this environment variable"
    )
    auth.add_argument(
        "--serve-credentials", metavar="PATH", help="Use this a2a-serve executable's credential helper"
    )
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
