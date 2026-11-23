// How soon the helper sees a change that moves neither the DOM nor animation
// frames: an app that redraws a canvas from a timer. The helper's change
// hook counts canvas draw calls, so its poll (every 400 ms) sees each redraw;
// before it did, a redraw showed only at the full capture, every 3 s.
//
//   node change-check.mjs
//   MCP_APPS_CLI_HELPER=../mod/helper/bin/darwin-arm64/mcp-apps-cli-helper node change-check.mjs
//
// Prints the pictures seen and their delay after each redraw; PASS when every
// redraw became a picture within 600 ms (a poll's wait and a capture), FAIL
// (exit 1) otherwise.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));

const PERIOD_MS = 700;
const SECONDS = 7;
// Redraws a counter every PERIOD_MS from setTimeout: no DOM mutation, no
// requestAnimationFrame. It reports each redraw's time as model context, so
// the check can line pictures up against redraws.
const APP = `<!doctype html><html><body style="margin:0;background:#111"><canvas id="c" width="320" height="64"></canvas><script>
(function () {
  var x = document.getElementById("c").getContext("2d"), n = 0;
  function send(m) { parent.postMessage(m, "*"); }
  window.addEventListener("message", function (e) {
    if (e.data && e.data.id === 1 && e.data.result) send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "timer", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
  function draw() {
    n++;
    x.fillStyle = "hsl(" + (n * 47 % 360) + ",70%,50%)"; x.fillRect(0, 0, 320, 64);
    x.fillStyle = "#fff"; x.font = "32px sans-serif"; x.fillText("redraw " + n, 10, 44);
    send({ jsonrpc: "2.0", id: 100 + n, method: "ui/update-model-context", params: { content: [{ type: "text", text: "redraw " + n + " " + Date.now() }] } });
    setTimeout(draw, ${PERIOD_MS});
  }
  setTimeout(draw, 1500);
})();
</script></body></html>`;

function mcpServer() {
  const server = new McpServer({ name: "change-check", version: "1.0.0" });
  server.registerTool("timer", { description: "Timer", inputSchema: {}, _meta: { ui: { resourceUri: "ui://change-check/timer" } } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  server.registerResource("timer", "ui://change-check/timer", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://change-check/timer", mimeType: "text/html;profile=mcp-app", text: APP }],
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
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
const config = JSON.stringify({ mcpServers: { timer: { type: "http", url: `http://127.0.0.1:${mcp.address().port}/mcp` } } });

const [cmd, args] = process.env.MCP_APPS_CLI_HELPER
  ? [process.env.MCP_APPS_CLI_HELPER, ["--mcp-config", config]]
  : [process.execPath, [path.join(HELPER, "helper.mjs"), "--mcp-config", config]];
const helper = spawn(cmd, args, { env: { ...process.env, TERM_PROGRAM: "ghostty" }, stdio: ["pipe", "pipe", "pipe"] });
helper.stderr.resume();
const pictures = [];
const redraws = [];
let ready;
let buf = "";
const readyLine = new Promise((resolve) => {
  helper.stdout.on("data", (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "ready") resolve(m);
      if (m.type === "frame") pictures.push(Date.now());
      if (m.type === "notify" && m.method === "ui/update-model-context") {
        const text = m.params?.content?.[0]?.text ?? "";
        const at = /redraw \d+ (\d+)/.exec(text);
        if (at) redraws.push(Number(at[1]));
      }
    }
  });
});
ready = await readyLine;
const post = (route, body) =>
  new Promise((resolve) => {
    const where = ready.socket ? { socketPath: ready.socket } : { host: "127.0.0.1", port: new URL(ready.url).port };
    const q = http.request({ ...where, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": ready.token } }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => resolve(JSON.parse(t)));
    });
    q.on("error", (e) => resolve({ ok: false, error: String(e) }));
    q.end(JSON.stringify(body));
  });

const opened = await post("/open", { viewId: "timer", server: "timer", toolName: "timer", toolInput: {}, cols: 60, maxRows: 6, theme: "dark", mode: "image" });
if (!opened.ok) {
  console.log("FAIL the view didn't open:", opened.error);
  helper.kill("SIGTERM");
  process.exit(1);
}
await new Promise((r) => setTimeout(r, SECONDS * 1000));
// Each redraw's delay: from its time to the first picture after it.
const delays = redraws.map((t) => {
  const next = pictures.find((p) => p >= t);
  return next === undefined ? Infinity : next - t;
});
const prompt = delays.filter((d) => d <= 600).length;
const fmt = (d) => (Number.isFinite(d) ? `${d}` : "none");
console.log(`helper: ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"}`);
console.log(`${redraws.length} redraws, ${pictures.length} pictures; delay after each redraw (ms): ${delays.map(fmt).join(" ")}`);
const ok = redraws.length >= 4 && prompt === redraws.length;
console.log(`${ok ? "PASS" : "FAIL"} redraws from a timer become pictures within 600 ms: ${prompt}/${redraws.length}`);
helper.kill("SIGTERM");
mcp.close();
await new Promise((r) => setTimeout(r, 1000));
process.exit(ok ? 0 : 1);
