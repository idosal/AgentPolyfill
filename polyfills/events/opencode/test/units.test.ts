// The parts of the OpenCode form that need no OpenCode: reading its MCP
// configuration, and the committed bundle.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { upstreamOf } from '../src/config.ts';
import { stateDir } from '../src/plugin.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('a local server: its command, arguments, environment and folder', () => {
    assert.deepEqual(upstreamOf({ type: 'local', command: ['node', 'server.js', '--x'], environment: { A: '1' }, cwd: '/w' }), { command: 'node', args: ['server.js', '--x'], env: { A: '1' }, cwd: '/w' });
});

test('a remote server: its URL and headers', () => {
    assert.deepEqual(upstreamOf({ type: 'remote', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t' } }), { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t' } });
});

test('a server turned off in OpenCode is left alone', () => {
    assert.ok('skip' in upstreamOf({ type: 'remote', url: 'https://x.example/mcp', disabled: true }));
    assert.ok('skip' in upstreamOf({ type: 'remote', url: 'https://x.example/mcp' }, 'disabled'));
});

test('a value OpenCode would fill in, left unfilled, is never sent', () => {
    assert.ok('skip' in upstreamOf({ type: 'remote', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer {env:TOKEN}' } }));
    assert.ok('skip' in upstreamOf({ type: 'local', command: ['node', '{file:./x}'] }));
});

test('state lives under OpenCode\'s data folder, or MCP_EVENTS_STATE', () => {
    assert.equal(stateDir({ XDG_DATA_HOME: '/d' }), join('/d', 'opencode', 'mcp-events'));
    assert.equal(stateDir({ HOME: '/h' }), join('/h', '.local', 'share', 'opencode', 'mcp-events'));
    assert.equal(stateDir({ MCP_EVENTS_STATE: '/s' }), '/s');
});

test('plugin/server.js is what the sources build', () => {
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('the bundle loads on its own and exports a V2 plugin', async () => {
    const mod = (await import(join(ROOT, 'plugin', 'server.js'))) as { default: { id: string; setup: unknown } };
    assert.equal(mod.default.id, 'mcp-events');
    assert.equal(typeof mod.default.setup, 'function');
});
