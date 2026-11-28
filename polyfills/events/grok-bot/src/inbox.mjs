import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalError } from '../../core/src/untrusted.ts';
import { sessionDir } from '../../core/src/store.ts';

const database = (dir) => join(dir, 'inbox.sqlite');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const maxBytes = 64 * 1024 * 1024;
const numberOf = (id) => Number(id.slice(1));
const decode = (row) => ({ ...JSON.parse(row.record), id: 'e' + row.n });

function transaction(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

// One routine owns an inbox. Pending records, issued references and delivery decisions share
// a transaction. AUTOINCREMENT keeps old event handles from referring to future records.
export class RoutineInbox {
    constructor(base, binding, { retentionMs, byteLimit = maxBytes }) {
        this.dir = sessionDir(base, 'agent');
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.retentionMs = retentionMs;
        this.byteLimit = byteLimit;
        const path = database(base);
        const db = (this.db = new DatabaseSync(path));
        try {
            chmodSync(path, 0o600);
            db.exec(`PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches (ref TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL,
                    payload TEXT, expires INTEGER);
                CREATE INDEX IF NOT EXISTS expiry ON batches(expires);
                CREATE TABLE IF NOT EXISTS usage (bytes INTEGER NOT NULL);
                INSERT INTO usage SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM usage);
                CREATE TRIGGER IF NOT EXISTS added AFTER INSERT ON events BEGIN
                    UPDATE usage SET bytes = bytes + length(CAST(NEW.record AS BLOB)); END;
                CREATE TRIGGER IF NOT EXISTS removed AFTER DELETE ON events BEGIN
                    UPDATE usage SET bytes = bytes - length(CAST(OLD.record AS BLOB)); END;`);
            const legacySpool = join(this.dir, 'events.jsonl');
            if (!this.meta('delivery')) this.importLegacy(base, binding, legacySpool);
            this.state = this.meta('delivery');
            if (this.state.binding !== binding) throw Error('The routine URL changed. Use a new profile directory.');
            // Remove the old copy only after a verified, committed import. A crash here is resumable.
            if (existsSync(legacySpool)) {
                const fingerprint = this.meta('importHash');
                if (fingerprint !== hash(readFileSync(legacySpool)))
                    throw Error('The legacy inbox changed. Stop the old watcher and inspect the profile.');
                unlinkSync(legacySpool);
            }
            this.prune();
        } catch (e) {
            db.close();
            throw e;
        }
    }
    meta(key) {
        const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : undefined;
    }
    put(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run(key, JSON.stringify(value));
    }
    importLegacy(base, binding, file) {
        const old = join(base, 'delivery.json');
        const legacy = existsSync(old);
        const state = legacy ? JSON.parse(readFileSync(old, 'utf8')) : { binding, through: 0, wakes: [], attempt: null };
        if (state.binding !== binding) throw Error('The routine URL changed. Use a new profile directory.');
        state.inbox ??= randomUUID().replaceAll('-', '');
        if (legacy && !existsSync(file) && (state.through > 0 || state.attempt))
            throw Error('Legacy spool missing. Restore the complete profile before starting the watcher.');
        state.referenceOnly = legacy;
        transaction(this.db, () => {
            if (existsSync(file)) {
                const bytes = readFileSync(file);
                if (!legacy && bytes.length) throw Error('Missing delivery ledger for an existing inbox.');
                const insert = this.db.prepare('INSERT INTO events(n,record) VALUES (?,?)');
                const raw = bytes.toString('utf8');
                if (raw.length && !raw.endsWith('\n')) throw Error('Incomplete legacy event record.');
                for (const line of raw.split('\n').filter(Boolean)) {
                    const r = JSON.parse(line);
                    if (!/^e[1-9]\d*$/.test(r.id)) throw Error('Invalid legacy event handle.');
                    insert.run(numberOf(r.id), JSON.stringify(r));
                }
                this.put('importHash', hash(bytes));
            }
            if (state.attempt) {
                const { first, last } = state.attempt,
                    ref = this.reference(state, first, last);
                const held = this.range(first, last);
                if (first <= state.through || held[0]?.id !== 'e' + first || held.at(-1)?.id !== 'e' + last)
                    throw Error('Held batch is missing from the legacy inbox.');
                this.db
                    .prepare('INSERT INTO batches VALUES (?,?,?,?,NULL)')
                    .run(ref, first, last, JSON.stringify({ source: 'mcp-events', batch: ref }));
            }
            // The old ledger records only a high-water mark, not the individual accepted batches.
            // Preserve that high-water mark, but never infer readable batches from it.
            this.db.exec("DELETE FROM events WHERE json_extract(record,'$.kind')='notice'");
            if (state.through) {
                this.db
                    .prepare('INSERT INTO batches VALUES (?,?,?,?,?)')
                    .run('legacy-archive', 1, state.through, null, Date.now() + this.retentionMs);
                const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get();
                if (sequence) this.db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='events'").run(state.through);
                else this.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('events',?)").run(state.through);
            }
            this.put('delivery', state);
        });
    }
    reference(state, first, last) {
        return state.inbox + '.e' + first + '-e' + last;
    }
    range(first, last) {
        return this.db
            .prepare('SELECT * FROM events WHERE n BETWEEN ? AND ? ORDER BY n')
            .all(first, last)
            .map(decode)
            .filter((r) => r.kind === 'event');
    }
    forget(ref, first, last) {
        this.db.prepare('DELETE FROM events WHERE n BETWEEN ? AND ?').run(first, last);
        this.db.prepare('DELETE FROM batches WHERE ref=?').run(ref);
    }
    removeExpired(now) {
        for (const b of this.db.prepare('SELECT * FROM batches WHERE expires<=?').all(now)) this.forget(b.ref, b.first, b.last);
    }
    prune(now = Date.now()) {
        transaction(this.db, () => this.removeExpired(now));
    }
    all() {
        return this.db.prepare('SELECT * FROM events ORDER BY n').all().map(decode);
    }
    append(r) {
        return this.appendMany([r])[0];
    }
    appendMany(records) {
        const eligible = this.armedAt ? records.filter((r) => r.kind !== 'event' || Date.parse(r.timestamp) >= this.armedAt) : records;
        const dated = eligible.map((r) => ({ receivedAt: new Date().toISOString(), ...r }));
        const full = transaction(this.db, () => {
            const encoded = dated.map((r) => (r.kind === 'notice' ? null : JSON.stringify(r)));
            const needed = encoded.reduce((sum, text) => sum + (text ? Buffer.byteLength(text) : 0), 0);
            const used = () => this.db.prepare('SELECT bytes FROM usage').get().bytes;
            if (used() + needed > this.byteLimit) {
                const accepted = this.db.prepare('SELECT ref,first,last FROM batches WHERE expires IS NOT NULL ORDER BY expires').all();
                for (const batch of accepted) {
                    this.forget(batch.ref, batch.first, batch.last);
                    if (used() + needed <= this.byteLimit) break;
                }
                if (used() + needed > this.byteLimit)
                    throw new LocalError('Inbox full of pending events. Resolve delivery before collecting more.');
            }
            const insert = this.db.prepare('INSERT INTO events(record) VALUES (?)');
            return dated.map((r, i) => {
                // Health notices go directly to the operator without filling the event queue.
                if (encoded[i] === null) return { ...r, id: 'notice' };
                const inserted = insert.run(encoded[i]);
                return { ...r, id: 'e' + inserted.lastInsertRowid };
            });
        });
        for (const r of full) this.onAppend?.(r);
        return full;
    }
    pending(limit) {
        return this.db
            .prepare('SELECT * FROM events WHERE n>? ORDER BY n LIMIT ?')
            .all(this.state.through, limit)
            .map(decode)
            .filter((r) => r.kind === 'event');
    }
    reserve(records, makePayload) {
        if (this.state.attempt) {
            const { first, last } = this.state.attempt;
            return this.db.prepare('SELECT payload FROM batches WHERE ref=?').get(this.reference(this.state, first, last)).payload;
        }
        const first = numberOf(records[0].id),
            last = numberOf(records.at(-1).id);
        const ref = this.reference(this.state, first, last);
        const payload = JSON.stringify(makePayload(ref, records));
        const next = { ...this.state, attempt: { first, last } };
        transaction(this.db, () => {
            this.db.prepare('INSERT INTO batches VALUES (?,?,?,?,NULL)').run(ref, first, last, payload);
            this.put('delivery', next);
        });
        this.state = next;
        return payload;
    }
    accept(ref, now = Date.now()) {
        const a = this.state.attempt;
        if (!a || ref !== this.reference(this.state, a.first, a.last)) throw Error('Batch does not match the held delivery.');
        const next = { ...this.state, through: a.last, lastAccepted: { batch: ref, at: new Date(now).toISOString() }, wakes: [...this.state.wakes.filter((t) => t > now - 3600000), now], attempt: null };
        transaction(this.db, () => {
            this.db.prepare('UPDATE batches SET expires=?, payload=NULL WHERE ref=?').run(now + this.retentionMs, ref);
            this.put('delivery', next);
        });
        this.state = next;
    }
    close() {
        this.db.close();
    }
}

export function inboxStatus(dir) {
    const empty = { pending: 0, heldBatch: null, heldEvents: 0, lastAccepted: null, acceptedThrough: 0 };
    if (!existsSync(database(dir))) return { ...empty, legacy: existsSync(join(dir, 'delivery.json')) };
    const db = new DatabaseSync(database(dir), { readOnly: true });
    try {
        db.exec('BEGIN');
        const row = db.prepare("SELECT value FROM metadata WHERE key='delivery'").get();
        if (!row) return empty;
        const s = JSON.parse(row.value);
        const a = s.attempt;
        const count = (lower, upper) => db.prepare('SELECT count(*) AS n FROM events WHERE n > ? AND n <= ?').get(lower, upper).n;
        const heldBatch = a ? s.inbox + '.e' + a.first + '-e' + a.last : null;
        // Display only identifiers actually sent to the Bot. A reference-only wake carries the batch ID.
        const saved = heldBatch && db.prepare('SELECT payload FROM batches WHERE ref=?').get(heldBatch);
        const sent = saved?.payload ? JSON.parse(saved.payload).events : [];
        const heldIdentifiers = Array.isArray(sent) ? [...new Set(sent.map(e=>e.ticketId || e.eventId).filter(id =>
            typeof id==='string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/.test(id)))].slice(0,20) : [];
        return {
            pending: count(a?.last ?? s.through, Number.MAX_SAFE_INTEGER),
            heldBatch, heldIdentifiers,
            heldEvents: a ? count(a.first - 1, a.last) : 0,
            lastAccepted: s.lastAccepted ?? null,
            acceptedThrough: s.through
        };
    } finally { db.close(); }
}

export function readBatch(dir, ref) {
    if (!/^[0-9a-f]{32}\.e[1-9]\d*-e[1-9]\d*$/.test(ref)) throw Error('Expected an inbox-qualified batch reference.');
    const db = new DatabaseSync(database(dir), { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=3000; BEGIN');
        const batch = db.prepare('SELECT first,last FROM batches WHERE ref=? AND expires>?').get(ref, Date.now());
        if (!batch) throw Error('Unknown or expired batch for this routine, or delivery still held.');
        return db
            .prepare('SELECT * FROM events WHERE n BETWEEN ? AND ? ORDER BY n')
            .all(batch.first, batch.last)
            .map(decode)
            .filter((r) => r.kind === 'event')
            .map(({ id, server, watch, note, eventId, event, timestamp, data }) => ({
                id,
                server,
                watch,
                watchName: note,
                eventId,
                event,
                timestamp,
                data
            }));
    } finally {
        db.close();
    }
}
