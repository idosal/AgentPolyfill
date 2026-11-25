"""Loopback-only catalogs, cards, registry and HTTP MCP server for Hermes tests.

No external server is contacted. This hand-written fixture is not independent
interop evidence; the imported real publisher snapshots provide that separately.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
CARD_TYPE = "application/mcp-server-card+json"


class CardFixture:
    def __init__(self):
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def send(self, data, status=200, headers=None):
                body = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                owner.requests.append(("GET", self.path, None))
                if self.path in {"/.well-known/ai-catalog.json", "/.well-known/ard.json", "/linked-ard.json"}:
                    entries = [{"identifier": n, "type": CARD_TYPE, "url": owner.url + "/cards/" + n} for n in ["plain", "secret", "oauth", "bad"]]
                    return self.send({**({"specVersion": "1.0"} if "ai-catalog" in self.path else {}), "entries": entries})
                if self.path.startswith("/cards/"):
                    return self.send(owner.card(self.path.rsplit("/", 1)[1]))
                if self.path == "/":
                    return self.send({}, headers={"Link": '</linked-ard.json>; rel="ard"'})
                if self.path == "/oauth":
                    return self.send({}, 401, {"WWW-Authenticate": 'Bearer resource_metadata="' + owner.url + '/oauth-metadata"'})
                if self.path == "/oauth-metadata":
                    return self.send({"resource": owner.url + "/oauth", "authorization_servers": []})
                return self.send({}, 404)

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b'{}')
                owner.requests.append(("POST", self.path, data))
                if self.path in {"/registry/search", "/referral"}:
                    return self.send({"results": [{"identifier": "plain", "type": CARD_TYPE, "url": owner.url + "/cards/plain", "score": .8}],
                                      "referrals": [{"url": owner.url + "/referral"}] if self.path == "/registry/search" else []})
                if self.path == "/oauth":
                    return self.send({}, 401, {"WWW-Authenticate": 'Bearer resource_metadata="' + owner.url + '/oauth-metadata"'})
                if self.path not in {"/mcp", "/secret"}:
                    return self.send({}, 404)
                if "id" not in data:
                    return self.send({}, 202)
                method = data.get("method")
                if method == "initialize":
                    result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "cards-fixture", "version": "1.0.0"}}
                elif method == "tools/list":
                    result = {"tools": [{"name": "fixture_proof", "description": "Proves the newly added server reached Hermes", "inputSchema": {"type": "object", "properties": {}}}]}
                elif method == "tools/call":
                    result = {"content": [{"type": "text", "text": "Connected through Hermes"}]}
                elif method == "ping":
                    result = {}
                else:
                    return self.send({"jsonrpc": "2.0", "id": data["id"], "error": {"code": -32601, "message": "Method not found"}})
                return self.send({"jsonrpc": "2.0", "id": data["id"], "result": result})

        class Server(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                import sys
                if not isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError)):
                    super().handle_error(request, client_address)

        self.http = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def card(self, name):
        if name == "bad":
            return {"name": "invalid"}
        path = "/mcp" if name == "plain" else "/" + name
        remote = {"type": "streamable-http", "url": self.url + path}
        if name == "secret":
            remote["headers"] = [{"name": "X-API-Key", "isSecret": True, "isRequired": True}]
        return {"$schema": SCHEMA, "name": "org.example/" + name, "version": "1.0.0", "description": "Local test server", "remotes": [remote]}

    def posts(self, path):
        return [body for method, url, body in self.requests if method == "POST" and url == path]

    def close(self):
        self.http.shutdown()
        self.http.server_close()
