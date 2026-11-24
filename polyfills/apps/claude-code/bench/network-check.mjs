// The helper's /activity against a real page, which the mod's resting asks
// before it rests a view that reaches other sites: an app that opens a
// WebSocket to its server (the one local address a view may reach), keeps it
// 3 s, then closes it.
//   MCP_APPS_CLI_HELPER=<binary> node network-check.mjs
import { spawn } from "./answer-checks.mjs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(MOD, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A bare WebSocket on the MCP server's own address (the only local one a
// view may reach): the handshake, then it holds the socket.
const upgrade = (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("error", () => {});
  // A close frame from the page (opcode 8): answered, and the socket ends.
  socket.on("data", (buf) => { if ((buf[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0x00])); });
};
let WS = "";

const APP = () => `<!doctype html><html><body style="margin:0;font:16px sans-serif;background:#fff"><h1>Live</h1>
<script>const s = new WebSocket(${JSON.stringify(WS)}); s.onopen = () => setTimeout(() => s.close(), 3000);</script></body></html>`;
function mcpServer() {
  const server = new McpServer({ name: "live", version: "1.0.0" });
  server.registerTool("feed", { description: "A live feed", inputSchema: {}, _meta: { ui: { resourceUri: "ui://live/app" } } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  server.registerResource("app", "ui://live/app", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://live/app", mimeType: "text/html;profile=mcp-app", text: APP(), _meta: { ui: { csp: { connectDomains: [WS] } } } }],
  }));
  return server;
}
const mcp = http.createServer(async (req, res) => {
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await server.connect(transport);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
});
mcp.on("upgrade", upgrade);
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
WS = `ws://127.0.0.1:${mcp.address().port}`;
const config = JSON.stringify({ mcpServers: { live: { type: "http", url: `http://127.0.0.1:${mcp.address().port}/mcp` } } });

const helper = spawn(process.env.MCP_APPS_CLI_HELPER, ["--mcp-config", config], { env: { ...process.env, TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor" }, stdio: ["pipe", "pipe", "pipe"] });
const where = await new Promise((resolve) => { let buf = ""; helper.stdout.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(l); if (m.type === "ready") resolve(m); } catch {} } }); });
const post = (route, b) => new Promise((resolve) => { const data = JSON.stringify(b); const req = http.request({ socketPath: where.socket, path: route, method: "POST", headers: { "content-type": "application/json", "x-mcp-apps-cli-token": where.token, "content-length": Buffer.byteLength(data) } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(JSON.parse(t))); }); req.end(data); });

let failed = 0;
const check = (label, ok, got) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}`); };
const opened = await post("/open", { viewId: "v1", server: "live", toolName: "feed", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
check("the view opens, saying where it reaches", opened.ok === true && opened.domains?.length === 1, opened);
await sleep(1200);
const open = await post("/activity", { viewId: "v1" });
check("with its socket open, the helper says so", open.ok === true && open.sockets === 1, open);
await sleep(3500);
const closed = await post("/activity", { viewId: "v1" });
check("once the app closes it, none is open and its network is quiet a moment", closed.ok === true && closed.sockets === 0 && closed.inflight === 0 && closed.quietMs >= 0, closed);
await sleep(1500);
const later = await post("/activity", { viewId: "v1" });
check("and it stays quiet: the quiet time grows", later.quietMs >= closed.quietMs + 1000, later);
const none = await post("/activity", { viewId: "nope" });
check("a view that isn't open: no answer to rest on", none.ok !== true, none);
helper.kill(); mcp.close();
console.log(failed ? `network-check: ${failed} failed` : "network-check: all passed");
process.exit(failed ? 1 : 0);
