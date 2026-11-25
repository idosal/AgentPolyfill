// The parts of the OpenCode form that need no OpenCode: reading its MCP
// configuration, and the committed bundle.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    const mod = (await import(pathToFileURL(join(ROOT, 'plugin', 'server.js')).href)) as { default: { id: string; setup: unknown } };
    assert.equal(mod.default.id, 'mcp-events');
    assert.equal(typeof mod.default.setup, 'function');
});

test('a name a server chose is shown in a permission request with anything but printable ASCII escaped', async () => {
    const { visible } = await import('../src/plugin.ts');
    assert.equal(visible('ticket.created'), 'ticket.created');
    assert.equal(visible('tick​et'), 'tick\\u{200b}et');
    assert.equal(visible('a‮b'), 'a\\u{202e}b');
});

test('"Allow always" on a watch saves a rule only for plain names, never a wildcard a server chose', async () => {
    const { watchPermission } = await import('../src/plugin.ts');
    assert.deepEqual(watchPermission('tickets', 'ticket.created'), { resource: 'tickets:ticket.created', save: ['tickets:ticket.created'] });
    assert.deepEqual(watchPermission('tickets', '*'), { resource: 'tickets:*', save: [] });
    assert.deepEqual(watchPermission('tickets', 'ticket?'), { resource: 'tickets:ticket?', save: [] });
    assert.deepEqual(watchPermission('tickets', 'tick​et').save, []);
});
