// Reading the user's Codex config: which servers are looked at, how, and which are left alone.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { codexHomeOf, managedPolicy, parseServers, readCodexConfig, readSkillRules } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { temp } from './harness.ts';

const home = (toml: string): string => {
    const dir = temp();
    writeFileSync(join(dir, 'config.toml'), toml);
    return dir;
};

describe('the Codex config', () => {
    test('stdio and HTTP servers are read as Codex runs them; a server turned off or elsewhere is left alone, with the reason', () => {
        const dir = home(`
[mcp_servers.local]
command = "node"
args = ["server.js", "--flag"]
cwd = "tools"
env = { MODE = "x" }

[mcp_servers.hf]
url = "https://huggingface.co/mcp"
http_headers = { "X-Team" = "a" }

[mcp_servers.off]
url = "https://example.com/mcp"
enabled = false

[mcp_servers.remote]
command = "x"
environment_id = "devbox"

[mcp_servers."bad name!"]
url = "https://example.com/mcp"
`);
        const { table, file } = readCodexConfig(dir, {}, { managedFiles: [] });
        assert.equal(file, join(dir, 'config.toml'));
        assert.deepEqual(table.servers.local, { command: 'node', args: ['server.js', '--flag'], env: { MODE: 'x' }, cwd: join(dir, 'tools') });
        assert.deepEqual(table.servers.hf, { url: 'https://huggingface.co/mcp', headers: { 'X-Team': 'a' } });
        assert.match(table.skipped.off!, /turned off in your Codex config/);
        assert.match(table.skipped.remote!, /another environment/);
        assert.equal(Object.keys(table.servers).length, 2, 'a name that does not look like one is left out');
    });

    test('variables a server names are passed only when this process has them; without them the server is left out, and told why', () => {
        const raw = {
            withToken: { url: 'https://a.example/mcp', bearer_token_env_var: 'A_TOKEN', env_http_headers: { 'X-Key': 'A_KEY' } },
            missing: { url: 'https://b.example/mcp', bearer_token_env_var: 'B_TOKEN' },
            stdio: { command: 'srv', env_vars: ['HAVE', { name: 'REMOTE_ONLY', source: 'remote' }] },
            stdioMissing: { command: 'srv', env_vars: ['NOPE'] }
        };
        const t = parseServers(raw, '/cfg', { A_TOKEN: 'tok-123456789', A_KEY: 'key-123456789', HAVE: 'yes' });
        assert.deepEqual(t.servers.withToken, { url: 'https://a.example/mcp', headers: { 'X-Key': 'key-123456789', Authorization: 'Bearer tok-123456789' } });
        assert.deepEqual((t.servers.stdio as { env: unknown }).env, { HAVE: 'yes' });
        assert.match(t.skipped.missing!, /needs the environment variable B_TOKEN, which Codex does not pass to a plugin's MCP server/);
        assert.match(t.skipped.stdioMissing!, /NOPE/);
    });

    test('this plugin\'s own server is never connected to', () => {
        const t = parseServers({ self: { command: 'node', args: ['/x/.codex/plugins/cache/agent-polyfill/mcp-skills/0.1.0/dist/helper.js'] }, src: { command: 'node', args: ['/repo/polyfills/skills/codex/src/helper.ts'] } }, '/', {});
        assert.deepEqual(t.servers, {});
    });

    test('a managed Codex policy that speaks of MCP servers turns discovery off; one that does not, or none, does not', () => {
        const dir = temp();
        const about = join(dir, 'requirements.toml');
        writeFileSync(about, '[mcp_servers.allowed]\nidentity = { command = "x" }\n');
        const other = join(dir, 'other.toml');
        writeFileSync(other, 'allowed_approval_policies = ["on-request"]\n');
        const broken = join(dir, 'broken.toml');
        writeFileSync(broken, '= nope');
        assert.equal(managedPolicy([other]), undefined);
        assert.equal(managedPolicy([join(dir, 'absent.toml'), about]), about);
        assert.equal(managedPolicy([broken]), broken);
        const cfg = readCodexConfig(home('[mcp_servers.hf]\nurl = "https://huggingface.co/mcp"\n'), {}, { managedFiles: [about] });
        assert.deepEqual(cfg.table.servers, {});
        assert.match(cfg.table.skipped['(all servers)']!, /managed Codex policy/);
    });

    test('the plugin\'s own settings narrow the servers', () => {
        const dir = home('[mcp_servers.a]\nurl = "https://a.example/mcp"\n[mcp_servers.b]\nurl = "https://b.example/mcp"\n[mcp_servers.c]\nurl = "https://c.example/mcp"\n');
        const store = new Store(join(dir, 'mcp-skills'));
        writeFileSync(join(store.dir, 'settings.json'), JSON.stringify({ servers: ['a', 'b'], skip: ['b'] }));
        const s = store.settings();
        const { table } = readCodexConfig(dir, {}, { managedFiles: [], only: s.servers, skip: s.skip });
        assert.deepEqual(Object.keys(table.servers), ['a']);
        assert.match(table.skipped.b!, /settings/);
    });

    test('[[skills.config]] rules are read, by path and by name, in order', () => {
        const dir = home('[[skills.config]]\npath = "/p/SKILL.md"\nenabled = false\n\n[[skills.config]]\nname = "mcp-skills:hf:x"\nenabled = true\n\n[[skills.config]]\nenabled = false\n');
        // A rule's path is resolved as the platform does: on Windows '/p/SKILL.md' becomes a drive path.
        assert.deepEqual(readSkillRules(join(dir, 'config.toml')), [{ path: resolve('/p/SKILL.md'), enabled: false }, { name: 'mcp-skills:hf:x', enabled: true }]);
    });

    test('CODEX_HOME is found from an installed plugin\'s path, where Codex does not pass the variable', () => {
        const base = temp();
        assert.equal(codexHomeOf({}, join(base, '.codex', 'plugins', 'cache', 'agent-polyfill', 'mcp-skills', '0.1.0')), join(base, '.codex'));
        assert.equal(codexHomeOf({ HOME: base }, join(base, 'repo', 'polyfills', 'skills', 'codex', 'mod')), join(base, '.codex'));
        assert.equal(codexHomeOf({ CODEX_HOME: join(base, 'c') }, join(base, 'x')), join(base, 'c'));
        assert.equal(codexHomeOf({ MCP_SKILLS_CODEX_HOME: join(base, 'm'), CODEX_HOME: join(base, 'c') }), join(base, 'm'));
        mkdirSync(join(base, 'x'), { recursive: true });
    });
});
