// State on disk.
//
//   <state>/projects/<hash of project folder>/watches.json   what this project watches,
//       with each watch's cursor (the SEP: "the client owns the canonical list of
//       subscriptions" and persists every cursor it receives)
//   <state>/projects/<hash>/owner.json                       which session runs the watches
//   <state>/sessions/<session id>/events.jsonl               events for this session, which
//       the plugin's monitor prints to Claude
//
// <state> is MCP_EVENTS_STATE, else CLAUDE_PLUGIN_DATA, else ~/.mcp-events-plugin.

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DeliveryMode } from './events-client.ts';
import { LocalError } from './untrusted.ts';
import type { ReplayState } from './webhooks.ts';

type Json = Record<string, unknown>;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.MCP_EVENTS_STATE || env.CLAUDE_PLUGIN_DATA || join(homedir(), '.mcp-events-plugin');
}

export function sessionId(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAUDE_CODE_SESSION_ID || `pid-${env.CLAUDE_PID || process.ppid}`;
}

export function projectKey(projectDir: string): string {
    return createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16);
}

function writeAtomic(file: string, data: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}

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

    constructor(base: string, projectDir: string) {
        this.dir = join(base, 'projects', projectKey(projectDir));
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.reload();
        writeAtomic(join(this.dir, 'project.json'), JSON.stringify({ projectDir: resolve(projectDir) }) + '\n');
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

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const SESSION_FILES = ['events.jsonl', 'delivered.pos', 'monitor.pos'];

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
    onAppend?: () => void;
    #seq = 0;
    #bytes = 0;

    constructor(base: string, session: string) {
        this.dir = join(base, 'sessions', session.replace(/[^A-Za-z0-9_-]/g, '_'));
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
        const full: SpoolRecord = { id: `e${this.#seq + 1}`, receivedAt: new Date().toISOString(), ...rec };
        const line = JSON.stringify(full) + '\n';
        // One session's events take at most this much disk. Past it nothing more is taken (so nothing
        // more is acknowledged), until a new session starts.
        // A notice (a watch stopping, say) still fits in a small reserve, so the reason can be told.
        if (this.#bytes + Buffer.byteLength(line) > MAX_SPOOL_BYTES + (full.kind === 'notice' ? NOTICE_RESERVE_BYTES : 0)) throw new LocalError('this session\'s event store is full; events wait at their source until a new session starts');
        // Written and flushed: an event is acknowledged to its sender only after this.
        const fd = openSync(this.file, 'a', 0o600);
        try {
            writeSync(fd, line);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        this.#seq++;
        this.#bytes += Buffer.byteLength(line);
        this.onAppend?.();
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
