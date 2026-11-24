// A helper's essentials on any platform (Windows, Linux, macOS), for CI where
// the other checks' process tools (ps, pgrep) aren't there:
// - the ready line and its token (a request without it is refused);
// - /ping, and /discover against a small MCP server in this process;
// - Chrome started, and a view opened, its first frame drawn, then closed;
// - the helper ended outright, with Chrome running: no Chrome of it left
//   (Unix: its watcher; Windows: its job object).
//
//   MCP_APPS_CLI_HELPER=<binary> node smoke-check.mjs
//
// Prints PASS or FAIL per check; exits 1 on a failure. Needs Chrome (or
// MCP_APPS_CLI_CHROME) and the helper's packages (npm ci in ../mod/helper)
// for the MCP SDK this file's server uses.

import { execFileSync } from "node:child_process";
import { spawn } from "./answer-checks.mjs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));

const APP = `<!doctype html><html><body style="margin:0;font:16px sans-serif;background:#fff"><h1>Smoke</h1><p>a view</p></body></html>`;
function mcpServer() {
  const server = new McpServer({ name: "smoke", version: "1.0.0" });
  server.registerTool("show", { description: "Has a UI", inputSchema: {}, _meta: { ui: { resourceUri: "ui://smoke/app" } } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  server.registerResource("app", "ui://smoke/app", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://smoke/app", mimeType: "text/html;profile=mcp-app", text: APP }],
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
const config = JSON.stringify({ mcpServers: { smoke: { type: "http", url: `http://127.0.0.1:${mcp.address().port}/mcp` } } });

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${got === undefined ? "" : `: ${got}`}`);
};

const [cmd, args] = process.env.MCP_APPS_CLI_HELPER
  ? [process.env.MCP_APPS_CLI_HELPER, ["--mcp-config", config]]
  : [process.execPath, [path.join(HELPER, "helper.mjs"), "--mcp-config", config]];
console.log(`helper: ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"} on ${process.platform}-${process.arch}`);
// Full colour: cell frames carry their text as styled rows, which the check reads.
const helper = spawn(cmd, args, { env: { ...process.env, TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor", MCP_APPS_CLI_CHROME_IDLE_S: "0" }, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
helper.stderr.on("data", (d) => (stderr += d));
const frames = [];
let buf = "";
const exited = new Promise((r) => helper.on("exit", r));
const ready = await Promise.race([
  new Promise((resolve) =>
    helper.stdout.on("data", (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "ready") resolve(m);
        if (m.type === "frame") frames.push(m);
      }
    }),
  ),
  exited.then(() => null),
  new Promise((r) => setTimeout(() => r(null), 30_000)),
]);
check("ready line with a token", ready && /^[0-9a-f]{64}$/.test(ready.token ?? "") && (ready.socket || ready.url), ready ? (ready.socket ? "socket" : ready.url) : `none; stderr: ${stderr.slice(-500)}`);
if (!ready) process.exit(1);

const post = (route, body, token = ready.token) =>
  new Promise((resolve) => {
    const where = ready.socket ? { socketPath: ready.socket } : { host: "127.0.0.1", port: new URL(ready.url).port };
    const q = http.request({ ...where, path: route, method: "POST", headers: token ? { "x-mcp-apps-cli-token": token } : {} }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => {
        let json;
        try { json = JSON.parse(t); } catch { json = t; }
        resolve({ status: r.statusCode, json });
      });
    });
    q.on("error", (e) => resolve({ status: 0, json: String(e) }));
    q.end(JSON.stringify(body ?? {}));
  });

check("a request without the token is refused", (await post("/ping", {}, "")).status === 403);
const ping = await post("/ping");
check("/ping", ping.status === 200 && ping.json.ok === true, JSON.stringify(ping.json));
const found = (await post("/discover", { server: "smoke" })).json;
check("/discover finds the tool's UI", found.ok && found.tools?.show?.resourceUri === "ui://smoke/app", JSON.stringify(found).slice(0, 200));
const warm = await post("/prewarm");
check("Chrome starts", warm.json.ok === true, JSON.stringify(warm.json));
const opened = await post("/open", { viewId: "v", server: "smoke", toolName: "show", toolInput: {}, cols: 60, maxRows: 8, theme: "light", mode: "cells" });
check("a view opens", opened.json.ok === true, JSON.stringify(opened.json));
const deadline = Date.now() + 20_000;
while (!frames.some((f) => f.viewId === "v") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
const frame = frames.find((f) => f.viewId === "v")?.frame;
// Rows of styled runs, [text, fg, bg, flags]: a row's text is its runs' joined.
const rows = (frame?.styled ?? []).map((row) => row.map((run) => run[0]).join(""));
const heading = rows.find((row) => row.includes("Smoke"));
check("its first frame is drawn, with the app's text", Boolean(heading), frame ? `${frame.cols}x${frame.rows}: ${JSON.stringify((heading ?? rows.join("|")).trim().slice(0, 60))}` : "no frame");
check("/close", (await post("/close", { viewId: "v" })).json.ok === true);
await post("/open", { viewId: "w", server: "smoke", toolName: "show", toolInput: {}, cols: 60, maxRows: 8, theme: "light", mode: "cells" });

// Chrome processes on this helper's profile (its folder is named for its pid).
const marker = `mcp-apps-cli-${helper.pid}.tmp`;
const chromes = () => {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8", windowsHide: true })
        : execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => l.includes(marker) && /chrom|msedge|brave/i.test(l)).length;
  } catch {
    return -1;
  }
};
const before = chromes();
check("Chrome runs on the helper's own profile", before > 0, `${before} process(es)`);
helper.kill("SIGKILL");
await exited;
let after = before;
for (let i = 0; i < 20 && after > 0; i++) {
  await new Promise((r) => setTimeout(r, 500));
  after = chromes();
}
check("the helper ended outright leaves no Chrome", after === 0, `${after} left`);
mcp.close();
console.log(`smoke: ${failed ? `${failed} failed` : "all passed"} (${os.platform()})`);
process.exit(failed ? 1 : 0);
