#!/usr/bin/env node
// Drives the helper the way the mod does, without Claude Code: opens a tool's
// view, prints each frame to the terminal, clicks a button by its label and
// types into a field, answering the app's tool calls with an MCP client of
// its own in place of Claude Code's connection.
//
//   node preview.mjs --mcp-config cfg.json --server vanilla --tool get-time \
//     [--click "Get Server Time"] [--type "hello"] [--cols 100]

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const opts = parse(process.argv.slice(2));
const config = JSON.parse(fs.readFileSync(opts["mcp-config"], "utf8")).mcpServers[opts.server];

const helper = spawn(process.execPath, [path.join(HERE, "helper.mjs"), "--mcp-config", opts["mcp-config"]], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, MCP_APPS_CLI_LINES: "1" },
});
const frames = [];
let socket;
const waiters = [];
const mcp = new Client({ name: "preview", version: "0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(config.url)));

readline.createInterface({ input: helper.stdout }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "ready") socket = msg.socket;
  if (msg.type === "frame") frames.push(msg);
  if (msg.type === "request" && msg.method === "tools/call") {
    const result = await mcp.callTool(msg.params);
    await post("/reply", { id: msg.id, result });
    console.log(`  ↳ app called ${msg.params.name}, answered`);
  }
  if (msg.type === "notify") console.log(`  ↳ app sent ${msg.method}: ${JSON.stringify(msg.params).slice(0, 120)}`);
  for (const w of waiters.splice(0)) w();
});

await until(() => socket, 10_000, "helper ready");
const discovered = await post("/discover", { server: opts.server });
console.log("discovered:", JSON.stringify(discovered.tools));

const toolArgs = opts.args ? JSON.parse(fs.readFileSync(opts.args, "utf8")) : {};
const toolResult = await mcp.callTool({ name: opts.tool, arguments: toolArgs });
const viewId = "preview-1";
const t0 = Date.now();
const opened = await post("/open", {
  viewId,
  server: opts.server,
  toolName: opts.tool,
  toolInput: toolArgs,
  toolResult,
  cols: Number(opts.cols ?? 100),
  maxRows: 30,
  theme: opts.theme ?? "dark",
});
console.log("open:", JSON.stringify(opened));
await settle();
console.log(`first stable frame after ${Date.now() - t0} ms`);
show("initial");

if (opts["pre-keys"]) {
  for (const key of opts["pre-keys"].split(",")) {
    await post("/input", { viewId, event: { kind: "key", key } });
  }
  await settle(1000);
  show(`after ${opts["pre-keys"]}`);
}

if (opts.click) {
  const before = text(last());
  const where = find(last(), opts.click);
  if (!where) throw new Error(`"${opts.click}" not in frame`);
  console.log(`clicking "${opts.click}" at cell ${where.x},${where.y}`);
  await post("/input", { viewId, event: { kind: "pointer", type: "down", x: where.x + 2, y: where.y, button: "left" } });
  await post("/input", { viewId, event: { kind: "pointer", type: "up", x: where.x + 2, y: where.y, button: "left" } });
  await settle(1500);
  show(`after clicking "${opts.click}"`);
  console.log(text(last()) === before ? "RESULT: frame unchanged" : "RESULT: frame changed");
}

if (opts.keys) {
  // Comma-separated key names after the click, e.g. --keys down,return
  for (const key of opts.keys.split(",")) {
    await post("/input", { viewId, event: { kind: "key", key } });
  }
  await settle(1500);
  show(`after keys ${opts.keys}`);
}

if (opts.type) {
  const field = find(last(), opts.field ?? "This is message text.");
  if (field) {
    await post("/input", { viewId, event: { kind: "pointer", type: "down", x: field.x + 1, y: field.y, button: "left" } });
    await post("/input", { viewId, event: { kind: "pointer", type: "up", x: field.x + 1, y: field.y, button: "left" } });
    await post("/input", { viewId, event: { kind: "key", key: "a", meta: true } });
    for (const ch of opts.type) await post("/input", { viewId, event: { kind: "key", key: ch } });
    await settle(1000);
    show(`after typing "${opts.type}"`);
    console.log(text(last()).includes(opts.type) ? "RESULT: typed text visible" : "RESULT: typed text missing");
  }
}

if (opts.fps) {
  const before = frames.length;
  await new Promise((r) => setTimeout(r, Number(opts.fps) * 1000));
  console.log(`frames per second over ${opts.fps}s: ${((frames.length - before) / Number(opts.fps)).toFixed(1)}`);
}

if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(last(), null, 0));
await post("/close", { viewId });
helper.kill("SIGTERM");
await mcp.close();
process.exit(0);

// ---------------------------------------------------------------- helpers

function last() {
  return frames[frames.length - 1];
}

async function settle(minMs = 0) {
  const start = Date.now();
  await until(() => frames.length > 0, 20_000, "first frame");
  let count = frames.length;
  let quietSince = Date.now();
  while (Date.now() - start < 20_000) {
    await new Promise((r) => setTimeout(r, 100));
    if (frames.length !== count) {
      count = frames.length;
      quietSince = Date.now();
    }
    if (Date.now() - quietSince > 900 && Date.now() - start >= minMs) return;
  }
}

function text(message) {
  return message.frame.lines.map((runs) => runs.map((r) => r[0]).join("")).join("\n");
}

function find(message, label) {
  const rows = text(message).split("\n");
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y].indexOf(label);
    if (x >= 0) return { x, y };
  }
  return null;
}

function show(title) {
  const message = last();
  console.log(`\n── ${title} (v${message.v}, ${message.frame.cols}×${message.frame.rows}, ${JSON.stringify(message.frame).length} chars)`);
  for (const runs of message.frame.lines) {
    let out = "";
    for (const [t, fg, bg, flags] of runs) {
      let sgr = "";
      if (fg) sgr += `\x1b[38;2;${rgb(fg)}m`;
      if (bg) sgr += `\x1b[48;2;${rgb(bg)}m`;
      if (flags & 1) sgr += "\x1b[1m";
      if (flags & 2) sgr += "\x1b[7m";
      if (flags & 4) sgr += "\x1b[2m";
      out += `${sgr}${t}\x1b[0m`;
    }
    console.log(out);
  }
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function post(route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: route, method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function until(check, ms, what) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function parse(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 2) out[list[i].replace(/^--/, "")] = list[i + 1];
  return out;
}
