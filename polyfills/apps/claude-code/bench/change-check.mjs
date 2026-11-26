// Whether the helper sees a change that moves neither the DOM nor animation
// frames: an app that redraws a canvas from a timer, once a second. The
// helper's change hook counts canvas draw calls, so its poll (every 500 ms)
// sees each redraw before the next; the full capture alone, every 3 s, would
// skip most of them.
//
//   node change-check.mjs
//   MCP_APPS_CLI_HELPER=../mod/helper/bin/darwin-arm64/mcp-apps-cli-helper node change-check.mjs
//
// Each redraw paints the canvas a colour of its own and says which. PASS when
// every redraw made while the view showed became a picture of its own (a
// picture in that redraw's colour), FAIL (exit 1) otherwise. It prints each
// redraw's delay to its picture, for information.

import { spawn } from "./answer-checks.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));
const { decodePng } = await import(pathToFileURL(path.join(HELPER, "png.mjs")).href);

// Longer than a poll and a capture, shorter than the full capture's 3 s.
const PERIOD_MS = 1000;
// Redraws judged (those made once the view showed its first picture).
const JUDGED = 6;
// Redraws a counter every PERIOD_MS from setTimeout: no DOM mutation, no
// requestAnimationFrame. Each fills the canvas with a colour of its own and
// reports its number, its time and that colour (read back from the canvas)
// as model context.
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
    var p = x.getImageData(6, 6, 1, 1).data;
    send({ jsonrpc: "2.0", id: 100 + n, method: "ui/update-model-context", params: { content: [{ type: "text", text: "redraw " + n + " " + Date.now() + " " + p[0] + "," + p[1] + "," + p[2] }] } });
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
// Each picture: when it came, and the colour at the canvas's (6, 6).
const pictures = [];
const redraws = [];
// The picture's PNG, whichever way the frame carries it.
function pngOf(image) {
  if (image.png) return Buffer.from(image.png, "base64");
  if (image.file) return fs.readFileSync(image.file);
  if (image.strips?.[0]?.png) return Buffer.from(image.strips[0].png, "base64");
  return null;
}
function colourOf(image) {
  try {
    const png = pngOf(image);
    if (!png) return null;
    const { width, data } = decodePng(png);
    // The picture is cols * 8 CSS pixels wide, at its own scale.
    const scale = width / (image.cols * 8);
    const at = (Math.round(6 * scale) * width + Math.round(6 * scale)) * 4;
    return [data[at], data[at + 1], data[at + 2]];
  } catch {
    return null;
  }
}
const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= 6);
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
      if (m.type === "frame" && m.image) pictures.push({ at: Date.now(), colour: colourOf(m.image) });
      if (m.type === "notify" && m.method === "ui/update-model-context") {
        const text = m.params?.content?.[0]?.text ?? "";
        const at = /redraw (\d+) (\d+) (\d+),(\d+),(\d+)/.exec(text);
        if (at) redraws.push({ n: Number(at[1]), at: Number(at[2]), colour: [Number(at[3]), Number(at[4]), Number(at[5])] });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Judged: the redraws made once the view showed its first picture (before
// that, the view is still opening, which smoke-check.mjs times).
const judged = () => redraws.filter((r) => pictures.length > 0 && r.at >= pictures[0].at);
const shown = (r) => pictures.some((p) => same(p.colour, r.colour));
// Until JUDGED redraws were made and the app drew once more after the last
// (a picture of a redraw can only be taken before the next one); 30 s at
// most, for a view that stopped.
for (let t = 0; t < 30_000; t += 50) {
  const j = judged();
  if (j.length > JUDGED || (j.length === JUDGED && shown(j[JUDGED - 1]))) break;
  await sleep(50);
}
const checked = judged().slice(0, JUDGED);
const seen = checked.filter(shown);
const delay = (r) => {
  const p = pictures.find((p) => p.at >= r.at && same(p.colour, r.colour));
  return p ? `${p.at - r.at}` : "none";
};
console.log(`helper: ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"}`);
console.log(`${checked.length} redraws, ${pictures.length} pictures (${pictures.filter((p) => !p.colour).length} unreadable); delay from each redraw to its picture (ms): ${checked.map(delay).join(" ")}`);
const ok = checked.length === JUDGED && seen.length === checked.length;
console.log(`${ok ? "PASS" : "FAIL"} each redraw from a timer becomes a picture of its own: ${seen.length}/${checked.length}`);
helper.kill("SIGTERM");
mcp.close();
await new Promise((r) => setTimeout(r, 1000));
process.exit(ok ? 0 : 1);
