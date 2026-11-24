// Hours of use, compressed: three views that never stop changing (the 3D
// scene, live system stats, a hover sweep over the cohort heatmap) for
// SOAK_MIN minutes (10 by default), the helper's and Chrome's memory sampled
// every 30 s. Memory should level off after warming up; frames should keep
// coming the whole time.
//
//   SOAK_MIN=60 MCP_APPS_CLI_HELPER=<binary> node soak-check.mjs
//
// Needs the example servers in mcp-examples.json (3212, 3202, 3203). Memory is
// macOS's physical footprint (vmmap); elsewhere, resident size (ps). PASS if
// the helper grew under 15 MB and Chrome under 100 MB from the first sample
// after warm-up (2 minutes in) to the last, and every view drew in each
// window; FAIL (exit 1) otherwise.

import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sdk = (p) => pathToFileURL(path.join(HERE, "..", "mod", "helper", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { Client } = await import(sdk("client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk("client/streamableHttp.js"));
// The app's own tool calls (the system monitor polls its server), made as
// Claude Code would: over an MCP connection of this check's.
const servers = JSON.parse(fs.readFileSync(path.join(HERE, "mcp-examples.json"), "utf8")).mcpServers;
const clients = {};
const clientFor = (name) =>
  (clients[name] ??= (async () => {
    const client = new Client({ name: "soak", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(servers[name].url)));
    return client;
  })());
const MINUTES = Number(process.env.SOAK_MIN ?? 10);
const SAMPLE_MS = 30_000;
const WARM_MS = 120_000;
const scene = JSON.parse(fs.readFileSync(path.join(HERE, "scenarios", "bloom-scene.json"), "utf8"));

const [cmd, args] = process.env.MCP_APPS_CLI_HELPER
  ? [process.env.MCP_APPS_CLI_HELPER, []]
  : [process.execPath, [path.join(HERE, "..", "mod", "helper", "helper.mjs")]];
const helper = spawn(cmd, [...args, "--mcp-config", path.join(HERE, "mcp-examples.json")], {
  env: { ...process.env, TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.9" },
  stdio: ["pipe", "pipe", "pipe"],
});
helper.stderr.resume();
const drawn = { s: 0, m: 0, c: 0 };
let buf = "";
const ready = await new Promise((resolve) =>
  helper.stdout.on("data", (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "ready") resolve(m);
      if (m.type === "frame" && m.viewId in drawn) drawn[m.viewId]++;
      if (m.type === "request" && (m.method === "ui/allow-tool" || m.method === "ui/allow-read")) void post("/reply", { id: m.id, result: { allow: true } });
      if (m.type === "request" && m.method === "tools/call") {
        const server = viewServer[m.viewId];
        void clientFor(server)
          .then((client) => client.callTool({ name: m.params.name, arguments: m.params.arguments ?? {} }))
          .then((result) => post("/reply", { id: m.id, result }), (error) => post("/reply", { id: m.id, error: String(error) }));
      }
    }
  }),
);
const post = (route, body) =>
  new Promise((resolve) => {
    const q = http.request({ socketPath: ready.socket, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": ready.token } }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => resolve(t ? JSON.parse(t) : {}));
    });
    q.on("error", () => resolve({}));
    q.end(JSON.stringify(body));
  });
const viewServer = { s: "studio3d", m: "system", c: "analytics" };
for (const [id, server, toolName, toolInput] of [["s", "studio3d", "show_threejs_scene", scene], ["m", "system", "get-system-info", {}], ["c", "analytics", "get-cohort-data", {}]]) {
  // Each with its tool's result, as the mod opens a view once its call ran.
  const toolResult = await (await clientFor(server)).callTool({ name: toolName, arguments: toolInput });
  const opened = await post("/open", { viewId: id, server, toolName, toolInput, toolResult, cols: 100, maxRows: 30, theme: "dark", mode: "image" });
  if (!opened.ok) {
    console.log(`FAIL view ${id} didn't open: ${opened.error}`);
    helper.kill("SIGTERM");
    process.exit(1);
  }
}
// The pointer hops over the heatmap's cells, all along, resting between hops
// (a picture view is captured once the pointer rests).
let sweep = 0;
const sweeper = setInterval(() => {
  const x = 20 + ((sweep * 7) % 70);
  const y = 8 + (sweep++ % 12);
  void post("/input", { viewId: "c", event: { kind: "pointer", type: "move", x, y } });
}, 400);

const tree = (pid) => {
  const kids = execSync(`pgrep -P ${pid} || true`).toString().split("\n").filter(Boolean).map(Number);
  return [pid, ...kids.flatMap(tree)];
};
const memory = (pid) => {
  if (process.platform === "darwin") {
    const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(execFileSync("vmmap", ["-summary", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    return m ? Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]] : 0;
  }
  return Number(execSync(`ps -o rss= -p ${pid} || echo 0`).toString().trim() || 0) / 1024;
};
const samples = [];
const start = Date.now();
let last = { ...drawn };
let stalled = 0;
console.log(`soak: ${MINUTES} min, helper ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"}`);
while (Date.now() - start < MINUTES * 60_000) {
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  let chrome = 0;
  for (const pid of tree(helper.pid).slice(1)) {
    try { chrome += memory(pid); } catch {}
  }
  const own = memory(helper.pid);
  const window = Object.fromEntries(Object.keys(drawn).map((k) => [k, drawn[k] - last[k]]));
  if (Object.values(window).some((n) => n === 0)) stalled++;
  last = { ...drawn };
  samples.push({ t: Date.now() - start, own, chrome });
  console.log(`${((Date.now() - start) / 60000).toFixed(1).padStart(5)} min  helper ${own.toFixed(0).padStart(4)} MB  Chrome ${chrome.toFixed(0).padStart(5)} MB  frames ${JSON.stringify(window)}`);
}
clearInterval(sweeper);
const warm = samples.find((s) => s.t >= WARM_MS) ?? samples[0];
const end = samples.at(-1);
const grewOwn = end.own - warm.own;
const grewChrome = end.chrome - warm.chrome;
const ok = grewOwn < 15 && grewChrome < 100 && stalled === 0;
console.log(`${ok ? "PASS" : "FAIL"} after warm-up: helper ${grewOwn >= 0 ? "+" : ""}${grewOwn.toFixed(0)} MB, Chrome ${grewChrome >= 0 ? "+" : ""}${grewChrome.toFixed(0)} MB; windows with a view not drawing: ${stalled}`);
helper.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
process.exit(ok ? 0 : 1);
