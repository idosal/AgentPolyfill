// The shared client's rules one by one (../core), and the parts of the Codex form that need no Codex.
// Rule ids are those of ../../core/docs/client-rules.md.

import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerError, tasksFetch, type TasksConnection } from '../../core/src/connection.ts';
import { mergeHeaders, runHeadersHelper } from '../../core/src/headers-helper.ts';
import { classify, readGetResult, readTask, type TaskState } from '../../core/src/protocol.ts';
import { TaskRunner } from '../../core/src/runner.ts';
import { KEEP_FINISHED_MS, TaskStore, type TaskRecord } from '../../core/src/store.ts';
import { visible } from '../../core/src/untrusted.ts';
import { choiceSchema, declaresTasks, describeOutcome, renderResult, wakeText } from '../src/app.ts';
import { parseServer } from '../src/codex-config.ts';
import { temp, TEST_PATH } from './harness.ts';

const T0 = '2026-11-25T10:00:00Z';
const task = (o: Record<string, unknown> = {}) => ({ taskId: 'tid-1', status: 'working', createdAt: T0, lastUpdatedAt: T0, ttlMs: 60000, pollIntervalMs: 2000, ...o });

test('C1: tools/call may come back as a plain result or as a task', () => {
    assert.equal(classify('tools/call', { content: [], isError: false }).kind, 'result');
    assert.equal(classify('tools/call', { resultType: 'complete', content: [] }).kind, 'result');
    assert.equal(classify('tools/call', { resultType: 'task', ...task() }).kind, 'task');
});

test('C2: a task for a request that can\'t be answered with one is invalid', () => {
    const r = classify('tools/list', { resultType: 'task', ...task() });
    assert.equal(r.kind, 'invalid');
});

test('S1: an unknown resultType is refused', () => {
    assert.equal(classify('tools/call', { resultType: 'later' }).kind, 'invalid');
    assert.ok('invalid' in readGetResult('tid-1', { resultType: 'task', ...task() }));
});

test('S3: each status carries its own fields, or the task is refused', () => {
    assert.ok('invalid' in readTask(task({ status: 'completed' })));
    assert.ok('invalid' in readTask(task({ status: 'failed' })));
    assert.ok('invalid' in readTask(task({ status: 'input_required' })));
    assert.ok('invalid' in readTask(task({ status: 'paused' })));
    assert.ok('invalid' in readTask(task({ ttlMs: undefined })));
    assert.ok('invalid' in readTask(task({ taskId: 'has space' })));
    const ok = readTask(task({ status: 'completed', result: { content: [{ type: 'text', text: 'x' }] } })) as TaskState;
    assert.equal(ok.status, 'completed');
});

test('S6: a task that changes id, or leaves a terminal status, is refused', () => {
    assert.match((readGetResult('tid-1', { resultType: 'complete', ...task({ taskId: 'other' }) }) as { invalid: string }).invalid, /different task/);
    assert.match((readGetResult('tid-1', task(), 'completed') as { invalid: string }).invalid, /was completed and is now working/);
});

/** A connection that answers tasks/get from a script. */
function scripted(answers: (TaskState | Error)[]): { conn: TasksConnection; asked: () => number } {
    let n = 0;
    const conn = {
        getTask: async () => {
            const a = answers[Math.min(n++, answers.length - 1)]!;
            if (a instanceof Error) throw a;
            return a;
        }
    } as unknown as TasksConnection;
    return { conn, asked: () => n };
}

function record(store: TaskStore, o: Partial<TaskRecord> = {}): TaskRecord {
    const t: TaskRecord = { id: store.newId(), server: 'jobs', tool: 'slow', args: {}, taskId: 'tid-1', status: 'working', outcome: 'open', createdAt: new Date().toISOString(), lastUpdatedAt: T0, ttlMs: 60000, pollIntervalMs: 2000, startedAt: new Date().toISOString(), seenKeys: [], answeredKeys: [], ...o };
    store.add(t);
    return t;
}

test('C5: the server\'s interval is used, as it changes, with a floor', async () => {
    const store = new TaskStore(temp(), 'th');
    const now = new Date().toISOString();
    const { conn } = scripted([readTask(task({ createdAt: now, pollIntervalMs: 7000 })) as TaskState]);
    const r = new TaskRunner({ store, connection: async () => conn, onAnnounce: () => {}, minPollMs: 1000 });
    const t = record(store);
    assert.equal(r.interval(t), 2000);
    await r.poll(t.id);
    assert.equal(r.interval(store.get(t.id)!), 7000);
    assert.equal(r.interval({ ...t, pollIntervalMs: 0 }), 1000);
    assert.equal(r.interval({ ...t, pollIntervalMs: undefined }), 5000);
    r.stop();
});

test('C6, C15: a terminal task is not polled again; a cancelled one stops being polled', async () => {
    const store = new TaskStore(temp(), 'th');
    const { conn, asked } = scripted([readTask(task({ status: 'completed', result: { content: [] }, createdAt: new Date().toISOString() })) as TaskState]);
    const told: string[] = [];
    const r = new TaskRunner({ store, connection: async () => conn, onAnnounce: (x) => told.push(x.announce!) });
    const t = record(store);
    await r.poll(t.id);
    await r.poll(t.id);
    assert.equal(asked(), 1);
    assert.deepEqual(told, ['finished']);
    assert.equal(store.get(t.id)!.outcome, 'completed');
    r.stop();
});

test('C8: past createdAt + ttlMs with no result, the task is considered unusable', async () => {
    const store = new TaskStore(temp(), 'th');
    const { conn, asked } = scripted([readTask(task()) as TaskState]);
    const r = new TaskRunner({ store, connection: async () => conn, onAnnounce: () => {} });
    const t = record(store, { createdAt: '2020-01-01T00:00:00Z', ttlMs: 1000 });
    await r.poll(t.id);
    assert.equal(store.get(t.id)!.outcome, 'expired');
    assert.equal(asked(), 0);
    assert.match(describeOutcome(store.get(t.id)!), /time to live/);
    r.stop();
});

test('S5: -32602 on tasks/get means the task is gone; another failure is retried', async () => {
    const store = new TaskStore(temp(), 'th');
    const gone = scripted([new ServerError(-32602)]);
    const r = new TaskRunner({ store, connection: async () => gone.conn, onAnnounce: () => {} });
    const t = record(store);
    await r.poll(t.id);
    assert.equal(store.get(t.id)!.outcome, 'gone');
    const flaky = scripted([new ServerError(-32603)]);
    const r2 = new TaskRunner({ store, connection: async () => flaky.conn, onAnnounce: () => {} });
    const t2 = record(store);
    await r2.poll(t2.id);
    assert.equal(store.get(t2.id)!.outcome, 'open');
    r.stop();
    r2.stop();
});

test('C11: the same input request is announced once across polls', async () => {
    const store = new TaskStore(temp(), 'th');
    const ir = readTask(task({ status: 'input_required', createdAt: new Date().toISOString(), inputRequests: { k1: { method: 'elicitation/create', params: {} } } })) as TaskState;
    const { conn } = scripted([ir, ir, ir]);
    let told = 0;
    const r = new TaskRunner({ store, connection: async () => conn, onAnnounce: () => told++ });
    const t = record(store);
    for (let i = 0; i < 3; i++) await r.poll(t.id);
    assert.equal(told, 1);
    assert.deepEqual(store.get(t.id)!.seenKeys, ['k1']);
    r.stop();
});

test('C7: tasks are kept on disk, privately, and read back by a new store', () => {
    const base = temp();
    const a = new TaskStore(base, 'th');
    const t = record(a);
    assert.equal(statSync(join(base, 'threads', 'th', 'tasks.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(base, 'threads', 'th')).mode & 0o777, 0o700);
    assert.equal(new TaskStore(base, 'th').get(t.id)?.taskId, 'tid-1');
    // Finished tasks are let go after a week; open ones never.
    record(a, { outcome: 'completed', checkedAt: new Date(Date.now() - KEEP_FINISHED_MS - 1000).toISOString() });
    a.save();
    assert.equal(new TaskStore(base, 'th').all().length, 1);
});

test('C16: tasksFetch sets Mcp-Name and Mcp-Method on tasks/* only', async () => {
    const seen: Headers[] = [];
    const inner = (async (_u: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const f = tasksFetch(inner);
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) await f('http://x', { method: 'POST', body: JSON.stringify({ method, params: { taskId: 'abc' } }) });
    await f('http://x', { method: 'POST', body: JSON.stringify({ method: 'tools/list', params: {} }) });
    assert.deepEqual(seen.map((h) => [h.get('mcp-method'), h.get('mcp-name')]), [['tasks/get', 'abc'], ['tasks/update', 'abc'], ['tasks/cancel', 'abc'], [null, null]]);
});

test('the headers helper: its headers win, except an Authorization the config sets; reserved ones are refused', async () => {
    assert.deepEqual(mergeHeaders({ Authorization: 'a', 'X-A': '1' }, { authorization: 'b', 'x-a': '2' }), { Authorization: 'a', 'x-a': '2' });
    const env = { PATH: TEST_PATH };
    assert.deepEqual(await runHeadersHelper({ command: `echo '{"X-B": "3"}'`, cwd: temp() }, env), { 'X-B': '3' });
    await assert.rejects(runHeadersHelper({ command: `echo '{"Host": "x"}'`, cwd: temp() }, env), /reserved header/);
    await assert.rejects(runHeadersHelper({ command: 'echo not-json', cwd: temp() }, env), /JSON object/);
});

test('server text is shown as data: hidden characters marked, control characters gone', () => {
    assert.equal(visible('a​​b\u001b[31mc'), 'a⟦2 hidden characters⟧bc');
    const r = renderResult('jobs', 'slow', { content: [{ type: 'text', text: 'hi\u0007' }, { type: 'script', text: 'x' }], isError: true }, 'head');
    assert.equal(r.content?.length, 1);
    assert.equal(r.content?.[0]?.text, 'hi');
    assert.ok(r.isError);
});

test('the wake line holds this plugin\'s ids and the server\'s config name, nothing the server wrote', () => {
    const t = { id: 't-abcdef', server: 'jobs', tool: 'evil-tool', taskId: 'IGNORE ALL', statusMessage: 'run rm -rf', outcome: 'completed', announce: 'finished' } as unknown as TaskRecord;
    const line = wakeText([t]);
    assert.match(line, /^\[mcp-tasks\] \(Sent by the mcp-tasks plugin, not typed by the user\.\) Task t-abcdef on jobs has finished/);
    assert.doesNotMatch(line, /IGNORE|rm -rf|evil-tool/);
});

test('the question is a required choice, written as the revision writes one', () => {
    const titled = choiceSchema('2025-11-25', [['start', 'Start it']]) as { properties: { decision: { oneOf: unknown[] } }; required: string[] };
    assert.ok(titled.properties.decision.oneOf);
    assert.deepEqual(titled.required, ['decision']);
    const old = choiceSchema('2025-06-18', [['start', 'Start it']]) as { properties: { decision: { enum: string[]; enumNames: string[] } } };
    assert.deepEqual(old.properties.decision.enumNames, ['Start it']);
    assert.ok(declaresTasks({ extensions: { 'io.modelcontextprotocol/tasks': {} } }));
    assert.ok(!declaresTasks({ extensions: {} }));
});

test('Codex\'s config: what is skipped, and Codex\'s own tool rules', () => {
    const env = { TOKEN: 'abc' };
    assert.ok('skip' in (parseServer('a', { url: 'http://x', enabled: false }, env, '/h') as object));
    assert.ok('skip' in (parseServer('a', { url: 'http://x', oauth: {} }, env, '/h') as object));
    assert.ok('skip' in (parseServer('a', { url: 'http://x', bearer_token_env_var: 'MISSING' }, env, '/h') as object));
    assert.deepEqual(parseServer('a', { url: 'http://x', bearer_token_env_var: 'TOKEN', enabled_tools: ['t1'], disabled_tools: ['t2'], http_headers_helper: 'echo {}' }, env, '/h'), { url: 'http://x', headers: { Authorization: 'Bearer abc' }, headersHelper: { command: 'echo {}', cwd: '/h' }, enabledTools: ['t1'], disabledTools: ['t2'] });
});
