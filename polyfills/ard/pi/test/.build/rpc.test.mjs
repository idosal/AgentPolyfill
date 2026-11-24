// test/rpc.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pi, PI_BIN, BRAIN, temp as temp2, waitFor } from "../pi-rpc.ts";

// ../../server-cards/pi/test/harness.ts
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piDeps, Session } from "../../extension/dist/index.js";
import { temp } from "../pi-rpc.ts";
var TYPE = "application/mcp-server-card+json";
var SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
var card = (extra = {}) => ({
  $schema: SCHEMA,
  name: "com.example/docs",
  version: "1.0.0",
  description: "Docs.",
  title: "Example Docs",
  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
  ...extra
});
var IDENTIFIER = "urn:air:localhost:docs";
async function localWeb(headers = []) {
  const requests = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, body, headers: req.headers });
    const send = (value) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    const entry = { identifier: IDENTIFIER, type: TYPE, url: `${origin}/docs.json` };
    if (req.url === "/.well-known/ai-catalog.json") return send({ specVersion: "1.0", entries: [entry] });
    if (req.url === "/.well-known/ard.json") return send({ entries: [entry] });
    if (req.url === "/docs.json") return send(card({ remotes: [{ type: "streamable-http", url: `${origin}/mcp`, headers }] }));
    if (req.url === "/search") return send({ results: [entry] });
    if (req.url === "/mcp" && req.method === "POST") {
      const message = JSON.parse(body);
      if (message.id === void 0) {
        res.writeHead(202);
        return res.end();
      }
      const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pi-test-server", version: "1" } } : message.method === "tools/list" ? { tools: [{ name: "ping", description: "Returns pong", inputSchema: { type: "object", properties: {} } }] } : message.method === "tools/call" ? { content: [{ type: "text", text: "pong" }] } : {};
      return send({ jsonrpc: "2.0", id: message.id, result });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }) };
}
var saved = (agentDir) => JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));

// test/rpc.test.ts
import { planForPi } from "../../extension/dist/index.js";
var ROOT = fileURLToPath(new URL("../..", import.meta.url));
var EXTENSION = join2(ROOT, "extension");
var run = promisify(execFile);
for (const answer of ["Add it", "Don't add it", void 0]) {
  test(`RPC: ard_discover then add, answer ${String(answer)}; actual Pi CLI and connection`, async (t) => {
    const web = await localWeb();
    t.after(() => web.close());
    const isolated = temp2("installed-");
    cpSync(EXTENSION, join2(isolated, "extension"), { recursive: true });
    const pi = new Pi({ extensions: [join2(isolated, "extension")], env: { MCP_SERVER_CARDS_DISABLED: "", ARD_DISCOVERY_DISABLED: "" }, answer: () => answer, rules: [
      { when: "^discover$", call: { name: "ard_discover", args: { domain: web.origin } } },
      { when: "^add$", call: { name: "ard_add_mcp_server", args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } }
    ] });
    t.after(() => pi.stop());
    await pi.ready();
    await pi.prompt("discover");
    assert.match(pi.toolResults("ard_discover")[0].text, /1 with a valid Server Card/);
    await pi.prompt("add");
    const result = pi.toolResults("ard_add_mcp_server")[0];
    assert.equal(pi.ui.length, 1, pi.stderr);
    assert.deepEqual(pi.ui[0].options, ["Don't add it", "Add it"]);
    assert.ok(pi.ui[0].title.includes(`Written to ${join2(pi.agentDir, "mcp.json")}`));
    if (answer === "Add it") {
      assert.equal(result.isError, false, result.text + pi.stderr);
      assert.equal(saved(pi.agentDir).mcpServers["example-docs"].url, `${web.origin}/mcp`);
      assert.match(result.text, /Registered with Pi for this session/);
      await waitFor(() => web.requests.some((r) => r.path === "/mcp" && r.body.includes("tools/list")), 15e3, "Pi MCP connection");
      const init = web.requests.find((r) => r.path === "/mcp" && r.body.includes("initialize"));
      assert.equal(JSON.parse(init.body).params.protocolVersion, "2025-11-25");
      assert.ok(JSON.parse(init.body).params.clientInfo.name.toLowerCase().includes("pi"));
    } else {
      assert.match(result.text, /Nothing was written/);
      assert.equal(existsSync(join2(pi.agentDir, "mcp.json")), false);
      assert.equal(web.requests.some((r) => r.path === "/mcp"), false);
    }
  });
}
test("real Pi print/JSON mode refuses addition because nobody can be asked", async (t) => {
  const web = await localWeb();
  t.after(() => web.close());
  const agentDir = temp2("print-agent-");
  const rules = [
    { when: "^print-check$", call: { name: "ard_discover", args: { domain: web.origin } } },
    { when: "MCP servers listed:", call: { name: "ard_add_mcp_server", args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } }
  ];
  const pending = run(process.execPath, [PI_BIN, "--offline", "--mode", "json", "--provider", "scripted", "--model", "m1", "--no-session", "-e", BRAIN, "-e", EXTENSION, "-p", "print-check"], {
    cwd: agentDir,
    timeout: 3e4,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_TEST_RULES: JSON.stringify(rules), PI_TEST_BRAIN_LOG: join2(agentDir, "brain.jsonl"), MCP_SERVER_CARDS_DISABLED: "", ARD_DISCOVERY_DISABLED: "" }
  });
  pending.child.stdin?.end();
  const { stdout } = await pending;
  assert.match(stdout, /Pi has no one to ask in this mode/);
  assert.equal(existsSync(join2(agentDir, "mcp.json")), false);
  assert.equal(web.requests.some((r) => r.path === "/mcp"), false);
});
test("RPC: secret header stays a reference in mcp.json; Pi expands it only when connecting", async (t) => {
  const headers = [{ name: "X-Test-Key", isSecret: true }, { name: "X-Region", value: "eu" }];
  const web = await localWeb(headers);
  t.after(() => web.close());
  const planned = planForPi(card({ remotes: [{ type: "streamable-http", url: `${web.origin}/mcp`, headers }] }), 0, {}, void 0, true);
  assert.ok("plan" in planned);
  const variable = planned.plan.envVars[0].name;
  const pi = new Pi({ extensions: [EXTENSION], env: { [variable]: "test-only-placeholder", MCP_SERVER_CARDS_DISABLED: "", ARD_DISCOVERY_DISABLED: "" }, answer: () => "Add it", rules: [
    { when: "^discover-key$", call: { name: "ard_discover", args: { domain: web.origin } } },
    { when: "^add-key$", call: { name: "ard_add_mcp_server", args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } }
  ] });
  t.after(() => pi.stop());
  await pi.ready();
  await pi.prompt("discover-key");
  await pi.prompt("add-key");
  assert.equal(pi.toolResults("ard_add_mcp_server")[0].isError, false);
  const config = saved(pi.agentDir).mcpServers["example-docs"];
  assert.deepEqual(config.headers, { ...planned.plan.headers });
  assert.doesNotMatch(JSON.stringify(config), /test-only-placeholder/);
  assert.doesNotMatch(pi.ui[0].title, /test-only-placeholder/);
  const init = await waitFor(() => web.requests.find((r) => r.path === "/mcp" && r.body.includes("initialize")));
  assert.equal(init.headers["x-test-key"], "test-only-placeholder");
  assert.equal(init.headers["x-region"], "eu");
});
