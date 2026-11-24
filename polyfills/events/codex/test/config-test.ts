// Reading Codex's configuration: which servers the helper connects to, and with what.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { codexHome, readCodexServers } from '../src/codex-config.ts';
import { temp } from './harness.ts';

function home(configToml: string) {
    const dir = temp('mcp-events-codex-config-');
    const codex = join(dir, '.codex');
    mkdirSync(codex);
    writeFileSync(join(codex, 'config.toml'), configToml);
    return { dir, codex, env: { HOME: dir, CODEX_HOME: codex } as NodeJS.ProcessEnv };
}
const none = { managedFiles: [] };

describe("Codex's config.toml", () => {
    test('stdio and streamable HTTP servers are read as Codex writes them', () => {
        const h = home(`
model = "x"
[mcp_servers.local]
command = "node"
args = ["server.js", "--flag"]
cwd = "tools"
[mcp_servers.local.env]
API_MODE = "test"

[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Team" = "blue" }
`);
        const t = readCodexServers(h.env, () => {}, none);
        assert.deepEqual(t.servers.local, { command: 'node', args: ['server.js', '--flag'], env: { API_MODE: 'test' }, cwd: join(h.codex, 'tools') });
        assert.deepEqual(t.servers.remote, { url: 'https://example.com/mcp', headers: { 'X-Team': 'blue' } });
        assert.deepEqual(t.skipped, {});
    });

    test('a server switched off (enabled = false) stays off', () => {
        const h = home(`[mcp_servers.off]\ncommand = "node"\nenabled = false\n`);
        const t = readCodexServers(h.env, () => {}, none);
        assert.equal(t.servers.off, undefined);
        assert.match(t.skipped.off!, /switched off in Codex/);
    });

    test("a server that signs in through Codex (OAuth, ChatGPT) is left alone: this plugin never uses Codex's sign-in", () => {
        const h = home(`
[mcp_servers.chatgpt]
url = "https://a.example/mcp"
auth = "chatgpt"
[mcp_servers.oauth]
url = "https://b.example/mcp"
[mcp_servers.oauth.oauth]
client_id = "abc"
`);
        const t = readCodexServers(h.env, () => {}, none);
        assert.deepEqual(Object.keys(t.servers), []);
        assert.match(t.skipped.chatgpt!, /signs in through Codex/);
        assert.match(t.skipped.oauth!, /signs in through Codex/);
    });

    test('a token named by bearer_token_env_var or env_http_headers is used when the helper has that variable, and the server is left out with the reason when it has not', () => {
        const h = home(`
[mcp_servers.bearer]
url = "https://a.example/mcp"
bearer_token_env_var = "A_TOKEN"
[mcp_servers.header]
url = "https://b.example/mcp"
env_http_headers = { "X-Key" = "B_KEY" }
[mcp_servers.missing]
url = "https://c.example/mcp"
bearer_token_env_var = "NOT_SET_ANYWHERE"
`);
        const t = readCodexServers({ ...h.env, A_TOKEN: 'tok', B_KEY: 'key' }, () => {}, none);
        assert.deepEqual(t.servers.bearer, { url: 'https://a.example/mcp', headers: { Authorization: 'Bearer tok' } });
        assert.deepEqual(t.servers.header, { url: 'https://b.example/mcp', headers: { 'X-Key': 'key' } });
        assert.match(t.skipped.missing!, /NOT_SET_ANYWHERE, which Codex does not pass to this plugin's helper/);
    });

    test('env_vars passes on the named variables the helper has', () => {
        const h = home(`[mcp_servers.s]\ncommand = "x"\nenv_vars = ["HAVE", "LACK", { name = "ALSO" }, { name = "REMOTE", source = "remote" }]\n`);
        const t = readCodexServers({ ...h.env, HAVE: '1', ALSO: '2', REMOTE: '3' }, () => {}, none);
        assert.deepEqual((t.servers.s as { env: Record<string, string> }).env, { HAVE: '1', ALSO: '2' });
    });

    test('http_headers_helper is run as Codex runs it, from the Codex home', () => {
        const h = home(`[mcp_servers.s]\nurl = "https://a.example/mcp"\nhttp_headers_helper = "print-headers"\n`);
        const t = readCodexServers(h.env, () => {}, none);
        assert.deepEqual((t.servers.s as { headersHelper: unknown }).headersHelper, { command: 'print-headers', cwd: h.codex, fromRepo: false });
    });

    test('other transports, other environments and this plugin itself are left out', () => {
        const h = home(`
[mcp_servers.self]
command = "node"
args = ["/Users/x/.codex/plugins/cache/agent-polyfill/mcp-events/0.1.0/dist/helper.js"]
[mcp_servers.elsewhere]
command = "node"
environment_id = "remote-box"
[mcp_servers.odd]
transport = "carrier-pigeon"
`);
        const t = readCodexServers(h.env, () => {}, none);
        assert.deepEqual(Object.keys(t.servers), []);
        assert.equal(t.skipped.self, undefined, 'itself is not even listed');
        assert.match(t.skipped.elsewhere!, /another environment/);
        assert.match(t.skipped.odd!, /transport is not supported/);
    });

    test('MCP_EVENTS_SERVERS and MCP_EVENTS_SKIP narrow it', () => {
        const h = home(`[mcp_servers.a]\ncommand = "a"\n[mcp_servers.b]\ncommand = "b"\n[mcp_servers.c]\ncommand = "c"\n`);
        assert.deepEqual(Object.keys(readCodexServers({ ...h.env, MCP_EVENTS_SERVERS: 'a,b' }, () => {}, none).servers), ['a', 'b']);
        assert.deepEqual(Object.keys(readCodexServers({ ...h.env, MCP_EVENTS_SKIP: 'b' }, () => {}, none).servers), ['a', 'c']);
    });

    test('a config.toml that is not TOML connects to nothing, and says why', () => {
        const h = home('[mcp_servers.a\ncommand = ');
        const t = readCodexServers(h.env, () => {}, none);
        assert.deepEqual(t.servers, {});
        assert.match(t.skipped['(all servers)']!, /could not be read/);
    });

    test('MCP_EVENTS_CONFIG names a servers file of the user\'s own, TOML or JSON', () => {
        const h = home('');
        const json = join(h.dir, 'servers.json');
        writeFileSync(json, JSON.stringify({ mcpServers: { j: { url: 'https://j.example/mcp' } } }));
        assert.deepEqual(readCodexServers({ ...h.env, MCP_EVENTS_CONFIG: json }, () => {}, none).servers, { j: { url: 'https://j.example/mcp', headers: undefined } });
    });

    test('CODEX_HOME is honoured, as Codex honours it', () => {
        assert.equal(codexHome({ HOME: '/h' }), join('/h', '.codex'));
        assert.equal(codexHome({ HOME: '/h', CODEX_HOME: '/elsewhere' }), '/elsewhere');
    });
});

describe('an organisation that manages Codex', () => {
    test('a managed file that says anything about MCP, or cannot be read, turns discovery off; one about other things does not', () => {
        const h = home(`[mcp_servers.a]\ncommand = "a"\n`);
        const policy = join(h.dir, 'requirements.toml');
        writeFileSync(policy, '[mcp_servers.allowed]\nidentity = "x"\n');
        assert.match(readCodexServers(h.env, () => {}, { managedFiles: [policy] }).skipped['(all servers)']!, /manages which MCP servers Codex may use/);
        writeFileSync(policy, 'allowed_sandbox_modes = ["read-only"]\n');
        assert.deepEqual(Object.keys(readCodexServers(h.env, () => {}, { managedFiles: [policy] }).servers), ['a']);
        writeFileSync(policy, 'not toml [');
        assert.deepEqual(readCodexServers(h.env, () => {}, { managedFiles: [policy] }).servers, {});
    });

    test('a managed-preferences profile for Codex turns discovery off', () => {
        const h = home(`[mcp_servers.a]\ncommand = "a"\n`);
        const plist = join(h.dir, 'com.openai.codex.plist');
        writeFileSync(plist, '');
        assert.match(readCodexServers(h.env, () => {}, { managedFiles: [plist] }).skipped['(all servers)']!, /your organisation manages Codex/);
    });
});
