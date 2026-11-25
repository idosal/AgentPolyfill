// Stand-in MCP servers for gate.rs, run with `node` from PATH, so the gate
// tests run alike on macOS, Linux and Windows. Standard library only.
//
//   node gate-server.mjs marker <file>
//     Writes "ran" to <file> as soon as it starts, then waits a second: a
//     server whose start the test can see (a planted one must never write it).
//   node gate-server.mjs probe <log> <answer|hang>
//     A stdio MCP server that appends "start <pid>" to <log> when it starts
//     and each method it is sent; "hang" leaves tools/list unanswered. It is
//     a 2025-era server: server/discover is a method it doesn't know.
//   node gate-server.mjs revision <log> <modern|legacy|dual> [http]
//     An MCP Apps server (one tool with a UI) that serves revision
//     2026-07-28 only (modern), the 2025 revisions only (legacy) or both
//     (dual), over stdio, or with "http" over streamable HTTP on a loopback
//     port it prints first. It answers as the TypeScript SDK 2.4.0 does
//     (createMcpHandler with legacy: "reject", legacyStatelessFallback, and
//     the default), and appends to <log> one JSON line per message: its
//     method, the protocol version in its _meta, the MCP-Protocol-Version
//     header (HTTP), initialize's protocolVersion and whether the client
//     said it renders MCP Apps.

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const [mode, file, how, transport] = process.argv.slice(2);

if (mode === "marker") {
  writeFileSync(file, "ran\n");
  setTimeout(() => {}, 1000);
} else if (mode === "probe") {
  const log = (line) => appendFileSync(file, `${line}\n`);
  log(`start ${process.pid}`);
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const method = typeof message.method === "string" ? message.method : "";
    log(method);
    if (!("id" in message)) return;
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "probe", version: "0" },
      };
    } else if (method === "server/discover") {
      // A 2025-era server (the TypeScript SDK 1.x, for one) doesn't know it.
      const error = { code: -32601, message: "Method not found" };
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error })}\n`);
      return;
    } else if (method === "tools/list" && how === "hang") {
      return;
    } else if (method === "tools/list") {
      result = { tools: [{ name: "t", inputSchema: { type: "object" } }] };
    } else {
      result = {};
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  });
} else if (mode === "revision" && ["modern", "legacy", "dual"].includes(how)) {
  revision(how, transport === "http");
} else {
  console.error("usage: node gate-server.mjs marker <file> | probe <log> <answer|hang> | revision <log> <modern|legacy|dual> [http]");
  process.exit(2);
}

function revision(serves, http) {
  const MODERN = "2026-07-28";
  const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
  const modern = serves !== "legacy";
  const legacy = serves !== "modern";
  const URI = "ui://probe/view.html";
  const serverInfo = { name: `revision-${serves}`, version: "1.0.0" };
  const tools = [{ name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: URI } } }];
  const log = (entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`);

  // One message in; its answer out (undefined for none), or an HTTP status
  // and body for a request a server rejects before JSON-RPC (HTTP only).
  function answer(message, header) {
    const method = typeof message.method === "string" ? message.method : "";
    const meta = message.params?._meta ?? {};
    const envelope = meta["io.modelcontextprotocol/protocolVersion"] ?? null;
    const caps = method === "initialize" ? message.params?.capabilities : meta["io.modelcontextprotocol/clientCapabilities"];
    log({
      method,
      envelope,
      header: header ?? null,
      initialize: method === "initialize" ? (message.params?.protocolVersion ?? null) : null,
      apps: Boolean(caps?.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes?.includes("text/html;profile=mcp-app")),
    });
    if (!("id" in message)) return undefined;
    const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text, data) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text, ...(data ? { data } : {}) } });
    // A 2026-07-28 result, as the SDK sends it: its type, how long it may be
    // cached and for whom, and who the server is.
    const complete = (result) =>
      reply(envelope ? { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } } : result);
    if (method === "initialize") {
      const asked = message.params?.protocolVersion;
      if (!legacy) return fail(-32022, `Unsupported protocol version: ${asked}`, { supported: [MODERN], requested: asked });
      const protocolVersion = LEGACY.includes(asked) ? asked : LEGACY[0];
      return reply({ protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo });
    }
    if (envelope !== null) {
      if (!modern) {
        // legacyStatelessFallback's answer over HTTP, a 2025-era server's over stdio.
        if (http) return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Bad Request: Unsupported protocol version: ${envelope}` } } };
        return fail(-32601, "Method not found");
      }
      if (envelope !== MODERN || (http && header !== MODERN)) return fail(-32022, `Unsupported protocol version: ${envelope}`, { supported: [MODERN], requested: envelope });
    } else if (!legacy && method !== "ping") {
      return fail(-32022, "Unsupported protocol version: none", { supported: [MODERN] });
    }
    switch (method) {
      case "server/discover":
        return modern ? complete({ supportedVersions: [MODERN], capabilities: { tools: {}, resources: {} } }) : fail(-32601, "Method not found");
      case "tools/list":
        return complete({ tools });
      case "ping":
        return reply({});
      default:
        return fail(-32601, "Method not found");
    }
  }

  if (!http) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const out = answer(message);
      if (out && !("status" in out)) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
    return;
  }
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST") {
        if (req.method !== "DELETE") log({ method: req.method, envelope: null, header: req.headers["mcp-protocol-version"] ?? null, initialize: null, apps: false });
        res.writeHead(req.method === "DELETE" ? 200 : 405).end();
        return;
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400).end();
        return;
      }
      const out = answer(message, req.headers["mcp-protocol-version"]);
      if (out === undefined) {
        res.writeHead(202).end();
      } else if ("status" in out) {
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      }
    });
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
}
