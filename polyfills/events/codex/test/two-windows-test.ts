// The same Codex session open in two windows: two helper processes, of which one runs the session's
// watches and wakes it, and the other only lists them and takes over if the first goes. The wake
// model (claude-code/model/wakeCodex.qnt) has one helper process at a time; these are the cases of
// two: the one taking over reads the wake count again, and the one that doesn't run
// the watches never writes it.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { eventIdsIn, type Helper, newThread, sleep, startHelper, untilActive, waitFor, world, type World } from './harness.ts';

const ENV = { MCP_EVENTS_WAKE_GAP_S: '0' };
const wakesOf = (w: World, thread: string) => JSON.parse(readFileSync(join(w.state, 'sessions', thread, 'wakes.json'), 'utf8')) as { wakes: number[]; handed?: { upto: number } };
/** The event ids a wake names ("[event e1; watch …]", "[events e1, e2; watch …]"), not a watch id's letters. */
const idsIn = (message: string) => [...message.matchAll(/\[events? ([^;\]]+); watch /g)].flatMap((m) => m[1]!.match(/e\d+/g) ?? []);

/** Kills a helper as a crash would, and any `codex queue` it left hanging (the fake's "queuehang"). */
async function crash(w: World, h: Helper): Promise<void> {
    h.child.kill('SIGKILL');
    await h.exited;
    for (const q of w.queued()) {
        try {
            process.kill(q.pid, 'SIGKILL');
        } catch {
            // gone
        }
    }
}

const runsTheWatches = (h: Helper, thread: string) => async () => /"status": "active"/.test((await h.call('list_watches', {}, thread, 'queue')).text);

describe('a session open in two windows', () => {
    test('the window that runs the watches dies while codex queue runs: the other takes over, counts that wake from the record, and does not hand the batch over again', async () => {
        const w = world();
        const thread = newThread();
        const first = await startHelper(w, ENV);
        const second = await startHelper(w, ENV);
        try {
            await first.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(first, thread);
            // The second window sees the session now, before the hand-over: what it read then is out of date by the takeover.
            await second.call('list_watches', {}, thread, 'queue');
            writeFileSync(w.mode, 'queuehang');
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'codex queue to take the batch');
            await sleep(300);
            assert.ok(wakesOf(w, thread).handed, 'the hand-over is recorded while codex queue runs');
            await crash(w, first);
            writeFileSync(w.mode, 'ok');
            await waitFor(runsTheWatches(second, thread), 20000, 'the second window to take the watches over');
            await sleep(2500);
            assert.equal(w.queued().length, 1, 'e1 is not handed over a second time, by the second window');
            const saved = wakesOf(w, thread);
            assert.equal(saved.wakes.length, 1, 'the wake it made is counted');
            assert.equal(saved.handed, undefined, 'and the record cleared');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => w.queued().length === 2, 20000, 'the next wake');
            assert.deepEqual(idsIn(w.queued()[1]!.message), ['e2'], 'the next wake carries only what came since');
            // The second window's store had counted no events when it first saw the session: the event it
            // stores after taking over gets an id of its own, not e1 again.
            assert.deepEqual(eventIdsIn((await second.call('recent_events', {}, thread, 'queue')).text), ['e1', 'e2']);
        } finally {
            await second.stop();
            first.child.kill('SIGKILL');
        }
    });

    test("the person writes in the window that doesn't run the watches while the other is in codex queue: the record stays, and a restarted helper does not hand that batch over again", async () => {
        const w = world();
        const thread = newThread();
        const first = await startHelper(w, ENV);
        let second: Helper | undefined;
        let third: Helper | undefined;
        try {
            await first.call('watch_event', { server: 'tickets', event: 'ticket.created' }, thread);
            await untilActive(first, thread);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => w.queued().length === 1, 20000, 'the first wake');
            await sleep(500);
            // The second window reads the count now: one wake this hour, nothing being handed over.
            second = await startHelper(w, ENV);
            await second.call('list_watches', {}, thread, 'queue');
            writeFileSync(w.mode, 'queuehang');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => w.queued().length === 2, 20000, 'the second codex queue');
            await sleep(300);
            const recorded = wakesOf(w, thread).handed;
            assert.ok(recorded, 'the hand-over of e2 is recorded while codex queue runs');
            // The person's own turn, in the second window.
            await second.call('list_watches', {}, thread, 'user');
            assert.deepEqual(wakesOf(w, thread).handed, recorded, "the second window's call leaves the record as it was");
            await crash(w, first);
            await second.stop();
            second = undefined;
            writeFileSync(w.mode, 'ok');
            third = await startHelper(w, ENV);
            await waitFor(runsTheWatches(third, thread), 20000, 'the restarted helper to run the watches');
            await sleep(2500);
            assert.deepEqual(
                w.queued().map((q) => idsIn(q.message)),
                [['e1'], ['e2']],
                'e2 is not handed over a second time'
            );
            const saved = wakesOf(w, thread);
            assert.equal(saved.wakes.length, 2, 'both wakes are counted');
            assert.equal(saved.handed, undefined);
        } finally {
            await third?.stop();
            await second?.stop();
            first.child.kill('SIGKILL');
        }
    });
});
