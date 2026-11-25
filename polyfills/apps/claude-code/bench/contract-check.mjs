// The helper's contract, the parts with no view, checked against either
// helper: the Node one by default, or
// the binary MCP_APPS_CLI_HELPER names (the Rust port).
//
//   node contract-check.mjs
//   MCP_APPS_CLI_HELPER=../helper-rs/target/release/mcp-apps-cli-helper node contract-check.mjs
//
// The ready line; the token (a request without it is refused, over the
// socket or TCP); /ping; many large requests at once; /discover against a small MCP server in this
// process (tools with a UI, app-only and structured ones), over each
// transport a config can name (streamable HTTP, the older SSE, stdio); Chrome started
// (/prewarm), closed when idle, started again after it was killed; and the
// helper leaving on SIGTERM with its socket and temporary folder gone. Then
// the helper's own memory, idle and with Chrome running. Prints PASS or FAIL
// per check; exits 1 on a failure.

import { execSync } from "node:child_process";
import { spawn } from "./answer-checks.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "mod", "helper");
const sdk = (p) => pathToFileURL(path.join(HELPER, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", p)).href;
const { McpServer } = await import(sdk("server/mcp.js"));
const { StreamableHTTPServerTransport } = await import(sdk("server/streamableHttp.js"));
const { SSEServerTransport } = await import(sdk("server/sse.js"));
const { z } = await import(pathToFileURL(path.join(HELPER, "node_modules", "zod", "index.js")).href);

const helperCommand = (args) =>
  process.env.MCP_APPS_CLI_HELPER
    ? [process.env.MCP_APPS_CLI_HELPER, args]
    : [process.execPath, [path.join(HELPER, "helper.mjs"), ...args]];

function mcpServer() {
  const server = new McpServer({ name: "contract", version: "1.0.0" });
  server.registerTool("show", { description: "Has a UI", inputSchema: {}, _meta: { ui: { resourceUri: "ui://contract/app" } } }, async () => ({ content: [] }));
  server.registerTool("poll", { description: "App-only", inputSchema: {}, _meta: { ui: { visibility: ["app"] } } }, async () => ({ content: [] }));
  server.registerTool(
    "count",
    { description: "Structured", inputSchema: {}, outputSchema: { n: z.number() } },
    async () => ({ content: [], structuredContent: { n: 1 } }),
  );
  return server;
}
// The older SSE transport: GET /sse opens the stream, POST /messages?sessionId= carries messages.
const sseSessions = new Map();
const mcp = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, transport);
    res.on("close", () => sseSessions.delete(transport.sessionId));
    await mcpServer().connect(transport);
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/messages")) {
    const transport = sseSessions.get(new URL(req.url, "http://x").searchParams.get("sessionId"));
    if (!transport) return void res.writeHead(404).end();
    await transport.handlePostMessage(req, res);
    return;
  }
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await server.connect(transport);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
// The same server over stdio: this file, run with --stdio.
const stdioScript = path.join(os.tmpdir(), `contract-stdio-${process.pid}.mjs`);
fs.writeFileSync(
  stdioScript,
  `const { McpServer } = await import(${JSON.stringify(sdk("server/mcp.js"))});
const { StdioServerTransport } = await import(${JSON.stringify(sdk("server/stdio.js"))});
const server = new McpServer({ name: "contract", version: "1.0.0" });
server.registerTool("show", { description: "Has a UI", inputSchema: {}, _meta: { ui: { resourceUri: "ui://contract/app" } } }, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
`,
);
process.on("exit", () => fs.rmSync(stdioScript, { force: true }));
const base = `http://127.0.0.1:${mcp.address().port}`;
const config = JSON.stringify({
  mcpServers: {
    contract: { type: "http", url: `${base}/mcp` },
    "contract-sse": { type: "sse", url: `${base}/sse` },
    "contract-stdio": { command: process.execPath, args: [stdioScript] },
  },
});

function start(env = {}) {
  const [cmd, args] = helperCommand(["--mcp-config", config]);
  const helper = spawn(cmd, args, { env: { ...process.env, TERM_PROGRAM: "Apple_Terminal", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  if (process.env.V) helper.stderr.on("data", (d) => process.stderr.write(d));
  let buf = "";
  const ready = new Promise((resolve) =>
    helper.stdout.on("data", (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === "ready") resolve(m);
        } catch {}
      }
    }),
  );
  return { helper, ready };
}

const post = (ready, route, body, token = ready.token) =>
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const descendants = (pid) => {
  const kids = execSync(`pgrep -P ${pid} || true`).toString().split("\n").filter(Boolean).map(Number);
  return [...kids, ...kids.flatMap(descendants)];
};
const chromeOf = (pid) => descendants(pid).filter((p) => /chrom/i.test(execSync(`ps -o comm= -p ${p} || true`).toString()));
const rss = (pid) => Number(execSync(`ps -o rss= -p ${pid} || echo 0`).toString().trim() || 0) / 1024;

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${got === undefined ? "" : `: ${got}`}`);
};

console.log(`helper: ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"}`);
for (const transport of ["socket", "tcp"]) {
  const { helper, ready: r } = start({ MCP_APPS_CLI_TRANSPORT: transport === "tcp" ? "tcp" : "", MCP_APPS_CLI_CHROME_IDLE_S: "2" });
  const ready = await r;
  const where = transport === "tcp" ? ready.url : ready.socket;
  check(`${transport}: ready line`, typeof where === "string" && /^[0-9a-f]{64}$/.test(ready.token) && ready.pid > 0 && "images" in ready && "swapEveryDraw" in ready, JSON.stringify({ ...ready, token: "…", socket: ready.socket && "…" }));
  const refused = await post(ready, "/ping", {}, "");
  check(`${transport}: a request without the token is refused`, refused.status === 403, refused.status);
  const wrong = await post(ready, "/ping", {}, "0".repeat(64));
  check(`${transport}: a wrong token is refused`, wrong.status === 403, wrong.status);
  const ping = await post(ready, "/ping");
  check(`${transport}: /ping`, ping.status === 200 && ping.json.ok === true && Array.isArray(ping.json.views), JSON.stringify(ping.json));
  // Many large requests at once (a tool result the mod passes back runs to
  // megabytes): every one answered. A server that closed as soon as it had
  // answered failed most of these with EPIPE, the answer unread.
  const big = { pad: "x".repeat(200_000) };
  const answers = await Promise.all(Array.from({ length: 64 }, () => post(ready, "/ping", big)));
  const answered = answers.filter((a) => a.status === 200 && a.json.ok === true).length;
  check(`${transport}: 64 concurrent 200 KB requests all answered`, answered === 64, `${answered}/64${answered < 64 ? ` (${[...new Set(answers.filter((a) => a.status !== 200).map((a) => a.json))].join(", ")})` : ""}`);
  if (transport === "tcp") {
    helper.kill("SIGTERM");
    await new Promise((res) => helper.once("exit", res));
    continue;
  }
  const found = (await post(ready, "/discover", { server: "contract" })).json;
  check("/discover: the tool with a UI", found.ok && found.tools?.show?.resourceUri === "ui://contract/app", JSON.stringify(found.tools));
  check("/discover: app-only and structured tools", JSON.stringify(found.appOnly) === '["poll"]' && JSON.stringify(found.structured) === '["count"]', `${JSON.stringify(found.appOnly)} ${JSON.stringify(found.structured)}`);
  check("/discover: every definition", ["show", "poll", "count"].every((n) => found.definitions?.[n]?.name === n));
  const overSse = (await post(ready, "/discover", { server: "contract-sse" })).json;
  check("/discover over the older SSE transport", overSse.ok && overSse.tools?.show?.resourceUri === "ui://contract/app" && JSON.stringify(overSse.appOnly) === '["poll"]', JSON.stringify(overSse).slice(0, 200));
  const overStdio = (await post(ready, "/discover", { server: "contract-stdio" })).json;
  check("/discover over stdio", overStdio.ok && overStdio.tools?.show?.resourceUri === "ui://contract/app", JSON.stringify(overStdio).slice(0, 200));
  const unknown = (await post(ready, "/discover", { server: "nope" })).json;
  check("/discover: a server with no config says so", unknown.ok === false && /no config/.test(unknown.error), unknown.error);
  const idleMem = rss(helper.pid);
  const t = Date.now();
  const warm = await post(ready, "/prewarm");
  check("/prewarm starts Chrome", warm.json.ok === true && chromeOf(helper.pid).length > 0, `${Date.now() - t} ms, ${chromeOf(helper.pid).length} process(es)`);
  const busyMem = rss(helper.pid);
  await sleep(3500);
  check("Chrome closed after the idle wait, with no view", chromeOf(helper.pid).length === 0, `${chromeOf(helper.pid).length} left`);
  await post(ready, "/prewarm");
  for (const p of chromeOf(helper.pid)) try { process.kill(p, "SIGKILL"); } catch {}
  await sleep(800);
  const again = await post(ready, "/prewarm");
  check("Chrome killed: the next /prewarm starts it again", again.json.ok === true && chromeOf(helper.pid).length > 0, JSON.stringify(again.json));
  const tmp = path.join(os.tmpdir(), `mcp-apps-cli-${ready.pid}.tmp`);
  helper.kill("SIGTERM");
  await new Promise((res) => helper.once("exit", res));
  await sleep(300);
  check("SIGTERM: the helper leaves, its socket and folder gone", !fs.existsSync(ready.socket) && !fs.existsSync(tmp), `socket ${fs.existsSync(ready.socket)}, folder ${fs.existsSync(tmp)}`);
  console.log(`helper memory: ${idleMem.toFixed(0)} MB idle, ${busyMem.toFixed(0)} MB with Chrome started`);
}

mcp.close();
process.exit(failed ? 1 : 0);
