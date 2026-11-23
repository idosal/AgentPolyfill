// Cells: open the cohort heatmap at 100 columns and resize it to 137 (as the
// mod does), switch Period to Weekly (click, then down), and check the
// "Dec 2025" row stays whole: a bar before each number, no stray low blocks.
// N times; exits 1 on a garbled row.
//
//   OPEN_COLS=100 COLORTERM=truecolor node cells-update-check.mjs [N]
//   (or MCP_APPS_CLI_LINES=1 without full colour)
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const CONFIG = path.join(HERE, "mcp-examples.json");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href;
const { Client } = await import(sdk("client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk("client/streamableHttp.js"));
const N = Number(process.argv[2] ?? 6);
const client = new Client({ name: "weekly", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3212/mcp")));
const helper = spawn(process.env.MCP_APPS_CLI_HELPER ?? process.execPath, [...(process.env.MCP_APPS_CLI_HELPER ? [] : [path.join(HELPER, "helper.mjs")]), "--mcp-config", CONFIG], { env: { ...process.env, TERM_PROGRAM: "Apple_Terminal", MCP_APPS_CLI_DEBUG: "1", COLORTERM: process.env.COLORTERM ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", socket, token; const frames = {};
const post = (route, body) => new Promise((resolve, reject) => { const q = http.request({ socketPath: socket, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": token } }, (r) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => resolve(JSON.parse(t))); }); q.on("error", reject); q.end(JSON.stringify(body)); });
const rowText = (frame) => { if (frame.styled) return frame.styled.map((runs) => runs.map((r) => r[0]).join("")); if (frame.lines) return frame.lines.map((row) => (Array.isArray(row) ? row.map((r) => r[0]).join("") : row)); return []; };
await new Promise((resolve) => helper.stdout.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.type === "ready") { socket = m.socket; token = m.token; resolve(); }
  if (m.type === "request" && m.method === "ui/allow-tool") post("/reply", { id: m.id, result: { allow: true } });
  if (m.type === "request" && m.method === "tools/call") client.callTool({ name: m.params.name, arguments: m.params.arguments ?? {} }).then((r) => post("/reply", { id: m.id, result: r }), (e) => post("/reply", { id: m.id, error: String(e) }));
  if (m.type === "frame" && m.frame) (frames[m.viewId] ??= []).push({ t: Date.now(), frame: m.frame }); } }));
const result = await client.callTool({ name: "get-cohort-data", arguments: {} });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, firstFrameKeys;
for (let i = 0; i < N; i++) {
  const viewId = `w${i}`;
  await post("/open", { viewId, server: "analytics", toolName: "get-cohort-data", toolInput: {}, toolResult: result, cols: Number(process.env.OPEN_COLS ?? 137), maxRows: 31, theme: "dark", mode: "cells" });
  if (process.env.OPEN_COLS) { await settle(Math.random() * 300); await post("/resize", { viewId, cols: 137, maxRows: 31 }); }
  await settle(2500);
  firstFrameKeys ??= Object.keys(frames[viewId]?.at(-1)?.frame ?? {});
  const before = rowText(frames[viewId].at(-1).frame).find((l) => l.includes("Dec 2025")) ?? "";
  const blocks = (l) => (l.match(/[▎▊]/g) ?? []).length;
  if (process.env.SHOW) console.log("  before:", JSON.stringify(before.trim().slice(0, 90)), "bars", blocks(before));
  const at = await post("/locate", { text: "Monthly" });
  if (!at.ok) { console.log(viewId, "no Monthly select", JSON.stringify(at)); continue; }
  const t0 = Date.now();
  await post("/input", { viewId, event: { kind: "pointer", type: "down", x: at.cellX, y: at.cellY, button: "left" } });
  await post("/input", { viewId, event: { kind: "pointer", type: "up", x: at.cellX, y: at.cellY, button: "left" } });
  await settle(150);
  await post("/input", { viewId, event: { kind: "key", key: "down" } });
  await settle(3000);
  const after = frames[viewId].filter((f) => f.t > t0).map((f) => rowText(f.frame).find((l) => l.includes("Dec 2025")) ?? "");
  const final = after.at(-1) ?? "";
  // Clean rows have a block right before each number ("▎ 100▊ 80 ▊"); the garbled
  // ones have stray low blocks between ("▂  ▊  ▂ 100 ▂ 86").
  // Clean: a left bar before each of the row's 12 numbers.
  const garbled = /[▁▂]/.test(final) || blocks(final) < 10 || /[▁▂]/.test(before) || blocks(before) < 10;
  if (garbled) bad++;
  console.log(viewId, `${after.length} frames after; final${garbled ? " GARBLED" : ""}:`, JSON.stringify(final.trim().slice(0, 90)));
  if (process.env.SHOW) for (const a of after) console.log("     ", JSON.stringify(a.trim().slice(0, 70)));
  await post("/close", { viewId });
}
console.log("frame keys:", firstFrameKeys?.join(","), ` garbled ${bad}/${N}`);
helper.kill("SIGTERM"); await settle(1500); process.exit(bad ? 1 : 0);
