"""A scripted OpenAI-compatible chat model for driving a real Hermes without an API key.

POST /v1/chat/completions answers from rules the test sets with POST /control/rules:
each rule is {"when": {"last_role": "user"|"tool", "contains": "..."}, "reply": {...}} where reply is
{"text": "..."} or {"tool": "name", "args": {...}, "capture": {"arg": "regex"}}; ``capture`` fills an
argument from the first group of a regex over the last message. The first matching rule is used once
(unless "sticky": true). Without a match: a plain "ok." text. Every request is kept for GET
/control/requests. Used in-process too: ``serve()``, ``RULES`` and ``REQUESTS``.
"""
import re
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RULES: list[dict] = []
REQUESTS: list[dict] = []
LOCK = threading.Lock()


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def choose(messages: list[dict]) -> dict:
    last = messages[-1] if messages else {}
    role = last.get("role")
    text = _content_text(last.get("content"))
    # The latest user message, for rules on what the person (or an injected message) said.
    with LOCK:
        for rule in RULES:
            w = rule.get("when", {})
            if w.get("last_role") and w["last_role"] != role:
                continue
            if w.get("contains") and w["contains"] not in text:
                continue
            if not rule.get("sticky"):
                RULES.remove(rule)
            reply = dict(rule["reply"])
            for arg, rx in (reply.pop("capture", None) or {}).items():
                m = re.search(rx, text)
                if m:
                    # A dotted name fills a nested argument ("arguments.channel").
                    args = json.loads(json.dumps(reply.get("args", {})))
                    *path, leaf = arg.split(".")
                    node = args
                    for part in path:
                        node = node.setdefault(part, {})
                    node[leaf] = m.group(1)
                    reply["args"] = args
            return reply
    return {"text": "ok."}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/control/requests"):
            with LOCK:
                return self._json(200, REQUESTS)
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "scripted", "object": "model"}]})
        self._json(404, {})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        body = json.loads(raw or b"{}")
        if self.path == "/control/rules":
            with LOCK:
                RULES.extend(body if isinstance(body, list) else [body])
            return self._json(200, {"ok": True})
        if self.path == "/control/reset":
            with LOCK:
                RULES.clear()
                REQUESTS.clear()
            return self._json(200, {"ok": True})
        if not self.path.endswith("/chat/completions"):
            return self._json(404, {})
        messages = body.get("messages") or []
        with LOCK:
            REQUESTS.append({"at": time.time(), "messages": messages, "tools": [t.get("function", {}).get("name") for t in body.get("tools") or []]})
        reply = choose(messages)
        cid = "chatcmpl-" + uuid.uuid4().hex[:12]
        if "tool" in reply:
            call = {"id": "call_" + uuid.uuid4().hex[:10], "type": "function",
                    "function": {"name": reply["tool"], "arguments": json.dumps(reply.get("args", {}))}}
            message = {"role": "assistant", "content": None, "tool_calls": [call]}
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": reply.get("text", "")}
            finish = "stop"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            delta = {"role": "assistant"}
            if message.get("tool_calls"):
                delta["tool_calls"] = [{"index": 0, **message["tool_calls"][0]}]
            else:
                delta["content"] = message["content"]
            for chunk in (
                {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": "scripted",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": "scripted",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage},
            ):
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self._json(200, {"id": cid, "object": "chat.completion", "created": int(time.time()), "model": "scripted",
                         "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage})


def serve(port: int = 0) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    s = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(s.server_address[1], flush=True)
    threading.Event().wait()
