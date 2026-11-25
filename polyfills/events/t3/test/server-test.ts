// The server Codex starts for a T3 Code thread, and the watcher it starts: end to end, with
// the fixture events server and a stand-in `t3`.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { socketPath } from '../src/ipc.ts';
import { teardown, BUNDLE, SERVER, newThread, ROOT, sleep, startServer, stopWatcher, untilActive, waitFor, watcherLog, world, type World } from './harness.ts';

const worlds: World[] = [];
const make = (env: Record<string, string> = {}, extraToml = '') => {
    const w = world(env, extraToml);
    worlds.push(w);
    return w;
};
after(() => teardown(worlds));

const watchTickets = async (w: World, thread: string, note = 'tell me') => {
    const s = await startServer(w, thread);
    const r = await s.call('watch_event', { server: 'tickets', event: 'ticket.created', note });
    assert.equal(r.isError, false, r.text);
    await untilActive(s);
    return { s, watch: /as (w-[0-9a-f]+)/.exec(r.text)![1]! };
};

test('outside a T3 Code thread (no T3CODE_THREAD_ID) it offers no tools, and starts no watcher', async () => {
    const w = make();
    const s = await startServer(w, undefined);
    assert.deepEqual(await s.tools(), []);
    const init = await s.request('tools/call', { name: 'list_watches', arguments: {} });
    assert.match(JSON.stringify(init), /only in a thread T3 Code runs/);
    await s.stop();
    assert.doesNotMatch(watcherLog(w), /started the watcher/);
});

test('MCP_EVENTS_OFF=1 offers nothing', async () => {
    const w = make();
    const s = await startServer(w, newThread(), { MCP_EVENTS_OFF: '1' });
    assert.deepEqual(await s.tools(), []);
    await s.stop();
});

test('in a thread: the six tools, with reading tools marked read-only', async () => {
    const w = make();
    const s = await startServer(w, newThread());
    const r = await s.request('tools/list');
    const tools = (r.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ['list_event_types', 'watch_event', 'unwatch_event', 'list_watches', 'get_event', 'recent_events']);
    assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name), ['list_event_types', 'list_watches', 'get_event', 'recent_events']);
    await s.stop();
});

test('a watch outlives the server the agent started: after it exits, an event still wakes the thread through t3 thread send', async () => {
    const w = make();
    const thread = newThread();
    const { s, watch } = await watchTickets(w, thread, 'triage it');
    // T3 Code closes the agent's session; the agent stops the server it started for the thread.
    assert.equal(await s.stop(), 0);
    w.emit('ticket.created', { id: 'T-1', priority: 'high', title: 'Printer on fire' });
    const sent = await waitFor(() => w.sent()[0], 15000, 'a wake');
    assert.equal(sent.thread, thread);
    assert.deepEqual(sent.args.slice(0, 3), ['thread', 'send', '--json']);
    const lines = sent.message.split('\n');
    assert.equal(lines[0], '[mcp-events] (Sent by the mcp-events polyfill through T3 Code, not typed by the user.)');
    assert.match(sent.message, new RegExp(`tickets · ticket.created: 1 new event \\[event e1; watch ${watch}`));
    assert.match(sent.message, /triage it/);
    // Nothing the server wrote goes into the wake.
    assert.doesNotMatch(sent.message, /Printer on fire/);
    // Neither this polyfill's settings nor the first thread's id reach T3 Code.
    assert.deepEqual(sent.leaked, []);

    // A new session of the same thread reads the event.
    const again = await startServer(w, thread);
    const ev = await again.call('get_event', { id: 'e1' });
    assert.match(ev.text, /Printer on fire/);
    await again.stop();
});

test('one watcher serves many threads; each thread sees and is woken for its own watches only', async () => {
    const w = make();
    const a = newThread();
    const b = newThread();
    const one = await watchTickets(w, a, 'for a');
    const two = await startServer(w, b);
    assert.match((await two.call('list_watches')).text, /^\[\]/);
    const r = await two.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: { priority: 'low' }, note: 'for b' });
    assert.equal(r.isError, false, r.text);
    await untilActive(two);
    // b cannot stop a's watch.
    const stolen = await two.call('unwatch_event', { watch: one.watch });
    assert.equal(stolen.isError, true);
    w.emit('ticket.created', { id: 'T-2', priority: 'high', title: 'for a only' });
    await waitFor(() => w.sent().some((x) => x.thread === a), 15000, "a's wake");
    await sleep(1500);
    assert.deepEqual(
        w.sent().map((x) => x.thread),
        [a]
    );
    const pids = new Set(watcherLog(w).match(/\[watcher \d+\]/g));
    assert.equal(pids.size, 1, 'one watcher');
    await one.s.stop();
    await two.stop();
});

test('a watcher that was stopped resumes every saved watch when it starts again, without waiting for a call', async () => {
    const w = make();
    const thread = newThread();
    const { s } = await watchTickets(w, thread);
    await s.stop();
    assert.match(await stopWatcher(w), /stopping/);
    await waitFor(() => /stopped \(asked to stop\)/.test(watcherLog(w)), 10000, 'the watcher to stop');
    // Events from the meantime, kept by the server.
    w.emit('ticket.created', { id: 'T-3', priority: 'high', title: 'while stopped' });
    // Another thread's call starts the watcher again; it resumes this thread's watch from its cursor.
    const other = await startServer(w, newThread());
    await other.call('list_event_types');
    const sent = await waitFor(() => w.sent().find((x) => x.thread === thread), 15000, 'the wake after the restart');
    assert.match(sent.message, /1 new event/);
    assert.match(watcherLog(w), /resumed the watches of 1 thread\(s\)/);
    await other.stop();
});

test('with nothing watched the watcher ends by itself; it starts again with the next call', async () => {
    const w = make();
    const s = await startServer(w, newThread(), { MCP_EVENTS_WATCHER_IDLE_MS: '1500' });
    await s.call('list_event_types');
    await waitFor(() => /stopped \(no thread has a watch\)/.test(watcherLog(w)), 15000, 'the idle watcher to end');
    const r = await s.call('list_watches');
    assert.equal(r.isError, false, r.text);
    assert.equal((watcherLog(w).match(/watcher started/g) ?? []).length, 2);
    await s.stop();
});

test('while T3 Code is not running, events are stored and the wake is tried again until it is', async () => {
    const w = make();
    const thread = newThread();
    const { s } = await watchTickets(w, thread);
    writeFileSync(w.mode, 'down');
    w.emit('ticket.created', { id: 'T-4', priority: 'high' });
    await waitFor(() => w.sent().length > 0, 15000, 'a first try');
    const listed = await s.call('list_watches');
    assert.match(listed.text, /Waking this thread failed the last time it was tried \(T3 Code is not running/);
    writeFileSync(w.mode, 'ok');
    await waitFor(() => w.sent().some((x) => x.args.length && JSON.stringify(x).includes('1 new event') && x.pid !== w.sent()[0]!.pid), 20000, 'the retry');
    await s.stop();
});

test('a thread T3 Code no longer knows is not tried again; its events stay readable', async () => {
    const w = make();
    const thread = newThread();
    const { s } = await watchTickets(w, thread);
    writeFileSync(w.mode, 'gone');
    w.emit('ticket.created', { id: 'T-5', priority: 'high' });
    await waitFor(() => w.sent().length > 0, 15000, 'the try');
    await sleep(6000);
    assert.equal(w.sent().length, 1);
    assert.match((await s.call('list_watches')).text, /can't be woken/);
    assert.match((await s.call('recent_events')).text, /T-5/);
    await s.stop();
});

test('the state is private to the user', async () => {
    if (process.platform === 'win32') return;
    const w = make();
    const s = await startServer(w, newThread());
    await s.call('list_event_types');
    const mode = (p: string) => execFileSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', p] : ['-c', '%a', p]).toString().trim();
    assert.equal(mode(w.state), '700');
    assert.equal(mode(join(w.state, 'mcp-events.log')), '600');
    assert.ok(existsSync(socketPath(w.state)));
    await s.stop();
});

test('the committed bundle is what src builds, and runs on its own', async () => {
    const out = join(make().dir, 'built');
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'ignore' });
    assert.equal(readFileSync(join(out, 'server.js'), 'utf8'), readFileSync(BUNDLE, 'utf8'), 'plugin/dist/server.js is stale: run npm run build');
    const w = make();
    const thread = newThread();
    const s = await startServer(w, thread, {}, BUNDLE);
    const r = await s.call('watch_event', { server: 'tickets', event: 'ticket.created', note: 'bundle' });
    assert.equal(r.isError, false, r.text);
    await untilActive(s);
    await s.stop();
    w.emit('ticket.created', { id: 'T-6', priority: 'high' });
    await waitFor(() => w.sent().find((x) => x.thread === thread), 15000, 'a wake from the bundle');
    await stopWatcher(w, BUNDLE);
});

test("the watcher doesn't connect to this server's own entry in the configuration", async () => {
    const w = make({}, [`[mcp_servers.mcp-events-t3]`, `command = ${JSON.stringify(process.execPath)}`, `args = ["--no-warnings", ${JSON.stringify(SERVER)}]`, ''].join('\n'));
    const s = await startServer(w, newThread());
    const r = await s.call('list_event_types');
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /mcp-events-t3/);
    assert.match(watcherLog(w), /watcher started \(1 configured server\(s\)\)/);
    assert.doesNotMatch(watcherLog(w), /outside a T3 Code thread/);
    await s.stop();
});
