// SEP-3415's rules for a client, as this form wires the shared client up: through the
// server Codex starts for a T3 Code thread, the watcher, and the fixture events server.
// The shared client's clause-by-clause tests run in mcp-events-test.yml; these check that
// this form keeps them.

import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { started, newThread, sleep, startServer, stopWatcher, untilActive, waitFor, watcherLog, world, type World } from './harness.ts';

const worlds: World[] = [];
const make = (env: Record<string, string> = {}) => {
    const w = world(env);
    worlds.push(w);
    return w;
};
after(async () => {
    for (const s of started) if (s.child.exitCode === null) s.child.kill('SIGKILL');
    for (const w of worlds) await stopWatcher(w);
});

test('a client MUST NOT send events/* to a server that has not declared the extension (with the pre-standard form turned off)', async () => {
    const w = make({ FIXTURE_CAPS: 'toplevel' });
    const s = await startServer(w, newThread(), { MCP_EVENTS_PRE_STANDARD: 'off' });
    const r = await s.call('list_event_types');
    assert.doesNotMatch(r.text, /"name": "ticket.created"/);
    assert.equal(w.fixtureMethods().filter((m) => m.startsWith('events/')).length, 0);
    await s.stop();
});

test('by default the form from before the standard is used, as the other forms do, and said so', async () => {
    const w = make({ FIXTURE_CAPS: 'toplevel' });
    const s = await startServer(w, newThread());
    const r = await s.call('list_event_types');
    assert.match(r.text, /ticket.created/);
    assert.match(watcherLog(w), /form from before the standard/);
    await s.stop();
});

test('the extension declared in the SEP form is used, and the client declares itself as this form', async () => {
    const w = make();
    const s = await startServer(w, newThread());
    await s.call('list_event_types');
    assert.ok(w.fixtureMethods().includes('events/list'));
    await s.stop();
});

test('unwatch_event ends the subscription on the server (events/unsubscribe, or the stream closed)', async () => {
    const w = make({ FIXTURE_TICKET_DELIVERY: 'poll' });
    const thread = newThread();
    const s = await startServer(w, thread);
    const r = await s.call('watch_event', { server: 'tickets', event: 'ticket.created' });
    const watch = /as (w-[0-9a-f]+)/.exec(r.text)![1]!;
    await untilActive(s);
    const u = await s.call('unwatch_event', { watch });
    assert.equal(u.isError, false, u.text);
    assert.match((await s.call('list_watches')).text, /^\[\]/);
    const polls = () => w.fixtureMethods().filter((m) => m === 'events/poll').length;
    const before = polls();
    await sleep(1500);
    assert.ok(polls() - before <= 1, 'polling stopped');
    await s.stop();
});

test('an event is handed to the thread once, across a restart of the watcher (eventId dedupe, cursor kept)', async () => {
    const w = make({ FIXTURE_TICKET_DELIVERY: 'poll' });
    const thread = newThread();
    const s = await startServer(w, thread);
    await s.call('watch_event', { server: 'tickets', event: 'ticket.created' });
    await untilActive(s);
    w.emit('ticket.created', { id: 'T-1', priority: 'high' }, 'evt_same');
    await waitFor(() => w.sent().length === 1, 15000, 'the first wake');
    await s.stop();
    await stopWatcher(w);
    await waitFor(() => /stopped \(asked to stop\)/.test(watcherLog(w)), 10000, 'the watcher to stop');
    // The server sends the same event again (at-least-once delivery), then a new one.
    w.emit('ticket.created', { id: 'T-1', priority: 'high' }, 'evt_same');
    w.emit('ticket.created', { id: 'T-2', priority: 'high' }, 'evt_new');
    const again = await startServer(w, thread);
    await again.call('list_watches');
    await waitFor(() => w.sent().length === 2, 15000, 'the second wake');
    await sleep(1500);
    assert.equal(w.sent().length, 2);
    const recent = (await again.call('recent_events')).text;
    assert.equal((recent.match(/T-1/g) ?? []).length, 1, recent);
    assert.match(recent, /T-2/);
    await again.stop();
});
