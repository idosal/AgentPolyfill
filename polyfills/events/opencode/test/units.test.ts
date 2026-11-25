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

test("a watch's note or filters holding a character nobody sees is refused before anyone is asked", async () => {
    const { watchTextProblem } = await import('../src/plugin.ts');
    assert.equal(watchTextProblem({ note: 'tell me the title', arguments: { priority: 'high' } }), undefined);
    assert.match(watchTextProblem({ note: 'tell me\u{E0041}\u{E0042}' })!, /hidden character/);
    assert.match(watchTextProblem({ note: 'line one\nline two' })!, /control or hidden/);
    assert.match(watchTextProblem({ arguments: { priority: 'high​' } })!, /filter/);
    assert.match(watchTextProblem({ arguments: { ['pri‮ority']: 'high' } })!, /filter/);
    assert.match(watchTextProblem({ note: 'x'.repeat(501) })!, /at most 500/);
});

test('plugin/package.json makes the folder an installable package: this form, its bundle, nothing to install', async () => {
    const { readFileSync } = await import('node:fs');
    const form = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));
    assert.equal(pkg.name, form.name);
    assert.equal(pkg.version, form.version);
    assert.equal(pkg.main, './server.js');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.private, true);
    for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) assert.equal(pkg[k], undefined, k);
});

test('"Allow always" lists 0.1.0 kept are not read: they could hold another project\'s answers (OC-4)', async () => {
    const { alwaysKey, alwaysKeyV1, askByDefault } = await import('../src/consent.ts');
    const location = { directory: '/work/a', project: { id: 'project-a' } };
    const watch = 'mcp_events_watch';
    const resource = 'tickets:ticket.created';
    const instance = async (stored: Map<string, unknown>) => {
        let hook: ((e: { action: string; resources: string[]; effect: 'allow' | 'ask' | 'deny'; message?: string }) => void | Promise<void>) | undefined;
        const ctx = {
            location,
            storage: { get: async (k: string) => stored.get(k), set: async (k: string, v: unknown) => void stored.set(k, v) },
            // No permission events in this test.
            event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<{ type: string }>>(() => {}) }) }) },
            session: { get: async () => undefined },
            permission: { hook: async (_name: 'evaluate', cb: typeof hook) => ((hook = cb), { dispose: async () => {} }) }
        };
        await askByDefault(ctx as never, { actions: [watch], prefix: 'mcp-events', plugin: 'mcp-events', log: () => {} });
        const event = { action: watch, resources: [resource], effect: 'allow' as 'allow' | 'ask' | 'deny' };
        await hook!(event);
        return event.effect;
    };
    // Under 0.1.0's key: ignored, so the watch is asked about.
    assert.equal(await instance(new Map([[alwaysKeyV1('mcp-events', location), [`${watch}\n${resource}`]]])), 'ask');
    // Under the current key, the same entry holds.
    assert.equal(await instance(new Map([[alwaysKey('mcp-events', location), [`${watch}\n${resource}`]]])), 'allow');
    assert.notEqual(alwaysKey('mcp-events', location), alwaysKeyV1('mcp-events', location));
});

test('the three copies of consent.ts are the same file', async () => {
    const { readFileSync } = await import('node:fs');
    const mine = readFileSync(join(ROOT, 'src', 'consent.ts'), 'utf8');
    for (const other of ['skills', 'server-cards']) assert.equal(readFileSync(join(ROOT, '..', '..', other, 'opencode', 'src', 'consent.ts'), 'utf8'), mine, other);
});
