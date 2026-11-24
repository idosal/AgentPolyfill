// Checks what the host page tells an app, through the helper and Chrome (no
// Claude Code): arguments while Claude writes them (tool-input-partial, then
// tool-input), a theme change (host-context-changed), and the alt text read
// from the app's accessibility tree. Then times a first view with Chrome
// cold and with it started ahead (/prewarm), on the cohort example (3212).
//
//   node host-check.mjs
//
// Prints PASS or FAIL per check, then the timings; exits 1 on a failure.
// Needs Chrome and the helper's packages (npm install in ../mod/helper); the
// timings need the cohort example server (see README.md), skipped without it.

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
// The helper to check: MCP_APPS_CLI_HELPER names another (the Rust port's
// binary, helper-rs/PORT.md); by default the Node one.
const helperCommand = (args) =>
  process.env.MCP_APPS_CLI_HELPER
    ? [process.env.MCP_APPS_CLI_HELPER, args]
    : [process.execPath, [path.join(HELPER, "helper.mjs"), ...args]];
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));

// The app: says what it received, as model context, after each message.
const APP = `<!doctype html><html><body><h1>Echo</h1><button>Again</button><p id="out">waiting</p><script>
(function () {
  var seen = { partial: [], input: null, theme: null };
  function send(m) { parent.postMessage(m, "*"); }
  function say() {
    var text = JSON.stringify(seen);
    document.getElementById("out").textContent = text;
    send({ jsonrpc: "2.0", id: Date.now(), method: "ui/update-model-context", params: { content: [{ type: "text", text: text }] } });
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id === 1 && m.result) {
      seen.theme = m.result.hostContext && m.result.hostContext.theme;
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      say();
    }
    if (m.method === "ui/notifications/tool-input-partial") { seen.partial.push(m.params.arguments); say(); }
    if (m.method === "ui/notifications/tool-input") { seen.input = m.params.arguments; say(); }
    if (m.method === "ui/notifications/host-context-changed" && m.params.theme) { seen.theme = m.params.theme; say(); }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "echo", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;

// Another server on this machine, which no view's CSP may name: it counts
// what reaches it (a fetch, a navigation, a form).
const hits = [];
const elsewhere = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  res.end("reached");
});
await new Promise((r) => elsewhere.listen(0, "127.0.0.1", r));
const ELSEWHERE = `http://127.0.0.1:${elsewhere.address().port}`;
let MCP_ORIGIN = "";

// The probe: what a view may reach. Says, as model context: whether WebRTC
// is there, whether a fetch to the other server and to its own got through;
// then tries to leave by a form and by navigating, with a "secret" each.
const PROBE = (own = MCP_ORIGIN, leave = true) => `<!doctype html><html><body><form id="f" method="post" action="${ELSEWHERE}/form"><input name="secret" value="1"></form><script>
(function () {
  function send(m) { parent.postMessage(m, "*"); }
  function attempt(url) { return fetch(url).then(function (r) { return r.ok ? "reached" : "status " + r.status; }, function () { return "blocked"; }); }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0" || m.id !== 1 || !m.result) return;
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    Promise.all([attempt("${ELSEWHERE}/fetch"), attempt(location.origin === "x" ? "" : "${own}/own")]).then(function (r) {
      var report = { rtc: typeof RTCPeerConnection, elsewhere: r[0], own: r[1] };
      send({ jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { content: [{ type: "text", text: JSON.stringify(report) }] } });
      if (${leave}) setTimeout(function () { document.getElementById("f").submit(); }, 300);
      if (${leave}) setTimeout(function () { location.href = "${ELSEWHERE}/nav?secret=1"; }, 900);
    });
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "probe", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;

// The origin app: says its origin and whether its storage works, asking for
// a dedicated origin (`domain`): this server's own, or another's.
const ORIGIN_APP = `<!doctype html><html><body><script>
(function () {
  function send(m) { parent.postMessage(m, "*"); }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0" || m.id !== 1 || !m.result) return;
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    var stored;
    try { localStorage.setItem("k", "v"); stored = localStorage.getItem("k") === "v" ? "works" : "lost"; } catch (err) { stored = "throws"; }
    send({ jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { content: [{ type: "text", text: JSON.stringify({ origin: location.origin, storage: stored }) }] } });
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "origin", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;
// The keys app: a text area filling the view; says its text and how many
// double clicks it got.
const KEYS_APP = `<!doctype html><html><body style="margin:0"><textarea id="t" style="position:fixed;inset:0;width:100%;height:100%"></textarea><script>
(function () {
  var t = document.getElementById("t"), dbl = 0;
  function send(m) { parent.postMessage(m, "*"); }
  function say() { send({ jsonrpc: "2.0", id: Date.now(), method: "ui/update-model-context", params: { content: [{ type: "text", text: JSON.stringify({ text: t.value, dblclicks: dbl }) }] } }); }
  t.addEventListener("dblclick", function () { dbl++; say(); });
  t.addEventListener("input", say);
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && m.jsonrpc === "2.0" && m.id === 1 && m.result) { send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); say(); }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "keys", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;
// The tall app: forty buttons, far taller than its view; says which was clicked.
const TALL_APP = `<!doctype html><html><body style="margin:0">${Array.from({ length: 40 }, (_, i) => `<button style="display:block;width:100%;height:40px">Button ${i + 1}</button>`).join("")}<script>
(function () {
  function send(m) { parent.postMessage(m, "*"); }
  var h = 0;
  function size() { var now = document.documentElement.scrollHeight; if (now !== h) { h = now; send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: now } }); } }
  document.addEventListener("click", function (e) {
    if (e.target.tagName === "BUTTON") send({ jsonrpc: "2.0", id: Date.now(), method: "ui/update-model-context", params: { content: [{ type: "text", text: e.target.textContent }] } });
  });
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && m.jsonrpc === "2.0" && m.id === 1 && m.result) { send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); size(); }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "tall", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;
// The nested app: a tall page with a frame from another site (its server's
// own address) part way down; says when that frame has loaded ("frame ready")
// and when the button inside it is clicked.
const NESTED_APP = () => `<!doctype html><html><body style="margin:0"><div style="height:300px">top</div><iframe src="${MCP_ORIGIN}/frame" style="display:block;border:0;width:100%;height:200px"></iframe><div style="height:1100px">bottom</div><script>
(function () {
  var frameReady = false, initialized = false;
  function send(m) { parent.postMessage(m, "*"); }
  function say(text) { send({ jsonrpc: "2.0", id: Date.now(), method: "ui/update-model-context", params: { content: [{ type: "text", text: text }] } }); }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m === "frame clicked") say("frame clicked");
    if (m === "frame ready") { frameReady = true; if (initialized) say("frame ready"); }
    if (m && m.jsonrpc === "2.0" && m.id === 1 && m.result) {
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
      initialized = true;
      if (frameReady) say("frame ready");
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "nested", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;
// The ticker app: counts every 50 ms, as does a frame from another site in
// it (a process of its own); says both counts every 100 ms.
const TICKER_APP = () => `<!doctype html><html><body style="margin:0"><iframe src="${MCP_ORIGIN}/ticker-frame" style="border:0;width:100%;height:40px"></iframe><script>
(function () {
  var own = 0, frame = 0, worker = 0, ready = false;
  function send(m) { parent.postMessage(m, "*"); }
  setInterval(function () { own++; }, 50);
  // A worker counting too: it posts its own count.
  var counter = new Worker(URL.createObjectURL(new Blob(["var n = 0; setInterval(function () { n++; postMessage(n); }, 50);"], { type: "text/javascript" })));
  counter.onmessage = function (e) { worker = e.data; };
  setInterval(function () { if (ready) send({ jsonrpc: "2.0", id: Date.now(), method: "ui/update-model-context", params: { content: [{ type: "text", text: JSON.stringify({ own: own, frame: frame, worker: worker }) }] } }); }, 100);
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && typeof m.ticks === "number") frame = m.ticks;
    if (m && m.jsonrpc === "2.0" && m.id === 1 && m.result) { ready = true; send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "ticker", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;
// An app that makes frames of its own (blank, srcdoc, blob) and says
// whether WebRTC is in each: a frame the app writes into itself is the way
// around a block applied only to its own window.
const RTC_APP = `<!doctype html><html><body><script>
(function () {
  function send(m) { parent.postMessage(m, "*"); }
  function frame(set) { var f = document.createElement("iframe"); set(f); document.body.appendChild(f); return f; }
  var blank = frame(function () {});
  var srcdoc = frame(function (f) { f.srcdoc = "<p>x</p>"; });
  var blob = frame(function (f) { f.src = URL.createObjectURL(new Blob(["<p>x</p>"], { type: "text/html" })); });
  function rtc(f) { try { return typeof f.contentWindow.RTCPeerConnection; } catch (e) { return "no access"; } }
  var first = rtc(blank);
  setTimeout(function () {
    var report = { blankAtOnce: first, blank: rtc(blank), srcdoc: rtc(srcdoc), blob: rtc(blob), viaFrames: (function () { try { return typeof window.frames[0].RTCPeerConnection; } catch (e) { return "no access"; } })() };
    send({ jsonrpc: "2.0", id: 3, method: "ui/update-model-context", params: { content: [{ type: "text", text: JSON.stringify(report) }] } });
  }, 800);
})();
</script></body></html>`;

// An app that says it's up, then never returns from a loop.
const HANG_APP = `<!doctype html><html><body><p>hanging</p><script>
parent.postMessage({ jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { content: [{ type: "text", text: "up" }] } }, "*");
setTimeout(() => { for (;;) {} }, 500);
</script></body></html>`;
const claudeDomain = (url) => `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.claudemcpcontent.com`;

function mcpServer() {
  const server = new McpServer({ name: "host-check", version: "1.0.0" });
  server.registerTool("nested", { description: "Nested", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/nested" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerTool("ticker", { description: "Ticker", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/ticker" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("ticker", "ui://host-check/ticker", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/ticker", mimeType: "text/html;profile=mcp-app", text: TICKER_APP(), _meta: { ui: { csp: { frameDomains: [MCP_ORIGIN] } } } }],
  }));
  server.registerResource("nested", "ui://host-check/nested", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/nested", mimeType: "text/html;profile=mcp-app", text: NESTED_APP(), _meta: { ui: { csp: { frameDomains: [MCP_ORIGIN] } } } }],
  }));
  server.registerTool("tall", { description: "Tall", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/tall" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("tall", "ui://host-check/tall", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/tall", mimeType: "text/html;profile=mcp-app", text: TALL_APP }],
  }));
  server.registerTool("rtc", { description: "Frames", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/rtc" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("rtc", "ui://host-check/rtc", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/rtc", mimeType: "text/html;profile=mcp-app", text: RTC_APP }],
  }));
  server.registerTool("hang", { description: "Hangs", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/hang" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("hang", "ui://host-check/hang", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/hang", mimeType: "text/html;profile=mcp-app", text: HANG_APP }],
  }));
  server.registerTool("keys", { description: "Keys", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/keys" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("keys", "ui://host-check/keys", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/keys", mimeType: "text/html;profile=mcp-app", text: KEYS_APP }],
  }));
  for (const [tool, domain] of [["own-domain", () => claudeDomain(`${MCP_ORIGIN}/mcp`)], ["other-domain", () => claudeDomain("https://example.com/mcp")]]) {
    server.registerTool(tool, { description: "Origin", inputSchema: {}, _meta: { ui: { resourceUri: `ui://host-check/${tool}` } } }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    server.registerResource(tool, `ui://host-check/${tool}`, { mimeType: "text/html;profile=mcp-app" }, async () => ({
      contents: [{ uri: `ui://host-check/${tool}`, mimeType: "text/html;profile=mcp-app", text: ORIGIN_APP, _meta: { ui: { domain: domain() } } }],
    }));
  }
  server.registerTool("probe", { description: "Probes", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/probe" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("probe", "ui://host-check/probe", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{
      uri: "ui://host-check/probe",
      mimeType: "text/html;profile=mcp-app",
      text: PROBE(),
      // The other server is named, as is the server's own address, and everything.
      _meta: { ui: { csp: { connectDomains: [ELSEWHERE, MCP_ORIGIN, "*"], resourceDomains: [ELSEWHERE] } } },
    }],
  }));
  // The same probe, for this server named as if it were elsewhere (a public
  // name that resolves to this machine): its CSP names that address.
  server.registerTool("probe-remote", { description: "Probes", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/probe-remote" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("probe-remote", "ui://host-check/probe-remote", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/probe-remote", mimeType: "text/html;profile=mcp-app", text: PROBE(REMOTE_ORIGIN, false), _meta: { ui: { csp: { connectDomains: [REMOTE_ORIGIN] } } } }],
  }));
  server.registerTool("echo", { description: "Echoes", inputSchema: {}, _meta: { ui: { resourceUri: "ui://host-check/app" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("app", "ui://host-check/app", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://host-check/app", mimeType: "text/html;profile=mcp-app", text: APP }],
  }));
  return server;
}

const mcp = http.createServer(async (req, res) => {
  if (req.url === "/frame") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><body style="margin:0"><button style="width:100%;height:200px" onclick="parent.postMessage('frame clicked','*')">in the frame</button><script>parent.postMessage('frame ready','*')</script></body>`);
  }
  if (req.url === "/ticker-frame") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><body><script>var n = 0; setInterval(function () { n++; parent.postMessage({ ticks: n }, "*"); }, 50);</script></body>`);
  }
  if (req.url === "/own") {
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    return res.end("own");
  }
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await server.connect(transport);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
MCP_ORIGIN = `http://127.0.0.1:${mcp.address().port}`;
// localtest.me is a public name that resolves to this machine: a server
// there is, to the helper, elsewhere. Where it doesn't resolve (no DNS), the
// check that uses it is skipped. The same server answers on ::1 too.
const resolved = await import("node:dns").then((dns) => dns.promises.lookup("localtest.me")).catch(() => null);
let REMOTE_ORIGIN = "";
if (resolved && ["127.0.0.1", "::1"].includes(resolved.address)) {
  REMOTE_ORIGIN = `http://localtest.me:${mcp.address().port}`;
  await new Promise((r) => http.createServer((req, res) => mcp.emit("request", req, res)).listen(mcp.address().port, "::1", r).on("error", r));
}
const config = path.join(os.tmpdir(), `host-check-${process.pid}.json`);
fs.writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      echo: { type: "http", url: `${MCP_ORIGIN}/mcp` },
      ...(REMOTE_ORIGIN ? { remote: { type: "http", url: `${REMOTE_ORIGIN}/mcp` } } : {}),
      analytics: { type: "http", url: "http://localhost:3212/mcp" },
    },
  }),
);
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-check-"));

function startHelper(term = "Apple_Terminal", extraEnv = {}) {
  const helper = spawn(...helperCommand(["--mcp-config", config]), {
    env: { ...process.env, MCP_APPS_CLI_STORAGE_DIR: storeDir, TERM_PROGRAM: term, TERM_PROGRAM_VERSION: "3.6.9", MCP_APPS_CLI_DEBUG: process.env.V ? "1" : "", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const said = new Map();
  const alts = new Map();
  const firstFrame = new Map();
  if (process.env.V) helper.stderr.on("data", (d) => process.stderr.write(d));
  let buf = "";
  const ready = new Promise((resolve) =>
    helper.stdout.on("data", (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "ready") resolve(m.socket ? { socket: m.socket, token: m.token } : { url: m.url, token: m.token });
        if (m.type === "notify" && m.method === "ui/update-model-context") said.set(m.viewId, m.params.content[0].text);
        if (m.type === "describe") alts.set(m.viewId, m.text);
        if (m.type === "frame" && !firstFrame.has(m.viewId)) firstFrame.set(m.viewId, Date.now());
      }
    }),
  );
  return { helper, said, alts, firstFrame, ready };
}

// The helper's socket, or on Windows (MCP_APPS_CLI_TRANSPORT=tcp) its URL; and its token.
const target = (where, route) => ({
  ...(where.socket ? { socketPath: where.socket } : { host: "127.0.0.1", port: new URL(where.url).port }),
  path: route,
  headers: { "x-mcp-apps-cli-token": where.token },
});
const post = (socket, route, body) =>
  new Promise((resolve, reject) => {
    const q = http.request({ ...target(socket, route), method: "POST" }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => resolve(JSON.parse(t)));
    });
    q.on("error", reject);
    q.end(JSON.stringify(body));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 10000) {
  for (let t = 0; t < ms && !check(); t += 50) await sleep(50);
  return check();
}

let failed = 0;
const refused = (where) =>
  new Promise((resolve) => {
    const { headers: _, ...open } = target(where, "/ping");
    const q = http.request({ ...open, method: "POST" }, (r) => { r.resume(); resolve(String(r.statusCode)); });
    q.on("error", () => resolve("error"));
    q.end("{}");
  });
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${got === undefined ? "" : `: ${got}`}`);
};

// --- what the app is told ----------------------------------------------------

let h = startHelper();
let socket = await h.ready;
const seen = (id) => {
  try { return JSON.parse(h.said.get(id) ?? "null"); } catch { return null; }
};
// Opened while Claude writes the call: what's written so far, then more, then all.
await post(socket, "/open", {
  viewId: "early", server: "echo", toolName: "echo", streaming: true, partialInput: { code: "const a" },
  cols: 60, maxRows: 10, theme: "dark", mode: "cells",
});
await until(() => seen("early")?.partial?.length >= 1);
await post(socket, "/args", { viewId: "early", arguments: { code: "const a = 1;" }, partial: true });
await until(() => seen("early")?.partial?.length >= 2);
await post(socket, "/args", { viewId: "early", arguments: { code: "const a = 1;\nconst b = 2;" }, partial: false });
await until(() => seen("early")?.input);
// A partial after the whole arguments is never passed on.
await post(socket, "/args", { viewId: "early", arguments: { code: "late" }, partial: true });
await sleep(300);
const early = seen("early");
check("partial arguments reach the app in order, before the whole", JSON.stringify(early?.partial) === JSON.stringify([{ code: "const a" }, { code: "const a = 1;" }]), JSON.stringify(early?.partial));
check("then the whole arguments, once", early?.input?.code === "const a = 1;\nconst b = 2;" && early.partial.length === 2);
// Opened as it runs: the whole arguments straight away, no partial.
await post(socket, "/open", { viewId: "late", server: "echo", toolName: "echo", toolInput: { code: "x" }, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => seen("late")?.input);
check("a view opened as its call runs gets the whole arguments, no partial", seen("late")?.input?.code === "x" && seen("late").partial.length === 0);
// A theme change.
check("the app starts in the theme it was opened in", seen("late")?.theme === "dark", seen("late")?.theme);
await post(socket, "/theme", { viewId: "late", theme: "light" });
await until(() => seen("late")?.theme === "light");
check("a theme change reaches the app (host-context-changed)", seen("late")?.theme === "light", seen("late")?.theme);
await post(socket, "/close", { viewId: "early" });
await post(socket, "/close", { viewId: "late" });
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// Alt text: picture views only (iTerm2 here).
h = startHelper("iTerm.app");
socket = await h.ready;
await post(socket, "/open", { viewId: "alt", server: "echo", toolName: "echo", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "image" });
await until(() => h.alts.has("alt"), 8000);
check("a picture view's alt text reads the app", /^Echo\. Again \(button\)\./.test(h.alts.get("alt") ?? ""), h.alts.get("alt"));
await post(socket, "/close", { viewId: "alt" });
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// --- what a view may reach --------------------------------------------------

h = startHelper();
socket = await h.ready;
const status = await refused(socket);
check("a request without the helper's token is refused", status === "403", status);
await post(socket, "/open", { viewId: "probe", server: "echo", toolName: "probe", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("probe"), 8000);
const probe = JSON.parse(h.said.get("probe") ?? "{}");
check("no WebRTC in a view (it would reach past the CSP)", probe.rtc === "undefined", probe.rtc);
check("another server on this machine, named in the CSP, is not reached", probe.elsewhere === "blocked", probe.elsewhere);
check("the server's own address, named in the CSP, is", probe.own === "reached", probe.own);
await sleep(2000);
// A form posts its secret in the body, a navigation in the URL: neither may arrive.
check("the view can't send what it holds away by a form or by navigating", hits.length === 0, hits.join(" ") || "nothing reached");
// Frames the app makes itself get no WebRTC either.
await post(socket, "/open", { viewId: "rtc", server: "echo", toolName: "rtc", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("rtc"), 10000);
const rtcIn = JSON.parse(h.said.get("rtc") ?? "{}");
check("no WebRTC in frames the app makes (blank, srcdoc, blob)", Object.keys(rtcIn).length > 0 && Object.values(rtcIn).every((t) => t === "undefined" || t === "no access"), JSON.stringify(rtcIn));
await post(socket, "/close", { viewId: "rtc" });
// Chrome's local-network checks: a page from elsewhere doesn't reach this
// machine even by a name its CSP allows that resolves here.
if (REMOTE_ORIGIN) {
  await post(socket, "/open", { viewId: "probe-remote", server: "remote", toolName: "probe-remote", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
  await until(() => h.said.has("probe-remote"), 25000);
  const remote = JSON.parse(h.said.get("probe-remote") ?? "{}");
  check("a view of a server elsewhere doesn't reach this machine, even by a public name that resolves here", remote.own === "blocked", remote.own ?? "no report");
  await post(socket, "/close", { viewId: "probe-remote" });
} else console.log("SKIP local-network check: localtest.me doesn't resolve to this machine here");
await post(socket, "/close", { viewId: "probe" });
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// --- input -------------------------------------------------------------------

h = startHelper();
socket = await h.ready;
await post(socket, "/open", { viewId: "keys", server: "echo", toolName: "keys", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("keys"), 8000);
const typed = () => JSON.parse(h.said.get("keys") ?? "{}");
const press = (event) => post(socket, "/input", { viewId: "keys", event });
for (let n = 0; n < 2; n++) {
  await press({ kind: "pointer", type: "down", x: 5, y: 2, button: "left" });
  await press({ kind: "pointer", type: "up", x: 5, y: 2, button: "left" });
}
await until(() => typed().dblclicks >= 1, 3000);
check("two quick clicks in one place are a double click", typed().dblclicks === 1, `${typed().dblclicks} double clicks`);
// One character each (an emoji is two UTF-16 units), text of several, and
// a control sequence no key is known for.
for (const key of ["😀", "é", "👍🏽", "\u001b[99~", "x"]) await press({ kind: "key", key });
await until(() => typed().text === "😀é👍🏽x", 3000);
check("an emoji, an accented letter and an emoji with a skin tone reach a text field; an unknown key sequence doesn't", typed().text === "😀é👍🏽x", JSON.stringify(typed().text));
await post(socket, "/close", { viewId: "keys" });
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// A tall view scrolled (PgDn) still takes clicks where they land: the app's
// frame is in the host page's process (the same site), whatever Chrome's
// process isolation says.
h = startHelper("Apple_Terminal", { MCP_APPS_CLI_DEBUG: "1" });
socket = await h.ready;
await post(socket, "/open", { viewId: "tall", server: "echo", toolName: "tall", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await sleep(2500);
for (let n = 0; n < 2; n++) {
  await post(socket, "/input", { viewId: "tall", event: { kind: "key", key: "pagedown" } });
  await sleep(300);
}
const clicked = [];
for (const label of ["Button 7", "Button 10"]) {
  const at = await post(socket, "/locate", { text: label });
  if (!at.ok || at.cellY < 0 || at.cellY > 9) {
    clicked.push(`${label}: not in sight (${JSON.stringify(at)})`);
    continue;
  }
  h.said.delete("tall");
  await post(socket, "/input", { viewId: "tall", event: { kind: "pointer", type: "down", x: at.cellX, y: at.cellY, button: "left" } });
  await post(socket, "/input", { viewId: "tall", event: { kind: "pointer", type: "up", x: at.cellX, y: at.cellY, button: "left" } });
  await until(() => h.said.has("tall"), 3000);
  clicked.push(`${label} → ${h.said.get("tall") ?? "nothing"}`);
  await sleep(700);
}
// A frame from another site in it (Chrome may give it a process of its own).
await post(socket, "/close", { viewId: "tall" });
await post(socket, "/open", { viewId: "nested", server: "echo", toolName: "nested", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
// Clicked only once the frame from another site has loaded (it can take
// seconds on a slow machine), and the view has drawn it.
await until(() => h.said.get("nested") === "frame ready", 15000);
await sleep(500);
for (let n = 0; n < 2; n++) {
  await post(socket, "/input", { viewId: "nested", event: { kind: "key", key: "pagedown" } });
  await sleep(300);
}
h.said.delete("nested");
// 300 px down the page is the frame: rows of the scrolled window inside it.
const rows = await post(socket, "/ping", {});
const cellH = rows.rowHeights?.[0] ?? 16;
const row = Math.floor((350 - 2 * 8 * cellH) / cellH);
await post(socket, "/input", { viewId: "nested", event: { kind: "pointer", type: "down", x: 20, y: row, button: "left" } });
await post(socket, "/input", { viewId: "nested", event: { kind: "pointer", type: "up", x: 20, y: row, button: "left" } });
await until(() => h.said.has("nested"), 3000);
check("in a tall view scrolled down, a click lands in a frame from another site", h.said.get("nested") === "frame clicked", `row ${row}: ${h.said.get("nested") ?? "nothing"}`);
await post(socket, "/close", { viewId: "nested" });
check("in a tall view scrolled down, a click lands on what's under it", clicked.every((c) => /^Button (\d+) → Button \1$/.test(c)), clicked.join("; "));
// Out of sight, a view's page is paused, a frame from another site in it
// too: a game scrolled away takes no CPU. It still answers, and runs again.
await post(socket, "/open", { viewId: "ticker", server: "echo", toolName: "ticker", toolInput: {}, cols: 60, maxRows: 4, theme: "dark", mode: "cells" });
await until(() => (seen("ticker")?.frame ?? 0) > 5, 8000);
const running = seen("ticker");
await post(socket, "/shown", { viewId: "ticker", shown: false });
await sleep(1000);
const asked = await Promise.race([post(socket, "/theme", { viewId: "ticker", theme: "light" }), sleep(5000).then(() => null)]);
await sleep(1000);
const hidden = seen("ticker");
check("a view out of sight answers a request", asked?.ok === true, JSON.stringify(asked));
await post(socket, "/shown", { viewId: "ticker", shown: true });
await sleep(400);
const back = seen("ticker");
// Two seconds, not one: a frame from another site takes a moment longer to
// run again on macOS. Running, each count gains about 40 in that time;
// paused, none.
await sleep(2000);
const later = seen("ticker");
// Last count before hiding to the first after showing, about 2.4 s: running,
// about 48. Paused, a few still: the report's age, the time to pause, the
// /theme request's wake (up to about 190 ms), the 400 ms after showing.
check("out of sight, its page, a frame from another site in it, and its worker stop", back.own - running.own < 25 && back.frame - running.frame < 25 && back.worker - running.worker < 25, `in about 2.4 s: own +${back.own - running.own}, frame +${back.frame - running.frame}, worker +${back.worker - running.worker} (shown when hidden: ${JSON.stringify(hidden)})`);
check("back in sight, both run again", later.own - back.own > 10 && later.frame - back.frame > 10, `in 2 s: own +${later.own - back.own}, frame +${later.frame - back.frame}`);
await post(socket, "/close", { viewId: "ticker" });
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// --- a dedicated origin (`domain`) -------------------------------------------

h = startHelper();
socket = await h.ready;
const reported = async (id, tool) => {
  await post(socket, "/open", { viewId: id, server: "echo", toolName: tool, toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
  await until(() => h.said.has(id), 8000);
  return JSON.parse(h.said.get(id) ?? "{}");
};
const own = await reported("own", "own-domain");
check("the server's own Claude domain is the app's origin, its storage first party", own.origin === `https://${claudeDomain(`${MCP_ORIGIN}/mcp`)}` && own.storage === "works", JSON.stringify(own));
const other = await reported("other", "other-domain");
check("another server's domain isn't given", other.origin === "http://mcp-app.localhost" && other.storage === "works", JSON.stringify(other));

// --- Chrome or an app's page dying ---------------------------------------------

const closed = new Map();
h.helper.stdout.on("data", (d) => {
  for (const line of String(d).split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.type === "closed") closed.set(m.viewId, m.reason);
    } catch {}
  }
});
const chromeOf = (pid) =>
  execSync(`pgrep -P ${pid} || true`).toString().split("\n").filter(Boolean)
    .filter((p) => /chrom/i.test(execSync(`ps -o comm= -p ${p} || true`).toString()));
// Every descendant, not only children: on Linux the renderers are the
// zygote's children, not the browser's.
const descendantsOf = (pid) =>
  execSync(`pgrep -P ${pid} || true`).toString().split("\n").filter(Boolean).flatMap((p) => [p, ...descendantsOf(p)]);
const renderersOf = (pid) =>
  descendantsOf(pid).filter((p) => /--type=renderer/.test(execSync(`ps -o args= -p ${p} || true`).toString()));
await post(socket, "/close", { viewId: "other" });
const browserPid = chromeOf(h.helper.pid)[0];
for (const p of renderersOf(browserPid)) process.kill(Number(p), "SIGKILL");
await until(() => closed.has("own"), 8000);
check("an app's page that crashed closes its view, and says why", closed.get("own") === "the app's page crashed", closed.get("own"));
await post(socket, "/open", { viewId: "after-crash", server: "echo", toolName: "echo", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("after-crash"), 8000);
for (const p of chromeOf(h.helper.pid)) process.kill(Number(p), "SIGKILL");
await until(() => closed.has("after-crash"), 8000);
check("Chrome stopping closes its views, and says why", closed.get("after-crash") === "Chrome stopped", closed.get("after-crash"));
await post(socket, "/open", { viewId: "after-chrome", server: "echo", toolName: "echo", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("after-chrome"), 10000);
check("the next view starts Chrome again", h.said.has("after-chrome"));
// An app that hangs (a loop that never returns) is closed, rather than hold
// a core and its view for good.
await post(socket, "/open", { viewId: "hang", server: "echo", toolName: "hang", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => closed.has("hang"), 30000);
check("an app that stops responding is closed, and says why", closed.get("hang") === "the app stopped responding", closed.get("hang") ?? "still open after 30 s");
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// --- Chrome closed when idle --------------------------------------------------

h = startHelper("Apple_Terminal", { MCP_APPS_CLI_CHROME_IDLE_S: "2" });
socket = await h.ready;
await post(socket, "/open", { viewId: "idle", server: "echo", toolName: "echo", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("idle"), 8000);
await post(socket, "/close", { viewId: "idle" });
await sleep(3500);
check("with no view open for a while, Chrome is closed", chromeOf(h.helper.pid).length === 0, `${chromeOf(h.helper.pid).length} left`);
await post(socket, "/open", { viewId: "idle-2", server: "echo", toolName: "echo", toolInput: {}, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
await until(() => h.said.has("idle-2"), 10000);
check("and the next view starts it again", h.said.has("idle-2"));
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));

// --- a first view, Chrome cold or started ahead --------------------------------

const cohortUp = await fetch("http://localhost:3212/mcp", { method: "POST" }).then(() => true, () => false);
if (!cohortUp || process.env.RUNS === "0") console.log("SKIP timings" + (cohortUp ? "" : ": the cohort example isn't on 3212"));
else {
  const runs = Number(process.env.RUNS ?? 3);
  const open = async (h, socket, id) => {
    const t = Date.now();
    await post(socket, "/open", { viewId: id, server: "analytics", toolName: "get-cohort-data", toolInput: {}, cols: 100, maxRows: 30, theme: "dark", mode: "image" });
    await until(() => h.firstFrame.has(id), 20000);
    return h.firstFrame.get(id) - t;
  };
  const cold = [];
  const warm = [];
  const launch = [];
  for (let i = 0; i < runs; i++) {
    let h = startHelper("iTerm.app");
    let s = await h.ready;
    cold.push(await open(h, s, `cold-${i}`));
    h.helper.kill("SIGTERM");
    await new Promise((r) => h.helper.once("exit", r));
    h = startHelper("iTerm.app");
    s = await h.ready;
    const t = Date.now();
    await post(s, "/prewarm", {});
    launch.push(Date.now() - t);
    warm.push(await open(h, s, `warm-${i}`));
    h.helper.kill("SIGTERM");
    await new Promise((r) => h.helper.once("exit", r));
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`first picture, Chrome cold: ${cold.join(", ")} ms (median ${median(cold)})`);
  console.log(`Chrome started ahead (/prewarm): ${launch.join(", ")} ms (median ${median(launch)})`);
  console.log(`first picture after that: ${warm.join(", ")} ms (median ${median(warm)})`);
}

fs.rmSync(storeDir, { recursive: true, force: true });
fs.rmSync(config, { force: true });
mcp.close();
elsewhere.close();
process.exit(failed ? 1 : 0);
