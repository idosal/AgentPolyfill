import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from '../../core/src/store.ts';

export const batchFormat = /^([0-9a-f]{32})\.e([1-9]\d{0,15})-e([1-9]\d{0,15})$/;
export const recordIdFormat = /^e([1-9]\d{0,15})$/;
export const maxWakeEvents = 20;
export const maxSpoolBytes = 64 * 1024 * 1024;

function toEventRecord(r) {
    const { id, server, watch, note, eventId, event, timestamp, data } = r;
    return { id, server, watch, watchName: note, eventId, event, timestamp, data };
}

function toNoticeRecord(r) {
    const { id, kind, receivedAt, watch, text } = r;
    return { id, kind, receivedAt, watch, text };
}

// The spool is append-only and IDs count complete lines, including notices.
// Keep byte offsets in the reader process, so repeated reads parse only the requested rows.
export class InboxReader {
    constructor(dir) {
        this.ledger = join(dir, 'delivery.json');
        this.spool = join(sessionDir(dir, 'agent'), 'events.jsonl');
        this.offsets = [0];
    }

    #readLedger() {
        return JSON.parse(readFileSync(this.ledger, 'utf8'));
    }

    #syncOffsets(fd, targetLine) {
        const { dev, ino, size } = fstatSync(fd);
        if (dev !== this.dev || ino !== this.ino || size < this.offsets.at(-1)) {
            this.offsets = [0];
            this.dev = dev;
            this.ino = ino;
        }
        let pos = this.offsets.at(-1);
        const wantAll = targetLine === undefined;
        if (wantAll || targetLine >= this.offsets.length) {
            const chunk = Buffer.allocUnsafe(65536);
            while (pos < size && (wantAll || targetLine >= this.offsets.length)) {
                const n = readSync(fd, chunk, 0, Math.min(size - pos, chunk.length), pos);
                if (!n) break;
                const bytes = chunk.subarray(0, n);
                for (let p = bytes.indexOf(10); p !== -1; p = bytes.indexOf(10, p + 1))
                    this.offsets.push(pos + p + 1);
                pos += n;
            }
        }
        return this.offsets.length - 1;
    }

    #readRow(fd, num) {
        const offset = this.offsets[num - 1];
        const row = Buffer.allocUnsafe(this.offsets[num] - offset);
        let used = 0;
        while (used < row.length) {
            const n = readSync(fd, row, used, row.length - used, offset + used);
            if (!n) throw Error('Incomplete inbox record.');
            used += n;
        }
        const r = JSON.parse(row.toString('utf8'));
        if (r.id !== 'e' + num) throw Error('Invalid inbox record.');
        return r;
    }

    #maxPublished(ledger) {
        return Math.max(ledger.through ?? 0, ledger.attempt?.last ?? 0);
    }

    readRange(batch, { publishedOnly = false } = {}) {
        const match = batchFormat.exec(batch);
        if (!match) throw Error('Expected an inbox-qualified batch reference.');
        const ledger = this.#readLedger();
        if (match[1] !== ledger.inbox) throw Error('Batch belongs to another inbox.');
        const [first, last] = match.slice(2).map(Number);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw Error('Invalid batch range.');
        if (publishedOnly && last > ledger.through && !(ledger.attempt?.first === first && ledger.attempt.last === last))
            throw Error('Batch has not been offered to the routine.');

        const fd = openSync(this.spool, 'r');
        try {
            const total = this.#syncOffsets(fd, last);
            if (last > total) throw Error('Batch is missing from this profile.');
            const events = [];
            const notices = [];
            let firstSeen;
            let lastSeen;
            for (let num = first; num <= last; num++) {
                const r = this.#readRow(fd, num);
                if (r.kind === 'event') {
                    if (publishedOnly && events.length === maxWakeEvents) throw Error('Range exceeds one wake batch.');
                    events.push(toEventRecord(r));
                    firstSeen ??= r.id;
                    lastSeen = r.id;
                } else if (r.kind === 'notice') {
                    notices.push(toNoticeRecord(r));
                    firstSeen ??= r.id;
                    lastSeen = r.id;
                }
            }
            if (firstSeen !== 'e' + first || lastSeen !== 'e' + last)
                throw Error('Batch is missing from this profile.');
            return { events, notices };
        } finally { closeSync(fd); }
    }

    read(batch, opts) {
        return this.readRange(batch, opts).events;
    }

    get(id, { publishedOnly = false } = {}) {
        const match = recordIdFormat.exec(id ?? '');
        if (!match) throw Error('Expected an event ID like e12.');
        const num = Number(match[1]);
        if (!Number.isSafeInteger(num)) throw Error('Invalid event ID.');
        if (publishedOnly) {
            const ledger = this.#readLedger();
            if (num > this.#maxPublished(ledger)) throw Error('Event is not available in this inbox.');
        }
        const fd = openSync(this.spool, 'r');
        try {
            const total = this.#syncOffsets(fd, num);
            if (num > total) throw Error('Event is missing from this profile.');
            const r = this.#readRow(fd, num);
            return r.kind === 'notice' ? toNoticeRecord(r) : toEventRecord(r);
        } finally { closeSync(fd); }
    }

    recent({ watch, limit = 20, publishedOnly = false } = {}) {
        const cap = Math.min(100, Math.max(1, limit));
        const maxId = publishedOnly ? this.#maxPublished(this.#readLedger()) : Infinity;
        if (publishedOnly && maxId < 1) return [];
        const fd = openSync(this.spool, 'r');
        try {
            const total = Math.min(this.#syncOffsets(fd), maxId);
            const items = [];
            for (let num = total; num >= 1 && items.length < cap; num--) {
                const r = this.#readRow(fd, num);
                if (watch && r.watch !== watch) continue;
                items.push(r.kind === 'notice' ? toNoticeRecord(r) : toEventRecord(r));
            }
            return items.reverse();
        } finally { closeSync(fd); }
    }

    stats() {
        let spoolBytes = 0;
        try { spoolBytes = statSync(this.spool).size; } catch { /* not created yet */ }
        return { spoolBytes, maxSpoolBytes };
    }
}
