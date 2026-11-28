"""A deterministic ACP worker for the A2A Serve interoperability test."""

import json
import sys
from uuid import uuid4


def send(**fields):
    print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def receive():
    return json.loads(next(sys.stdin))


for line in sys.stdin:
    req = json.loads(line)
    method, key = req.get("method"), req.get("id")
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "agentInfo": {"name": "sample", "version": "1"},
        }
    elif method == "session/new":
        result = {"sessionId": str(uuid4())}
    elif method == "session/prompt":
        for number, filename in enumerate(("first.txt", "second.txt"), start=1):
            send(
                id=f"permission-{number}",
                method="session/request_permission",
                params={
                    "sessionId": req["params"]["sessionId"],
                    "toolCall": {
                        "toolCallId": f"read-{number}",
                        "title": "Read file",
                        "kind": "read",
                        "rawInput": {"path": filename},
                    },
                    "options": [
                        {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "reject", "name": "Deny", "kind": "reject_once"},
                    ],
                },
            )
            reply = receive()
            if reply.get("result", {}).get("outcome", {}).get("optionId") != "once":
                break
        else:
            send(
                method="session/update",
                params={
                    "sessionId": req["params"]["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "Artifact: BLUE GREEN"},
                    },
                },
            )
        result = {"stopReason": "end_turn"}
    elif key is not None:
        send(id=key, error={"code": -32601, "message": "Method not found"})
        continue
    else:
        continue
    send(id=key, result=result)
