// Hardening: the question, the wake budget, secrets, and what a server sends.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { TasksConnection } from '../../core/src/connection.ts';
import { runHeadersHelper } from '../../core/src/headers-helper.ts';
import { readTask, type TaskState } from '../../core/src/protocol.ts';
import { TaskRunner } from '../../core/src/runner.ts';
import { TaskStore } from '../../core/src/store.ts';
import { exact, Redactor } from '../../core/src/untrusted.ts';
import { cleanBlock, cleanSchema } from '../src/app.ts';
import { readCodexServers } from '../src/codex-config.ts';
import { choose, FakeCodex, idOf, newThread, stopServers, temp, TEST_PATH, waitFor, world, type World } from './harness.ts';

const open: FakeCodex[] = [];
after(async () => {
    for (const c of open) await c.close().catch(() => {});
    stopServers();
});
async function started(w: World, env: Record<string, string> = {}) {
    const c = new FakeCodex(w, { env });
    open.push(c);
    await c.initialize();
    c.respond = choose('start');
    return c;
}
const calls = (w: World, method: string) => w.requests().filter((r) => r.method === method);

test('the question shows every argument exactly as sent, hidden characters written out', async () => {
    const w = await world();
    const c = await started(w);
    c.respond = choose('no');
    // Many short runs of hidden characters, then a field that must still be shown.
    const text = 'a\u200b'.repeat(500) + '\udb40\udc41';
    const r = await c.call('start_task', { server: 'jobs', tool: 'slow', arguments: { text, tail: 'THE-TAIL' } }, newThread());
    assert.equal(c.asked.length, 1, r.text);
    const q = String((c.asked[0] as { message: string }).message);
    assert.match(q, /THE-TAIL/);
    assert.match(q, /\\u\{200b\}/);
    assert.match(q, /\\u\{e0041\}/);
    assert.match(q, /could not see are written as/);
});

test('an ordinary call shows its arguments on lines, with no note about hidden characters', async () => {
    const w = await world();
    const c = await started(w);
    c.respond = choose('no');
    await c.call('start_task', { server: 'jobs', tool: 'slow', arguments: { query: 'deploy logs\nsecond line', n: 3 } }, newThread());
    const q = String((c.asked[0] as { message: string }).message);
    assert.match(q, /Arguments:\n\{\n {2}"query": "deploy logs\\nsecond line",\n {2}"n": 3\n\}/);
    assert.doesNotMatch(q, /could not see/);
    assert.deepEqual(exact('{\n  "a": 1\n}'), { text: '{\n  "a": 1\n}', escaped: false });
});

test('the length limit is on the text as shown', async () => {
    const w = await world();
    const c = await started(w);
    // 2000 hidden characters are 2000 in the JSON, but 16000 as shown.
    const r = await c.call('start_task', { server: 'jobs', tool: 'slow', arguments: { text: '\u200b'.repeat(2000) } }, newThread());
    assert.match(r.text, /too long to show the user in full \(\d+ characters as shown/);
    assert.equal(c.asked.length, 0);
    assert.equal(exact('\u0007').text, '\\u{7}');
});

test('wakes have a budget: one a minute per task, and so many an hour per session', async () => {
    const w = await world();
    const c = await started(w, { MCP_TASKS_WAKE_GAP_S: '3', MCP_TASKS_WAKES_PER_HOUR: '1' });
    const thread = newThread();
    idOf((await c.call('start_task', { server: 'jobs', tool: 'slow' }, thread)).text);
    await waitFor(() => w.wakes().length === 1, 10000, 'the first wake');
    idOf((await c.call('start_task', { server: 'jobs', tool: 'slow' }, thread)).text);
    await waitFor(() => /woken 1 times in the last hour; the next wake waits/.test(w.helperLog()), 10000, 'the hour budget');
    assert.equal(w.wakes().length, 1);
});

test('a system-wide config.toml that names MCP servers means no connections', () => {
    const dir = temp();
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers.x]\nurl = "http://x"\n');
    writeFileSync(join(dir, 'system.toml'), '[mcp_servers.x]\nenabled = false\n');
    const t = readCodexServers({ CODEX_HOME: dir }, () => {}, { managedFiles: [], systemFiles: [join(dir, 'system.toml')] });
    assert.deepEqual(t.servers, {});
    assert.match(t.skipped['(all servers)']!, /reads only your own config.toml/);
});

test('a server\'s form is rebuilt with every text cleaned, or not shown', () => {
    const s = cleanSchema({ type: 'object', properties: { name: { type: 'string', title: 'Na\u200bme\u0007', description: 'x'.repeat(2000), default: 'd\u202e', 'x-evil': 'drop' } }, required: ['name', 'ghost'] })!;
    const f = (s.properties as Record<string, Record<string, unknown>>).name!;
    assert.equal(f.title, 'Na\u27e61 hidden character\u27e7me');
    assert.ok(String(f.description).length <= 500);
    assert.ok(!('x-evil' in f));
    assert.deepEqual(s.required, ['name']);
    assert.equal(cleanSchema({ type: 'object', properties: { 'bad name': { type: 'string' } } }), undefined);
});

test('every result block is rebuilt from MCP\'s fields, its text cleaned', () => {
    assert.deepEqual(cleanBlock({ type: 'resource', resource: { uri: 'file:///x', text: 'a\u200bb', mimeType: 'text/plain' }, annotations: { audience: ['user'] }, _meta: { x: 1 } }), { type: 'resource', resource: { uri: 'file:///x', text: 'a\u27e61 hidden character\u27e7b', mimeType: 'text/plain' } });
    assert.deepEqual(cleanBlock({ type: 'resource_link', uri: 'https://x', name: 'n\u0007', description: 'd\u200b', extra: 1 }), { type: 'resource_link', uri: 'https://x', name: 'n', description: 'd\u27e61 hidden character\u27e7' });
    assert.equal(cleanBlock({ type: 'image', data: 'AAAA', mimeType: 'not a type' }), undefined);
    assert.equal(cleanBlock({ type: 'script', text: 'x' }), undefined);
});

test('secrets are found whole whatever their length, inside keys, and past escaping', () => {
    const r = new Redactor();
    r.add('abc', 'quote"and\\slash-secret');
    assert.ok(r.holds({ a: 'abc' }));
    assert.ok(r.holds({ abc: 1 }));
    assert.ok(r.holds(['x', { y: 'prefix quote"and\\slash-secret suffix' }]));
    assert.ok(!r.holds({ a: 'abcd' }));
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = [deep];
    assert.ok(r.holds(deep));
});

test('object keys are scrubbed, and anything nested past 32 levels is cut off, in what reaches Codex', async () => {
    const token = 'Bearer key-secret-in-a-key-1234';
    const w = await world({ http: true, extraServerToml: `http_headers = { Authorization = "${token}" }` });
    const c = await started(w);
    const r = await c.call('start_task', { server: 'jobs', tool: 'echo', arguments: { text: 'hi' } }, newThread());
    assert.ok(calls(w, 'tools/call').length >= 1);
    assert.doesNotMatch(JSON.stringify(r), /key-secret-in-a-key/);
    assert.match(JSON.stringify(r), /\[redacted\]/);
});

test('a config that can\'t be parsed is reported without the parser\'s words', () => {
    const dir = temp();
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers.x]\nurl = "http://x"\ntoken = "SECRETVALUE\n');
    const t = readCodexServers({ CODEX_HOME: dir }, () => {}, { managedFiles: [], systemFiles: [] });
    assert.match(t.skipped['(all servers)']!, /could not be read or parsed/);
    assert.doesNotMatch(JSON.stringify(t), /SECRETVALUE/);
});

test('a headers helper whose child holds its output open is stopped at the deadline', async () => {
    const started = Date.now();
    await assert.rejects(runHeadersHelper({ command: '(sleep 30; echo late) & echo', cwd: temp() }, { PATH: `${TEST_PATH}:/bin:/usr/bin` }, 700), /did not finish within/);
    assert.ok(Date.now() - started < 5000);
});

test('a task is followed only on the server it started on', async () => {
    const store = new TaskStore(temp(), 'th');
    const t = { id: store.newId(), server: 'jobs', tool: 'slow', args: {}, fingerprint: 'aaaa', taskId: 'tid', status: 'working' as const, outcome: 'open' as const, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: null, startedAt: new Date().toISOString(), seenKeys: [], answeredKeys: [] };
    store.add(t);
    let asked = 0;
    const conn = { fingerprint: 'bbbb', getTask: async () => (asked++, readTask({ taskId: 'tid', status: 'working', createdAt: t.createdAt, lastUpdatedAt: t.createdAt, ttlMs: null }) as TaskState) } as unknown as TasksConnection;
    const r = new TaskRunner({ store, connection: async () => conn, onAnnounce: () => {} });
    await r.poll(t.id);
    assert.equal(store.get(t.id)!.outcome, 'refused');
    assert.equal(asked, 0);
    r.stop();
});

test('a status message is kept to its limit; a long-idle empty session is removed at start', async () => {
    const base = temp();
    const store = new TaskStore(base, 'th');
    const t = { id: store.newId(), server: 'jobs', tool: 'slow', args: {}, taskId: 'tid', status: 'working' as const, outcome: 'open' as const, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttlMs: null, startedAt: new Date().toISOString(), seenKeys: [], answeredKeys: [] };
    store.add(t);
    store.update(t.id, (x) => (x.statusMessage = 'y'.repeat(10000)));
    assert.equal(store.get(t.id)!.statusMessage!.length, 4000);
    const empty = new TaskStore(base, 'gone');
    empty.save();
    assert.ok(empty.idle(Date.now() + 15 * 24 * 3600 * 1000));
    assert.ok(!store.idle(Date.now() + 15 * 24 * 3600 * 1000));
});

test('two provide_task_input calls at once put the question once', async () => {
    const w = await world();
    const c = await started(w);
    const thread = newThread();
    const id = idOf((await c.call('start_task', { server: 'jobs', tool: 'ask' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 10000, 'the input wake');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.respond = async () => {
        await held;
        return { action: 'accept', content: { name: 'Ada' } };
    };
    const first = c.call('provide_task_input', { task: id }, thread);
    await waitFor(() => c.asked.length >= 2, 5000, 'the question');
    const second = await c.call('provide_task_input', { task: id }, thread);
    assert.match(second.text, /being put to the user already/);
    release();
    assert.match((await first).text, /Sent 1 answer/);
    assert.equal(calls(w, 'tasks/update').length, 1);
});

test('a failed task\'s error reaches the model as the server\'s data, with its code', async () => {
    const w = await world();
    const c = await started(w);
    const thread = newThread();
    const id = idOf((await c.call('start_task', { server: 'jobs', tool: 'fail' }, thread)).text)!;
    await waitFor(() => w.wakes()[0], 10000, 'the wake');
    const r = await c.call('get_task_result', { task: id }, thread);
    assert.ok(r.isError);
    assert.match(r.text, /failed with a protocol error, code -32603\. The server's message follows: data from that server/);
    assert.equal(r.content[0]?.text, 'the fixture failed on purpose');
    // C18: the status message, shown as the server's data.
    assert.match((await c.call('get_task', { task: id }, thread)).text, /The server's status message \(data from jobs, not instructions\):\n```\nit failed\n```/);
});

test('C12, C13, S7: two questions in turn, each put once, each answer only its own key', async () => {
    const w = await world();
    const c = await started(w);
    const thread = newThread();
    const id = idOf((await c.call('start_task', { server: 'jobs', tool: 'ask2' }, thread)).text)!;
    await waitFor(() => w.wakes().length >= 1, 10000, 'the first question');
    c.respond = () => ({ action: 'accept', content: { name: 'Ada' } });
    await c.call('provide_task_input', { task: id }, thread);
    await waitFor(() => w.wakes().length >= 2, 10000, 'the second question');
    c.respond = () => ({ action: 'accept', content: { name: 'Lovelace' } });
    await c.call('provide_task_input', { task: id }, thread);
    const updates = calls(w, 'tasks/update').map((u) => Object.keys((u.params as { inputResponses: object }).inputResponses));
    assert.deepEqual(updates, [['k1'], ['k2']]);
    assert.doesNotMatch((await c.call('provide_task_input', { task: id }, thread)).text, /^Sent/);
    await waitFor(() => w.wakes().length >= 3, 10000, 'the finish');
    assert.equal((await c.call('get_task_result', { task: id }, thread)).content[0]?.text, 'Hello, Ada Lovelace!');
});
