// Rule 4 of the contract: when Codex speaks Tasks itself, the plugin does nothing.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { FakeCodex, newThread, world } from './harness.ts';

const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const open: FakeCodex[] = [];
after(async () => {
    for (const c of open) await c.close().catch(() => {});
});

test('declared at initialize: no tools, no connection', async () => {
    const w = await world();
    const c = new FakeCodex(w);
    open.push(c);
    await c.initialize({ elicitation: {}, ...TASKS });
    assert.deepEqual(((await c.request('tools/list')).result as { tools: unknown[] }).tools, []);
    assert.equal(w.requests().length, 0);
});

test('declared on server/discover (a 2026-07-28 client), which is answered "method not found" so the client falls back', async () => {
    const w = await world();
    const c = new FakeCodex(w);
    open.push(c);
    const d = await c.request('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': TASKS } });
    assert.equal((d.error as { code: number }).code, -32601);
    await c.initialize();
    assert.deepEqual(((await c.request('tools/list')).result as { tools: unknown[] }).tools, []);
});

test('declared on a tool call: that call and every later one is refused', async () => {
    const w = await world();
    const c = new FakeCodex(w);
    open.push(c);
    await c.initialize();
    const r = await c.call('list_task_servers', {}, newThread(), { meta: { 'io.modelcontextprotocol/clientCapabilities': TASKS } });
    assert.ok(r.isError);
    assert.deepEqual(((await c.request('tools/list')).result as { tools: unknown[] }).tools, []);
});

test('not declared: the tools are there, and their instructions are the plugin\'s own', async () => {
    const w = await world();
    const c = new FakeCodex(w);
    open.push(c);
    const init = await c.initialize();
    assert.match(String(init.instructions), /mcp-tasks adds the client side/);
    assert.equal(((await c.request('tools/list')).result as { tools: unknown[] }).tools.length, 7);
});
