// A helper ended outright (as Claude Code ends it when it quits) leaves its
// Chrome profile behind; the next helper removes it. One ended cleanly
// removes its own. Prints what's left at each step.
//
//   node leak-check.mjs
import { execSync } from "node:child_process";
import { spawn } from "./answer-checks.mjs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const H = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mod", "helper", "helper.mjs");
const start = () => new Promise((resolve) => { const p = spawn(process.env.MCP_APPS_CLI_HELPER ?? process.execPath, process.env.MCP_APPS_CLI_HELPER ? [] : [H], { stdio: ["pipe", "pipe", "pipe"] }); let b = ""; p.stdout.on("data", (d) => { b += d; for (const line of b.split("\n")) { try { const m = JSON.parse(line); if (m.type === "ready") resolve({ p, socket: m.socket, token: m.token }); } catch {} } }); });
const post = (h, route) => new Promise((r) => { const q = http.request({ socketPath: h.socket, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": h.token } }, (res) => { res.resume(); res.on("end", r); }); q.end("{}"); });
const own = (pid) => path.join(os.tmpdir(), `mcp-apps-cli-${pid}.tmp`);
const list = (pid) => (fs.existsSync(own(pid)) ? fs.readdirSync(own(pid)).join(",") : "(gone)");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Chrome processes running on a profile in a helper's folder.
const chromes = (pid) =>
  execSync("ps -A -ww -o pid=,args=").toString().split("\n").filter((l) => l.includes(`--user-data-dir=${own(pid)}`)).length;
// 1. Killed outright, as Claude Code does when it quits.
const a = await start(); await post(a, "/prewarm"); await wait(1000);
console.log("helper A running, its folder:", list(a.p.pid));
a.p.kill("SIGKILL"); await wait(1500);
console.log("after SIGKILL, A's folder:", list(a.p.pid), "| A's Chrome:", chromes(a.p.pid) ? "still running" : "gone");
// 2. The next helper sweeps it when it starts Chrome; then a clean shutdown.
const b = await start(); await post(b, "/prewarm"); await wait(1000);
console.log("helper B started; A's folder:", list(a.p.pid), "| A's Chrome:", chromes(a.p.pid) ? "still running" : "gone", "| B's:", list(b.p.pid));
b.p.kill("SIGTERM"); await wait(2500);
console.log("after SIGTERM, B's folder:", list(b.p.pid), "| B's Chrome:", chromes(b.p.pid) ? "still running" : "gone");
// A Chrome left running after its helper is gone is a leak (each holds hundreds of MB).
process.exit(chromes(a.p.pid) || chromes(b.p.pid) ? 1 : 0);
