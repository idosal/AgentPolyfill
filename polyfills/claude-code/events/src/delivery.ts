// Handing this session's spooled events to Claude Code.
//
// The helper spools every event before it acknowledges it to its sender. This
// reads the spool from where the last hand-over stopped and gives the mod's
// hooks module a batch of lines to submit as a prompt, which wakes an idle
// session. The batch says which watches have new events and how many; the
// payloads stay in the spool, for get_event and recent_events.
//
// Where it has got to is saved only once the hooks module says Claude Code took
// the lines (`ack`), so a session that ends between reading an event and
// showing it shows it next time. One bad record (too long, or one that cannot
// be formatted) is passed over with a plain line; it never stops the ones
// after it.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBatch, LINE_PREFIX } from './format.ts';
import type { Spool, SpoolRecord } from './store.ts';
import { secrets } from './untrusted.ts';

const MAX_READ = 4 * 1024 * 1024;
const SKIPPED = `${LINE_PREFIX} One event could not be shown (too large, or not in a form this mod can print) and was skipped.`;

/** `watches`: whose events these are (a notice counts under its watch). `events`: how many records. */
export type Batch = { lines: string[]; upto: number; watches: string[]; events: number };

export class Delivery {
    readonly #spool: Spool;
    readonly #posFile: string;
    /** Bytes of the spool handed over and acknowledged (saved). */
    #delivered = 0;
    readonly #values: boolean;

    /** `values`: put a few short payload fields in the lines (MCP_EVENTS_WAKE_VALUES=1). */
    constructor(spool: Spool, o: { values?: boolean } = {}) {
        this.#values = o.values === true;
        this.#spool = spool;
        this.#posFile = join(spool.dir, 'delivered.pos');
        // A position saved by the monitor of an earlier version of this plugin counts too.
        for (const file of [this.#posFile, join(spool.dir, 'monitor.pos')]) {
            try {
                this.#delivered = Math.max(0, Number((JSON.parse(readFileSync(file, 'utf8')) as { bytes?: unknown }).bytes) || 0);
                break;
            } catch {
                // nothing handed over yet
            }
        }
    }

    #size(): number {
        try {
            const fd = openSync(this.#spool.file, 'r');
            try {
                return fstatSync(fd).size;
            } finally {
                closeSync(fd);
            }
        } catch {
            return 0;
        }
    }

    /** Where the acknowledged hand-over stands, in bytes of the spool. */
    get position(): number {
        return this.#delivered;
    }

    /** Whether the spool holds anything not yet handed over. */
    get pending(): boolean {
        const size = this.#size();
        if (size < this.#delivered) this.#delivered = 0; // the spool was replaced
        return size > this.#delivered;
    }

    /** The next batch: what the spool holds past the last acknowledged hand-over, as lines. Nothing is marked until `ack`. */
    take(): Batch | undefined {
        if (!existsSync(this.#spool.file)) return undefined;
        let fd: number | undefined;
        try {
            fd = openSync(this.#spool.file, 'r');
            const size = fstatSync(fd).size;
            if (size < this.#delivered) this.#delivered = 0; // the spool was replaced
            if (size === this.#delivered) return undefined;
            const buf = Buffer.alloc(Math.min(size - this.#delivered, MAX_READ));
            const got = readSync(fd, buf, 0, buf.length, this.#delivered);
            // Whole lines only: one still being written is read next time.
            const whole = buf.subarray(0, got).lastIndexOf(10) + 1;
            if (whole === 0) {
                // No line end in a full window: a record longer than this will read. Pass over it, to
                // wherever the window ends, so the records after it are not held up behind it.
                return got === MAX_READ ? { lines: [SKIPPED], upto: this.#delivered + got, watches: [], events: 0 } : undefined;
            }
            const records: (SpoolRecord | undefined)[] = [];
            for (const line of buf.subarray(0, whole).toString('utf8').split('\n').slice(0, -1)) {
                if (!line.trim()) continue;
                try {
                    records.push(JSON.parse(line) as SpoolRecord);
                } catch {
                    records.push(undefined); // not a record (or the tail of one passed over): shown as skipped
                }
            }
            if (!records.length) return { lines: [], upto: this.#delivered + whole, watches: [], events: 0 };
            let lines: string[];
            let skipped = records.some((r) => !r);
            try {
                lines = formatBatch(records.filter((r): r is SpoolRecord => !!r), { values: this.#values });
            } catch {
                // One of these cannot be formatted. Take them one at a time, and pass over the one that fails.
                lines = [];
                for (const r of records) {
                    if (!r) continue;
                    try {
                        lines.push(...formatBatch([r], { values: this.#values }));
                    } catch {
                        skipped = true;
                    }
                }
            }
            if (skipped) lines.push(SKIPPED);
            lines = lines.map((l) => secrets.scrub(l));
            const sound = records.filter((r): r is SpoolRecord => !!r);
            return { lines, upto: this.#delivered + whole, watches: [...new Set(sound.map((r) => String(r.watch ?? '')))], events: sound.length };
        } catch {
            return undefined; // tried again on the next ask
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
    }

    /** Claude Code has taken everything up to `upto`. */
    ack(upto: number): void {
        if (!Number.isFinite(upto) || upto <= this.#delivered) return;
        this.#delivered = Math.min(upto, this.#size());
        try {
            writeFileSync(this.#posFile, JSON.stringify({ bytes: this.#delivered }), { mode: 0o600 });
        } catch {
            // shown, but not marked: the worst case is seeing these lines again after a restart
        }
    }
}
