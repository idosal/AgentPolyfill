// What a helper does with what earlier ones left behind, when it starts: an event written to a
// spool before the watch was saved after it is not written again, and an event a session stored
// and closed before showing reaches the next session, once. (model/delivery.qnt: storedTwice,
// stranded.)

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ProjectState, Spool, type Watch } from '../src/store.ts';
import { WatchManager } from '../src/watcher.ts';
import { sleep, temp } from './harness.ts';

const until = async (done: () => boolean, ms = 6000) => {
    const end = Date.now() + ms;
    while (!done()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await sleep(20);
    }
};

type Stream = { cursor: string | null; on: { event: (e: unknown) => void; active: (p: unknown) => void } };

/** One session of the project in `dir`: its own spool, the project's watches, a push server stand-in. */
function session(dir: string, id: string) {
    const project = new ProjectState(dir, '/project/recovery');
    const spool = new Spool(dir, id);
    const streams: Stream[] = [];
    const conn = {
        name: 's', fingerprint: 'fp', connected: true, declaration: 'extensions', stdio: true, authenticated: false,
        eventTypes: [{ name: 'x', delivery: ['push'], headers: [] }],
        list: async () => {},
        stream: (p: { cursor: string | null }, on: Stream['on']) => {
            streams.push({ cursor: p.cursor, on });
            let end!: () => void;
            const done = new Promise<void>((r) => (end = r));
            return { done, cancel: () => end() };
        }
    };
    const m = new WatchManager({ connections: new Map([['s', conn as never]]), project, spool, session: id, env: {} });
    return { project, spool, streams, m, events: () => spool.all().filter((r) => r.kind === 'event').map((r) => r.eventId) };
}

function oneWatch(dir: string, seen: string[] = []) {
    const project = new ProjectState(dir, '/project/recovery');
    project.watches = [{ id: 'w-rec', server: 's', fingerprint: 'fp', event: 'x', arguments: {}, mode: 'push', cursor: 'c0', createdAt: '', events: 0, status: 'active', seen } satisfies Watch];
    project.save();
}

describe('what an earlier helper left behind', () => {
    test('an event written to the spool before the watch was saved is not written again when the helper starts over', async () => {
        const dir = temp();
        oneWatch(dir);
        // The helper before this one wrote the event down and died before it saved the watch.
        new Spool(dir, 'sess-a').append({ kind: 'event', watch: 'w-rec', server: 's', event: 'x', eventId: 'a', data: {} });
        const s = session(dir, 'sess-a');
        try {
            s.m.start();
            await until(() => s.streams.length === 1);
            assert.equal(s.streams[0]!.cursor, 'c0', 'the saved cursor is from before the event, so the server sends it again');
            s.streams[0]!.on.active({ cursor: 'c0', heartbeatMs: 60000 });
            s.streams[0]!.on.event({ eventId: 'a', name: 'x', timestamp: '2026-11-24T00:00:00Z', data: {}, cursor: 'c1' });
            s.streams[0]!.on.event({ eventId: 'b', name: 'x', timestamp: '2026-11-24T00:00:01Z', data: {}, cursor: 'c2' });
            await until(() => s.events().includes('b'));
            assert.deepEqual(s.events(), ['a', 'b'], 'event a is in the spool once');
        } finally {
            await s.m.stop();
        }
    });

    test('an event stored by a session that closed before showing it reaches the next session, once', async () => {
        const dir = temp();
        oneWatch(dir);
        const a = session(dir, 'sess-a');
        a.m.start();
        await until(() => a.streams.length === 1);
        a.streams[0]!.on.active({ cursor: 'c0', heartbeatMs: 60000 });
        a.streams[0]!.on.event({ eventId: 'a', name: 'x', timestamp: '2026-11-24T00:00:00Z', data: { n: 1 }, cursor: 'c1' });
        await until(() => a.events().includes('a'));
        // Claude Code closes before the event is handed over (its wake was held back, say).
        await a.m.stop();

        const b = session(dir, 'sess-b');
        try {
            b.m.start();
            await until(() => b.streams.length === 1);
            assert.equal(b.streams[0]!.cursor, 'c1', 'the watch resumes after the event');
            const carried = b.spool.all().filter((r) => r.kind === 'event');
            assert.deepEqual(carried.map((r) => [r.watch, r.eventId, r.data]), [['w-rec', 'a', { n: 1 }]], 'the new session has it, to be shown');
            assert.ok(Number(JSON.parse(readFileSync(join(a.spool.dir, 'delivered.pos'), 'utf8')).bytes) > 0, 'and the old session counts it as handed over');
            // This session shows it.
            writeFileSync(join(b.spool.dir, 'delivered.pos'), JSON.stringify({ bytes: Buffer.byteLength(readFileSync(b.spool.file, 'utf8')) }));
        } finally {
            await b.m.stop();
        }
        // A third session does not get it again, from either.
        const c = session(dir, 'sess-c');
        try {
            c.m.start();
            await until(() => c.streams.length === 1);
            assert.deepEqual(c.events(), []);
        } finally {
            await c.m.stop();
        }
    });

    test('an event a session did show is not carried to the next one', async () => {
        const dir = temp();
        oneWatch(dir);
        const a = session(dir, 'sess-a');
        a.m.start();
        await until(() => a.streams.length === 1);
        a.streams[0]!.on.active({ cursor: 'c0', heartbeatMs: 60000 });
        a.streams[0]!.on.event({ eventId: 'a', name: 'x', timestamp: '2026-11-24T00:00:00Z', data: {}, cursor: 'c1' });
        await until(() => a.events().includes('a'));
        // Handed over: the hooks module acknowledged the whole spool.
        writeFileSync(join(a.spool.dir, 'delivered.pos'), JSON.stringify({ bytes: Buffer.byteLength(readFileSync(a.spool.file, 'utf8')) }));
        await a.m.stop();
        const b = session(dir, 'sess-b');
        try {
            b.m.start();
            await until(() => b.streams.length === 1);
            assert.deepEqual(b.events(), []);
        } finally {
            await b.m.stop();
        }
    });
});
