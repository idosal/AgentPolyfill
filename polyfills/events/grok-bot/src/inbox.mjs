import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from '../../core/src/store.ts';

export const batchFormat = /^([0-9a-f]{32})\.e([1-9]\d{0,15})-e([1-9]\d{0,15})$/;
export const maxWakeEvents = 20;

// The spool is append-only and IDs count complete lines, including notices.
// Keep byte offsets in the reader process, so repeated reads parse only the requested rows.
export class InboxReader {
    constructor(dir) {
        this.ledger = join(dir, 'delivery.json');
        this.spool = join(sessionDir(dir, 'agent'), 'events.jsonl');
        this.offsets = [0];
    }

    read(batch, { publishedOnly = false } = {}) {
        const match = batchFormat.exec(batch);
        if (!match) throw Error('Expected an inbox-qualified batch reference.');
        const ledger = JSON.parse(readFileSync(this.ledger, 'utf8'));
        if (match[1] !== ledger.inbox) throw Error('Batch belongs to another inbox.');
        const [first, last] = match.slice(2).map(Number);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw Error('Invalid batch range.');
        if (publishedOnly && last > ledger.through && !(ledger.attempt?.first === first && ledger.attempt.last === last))
            throw Error('Batch has not been offered to the routine.');

        const fd = openSync(this.spool, 'r');
        try {
            const { dev, ino, size } = fstatSync(fd);
            if (dev !== this.dev || ino !== this.ino || size < this.offsets.at(-1)) {
                this.offsets = [0];
                this.dev = dev;
                this.ino = ino;
            }
            let pos = this.offsets.at(-1);
            if (last >= this.offsets.length) {
                const chunk = Buffer.allocUnsafe(65536);
                while (pos < size && last >= this.offsets.length) {
                    const n = readSync(fd, chunk, 0, Math.min(size - pos, chunk.length), pos);
                    if (!n) break;
                    const bytes = chunk.subarray(0, n);
                    for (let p = bytes.indexOf(10); p !== -1; p = bytes.indexOf(10, p + 1))
                        this.offsets.push(pos + p + 1);
                    pos += n;
                }
            }
            if (last >= this.offsets.length) throw Error('Batch is missing from this profile.');
            const records = [];
            for (let num = first; num <= last; num++) {
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
                if (r.kind !== 'event') continue;
                if (publishedOnly && records.length === maxWakeEvents) throw Error('Range exceeds one wake batch.');
                const { id, server, watch, note, eventId, event, timestamp, data } = r;
                records.push({ id, server, watch, watchName: note, eventId, event, timestamp, data });
            }
            if (records.at(0)?.id !== 'e' + first || records.at(-1)?.id !== 'e' + last)
                throw Error('Batch is missing from this profile.');
            return records;
        } finally { closeSync(fd); }
    }
}
