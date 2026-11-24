// Runs the helper alone (no Claude Code) with one view and logs every
// picture it emits: fps, sizes, CPU, hover latency, drags, pausing. See README.md.
import { spawn } from "./answer-checks.mjs";
import http from "node:http";
import crypto from "node:crypto";
import fsMod from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require_fs = () => fsMod;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { Client } = await import(sdk("client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk("client/streamableHttp.js"));
const seconds = Number(process.argv[2] ?? 20);
const [port, serverName, toolName, inputFile, mode, savePng] = [process.argv[3] ?? "3212", process.argv[4] ?? "analytics", process.argv[5] ?? "get-cohort-data", process.argv[6], process.argv[7] ?? "image", process.argv[8]];
const toolInput = inputFile ? JSON.parse((await import("node:fs")).readFileSync(inputFile, "utf8")) : {};
const client = new Client({ name: "noise", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
const result = await client.callTool({ name: toolName, arguments: toolInput });
const helper = spawn(process.env.MCP_APPS_CLI_HELPER ?? process.execPath, [...(process.env.MCP_APPS_CLI_HELPER ? [] : [path.join(HELPER, "helper.mjs")]), "--mcp-config", process.env.DRIVER_MCP ?? path.join(HERE, "mcp-examples.json")], {
  env: { ...process.env, MCP_APPS_CLI_DEBUG: "1", TERM_PROGRAM: process.env.DRIVER_TERM ?? "ghostty", TERM_PROGRAM_VERSION: "3.6.9" }, stdio: ["pipe", "pipe", "pipe"] });
let socket; const t0 = Date.now(); const frames = [];
let buf = "";
helper.stderr.on("data", (d) => process.env.V && process.stderr.write(d));
const ready = new Promise((resolve) => helper.stdout.on("data", (d) => {
  buf += d; let k;
  while ((k = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, k); buf = buf.slice(k + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "ready") { socket = m.socket ? { socket: m.socket, token: m.token } : { url: m.url, token: m.token }; resolve(); }
    if (m.type === "request" && (m.method === "ui/allow-tool" || m.method === "ui/allow-read")) post("/reply", { id: m.id, result: { allow: true } });
    if (m.type === "request" && m.method === "tools/call") {
      client.callTool({ name: m.params.name, arguments: m.params.arguments ?? {} })
        .then((r) => post("/reply", { id: m.id, result: r }), (e) => post("/reply", { id: m.id, error: String(e) }));
    }
    if (m.type === "frame" && m.frame && savePng) fsMod.writeFileSync(savePng + ".frame.json", JSON.stringify(m.frame));
    if (m.type === "frame" && !m.image) frames.push({ t: (Date.now() - t0) / 1000, len: 0, hash: "cells" + frames.length, v: m.v });
    if (m.type === "frame" && m.image) {
      if (m.image.strips) {
        globalThis.bands ??= [];
        for (const st of m.image.strips) globalThis.bands[st.i] = Buffer.from(st.png, "base64");
        if (savePng) fsMod.writeFileSync(savePng + ".json", JSON.stringify(globalThis.bands.map((b) => b.toString("base64"))));
      }
      const bytes = m.image.png ? Buffer.from(m.image.png, "base64") : m.image.file ? fsMod.readFileSync(m.image.file) : Buffer.concat(m.image.strips.map((st) => Buffer.from(st.png, "base64")));
      if (savePng) fsMod.writeFileSync(savePng, bytes);
      const raw = bytes;
      frames.push({ t: (Date.now() - t0) / 1000, len: raw.length, hash: crypto.createHash("md5").update(raw.subarray(0, 33)).update(raw.subarray(60)).digest("hex").slice(0, 8), v: m.v });
    }
  }
}));
await ready;
const post = (route, body) => new Promise((resolve, reject) => {
  // The helper's socket, or its URL and token (Windows, or MCP_APPS_CLI_TRANSPORT=tcp).
  const where = socket.socket ? { socketPath: socket.socket } : { host: "127.0.0.1", port: new URL(socket.url).port };
  const token = { "x-mcp-apps-cli-token": socket.token };
  const req = http.request({ ...where, path: route, method: "POST", headers: { "content-type": "application/json", ...token } }, (res) => {
    let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve(JSON.parse(s))); });
  req.on("error", reject); req.end(JSON.stringify(body));
});
console.log("open", await post("/open", { viewId: "v1", server: serverName, toolName, toolInput, toolResult: result, cols: 137, maxRows: 31, theme: "dark", mode }));
const { execSync } = await import("node:child_process");
const cpu = [];
const tree = () => { const out = execSync("ps -axo pid=,ppid=,%cpu=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Set([helper.pid]); let grew = true; while (grew) { grew = false; for (const [p, pp] of out) if (kids.has(pp) && !kids.has(p)) { kids.add(p); grew = true; } }
  return out.filter(([p]) => kids.has(p)).reduce((a, [, , c]) => a + c, 0); };
await new Promise((r) => setTimeout(r, 4000));
let hoverWindow = null;
if (process.env.HOVER) {
  const start = (Date.now() - t0) / 1000;
  for (let k = 0; k < 50; k++) {
    // Across the heatmap rows, a cell or so per move.
    await post("/input", { viewId: "v1", event: { kind: "pointer", type: "move", x: 36 + (k % 25), y: 6 + Math.floor(k / 25) * 4, fine: { x: 36.3 + (k % 25), y: 6.4 + Math.floor(k / 25) * 4 } } });
    await new Promise((r) => setTimeout(r, 60));
  }
  if (process.env.PROBE) for (const type of ["down", "up"]) await post("/input", { viewId: "v1", event: { kind: "pointer", type, x: 60, y: 10, button: "left", fine: { x: 60.3, y: 10.4 } } });
  hoverWindow = [start, (Date.now() - t0) / 1000];
  if (process.env.SWEEP) {
    for (let k = 0; k < 3; k++) {
      await new Promise((r) => setTimeout(r, 1500));
      const start = Date.now(); const before = frames.length;
      const n = 68; // 1.5 s at 45 a second
      for (let j = 0; j <= n; j++) {
        const fx = 19 + ((k % 2 ? n - j : j) / n) * 22;
        await post("/input", { viewId: "v1", event: { kind: "pointer", type: "move", x: Math.floor(fx), y: 6, fine: { x: fx, y: 6.2 } } });
        await new Promise((r) => setTimeout(r, 22));
      }
      const stop = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      const mine = frames.slice(before).map((f) => +(f.t - (start - t0) / 1000).toFixed(2));
      console.log(`sweep ${((stop - start) / 1000).toFixed(2)}s: frames at ${mine.join(" ")} (stop at ${((stop - start) / 1000).toFixed(2)})`);
    }
  }
  if (process.env.HOPS) {
    await new Promise((r) => setTimeout(r, 1500));
    const lat = [];
    for (let k = 0; k < 6; k++) {
      const before = frames.length; const at = Date.now();
      // One hop onto another heatmap cell, then rest.
      await post("/input", { viewId: "v1", event: { kind: "pointer", type: "move", x: k % 2 ? 31 : 19, y: 6, fine: { x: (k % 2 ? 31 : 19) + 0.3, y: 6.2 } } });
      while (frames.length === before && Date.now() - at < 3000) await new Promise((r) => setTimeout(r, 5));
      lat.push(frames.length > before ? Date.now() - at : null);
      await new Promise((r) => setTimeout(r, 900));
    }
    console.log("hop latency ms", lat.join(" "));
  }
  console.log("hover from", hoverWindow[0].toFixed(2), "to", hoverWindow[1].toFixed(2));
}
if (process.env.DRAG) {
  // A drag across the scene (OrbitControls), a move every 50 ms for 4 s.
  const f0 = frames.length, t1 = Date.now(), c = [];
  await post("/input", { viewId: "v1", event: { kind: "pointer", type: "down", x: 40, y: 8, button: "left" } });
  // DRAG_HZ moves a second (20 by default); DRAG_FINE=0 sends whole cells only,
  // as a terminal without pixel mouse reports does (iTerm2 here).
  const hz = Number(process.env.DRAG_HZ ?? 20), fine = process.env.DRAG_FINE !== "0", moves = Math.round(4 * hz);
  for (let k = 0; k < moves; k++) {
    const x = 40 + k * (48 / moves), y = 8 + Math.sin(k / (moves / 10)) * 3;
    await post("/input", { viewId: "v1", event: { kind: "pointer", type: "move", x: fine ? x : Math.round(x), y: fine ? y : Math.round(y), ...(fine ? { fine: { x: x + 0.3, y: y + 0.2 } } : {}), button: "left" } });
    await new Promise((r) => setTimeout(r, 1000 / hz));
    if (k % Math.round(hz) === Math.round(hz) - 1) c.push(tree());
  }
  await post("/input", { viewId: "v1", event: { kind: "pointer", type: "up", x: 88, y: 8, button: "left" } });
  const secs = (Date.now() - t1) / 1000, drag = frames.slice(f0);
  console.log("drag", secs.toFixed(1) + "s", "pictures", drag.length, "fps", (drag.length / secs).toFixed(1), "avg KB", (drag.reduce((a, f) => a + f.len, 0) / Math.max(1, drag.length) / 1024).toFixed(0), "cpu%", (c.reduce((a, b) => a + b, 0) / c.length).toFixed(0));
}
if (process.env.PAUSE) {
  // Shown, then out of sight, then back: CPU of the helper and its Chrome in each.
  const phase = async (label) => { const c = [], f0 = frames.length; for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 1000)); c.push(tree()); }
    console.log(label.padEnd(8), "cpu%", (c.slice(1).reduce((a, b) => a + b, 0) / 5).toFixed(0), "pictures", frames.length - f0); };
  await phase("shown");
  console.log("pause", JSON.stringify(await post("/shown", { viewId: "v1", shown: false })));
  await phase("paused");
  await post("/shown", { viewId: "v1", shown: true });
  await phase("back");
}
for (let k = 0; k < (seconds - 4); k++) { await new Promise((r) => setTimeout(r, 1000)); cpu.push(tree()); }
console.log("cpu% mean", (cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1));
await post("/close", { viewId: "v1" }).catch(() => {});
helper.kill();
const kinds = new Map();
for (const f of frames) { if (!kinds.has(f.hash)) kinds.set(f.hash, kinds.size); }
console.log(frames.map((f) => `${f.t.toFixed(2)} v${f.v} #${kinds.get(f.hash)}`).join("\n"));
console.log("frames", frames.length, "distinct pixel sets", kinds.size);
const late = frames.filter((f) => f.t > 5); if (late.length > 1) console.log("fps after 5 s", ((late.length - 1) / (late[late.length - 1].t - late[0].t)).toFixed(1), "avg KB", (late.reduce((a, f) => a + f.len, 0) / late.length / 1024).toFixed(0));
if (hoverWindow) console.log("during hover", frames.filter((f) => f.t >= hoverWindow[0] && f.t <= hoverWindow[1]).length, "within 1.5 s after", frames.filter((f) => f.t > hoverWindow[1] && f.t <= hoverWindow[1] + 1.5).length);
process.exit(0);
