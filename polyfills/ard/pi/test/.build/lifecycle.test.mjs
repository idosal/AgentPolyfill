// test/lifecycle.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { install, addTool } from "../../extension/dist/index.js";

// ../../server-cards/pi/test/harness.ts
import { join } from "node:path";
import { piDeps, Session } from "../../extension/dist/index.js";
import { temp } from "../pi-rpc.ts";
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
function mockSession() {
  const dir = temp("adapter-");
  const calls = [];
  const registered = [];
  const pi = {
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
    getMcpServers: () => registered,
    registerMcpServer: (name, config) => {
      registered.push({ name, config });
    }
  };
  const deps = { ...piDeps(pi, { PI_CODING_AGENT_DIR: dir }), cli: "/verified/pi/dist/bundle/cli.js" };
  const session = new Session(deps);
  session.discovered.set(`https://publisher.example
${IDENTIFIER}`, { card: card(), isLocal: false, provenance: "listed in https://publisher.example's catalog" });
  return { dir, file: join(dir, "mcp.json"), calls, registered, pi, deps, session };
}
function context(answer = "Add it", hasUI = true) {
  const questions = [];
  const ctx = {
    hasUI,
    cwd: temp("cwd-"),
    isProjectTrusted: () => false,
    ui: { select: async (title, choices) => {
      questions.push({ title, choices });
      return answer;
    } }
  };
  return { ctx, questions };
}
var addArgs = { domain: "https://publisher.example", identifier: IDENTIFIER, url: "https://mcp.example.com/mcp" };

// test/lifecycle.test.ts
test("stand-down: the actual factory registers nothing when disabled", () => {
  const old = process.env.ARD_DISCOVERY_DISABLED;
  const names = [];
  process.env.ARD_DISCOVERY_DISABLED = "1";
  try {
    extension({ registerTool: (tool) => names.push(tool.name), on: () => {
      throw new Error("disabled factory should do nothing");
    } });
    assert.deepEqual(names, []);
  } finally {
    if (old === void 0) delete process.env.ARD_DISCOVERY_DISABLED;
    else process.env.ARD_DISCOVERY_DISABLED = old;
  }
});
test("a session_start clears previously shown cards, including resume and fork", async () => {
  const s = mockSession(), c = context();
  const definitions = [];
  const handlers = {};
  let current;
  const pi = { ...s.pi, registerTool: (tool) => definitions.push(tool), on: (event, handler) => {
    handlers[event] = handler;
  } };
  install(pi, "ARD_DISCOVERY_DISABLED", (session) => {
    current = session;
    return [addTool(session, "ard_discover", "ard_discover")];
  }, { PI_CODING_AGENT_DIR: s.dir });
  current.discovered.set([...s.session.discovered.keys()][0], [...s.session.discovered.values()][0]);
  assert.equal(current.discovered.size, 1);
  handlers.session_start();
  assert.equal(current.discovered.size, 0);
  const result = await definitions[0].execute("id", addArgs, void 0, void 0, c.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /was shown in this session/);
  assert.equal(c.questions.length, 0);
});
