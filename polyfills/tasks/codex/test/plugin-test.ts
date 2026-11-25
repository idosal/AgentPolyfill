// The installed plugin folder: the committed bundle is what the sources build to, the manifests agree,
// and every setting the helper reads is one Codex passes it (.mcp.json `env_vars`).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, temp } from './harness.ts';
import { VERSION } from '../src/version.ts';

test('plugin/dist/helper.js is what the sources build to', () => {
    const out = temp();
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'ignore' });
    assert.equal(readFileSync(join(out, 'helper.js'), 'utf8'), readFileSync(join(ROOT, 'plugin', 'dist', 'helper.js'), 'utf8'), 'run npm run build');
});

test('the manifests agree on the version and the server', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin', '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string; name: string };
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    assert.equal(plugin.version, VERSION);
    assert.equal(pkg.version, VERSION);
    assert.equal(plugin.name, 'mcp-tasks');
});

test('every MCP_TASKS_ setting the helper reads is passed through by .mcp.json', () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, 'plugin', '.mcp.json'), 'utf8')) as { mcpServers: { 'mcp-tasks': { env_vars: string[]; args: string[] } } };
    const server = mcp.mcpServers['mcp-tasks'];
    assert.deepEqual(server.args, ['./dist/helper.js']);
    const read = new Set<string>();
    for (const f of readdirSync(join(ROOT, 'src'))) for (const m of readFileSync(join(ROOT, 'src', f), 'utf8').matchAll(/\b(MCP_TASKS_[A-Z_]+)\b/g)) read.add(m[1]!);
    for (const v of read) assert.ok(server.env_vars.includes(v), `${v} is read but not in env_vars`);
    assert.ok(server.env_vars.includes('CODEX_HOME'));
});
