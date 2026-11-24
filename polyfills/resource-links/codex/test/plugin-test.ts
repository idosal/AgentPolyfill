// The plugin folder as Codex installs it: the committed bundle is what src/ builds,
// the manifests agree with each other, and the hook is set up as Codex expects.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, any>;

test('mod/dist is what src/ builds (run `npm run build` after a change)', () => {
    const out = mkdtempSync(join(tmpdir(), 'rl-build-'));
    const r = spawnSync(process.execPath, ['build.mjs', out], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['helper.js', 'hook.js']) assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(root, 'mod', 'dist', f), 'utf8'), `mod/dist/${f} is stale`);
});

test('plugin.json, package.json and the version in src agree', () => {
    const plugin = json('mod/.codex-plugin/plugin.json');
    assert.equal(plugin.name, 'mcp-resource-links');
    assert.equal(plugin.version, json('package.json').version);
    assert.match(readFileSync(join(root, 'src', 'version.ts'), 'utf8'), new RegExp(`VERSION = '${plugin.version}'`));
    assert.equal(plugin.mcpServers, './.mcp.json');
    assert.equal(plugin.hooks, './hooks/hooks.json');
});

test("the server runs the bundle, and passes on only the plugin's own settings and where Codex is", () => {
    const server = json('mod/.mcp.json').mcpServers['mcp-resource-links'];
    assert.deepEqual(server.args, ['./dist/helper.js']);
    assert.deepEqual(server.env_vars, ['CODEX_HOME', 'CODEX_CLI_PATH', 'MCP_RESOURCE_LINKS_DISABLED', 'MCP_RESOURCE_LINKS_STATE']);
});

test('the hook is one PostToolUse command for MCP tools, running the bundled hook', () => {
    const hooks = json('mod/hooks/hooks.json').hooks;
    assert.deepEqual(Object.keys(hooks), ['PostToolUse']);
    const [entry] = hooks.PostToolUse;
    assert.equal(entry.matcher, '^mcp__');
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].command, 'node "$PLUGIN_ROOT/dist/hook.js"');
});
