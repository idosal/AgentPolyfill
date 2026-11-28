import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RoutineInbox, readBatch } from '../src/inbox.mjs';

const binding = 'routine-a';
const options = { retentionMs: 3600000 };
const record = (id) => ({
    kind: 'event',
    server: 'desk',
    watch: 'w-desk',
    event: 'ticket.created',
    eventId: id,
    data: { title: 'x'.repeat(100) }
});
const payload = (ref, rows) => ({ source: 'mcp-events', batch: ref, events: rows.map((r) => r.eventId) });
function directory(t) {
    const dir = mkdtempSync(join(tmpdir(), 'routine-inbox-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function issue(box, n = 1) {
    return JSON.parse(box.reserve(box.pending(n), payload)).batch;
}
test('expiry forgets only accepted batches and keeps handles monotonic after a restart', (t) => {
    const dir = directory(t);
    let box = new RoutineInbox(dir, binding, options);
    box.appendMany([record('first'), record('second'), record('third')]);
    const first = issue(box);
    box.accept(first);
    const held = issue(box);
    box.prune(Date.now() + 2 * options.retentionMs);
    assert.throws(() => readBatch(dir, first), /expired/);
    assert.throws(() => readBatch(dir, held), /Unknown or expired/);
    assert.throws(() => readBatch(dir, box.reference(box.state, 2, 3)), /Unknown/);
    box.close();
    assert.throws(() => new RoutineInbox(dir, 'other-routine', options), /changed/);
    box = new RoutineInbox(dir, binding, options);
    assert.equal(issue(box), held);
    assert.deepEqual(
        box.pending(10).map((r) => r.eventId),
        ['second', 'third']
    );
    box.accept(held);
    assert.deepEqual(
        readBatch(dir, held).map((r) => r.eventId),
        ['second']
    );
    box.accept(issue(box));
    box.prune(Date.now() + 2 * options.retentionMs);
    assert.deepEqual(box.all(), []);
    box.close();
    box = new RoutineInbox(dir, binding, options);
    assert.equal(box.append(record('fourth')).id, 'e4');
    box.close();
});
test('storage pressure reclaims delivered records; a full pending queue rejects a new occurrence intact', (t) => {
    const dir = directory(t);
    const box = new RoutineInbox(dir, binding, { ...options, byteLimit: 650 });
    t.after(() => box.close());
    box.append(record('first'));
    const first = issue(box);
    box.accept(first);
    box.appendMany([record('second'), record('third')]);
    assert.throws(() => readBatch(dir, first), /expired/);
    const held = issue(box);
    assert.throws(() => box.append(record('fourth')), /full of pending/);
    assert.throws(() => readBatch(dir, held), /Unknown or expired/);
    assert.deepEqual(
        box.pending(10).map((r) => r.id),
        ['e2', 'e3']
    );
    box.accept(held);
    assert.deepEqual(
        readBatch(dir, held).map((r) => r.eventId),
        ['second']
    );
    assert.equal(box.append(record('fourth')).id, 'e4');
});
test('legacy state imports once with a held reference, unread events and the original retry body', (t) => {
    const dir = directory(t);
    const dest = join(dir, 'sessions', 'agent');
    mkdirSync(dest, { recursive: true });
    const inbox = 'a'.repeat(32);
    const oldState = { inbox, binding, through: 1, wakes: [], attempt: { first: 3, last: 3 } };
    writeFileSync(join(dir, 'delivery.json'), JSON.stringify(oldState));
    const oldFile = join(dest, 'events.jsonl');
    writeFileSync(
        oldFile,
        [record('accepted'), { kind: 'notice', text: 'notice' }, record('held'), record('unread')]
            .map((r, i) => JSON.stringify({ ...r, id: 'e' + (i + 1) }))
            .join('\n') + '\n'
    );
    let box = new RoutineInbox(dir, binding, options);
    assert.equal(box.state.referenceOnly, true);
    assert.equal(existsSync(oldFile), false);
    assert.throws(() => readBatch(dir, inbox + '.e1-e1'), /Unknown/);
    const held = inbox + '.e3-e3';
    assert.equal(box.reserve(box.pending(20), payload), JSON.stringify({ source: 'mcp-events', batch: held }));
    assert.throws(() => readBatch(dir, held), /Unknown or expired/);
    box.accept(held);
    assert.deepEqual(
        readBatch(dir, held).map((r) => r.eventId),
        ['held']
    );
    box.close();
    box = new RoutineInbox(dir, binding, options);
    assert.deepEqual(
        box.pending(20).map((r) => r.eventId),
        ['unread']
    );
    assert.equal(box.append(record('new')).id, 'e5');
    box.close();
});
