// State on disk.
//
//   <state>/projects/<hash of project folder>/watches.json   what this project watches,
//       with each watch's cursor (the SEP: "the client owns the canonical list of
//       subscriptions" and persists every cursor it receives)
//   <state>/projects/<hash>/owner.json                       which session runs the watches
//   <state>/sessions/<session id>/events.jsonl               events for this session, which
//       the plugin's monitor prints to Claude
//
// <state> is each host's: in Claude Code MCP_EVENTS_STATE, else CLAUDE_PLUGIN_DATA, else
// ~/.mcp-events-plugin. In Codex a thread owns its watches, so the "project" folder is the
// thread's (threads/<thread id>) and its session is the thread.

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DeliveryMode } from './events-client.ts';
import { LocalError } from './untrusted.ts';
import type { ReplayState } from './webhooks.ts';

type Json = Record<string, unknown>;

export function projectKey(projectDir: string): string {
    return createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16);
}

/**
 * Replaces a state file whole. The new content is flushed before it takes the old one's place, so
 * that a crash or a power cut leaves the old file or the new one: never an empty one, which would
 * read as no watches at all. (The folder is not flushed after the rename: if the rename is what is
 * lost, the old file is what comes back, and a starting helper recovers what it lacks from the
 * spools. Flushing the folder too cost a third of the event rate, measured: docs/performance.md.)
 */
function writeAtomic(file: string, data: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
        writeSync(fd, data);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}

/** How many sessions a project keeps listed as possibly holding events not yet handed over. */
const LISTED_MAX = 8;

export type WatchStatus = 'starting' | 'active' | 'retrying' | 'error' | 'ended' | 'elsewhere';

export type Watch = {
    id: string;
    server: string;
    /** How the server is reached, so a renamed or re-pointed config entry isn't mistaken for it. */
    fingerprint: string;
    event: string;
    arguments: Json;
    /** What Claude was asked to do when it fires, in the words of whoever set it up. */
    note?: string;
    /** When resuming from a saved cursor, replay at most this far back (the extension's `maxAgeMs`). */
    maxAgeMs?: number;
    mode: DeliveryMode;
    cursor: string | null;
    createdAt: string;
    lastEventAt?: string;
    events: number;
    status: WatchStatus;
    error?: string;
    subscriptionId?: string;
    /**
     * A webhook watch's lasting address on the relay, and the secret its deliveries are signed
     * with (which never leaves this machine except to the MCP server it subscribes at).
     * `replay` is what the watch remembers of deliveries already taken, against replays.
     */
    webhook?: { hook: string; url: string; secret: string; replay?: ReplayState };
    /** Recent eventIds, for deduplication within this subscription. */
    seen: string[];
};

export class ProjectState {
    readonly dir: string;
    watches: Watch[] = [];

    /** `o.dir`: a folder of the host's choosing instead of one per project folder (Codex: one per thread, `projectDir` then says whose). */
    constructor(base: string, projectDir: string, o: { dir?: string } = {}) {
        this.dir = o.dir ?? join(base, 'projects', projectKey(projectDir));
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.reload();
        writeAtomic(join(this.dir, 'project.json'), JSON.stringify(o.dir ? { for: projectDir } : { projectDir: resolve(projectDir) }) + '\n');
    }

    /** Reads the watches as last saved (by this session, or by the one that ran them before). */
    reload(): void {
        try {
            const j = JSON.parse(readFileSync(join(this.dir, 'watches.json'), 'utf8')) as { watches?: Watch[] };
            this.watches = Array.isArray(j.watches) ? j.watches : [];
        } catch {
            this.watches = [];
        }
    }

    save(): void {
        const keep = this.watches.filter((w) => w.status !== 'ended');
        writeAtomic(join(this.dir, 'watches.json'), JSON.stringify({ version: 1, watches: keep }, null, 2) + '\n');
    }

    /**
     * One session per project runs the watches, so two Claude Code windows on the same
     * project don't both react to every event. Of two sessions starting together, exactly
     * one gets the claim: looking at the current holder and taking over from one that has
     * exited happen under a lock (a directory, which only one process can create).
     */
    claim(session: string, pid = process.pid): { owner: true } | { owner: false; holder: { session: string; pid: number } } {
        const file = join(this.dir, 'owner.json');
        const lock = join(this.dir, 'owner.lock');
        let held = false;
        for (let attempt = 0; attempt < 60 && !held; attempt++) {
            try {
                // The lock names the process that took it. It is given up as abandoned only if that process
                // is gone: a process that is merely slow (or suspended) keeps it.
                writeFileSync(lock, String(pid), { flag: 'wx', mode: 0o600 });
                held = true;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                try {
                    const locker = Number(readFileSync(lock, 'utf8'));
                    if (!Number.isInteger(locker) || locker <= 0 || !alive(locker)) {
                        // Abandoned. Moved aside under a name of our own first, so that of several
                        // processes noticing at once, each removes only what it itself moved.
                        const aside = `${lock}.${pid}.${attempt}`;
                        renameSync(lock, aside);
                        const moved = Number(readFileSync(aside, 'utf8'));
                        if (moved === locker) unlinkSync(aside);
                        else renameSync(aside, lock); // a new lock got in between: put it back
                    }
                } catch {
                    // gone already, or being replaced: look again
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            }
        }
        if (!held) return { owner: false, holder: { session: 'unknown', pid: 0 } };
        try {
            let cur: { session?: unknown; pid?: unknown } | undefined;
            try {
                cur = JSON.parse(readFileSync(file, 'utf8')) as typeof cur;
            } catch {
                // no holder
            }
            if (cur && typeof cur.pid === 'number' && cur.pid !== pid && alive(cur.pid)) return { owner: false, holder: { session: String(cur.session ?? 'unknown'), pid: cur.pid } };
            writeAtomic(file, JSON.stringify({ session, pid }) + '\n');
            // Looked at again: if this process was held up long enough for its lock to be taken as
            // abandoned, someone else may have claimed meanwhile, and theirs stands.
            return this.owns(session, pid) ? { owner: true } : { owner: false, holder: { session: 'unknown', pid: 0 } };
        } finally {
            try {
                if (Number(readFileSync(lock, 'utf8')) === pid) unlinkSync(lock);
            } catch {
                // not ours any more
            }
        }
    }

    /** Whether this session still holds the claim. */
    owns(session: string, pid = process.pid): boolean {
        try {
            const cur = JSON.parse(readFileSync(join(this.dir, 'owner.json'), 'utf8')) as { session?: unknown; pid?: unknown };
            return cur.pid === pid && cur.session === session;
        } catch {
            return false;
        }
    }

    /**
     * The sessions whose spools may hold this project's events not yet handed over: each session
     * that ran the watches lists itself, and the next one that runs them takes what is waiting there
     * and takes it off the list (WatchManager). At most the latest LISTED_MAX are kept.
     */
    listed(): { session: string; pid: number }[] {
        try {
            const j = JSON.parse(readFileSync(join(this.dir, 'sessions.json'), 'utf8')) as { sessions?: unknown };
            return Array.isArray(j.sessions) ? j.sessions.filter((x): x is { session: string; pid: number } => typeof x?.session === 'string' && typeof x?.pid === 'number') : [];
        } catch {
            return [];
        }
    }

    list(session: string, pid = process.pid): void {
        const rest = this.listed().filter((x) => x.session !== session);
        writeAtomic(join(this.dir, 'sessions.json'), JSON.stringify({ sessions: [...rest, { session, pid }].slice(-LISTED_MAX) }) + '\n');
    }

    unlist(sessions: string[]): void {
        if (!sessions.length) return;
        writeAtomic(join(this.dir, 'sessions.json'), JSON.stringify({ sessions: this.listed().filter((x) => !sessions.includes(x.session)) }) + '\n');
    }

    /** Gives the claim up, if this process holds it. */
    release(pid = process.pid): void {
        const file = join(this.dir, 'owner.json');
        try {
            if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid === pid) unlinkSync(file);
        } catch {
            // nothing to release
        }
    }
}

export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const SESSION_FILES = ['events.jsonl', 'delivered.pos', 'monitor.pos', 'wakes.json'];

/** Where a session's spool and its hand-over position are kept. */
export function sessionDir(base: string, session: string): string {
    return join(base, 'sessions', session.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** How much of the end of another session's spool is read when a helper starts: what was not handed over, and the latest events. */
const PEEK_BYTES = 16 * 1024 * 1024;
const RECENT_BYTES = 4 * 1024 * 1024;

/** A session's hand-over position: bytes of its spool handed to Claude Code and acknowledged. */
export function deliveredPosition(dir: string): number {
    // A position saved by the monitor of an earlier version of this plugin counts too.
    for (const file of [join(dir, 'delivered.pos'), join(dir, 'monitor.pos')]) {
        try {
            return Math.max(0, Number((JSON.parse(readFileSync(file, 'utf8')) as { bytes?: unknown }).bytes) || 0);
        } catch {
            // nothing handed over yet
        }
    }
    return 0;
}

export function saveDeliveredPosition(dir: string, bytes: number): void {
    writeFileSync(join(dir, 'delivered.pos'), JSON.stringify({ bytes }), { mode: 0o600 });
}

/**
 * The end of a session's spool, as records with where each ends, and its hand-over position:
 * everything past that position, and the latest few megabytes before it. A record cut off by
 * where the reading starts is left out.
 */
export function peekSpool(base: string, session: string): { dir: string; size: number; delivered: number; records: { rec: SpoolRecord; end: number }[] } {
    const dir = sessionDir(base, session);
    const delivered = deliveredPosition(dir);
    const out = { dir, size: 0, delivered, records: [] as { rec: SpoolRecord; end: number }[] };
    let fd: number | undefined;
    try {
        fd = openSync(join(dir, 'events.jsonl'), 'r');
        const size = fstatSync(fd).size;
        out.size = size;
        const from = Math.max(0, size - PEEK_BYTES, Math.min(delivered, size - RECENT_BYTES));
        const buf = Buffer.alloc(size - from);
        const got = readSync(fd, buf, 0, buf.length, from);
        let at = from;
        let first = true;
        for (const line of buf.subarray(0, got).toString('utf8').split('\n')) {
            const end = at + Buffer.byteLength(line) + 1;
            const whole = !(first && from > 0 && from !== delivered);
            first = false;
            at = end;
            if (!whole || !line.trim() || end > size) continue;
            try {
                out.records.push({ rec: JSON.parse(line) as SpoolRecord, end });
            } catch {
                // not a record
            }
        }
    } catch {
        // no spool there
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
    return out;
}

/**
 * Removes the stored events of sessions that last wrote long ago. A session's events are read only
 * by that session, and every session leaves a folder behind, so without this they pile up.
 * It removes only the files this mod writes there, and then the folder if that left it empty.
 */
export function pruneSessions(base: string, keep: string, maxAgeMs = 14 * 24 * 60 * 60 * 1000, now = Date.now()): number {
    const root = join(base, 'sessions');
    let removed = 0;
    let names: string[];
    try {
        names = readdirSync(root);
    } catch {
        return 0;
    }
    for (const name of names.slice(0, 2000)) {
        if (name === keep.replace(/[^A-Za-z0-9_-]/g, '_') || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
        const dir = join(root, name);
        try {
            const newest = Math.max(...SESSION_FILES.map((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0), statSync(dir).mtimeMs);
            if (now - newest < maxAgeMs) continue;
            for (const f of SESSION_FILES) {
                try {
                    unlinkSync(join(dir, f));
                } catch {
                    // not there
                }
            }
            rmdirSync(dir); // fails, and leaves it, if anything else is inside
            removed++;
        } catch {
            // in use, or not ours: left alone
        }
    }
    return removed;
}

export type SpoolRecord = {
    id: string;
    kind: 'event' | 'notice';
    receivedAt: string;
    watch?: string;
    server?: string;
    event?: string;
    eventId?: string;
    timestamp?: string;
    data?: Json;
    /** The occurrence's `_meta`, as sent. */
    meta?: Json;
    note?: string;
    text?: string;
};

const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const NOTICE_RESERVE_BYTES = 1024 * 1024;

export class Spool {
    readonly dir: string;
    readonly file: string;
    /** Called after each record is on disk (the helper uses it to tell Claude Code that events wait). */
    onAppend?: (rec: SpoolRecord) => void;
    #seq = 0;
    #bytes = 0;

    constructor(base: string, session: string) {
        this.dir = sessionDir(base, session);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.file = join(this.dir, 'events.jsonl');
        // Opened for appending: this creates the file if it is not there and never empties one that is
        // (the monitor and the server both do this at startup, in either order).
        appendFileSync(this.file, '', { mode: 0o600 });
        const text = readFileSync(this.file, 'utf8');
        this.#seq = text.split('\n').filter(Boolean).length;
        this.#bytes = Buffer.byteLength(text);
    }

    /** Appends synchronously, so a webhook is acknowledged only once its event is on disk. */
    append(rec: Omit<SpoolRecord, 'id' | 'receivedAt'>): SpoolRecord {
        return this.appendMany([rec])[0]!;
    }

    /** Appends several records in one write and one flush: all of them are on disk, or none was taken. */
    appendMany(recs: (Omit<SpoolRecord, 'id' | 'receivedAt'> & { receivedAt?: string })[]): SpoolRecord[] {
        const full: SpoolRecord[] = recs.map((rec, i) => ({ id: `e${this.#seq + 1 + i}`, receivedAt: new Date().toISOString(), ...rec }));
        const text = full.map((r) => JSON.stringify(r) + '\n').join('');
        const bytes = Buffer.byteLength(text);
        // One session's events take at most this much disk. Past it nothing more is taken (so nothing
        // more is acknowledged), until a new session starts.
        // A notice (a watch stopping, say) still fits in a small reserve, so the reason can be told.
        if (this.#bytes + bytes > MAX_SPOOL_BYTES + (full.every((r) => r.kind === 'notice') ? NOTICE_RESERVE_BYTES : 0)) throw new LocalError('this session\'s event store is full; events wait at their source until a new session starts');
        // Written and flushed: an event is acknowledged to its sender only after this.
        const fd = openSync(this.file, 'a', 0o600);
        try {
            writeSync(fd, text);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        this.#seq += full.length;
        this.#bytes += bytes;
        for (const r of full) this.onAppend?.(r);
        return full;
    }

    all(): SpoolRecord[] {
        return readFileSync(this.file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as SpoolRecord);
    }

    get(id: string): SpoolRecord | undefined {
        return this.all().find((r) => r.id === id);
    }
}
