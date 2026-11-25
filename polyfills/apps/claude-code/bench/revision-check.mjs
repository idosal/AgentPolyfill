// Issue #5: the helper speaks each server's MCP revision, against servers
// built on the TypeScript SDK (someone else's code): 2.4.0 serving
// 2026-07-28 only (createMcpHandler with legacy: "reject"), 2.4.0 serving
// both revisions (its default), and 1.x serving the 2025 revisions only, the
// usual session-based deployment. For each over streamable HTTP:
// - /discover finds the tool's UI;
// - a view opens and its first frame is drawn (the helper read its ui://
//   resource);
// - the view calls an app-only tool, over the helper's own connection, and
//   gets the server's result whole, structuredContent and _meta with it;
// - what the server received: no `initialize` for 2026-07-28, every request
//   naming that revision in MCP-Protocol-Version; `initialize` at 2025-11-25
//   otherwise.
// And issue #6's setting: the view is given the model's call's result as
// Claude Code records it (one text block of the structuredContent's JSON).
// Opened with "Structured results from text" on (the modern server here), it
// gets structuredContent back; without it (dual), it gets the text alone.
//
//   MCP_APPS_CLI_HELPER=<binary> MCP_SDK_V2=<folder> node revision-check.mjs
//
// MCP_SDK_V2 is a folder with @modelcontextprotocol/server 2.4.0 and zod 4
// installed (npm install --prefix <folder> @modelcontextprotocol/server@2.4.0 zod@4.6.7);
// the 1.x SDK comes from ../mod/helper (npm ci there). Needs Chrome (or
// MCP_APPS_CLI_CHROME). Prints PASS or FAIL per check; exits 1 on a failure.

import { spawn } from "./answer-checks.mjs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1 = (p) => pathToFileURL(path.join(HERE, "..", "mod", "helper", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
if (!process.env.MCP_SDK_V2 || !process.env.MCP_APPS_CLI_HELPER) {
  console.error("usage: MCP_APPS_CLI_HELPER=<binary> MCP_SDK_V2=<folder> node revision-check.mjs");
  process.exit(2);
}
const V2 = (name, file) => pathToFileURL(path.join(process.env.MCP_SDK_V2, "node_modules", name, file)).href;
const v2 = await import(V2("@modelcontextprotocol/server", "dist/index.mjs"));
const z = await import(V2("zod", "index.js"));
const v1 = { ...(await import(V1("server/mcp.js"))), ...(await import(V1("server/streamableHttp.js"))) };

const URI = "ui://revision/app";
// A view that speaks the MCP Apps protocol by hand: ui/initialize, then a
// call to its app-only tool; it shows what came back.
const app = (name) => `<!doctype html><html><body style="margin:0;font:16px sans-serif;background:#fff">
<h1>Revision ${name}</h1><p id="stamp">waiting</p><p id="result">no result</p><script>
const send = (m) => parent.postMessage(m, "*");
addEventListener("message", (e) => {
  const m = e.data;
  if (m?.id === 1 && m.result) {
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stamp", arguments: {} } });
  }
  if (m?.method === "ui/notifications/tool-result") {
    document.getElementById("result").textContent = "result sc " + (m.params?.structuredContent?.n ?? "none");
  }
  if (m?.id === 2) {
    const r = m.result ?? {};
    document.getElementById("stamp").textContent = "stamp " + (r.structuredContent?.stamp ?? "none") + " meta " + (r._meta?.key ?? "none");
  }
});
send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "revision", version: "1" }, appCapabilities: {} } });
</script></body></html>`;

function register(server, name, schema, out) {
  server.registerTool(
    "show",
    { description: "Has a UI", inputSchema: schema, ...(out ? { outputSchema: out } : {}), _meta: { ui: { resourceUri: URI } } },
    async () => ({ content: [{ type: "text", text: "shown" }], ...(out ? { structuredContent: { n: 7 } } : {}) }),
  );
  server.registerTool(
    "stamp",
    { description: "For the app", inputSchema: schema, _meta: { ui: { resourceUri: URI, visibility: ["app"] } } },
    async () => ({ content: [{ type: "text", text: "stamped" }], structuredContent: { stamp: name }, _meta: { key: `${name}-meta` } }),
  );
  server.registerResource("app", URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: URI, mimeType: "text/html;profile=mcp-app", text: app(name) }],
  }));
  return server;
}

// What each server received: method, the MCP-Protocol-Version header, and
// initialize's protocolVersion.
const received = {};
function listen(name, handle) {
  received[name] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body;
    try { body = raw.length ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    if (req.method === "POST" && body && !Array.isArray(body)) {
      received[name].push({ method: body.method ?? "(response)", header: req.headers["mcp-protocol-version"] ?? null, initialize: body.method === "initialize" ? body.params?.protocolVersion : undefined });
    }
    await handle(req, res, raw, body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/mcp`)));
}

// 2.4.0 over node:http: the request as a web-standard Request.
function fetchFace(handler) {
  return async (req, res, raw) => {
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : raw });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const c of response.body) res.write(c);
    res.end();
  };
}

const factory = (name) => () => register(new v2.McpServer({ name, version: "1.0.0" }), name, z.object({}), z.object({ n: z.number() }));
const sessions = new Map();
const urls = {
  modern: await listen("modern", fetchFace(v2.createMcpHandler(factory("modern"), { legacy: "reject" }))),
  dual: await listen("dual", fetchFace(v2.createMcpHandler(factory("dual")))),
  legacy: await listen("legacy", async (req, res, _raw, body) => {
    const id = req.headers["mcp-session-id"];
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      transport = new v1.StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => sessions.set(sid, transport) });
      await register(new v1.McpServer({ name: "legacy", version: "1.0.0" }), "legacy", {}).connect(transport);
    }
    await transport.handleRequest(req, res, body);
  }),
};
const config = JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, { type: "http", url }])) });

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${got === undefined ? "" : `: ${got}`}`);
};

const helper = spawn(process.env.MCP_APPS_CLI_HELPER, ["--mcp-config", config], {
  env: { ...process.env, TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor", MCP_APPS_CLI_CHROME_IDLE_S: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let ready;
const frames = [];
const requests = [];
let buf = "";
const isReady = new Promise((resolve) =>
  helper.stdout.on("data", (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "ready") resolve((ready = m));
      if (m.type === "frame") frames.push(m);
      // As the mod would, on the person's yes: the app may call its app-only tool.
      if (m.type === "request") {
        requests.push(m);
        if (m.method === "ui/allow-tool") post("/reply", { id: m.id, gen: m.gen, result: { allow: true, epoch: 0 } });
      }
    }
  }),
);
await Promise.race([isReady, new Promise((r) => setTimeout(r, 30_000))]);
if (!ready) {
  console.log("FAIL the helper never said it was ready");
  process.exit(1);
}

function post(route, body) {
  return new Promise((resolve) => {
    const where = ready.socket ? { socketPath: ready.socket } : { host: "127.0.0.1", port: new URL(ready.url).port };
    const q = http.request({ ...where, path: route, method: "POST", headers: { "x-mcp-apps-cli-token": ready.token } }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => {
        try { resolve(JSON.parse(t)); } catch { resolve(t); }
      });
    });
    q.on("error", (e) => resolve(String(e)));
    q.end(JSON.stringify(body ?? {}));
  });
}

const rowsOf = (viewId) => (frames.filter((f) => f.viewId === viewId).at(-1)?.frame?.styled ?? []).map((row) => row.map((run) => run[0]).join(""));
for (const name of ["modern", "dual", "legacy"]) {
  const found = await post("/discover", { server: name });
  check(`${name}: /discover finds the tool's UI`, found.ok && found.tools?.show?.resourceUri === URI && found.appOnly?.includes("stamp"), JSON.stringify(found).slice(0, 160));
  const viewId = `v-${name}`;
  // Claude Code's record of a result with structuredContent: its JSON as text.
  const opened = await post("/open", { viewId, gen: 1, server: name, toolName: "show", toolInput: {}, toolResult: '{"n":7}', structuredFromText: name === "modern", cols: 60, maxRows: 8, theme: "light", mode: "cells" });
  check(`${name}: a view opens`, opened.ok === true, JSON.stringify(opened).slice(0, 160));
  const deadline = Date.now() + 20_000;
  while (!rowsOf(viewId).some((r) => r.includes(`stamp ${name}`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const rows = rowsOf(viewId);
  check(`${name}: its frame shows the app`, rows.some((r) => r.includes(`Revision ${name}`)), JSON.stringify(rows.join("|").trim().slice(0, 80)));
  check(`${name}: the app-only call came back whole`, rows.some((r) => r.includes(`stamp ${name} meta ${name}-meta`)), JSON.stringify(rows.find((r) => r.includes("stamp"))?.trim()));
  if (name !== "legacy") {
    const want = name === "modern" ? "result sc 7" : "result sc none";
    check(`${name}: the first result's structuredContent ${name === "modern" ? "from its text (setting on)" : "absent (setting off)"}`, rows.some((r) => r.includes(want)), JSON.stringify(rows.find((r) => r.includes("result"))?.trim()));
  }
  await post("/close", { viewId, gen: 1 });
  const got = received[name];
  const methods = got.map((m) => m.method);
  if (name === "legacy") {
    const init = got.find((m) => m.method === "initialize");
    check(`${name}: the 2025 handshake, at 2025-11-25`, init?.initialize === "2025-11-25", JSON.stringify(methods));
  } else {
    check(`${name}: no initialize, server/discover first`, !methods.includes("initialize") && methods[0] === "server/discover", JSON.stringify(methods));
    check(`${name}: every request names 2026-07-28`, got.length > 0 && got.every((m) => m.header === "2026-07-28"), JSON.stringify([...new Set(got.map((m) => m.header))]));
  }
}

helper.kill("SIGTERM");
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
