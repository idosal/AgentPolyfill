// Waking a Codex session: which session, how often, what it is told, and what happens when
// `codex queue` fails. The gate is the Claude Code form's (polyfills/events/core/src/wake.ts):
// a watch wakes its session at most once a minute, a session at most 30 times an hour, and
// past that it is told once and woken again only after the person writes.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { newThread, sleep, startHelper, untilActive, waitFor, world } from './harness.ts';

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
            // The person writes, and the model calls a tool in that turn.
            await h.call('list_watches', {}, thread, 'composer');
            await waitFor(() => w.queued().length === 3, 20000, 'waking again');
            assert.match(w.queued()[2]!.message, /2 new events \[events e2, e3;/);
        } finally {
            await h.stop();
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
            assert.match((await h.call('list_watches', {}, thread)).text, /Waking this session failed the last time it was tried \(codex queue failed \(exit 1\)\)/);
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
