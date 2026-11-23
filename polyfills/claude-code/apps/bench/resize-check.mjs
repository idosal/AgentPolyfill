// Opens a view at 100 columns and resizes it to 137 right away, as the mod
// does when it learns the real width, N times; checks each settled picture is
// whole: the header's right end (the cohort heatmap's dropdowns) drawn, and
// its bottom (the legend) not left grey. Exits 1 on a bad picture.
//
//   node resize-check.mjs [N]      (MAXROWS=36 shrinks the app to fit)
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const CONFIG = path.join(HERE, "mcp-examples.json");
const { decodePng } = await import(pathToFileURL(path.join(HELPER, "png.mjs")).href);
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href;
const { Client } = await import(sdk("client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk("client/streamableHttp.js"));
const N = Number(process.argv[2] ?? 12), TERM = process.env.DRIVER_TERM ?? "ghostty";
const [port, server, tool] = (process.env.APP ?? "3212 analytics get-cohort-data").split(" ");
const client = new Client({ name: "stress", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
const helper = spawn(process.env.MCP_APPS_CLI_HELPER ?? process.execPath, [...(process.env.MCP_APPS_CLI_HELPER ? [] : [path.join(HELPER, "helper.mjs")]), "--mcp-config", CONFIG], { env: { ...process.env, TERM_PROGRAM: TERM, MCP_APPS_CLI_DEBUG: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", socket, token; const last = {};
const post = (route, body) => new Promise((resolve, reject) => { const q = http.request({ socketPath: socket, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": token } }, (r) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => resolve(JSON.parse(t))); }); q.on("error", reject); q.end(JSON.stringify(body)); });
let stderr = ""; helper.stderr.on("data", (d) => (stderr += d));
await new Promise((resolve) => helper.stdout.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.type === "ready") { socket = m.socket; token = m.token; resolve(); }
  if (m.type === "request" && m.method === "ui/allow-tool") post("/reply", { id: m.id, result: { allow: true } });
  if (m.type === "request" && m.method === "tools/call") client.callTool({ name: m.params.name, arguments: m.params.arguments ?? {} }).then((r) => post("/reply", { id: m.id, result: r }), (e) => post("/reply", { id: m.id, error: String(e) }));
  if (m.type === "frame" && m.image) { const png = m.image.file ? fs.readFileSync(m.image.file) : m.image.png ? Buffer.from(m.image.png, "base64") : null; last[m.viewId] = { cols: m.image.cols, png }; } } }));
const result = await client.callTool({ name: tool, arguments: {} });
let bad = 0;
for (let i = 0; i < N; i++) {
  const viewId = `v${i}`;
  // As the mod does: open at its first guess, then, once open, the real width.
  await post("/open", { viewId, server, toolName: tool, toolInput: {}, toolResult: result, cols: 100, maxRows: Number(process.env.MAXROWS ?? 31), theme: "dark", mode: "image" });
  await new Promise((r) => setTimeout(r, Math.random() * 300));
  await post("/resize", { viewId, cols: 137, maxRows: Number(process.env.MAXROWS ?? 31) });
  await new Promise((r) => setTimeout(r, 2500));
  const f = last[viewId];
  let note = "no picture";
  if (f?.png) {
    const { width, height, data } = decodePng(f.png);
    // The header's right end (the Metric/Period dropdowns): one flat colour
    // there is the area Chrome didn't draw.
    const x0 = Math.floor(width * 0.93), counts = new Map();
    for (let y = 0; y < Math.min(height, 110); y += 2) for (let x = x0; x < width; x += 2) { const o = (y * width + x) * 4; const k = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const top = Math.max(...counts.values()) / [...counts.values()].reduce((a, b) => a + b, 0);
    // The bottom 12%: Chrome's grey (#202020) where it didn't draw.
    let grey = 0, n = 0;
    for (let y = Math.floor(height * 0.88); y < height; y += 2) for (let x = 0; x < width; x += 6) { const o = (y * width + x) * 4; n++; if (data[o] === 32 && data[o + 1] === 32 && data[o + 2] === 32) grey++; }
    const wrong = width !== f.cols * 16 || top > 0.995 || grey / n > 0.5;
    if (wrong) bad++;
    note = `${width}px for ${f.cols} cols, header's right end ${(top * 100).toFixed(1)}% one colour, bottom ${(100 * grey / n).toFixed(0)}% grey${wrong ? "  <-- BAD" : ""}`;
  }
  if (process.env.SAVE && f?.png) fs.writeFileSync(`${process.env.SAVE}-${viewId}.png`, f.png);
    console.log(viewId, note);
  await post("/close", { viewId });
}
console.log(`bad ${bad}/${N}`);
helper.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 1500)); process.exit(bad ? 1 : 0);
