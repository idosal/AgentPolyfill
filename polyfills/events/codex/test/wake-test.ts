// Waking a Codex session: which session, how often, what it is told, and what happens when
// `codex queue` fails. The gate is the Claude Code form's (polyfills/events/core/src/wake.ts):
// a watch wakes its session at most once a minute, a session at most 30 times an hour, and
// past that it is told once and woken again only after the person writes.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ThreadSession } from '../src/threads.ts';
import { eventIdsIn, newThread, sleep, startHelper, temp, untilActive, waitFor, world } from './harness.ts';

describe('which session', () => {
    test("a watch belongs to the session that made it: its events wake that session, and another session does not see it", async () => {
        const w = world();
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        const a = newThread();
        const b = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, a);
            assert.match((await h.call('list_watches', {}, b)).text, /^\[\]$/, "b has no watches of a's");
            await untilActive(h, a);
            w.emit('ticket.created', { title: 'x' });
            await waitFor(() => w.queued().length === 1, 20000, 'a wake');
            assert.equal(w.queued()[0]!.thread, a);
            assert.match((await h.call('get_event', { id: 'e1' }, b)).text, /No event by that id in this session/);
        } finally {
            await h.stop();
        }
    });

    test('a call that does not say which session it is from is refused, and nothing is stored for it', async () => {
        const w = world();
        const h = await startHelper(w);
        try {
            const r = await h.request('tools/call', { name: 'list_watches', arguments: {} });
            const result = r.result as { isError: boolean; content: { text: string }[] };
            assert.equal(result.isError, true);
            assert.match(result.content[0]!.text, /needs Codex to say which session/);
            const bad = await h.request('tools/call', { name: 'list_watches', arguments: {}, _meta: { threadId: '../../etc' } });
            assert.equal((bad.result as { isError: boolean }).isError, true, 'an id that is not a Codex session id is refused');
        } finally {
            await h.stop();
        }
    });

    test('a second process with the same session open only lists its watches, and runs them once the first is gone', async () => {
        const w = world();
        const thread = newThread();
        const first = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        const second = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            await first.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            const listed = await second.call('list_watches', {}, thread);
            assert.match(listed.text, /"status": "elsewhere"/);
            const refused = await second.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            assert.match(refused.text, /another Codex process \(pid \d+\) runs this session's watches/);
            await first.stop();
            await waitFor(async () => /"status": "active"/.test((await second.call('list_watches', {}, thread, 'queue')).text), 20000, 'the second to take over');
            w.emit('ticket.created', { title: 'after the takeover' });
            await waitFor(() => w.queued().length === 1, 20000, 'a wake from the second');
        } finally {
            await second.stop();
        }
    });
});

describe('how often', () => {
    test('a watch wakes its session at most once in its gap; what comes sooner waits and goes in one message', async () => {
        const w = world();
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '3' });
        const thread = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the first wake');
            const t0 = Date.now();
            w.emit('ticket.created', { title: 'two' });
            await sleep(300);
            w.emit('ticket.created', { title: 'three' });
            await waitFor(() => w.queued().length === 2, 20000, 'the second wake');
            assert.ok(Date.now() - t0 >= 2000, 'not before the gap is over');
            assert.match(w.queued()[1]!.message, /2 new events \[events e2, e3;/);
        } finally {
            await h.stop();
        }
    });

    test("past the hour's wakes the session is told once; only the person's own turn starts waking again", async () => {
        const w = world();
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1' });
        const thread = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the wake');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => w.queued().length === 2, 20000, 'the notice');
            assert.match(w.queued()[1]!.message, /woken by events 1 times in the last hour, so the mcp-events plugin has stopped waking it\. 1 event is waiting.*call list_watches once/s);
            w.emit('ticket.created', { title: 'three' });
            await sleep(1500);
            assert.equal(w.queued().length, 2, 'not woken again, not told again');
            // A turn the queue started (this plugin's own wake) is not the person.
            await h.call('list_watches', {}, thread, 'queue');
            await sleep(1000);
            assert.equal(w.queued().length, 2);
            // CX1: nor is a turn Codex says nothing about, or one started by something else (a hook).
            await h.request('tools/call', { name: 'list_watches', arguments: {}, _meta: { threadId: thread } });
            await h.request('tools/call', { name: 'list_watches', arguments: {}, _meta: { threadId: thread, 'x-codex-turn-metadata': { thread_id: thread } } });
            await h.call('list_watches', {}, thread, 'hook');
            await sleep(1000);
            assert.equal(w.queued().length, 2, 'not woken by a turn that is not the person\'s');
            // The person writes (the TUI says "user"), and the model calls a tool in that turn.
            await h.call('list_watches', {}, thread, 'user');
            await waitFor(() => w.queued().length === 3, 20000, 'waking again');
            assert.match(w.queued()[2]!.message, /2 new events \[events e2, e3;/);
        } finally {
            await h.stop();
        }
    });
});

describe('a hand-over the helper never heard back about (the wake model, TLC)', () => {
    const wakesOf = (base: string, thread: string) => JSON.parse(readFileSync(join(base, 'sessions', thread, 'wakes.json'), 'utf8')) as { wakes: number[]; handed?: unknown; noticeHanded?: boolean; paused?: boolean };

    test('killed after codex queue took a batch and before it heard back: the next helper counts that wake and does not hand the batch over again', async () => {
        const w = world();
        writeFileSync(w.mode, 'queuehang');
        const thread = newThread();
        let h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            // Codex has queued it (the session is woken); its answer has not come.
            await waitFor(() => w.queued().length === 1, 20000, 'codex queue to take the batch');
            await sleep(300);
            h.child.kill('SIGKILL');
            await h.exited;
        } finally {
            for (const q of w.queued()) {
                try {
                    process.kill(q.pid, 'SIGKILL');
                } catch {
                    // gone
                }
            }
        }
        writeFileSync(w.mode, 'ok');
        h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            // A resumed session's first call (from a woken turn, so not the person's) starts the watches again.
            await h.call('list_watches', {}, thread, 'queue');
            await sleep(2500);
            assert.equal(w.queued().length, 1, 'the batch is not handed over a second time');
            const saved = wakesOf(w.state, thread);
            assert.equal(saved.wakes.length, 1, 'and the wake it made is counted');
            assert.equal(saved.handed, undefined, 'the record is cleared once counted');
            // What comes next is handed over as a batch of its own.
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => w.queued().length === 2, 20000, 'the next wake');
            assert.match(w.queued()[1]!.message, /1 new event \[event e2;/);
        } finally {
            await h.stop();
        }
    });

    test('a codex queue that times out (it may have queued) counts as handed over: counted once, not tried again', async () => {
        const base = temp('mcp-events-codex-maybe-');
        const thread = newThread();
        let calls = 0;
        const s = new ThreadSession(thread, {
            base,
            connections: new Map(),
            unavailable: () => [],
            wake: async () => {
                calls++;
                return { ok: false, why: 'codex queue did not finish within 60 s', maybe: true };
            },
            log: () => {},
            env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_BATCH_MS: '50' }
        });
        try {
            assert.equal(s.start(), true);
            s.spool.append({ kind: 'event', watch: 'w-aaaaaa', server: 'tickets', event: 'ticket.created', eventId: 'a1', data: {} });
            await waitFor(() => calls === 1, 5000, 'the try');
            await sleep(6000);
            assert.equal(calls, 1, 'not tried again (a retry comes after 5 s)');
            const saved = wakesOf(base, thread);
            assert.equal(saved.wakes.length, 1);
            assert.equal(saved.handed, undefined);
        } finally {
            await s.stop();
        }
    });

    test("the notice's codex queue fails, the person writes, and the helper restarts: the new one does not start paused", async () => {
        const base = temp('mcp-events-codex-notice-');
        const thread = newThread();
        const env = { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_BATCH_MS: '50' };
        let calls = 0;
        const first = new ThreadSession(thread, {
            base,
            connections: new Map(),
            unavailable: () => [],
            // The first wake goes through; the notice's codex queue then fails.
            wake: async () => (++calls === 1 ? { ok: true, resumed: true } : { ok: false, why: 'codex queue failed (exit 1)' }),
            log: () => {},
            env
        });
        try {
            assert.equal(first.start(), true);
            first.spool.append({ kind: 'event', watch: 'w-aaaaaa', server: 'tickets', event: 'ticket.created', eventId: 'a1', data: {} });
            await waitFor(() => calls === 1, 5000, 'the wake');
            first.spool.append({ kind: 'event', watch: 'w-aaaaaa', server: 'tickets', event: 'ticket.created', eventId: 'a2', data: {} });
            await waitFor(() => first.lastWakeError !== undefined, 5000, "the notice's failed try");
            assert.equal(calls, 2);
            assert.equal(wakesOf(base, thread).noticeHanded, false, 'a notice codex queue did not take is not kept as handed over, on disk');
            // The person writes before the notice is tried again.
            first.spoke();
        } finally {
            await first.stop();
        }
        assert.equal(wakesOf(base, thread).noticeHanded, false);
        const second = new ThreadSession(thread, { base, connections: new Map(), unavailable: () => [], wake: async () => ({ ok: true, resumed: true }), log: () => {}, env });
        try {
            assert.equal(second.budget.paused, false, 'not paused by a notice the person wrote after');
        } finally {
            await second.stop();
        }
    });
});

describe('CX1: when the person never writes', () => {
    test('the pause after the hourly limit lifts by itself after its time, and what waited is handed over in one wake', async () => {
        const base = temp('mcp-events-codex-lift-');
        const wakes: string[] = [];
        const s = new ThreadSession(newThread(), {
            base,
            connections: new Map(),
            unavailable: () => [],
            wake: async (_thread, text) => {
                wakes.push(text);
                return { ok: true, resumed: true };
            },
            log: () => {},
            env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_BATCH_MS: '50' },
            // An hour in use; a second and a half here.
            liftAfterMs: 1500
        });
        try {
            assert.equal(s.start(), true);
            const event = (eventId: string) => s.spool.append({ kind: 'event', watch: 'w-aaaaaa', server: 'tickets', event: 'ticket.created', eventId, data: {} });
            event('a1');
            await waitFor(() => wakes.length === 1, 5000, 'the wake');
            event('a2');
            await waitFor(() => wakes.length === 2, 5000, 'the notice');
            assert.match(wakes[1]!, /has stopped waking it/);
            event('a3');
            await sleep(500);
            assert.equal(wakes.length, 2, 'paused');
            // Nobody writes. The pause lifts on its own, without a new event to prompt it.
            await waitFor(() => wakes.length === 3, 5000, 'waking again after the pause');
            assert.match(wakes[2]!, /2 new events \[events e2, e3;/);
        } finally {
            await s.stop();
        }
    });
});

describe('when codex queue fails', () => {
    test('the events stay and the wake is tried again; once it goes through, they are handed over once', async () => {
        const w = world();
        writeFileSync(w.mode, 'fail');
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        const thread = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the failed try');
            // The failure is known once codex queue has exited, a moment after the try is seen. Looked at
            // from a woken turn, so the look is not the person's and does not bring the next try forward.
            const failed = /Waking this session failed the last time it was tried \(codex queue failed \(exit 1\)\)/;
            await waitFor(async () => failed.test((await h.call('list_watches', {}, thread, 'queue')).text), 20000, 'list_watches to say the try failed');
            writeFileSync(w.mode, 'noresume');
            await waitFor(() => w.queued().length === 2, 20000, 'the second try');
            assert.equal(w.queued()[1]!.message, w.queued()[0]!.message, 'the same events');
            writeFileSync(w.mode, 'ok');
            await sleep(6000);
            assert.equal(w.queued().length, 2, 'taken, so not handed over again');
        } finally {
            await h.stop();
        }
    });

    test("a chat Codex has no local session for (the ChatGPT desktop app's) is not tried again; its events are kept and readable, and list_watches says why", async () => {
        const w = world();
        writeFileSync(w.mode, 'norollout');
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0' });
        const thread = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the one try');
            // The retry that used to follow 5 s later does not come, nor does a new event bring one.
            await sleep(6000);
            w.emit('ticket.created', { title: 'two' });
            await sleep(2000);
            assert.equal(w.queued().length, 1, 'tried once, and not again');
            const listed = await h.call('list_watches', {}, thread, 'user');
            assert.match(listed.text, /This chat can't be woken: it isn't a local Codex session/);
            assert.match(listed.text, /recent_events and get_event read them/);
            const recent = await h.call('recent_events', {}, thread, 'user');
            assert.deepEqual(eventIdsIn(recent.text), ['e1', 'e2']);
            assert.match((await h.call('get_event', { id: 'e2' }, thread, 'user')).text, /"title": "two"/);
        } finally {
            await h.stop();
        }
    });

    test('MCP_EVENTS_CODEX_REMOTE sends the wake to the app server Codex runs against', async () => {
        const w = world();
        const h = await startHelper(w, { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_CODEX_REMOTE: 'ws://127.0.0.1:47811' });
        const thread = newThread();
        try {
            await h.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(h, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the wake');
            assert.equal(w.queued()[0]!.remote, 'ws://127.0.0.1:47811');
            assert.deepEqual(w.queued()[0]!.args.slice(0, 1), ['queue']);
            assert.ok(w.queued()[0]!.args.includes('--resume'));
        } finally {
            await h.stop();
        }
    });
});

describe('taking over a session open in two windows', () => {
    test('the process that takes over the watches carries on from the saved wake count and pause', async () => {
        const base = temp('mcp-events-codex-takeover-');
        const thread = newThread();
        const make = () => new ThreadSession(thread, { base, connections: new Map(), unavailable: () => [], wake: async () => ({ ok: true, resumed: true }), log: () => {}, env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1' } });
        // The second window opens first, and reads an empty count.
        const standby = make();
        const first = make();
        try {
            assert.equal(first.start(), true);
            first.budget.woke(['w-aaaaaa']);
            first.budget.pause();
            await first.stop();
            assert.equal(standby.start(), true);
            assert.equal(standby.budget.paused, true, 'paused, as the first process left it');
            assert.equal(standby.budget.gate(['w-aaaaaa']).kind, 'paused');
        } finally {
            await standby.stop();
        }
    });
});
