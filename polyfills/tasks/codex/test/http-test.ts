// Over Streamable HTTP: the routing headers (C16), configured credentials, the headers helper, and
// secrets kept out of what reaches Codex.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { choose, FakeCodex, idOf, newThread, stopServers, waitFor, world, type World } from './harness.ts';

const open: FakeCodex[] = [];
after(async () => {
    for (const c of open) await c.close().catch(() => {});
    stopServers();
});
async function started(w: World) {
    const c = new FakeCodex(w);
    open.push(c);
    await c.initialize();
    c.respond = choose('start');
    return c;
}
type Logged = { method: string; params: { taskId?: string; name?: string }; headers: Record<string, string | null> };
const logged = (w: World, method: string) => w.requests().filter((r) => r.method === method) as unknown as Logged[];

test('C16: tasks/get, tasks/update and tasks/cancel carry Mcp-Name: <taskId> and Mcp-Method', async () => {
    const w = await world({ http: true });
    const c = await started(w);
    const thread = newThread();
    const ask = idOf((await c.call('start_task', { server: 'jobs', tool: 'ask' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 10000, 'a wake');
    c.respond = () => ({ action: 'accept', content: { name: 'Ada' } });
    await c.call('provide_task_input', { task: ask }, thread);
    c.respond = choose('start');
    const long = idOf((await c.call('start_task', { server: 'jobs', tool: 'long' }, thread)).text)!;
    await c.call('cancel_task', { task: long }, thread);
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
        const rs = logged(w, method);
        assert.ok(rs.length, method);
        for (const r of rs) {
            assert.equal(r.headers['mcp-method'], method);
            assert.equal(r.headers['mcp-name'], r.params.taskId);
        }
    }
    // tools/call keeps the transport's own header: the tool's name.
    assert.equal(logged(w, 'tools/call')[0]!.headers['mcp-name'], 'ask');
});

test('a header from the config is sent, and never shown to Codex', async () => {
    const token = 'Bearer s3cr3t-token-for-the-test';
    const w = await world({ http: true, extraServerToml: `http_headers = { Authorization = "${token}" }` });
    const c = await started(w);
    const thread = newThread();
    // The server echoes the token back: what reaches Codex has it taken out.
    const echo = await c.call('start_task', { server: 'jobs', tool: 'echo', arguments: { text: 'x' } }, thread);
    const discovered = logged(w, 'server/discover');
    assert.ok(discovered.length > 0 && discovered.every((r) => r.headers.authorization === token));
    assert.match(String(echo.content[0]?.text), /\(you sent \[redacted\]\)/);
    assert.doesNotMatch(JSON.stringify(echo), /s3cr3t/);
    // Arguments that hold it are not sent at all.
    const r = await c.call('start_task', { server: 'jobs', tool: 'slow', arguments: { text: 's3cr3t-token-for-the-test' } }, thread);
    assert.match(r.text, /hold one of the secrets/);
    assert.equal(logged(w, 'tools/call').filter((x) => JSON.stringify(x.params).includes('slow')).length, 0);
});

test('the http_headers_helper runs, and its headers are sent', async () => {
    const w = await world({ http: true, extraServerToml: `http_headers_helper = "echo '{\\"X-Helper\\": \\"from-the-helper-1234\\"}'"` });
    const c = await started(w);
    await c.call('list_task_servers', {}, newThread());
    assert.equal(logged(w, 'server/discover')[0]?.headers['x-helper'], 'from-the-helper-1234');
});
