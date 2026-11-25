// The interop run (contract rule 3): the helper, as Codex runs it, against a Tasks server someone else
// wrote: FastMCP with fastmcp-tasks (SEP-2663), over Streamable HTTP. The few tools in
// fastmcp_server.py only give it work to do; capability, task creation, tasks/get|update|cancel, the
// input loop and the check that Mcp-Name matches the task are all FastMCP's.
//
// MCP_TASKS_INTEROP_PYTHON names a Python that has `fastmcp[tasks]` installed (CI makes a venv with
// the versions below). Python runs isolated (-I), with an allowlisted environment and a throwaway HOME.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TasksConnection } from '../../../core/src/connection.ts';
import { children, choose, FakeCodex, idOf, newThread, stopServers, temp, waitFor, world } from '../harness.ts';

export const VERSIONS = { fastmcp: '4.2.6', 'fastmcp-tasks': '4.2.6' };
const PYTHON = process.env.MCP_TASKS_INTEROP_PYTHON;
const SERVER = fileURLToPath(new URL('fastmcp_server.py', import.meta.url));
const PORT = 47000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const open: FakeCodex[] = [];

before(async () => {
    assert.ok(PYTHON, 'set MCP_TASKS_INTEROP_PYTHON to a Python with fastmcp[tasks] installed');
    const home = temp();
    const child = spawn(PYTHON, ['-I', SERVER, String(PORT)], { env: { HOME: home, PATH: join(PYTHON, '..'), LANG: 'C.UTF-8' }, cwd: home, stdio: 'ignore' });
    children.push(child);
    child.unref();
    await waitFor(async () => {
        try {
            await fetch(URL_, { method: 'POST', body: '{}' });
            return true;
        } catch {
            return false;
        }
    }, 30000, 'FastMCP to listen');
});
after(async () => {
    for (const c of open) await c.close().catch(() => {});
    stopServers();
});

async function codex() {
    const w = await world({ url: URL_ });
    const c = new FakeCodex(w);
    open.push(c);
    await c.initialize();
    c.respond = choose('start');
    return { w, c, thread: newThread() };
}

const post = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}, declare = true) =>
    fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'x', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': declare ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {} } } })
    }).then(async (r) => ({ status: r.status, body: (await r.text()) as string }));

test('the Python packages are the versions tested', () => {
    const out = execFileSync(PYTHON!, ['-I', '-c', 'import importlib.metadata as m; print(m.version("fastmcp"), m.version("fastmcp-tasks"))'], { env: { HOME: temp(), PATH: join(PYTHON!, '..') } }).toString().trim();
    assert.equal(out, `${VERSIONS.fastmcp} ${VERSIONS['fastmcp-tasks']}`);
});

test('FastMCP gives no task to a client that doesn\'t declare the extension (C0)', async () => {
    const r = await post('tools/call', { name: 'slow_add', arguments: { a: 1, b: 2, seconds: 0 } }, { 'mcp-name': 'slow_add' }, false);
    assert.match(r.body, /"resultType":"complete"/);
    assert.match(r.body, /1 \+ 2 = 3/);
    assert.doesNotMatch(r.body, /"resultType":"task"/);
});

test('FastMCP refuses tasks/get with an Mcp-Name that isn\'t the task\'s (C16 checked by the server)', async () => {
    const created = await post('tools/call', { name: 'long_job', arguments: { seconds: 30 } }, { 'mcp-name': 'long_job' });
    const taskId = (JSON.parse(created.body) as { result: { taskId: string } }).result.taskId;
    const good = await post('tasks/get', { taskId }, { 'mcp-name': taskId });
    assert.match(good.body, /"status":"working"/);
    const bad = await post('tasks/get', { taskId }, { 'mcp-name': 'not-the-task' });
    assert.doesNotMatch(bad.body, /"status":"working"/);
    assert.ok(bad.status >= 400 || /"error"/.test(bad.body), bad.body);
    await post('tasks/cancel', { taskId }, { 'mcp-name': taskId });
});

test('FastMCP advertises the extension on 2026-07-28, and the versions are the ones tested', async () => {
    const conn = new TasksConnection('fm', { url: URL_ }, { name: 'interop', version: '0' });
    await conn.connect(10000);
    assert.ok(conn.offersTasks);
    assert.equal(conn.revision, '2026-07-28');
    await conn.close();
    const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'x', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const info = ((await r.json()) as { result: { _meta: Record<string, { version: string }> } }).result._meta['io.modelcontextprotocol/serverInfo'];
    assert.equal(info?.version, VERSIONS.fastmcp);
});

test('a task completes, the session is woken, the result reads as FastMCP\'s data', async () => {
    const { w, c, thread } = await codex();
    const id = idOf((await c.call('start_task', { server: 'fm', tool: 'slow_add', arguments: { a: 2, b: 40, seconds: 1 } }, thread)).text)!;
    assert.ok(id);
    await waitFor(() => w.wakes()[0], 30000, 'the wake');
    const r = await c.call('get_task_result', { task: id }, thread, { trigger: 'queue' });
    assert.equal(r.content[0]?.text, '2 + 40 = 42');
});

test('a plain result: FastMCP answers echo at once, with no task', async () => {
    const { c, thread } = await codex();
    const r = await c.call('start_task', { server: 'fm', tool: 'echo', arguments: { text: 'hi' } }, thread);
    assert.match(r.text, /answered at once/);
    assert.equal(r.content[0]?.text, 'hi');
});

test('input_required: FastMCP\'s question goes to the person, the answer goes back with tasks/update', async () => {
    const { w, c, thread } = await codex();
    const id = idOf((await c.call('start_task', { server: 'fm', tool: 'greet' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 30000, 'the input wake');
    c.respond = (p) => {
        assert.match(String(p.message), /What is your name\?/);
        return { action: 'accept', content: { name: 'Luca' } };
    };
    assert.match((await c.call('provide_task_input', { task: id }, thread)).text, /Sent 1 answer/);
    await waitFor(() => w.wakes().length >= 2, 30000, 'the second wake');
    assert.equal((await c.call('get_task_result', { task: id }, thread)).content[0]?.text, 'Hello, Luca!');
});

test('a declined question reaches FastMCP as a decline', async () => {
    const { w, c, thread } = await codex();
    const id = idOf((await c.call('start_task', { server: 'fm', tool: 'greet' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 30000, 'the input wake');
    c.respond = () => ({ action: 'decline' });
    await c.call('provide_task_input', { task: id }, thread);
    await waitFor(() => w.wakes().length >= 2, 30000, 'the second wake');
    assert.equal((await c.call('get_task_result', { task: id }, thread)).content[0]?.text, 'No name given (decline).');
});

test('sampling is refused, and FastMCP\'s task waits', async () => {
    const { w, c, thread } = await codex();
    const id = idOf((await c.call('start_task', { server: 'fm', tool: 'summarize_with_your_model' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 30000, 'the input wake');
    assert.match((await c.call('provide_task_input', { task: id }, thread)).text, /sampling/);
    assert.match((await c.call('get_task', { task: id }, thread)).text, /waiting for input/);
});

test('cancel: FastMCP acknowledges tasks/cancel, and the task is cancelled there', async () => {
    const { w, c, thread } = await codex();
    const id = idOf((await c.call('start_task', { server: 'fm', tool: 'long_job', arguments: { seconds: 60 } }, thread)).text)!;
    assert.match((await c.call('cancel_task', { task: id }, thread)).text, /acknowledged the cancellation/);
    const stored = JSON.parse(readFileSync(join(w.state, 'threads', thread, 'tasks.json'), 'utf8')) as { tasks: { id: string; taskId: string }[] };
    const conn = new TasksConnection('fm', { url: URL_ }, { name: 'interop', version: '0' });
    await conn.connect(10000);
    const state = await waitFor(async () => {
        const t = await conn.getTask(stored.tasks.find((x) => x.id === id)!.taskId);
        return 'status' in t && t.status === 'cancelled' && t;
    }, 15000, 'FastMCP to cancel it');
    assert.equal(state.status, 'cancelled');
    await conn.close();
});
