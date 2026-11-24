// Checks view stores (see "view stores" in ../mod/helper/helper.mjs): an app
// that counts its own opens in localStorage and IndexedDB, served by a small
// MCP server in this process, opened through the helper.
//
//   node store-check.mjs
//
// The same view, closed and opened again, and again after a helper restart,
// keeps counting; another view of the same app starts from 1. Prints PASS or
// FAIL per check and exits 1 on a failure. Needs Chrome and the helper's
// packages (npm install in ../mod/helper).

import { execFileSync } from "node:child_process";
import { spawn } from "./answer-checks.mjs";
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

// The app: counts its opens in both localStorage and IndexedDB, and says the
// counts as model context ("local=N idb=N") once the host has initialized it.
const APP = `<!doctype html><html><body><p id="out">counting</p><script>
(function () {
  function send(m) { parent.postMessage(m, "*"); }
  function idbCount() {
    return new Promise(function (resolve) {
      var open = indexedDB.open("counter", 1);
      open.onupgradeneeded = function () { open.result.createObjectStore("n"); };
      open.onerror = function () { resolve(-1); };
      open.onsuccess = function () {
        var db = open.result, tx = db.transaction("n", "readwrite"), store = tx.objectStore("n"), get = store.get("n");
        get.onsuccess = function () { var n = (get.result || 0) + 1; store.put(n, "n"); tx.oncomplete = function () { resolve(n); }; };
      };
    });
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id === 1 && m.result) {
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      function say(text) {
        document.getElementById("out").textContent = text;
        send({ jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { content: [{ type: "text", text: text }] } });
      }
      try {
        var local = Number(localStorage.getItem("n") || 0) + 1;
        localStorage.setItem("n", String(local));
        idbCount().then(function (idb) { say("local=" + local + " idb=" + idb); }, function (e) { say("idb error " + e); });
      } catch (e) {
        say("error " + e.name + ": " + e.message);
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "counter", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
})();
</script></body></html>`;

function mcpServer() {
  const server = new McpServer({ name: "store-check", version: "1.0.0" });
  server.registerTool("count", { description: "Counts", inputSchema: {}, _meta: { ui: { resourceUri: "ui://store-check/app" } } }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  server.registerResource("app", "ui://store-check/app", { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: "ui://store-check/app", mimeType: "text/html;profile=mcp-app", text: APP }],
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
const config = path.join(os.tmpdir(), `store-check-${process.pid}.json`);
fs.writeFileSync(config, JSON.stringify({ mcpServers: { store: { type: "http", url: `http://127.0.0.1:${mcp.address().port}/mcp` } } }));
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-check-"));

function startHelper() {
  const helper = spawn(...helperCommand(["--mcp-config", config]), {
    env: { ...process.env, MCP_APPS_CLI_STORAGE_DIR: storeDir, TERM_PROGRAM: "Apple_Terminal", MCP_APPS_CLI_DEBUG: process.env.V ? "1" : "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const said = new Map();
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
      }
    }),
  );
  return { helper, said, ready };
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

async function openAndRead(h, socket, viewId) {
  h.said.delete(viewId);
  await post(socket, "/open", { viewId, server: "store", toolName: "count", toolInput: {}, toolResult: { content: [{ type: "text", text: "ok" }] }, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
  for (let i = 0; i < 100 && !h.said.has(viewId); i++) await new Promise((r) => setTimeout(r, 100));
  const text = h.said.get(viewId) ?? "(nothing)";
  if (process.env.V) console.error("closing", viewId);
  await post(socket, "/close", { viewId });
  if (process.env.V) console.error("closed", viewId);
  return text;
}

let failed = 0;
// A request without the token, over the socket or the port.
const refused = (where) =>
  new Promise((resolve) => {
    const { headers: _, ...open } = target(where, "/locate");
    const q = http.request({ ...open, method: "POST" }, (r) => { r.resume(); resolve(String(r.statusCode)); });
    q.on("error", () => resolve("error"));
    q.end("{}");
  });
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
};

let h = startHelper();
let socket = await h.ready;
check("a request without the token is refused", await refused(socket), "403");
check("view A, first open", await openAndRead(h, socket, "view-a"), "local=1 idb=1");
check("view A, opened again", await openAndRead(h, socket, "view-a"), "local=2 idb=2");
check("view B, same app, its own store", await openAndRead(h, socket, "view-b"), "local=1 idb=1");
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));
h = startHelper();
socket = await h.ready;
check("view A, after a helper restart", await openAndRead(h, socket, "view-a"), "local=3 idb=3");
check("view B, after a helper restart", await openAndRead(h, socket, "view-b"), "local=2 idb=2");
// A helper ended outright (as Claude Code ends it when it quits) still kept
// what the app wrote a moment before: stores are saved soon after writes.
h.said.delete("view-c");
await post(socket, "/open", { viewId: "view-c", server: "store", toolName: "count", toolInput: {}, toolResult: { content: [{ type: "text", text: "ok" }] }, cols: 60, maxRows: 10, theme: "dark", mode: "cells" });
for (let i = 0; i < 100 && !h.said.has("view-c"); i++) await new Promise((r) => setTimeout(r, 100));
check("view C, first open", h.said.get("view-c") ?? "(nothing)", "local=1 idb=1");
await new Promise((r) => setTimeout(r, 2500));
h.helper.kill("SIGKILL");
await new Promise((r) => h.helper.once("exit", r));
h = startHelper();
socket = await h.ready;
check("view C, after the helper was killed", await openAndRead(h, socket, "view-c"), "local=2 idb=2");
const files = fs.readdirSync(storeDir).filter((f) => f.endsWith(".json"));
check("one store file per view", String(files.length), "3");
// Readable by the person only: mode 600 on macOS and Linux; on Windows, which
// has no such modes (Node reports 666), an access list naming only the
// person, SYSTEM and Administrators, as a file in their profile has.
function whoCanRead(file) {
  if (process.platform !== "win32") {
    const mode = (fs.statSync(file).mode & 0o777).toString(8);
    return mode === "600" ? "person only" : `mode ${mode}`;
  }
  const entries = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:STORE_FILE).Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, STORE_FILE: file } },
  ).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const me = os.userInfo().username.toLowerCase();
  const others = entries.filter((who) => !/^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$/i.test(who) && who.toLowerCase().split("\\").pop() !== me);
  return entries.length && !others.length ? "person only" : `also ${others.join(" ") || "nobody listed"}`;
}
const readers = files.map((f) => whoCanRead(path.join(storeDir, f)));
check("store files readable by the person only", readers.join(","), files.map(() => "person only").join(","));
h.helper.kill("SIGTERM");
await new Promise((r) => h.helper.once("exit", r));
fs.rmSync(storeDir, { recursive: true, force: true });
fs.rmSync(config, { force: true });
mcp.close();
process.exit(failed ? 1 : 0);
