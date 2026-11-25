// The tasks a session started, kept on disk so polling resumes after a crash or a restart (C7).
//
// One file per session (`<base>/threads/<id>/tasks.json`), private to the user (0700 folders, 0600
// files), written whole to a temporary file and renamed into place, so a crash never leaves half
// of it. A task is known to the model by a local id of this plugin's (`t-` and six hex digits);
// the server's taskId never reaches the model or a wake line.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputRequest, TaskStatus } from './protocol.ts';

/** What became of a task, as this client sees it. */
export type Outcome =
    /** Still running on the server, as far as is known. */
    | 'open'
    /** The server says so (the three terminal statuses). */
    | 'completed'
    | 'failed'
    | 'cancelled'
    /** tasks/cancel was acknowledged; the task is no longer polled (C6, C15). */
    | 'cancel-requested'
    /** The server no longer knows the task (tasks/get answered -32602). */
    | 'gone'
    /** createdAt + ttlMs passed with the task still not finished (the TTL backstop). */
    | 'expired'
    /** The server answered in a way the specification doesn't allow; the task is left alone. */
    | 'refused';

export type TaskRecord = {
    id: string;
    server: string;
    tool: string;
    /** The arguments the person approved, as they were sent. */
    args: Record<string, unknown>;
    taskId: string;
    status: TaskStatus;
    outcome: Outcome;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttlMs: number | null;
    pollIntervalMs?: number;
    startedAt: string;
    /** When this client last heard from the server about the task. */
    checkedAt?: string;
    /** The outstanding requests of an input_required task, as last seen. */
    inputRequests?: Record<string, InputRequest>;
    /** inputRequests keys already put to the person or answered (C11, C12). */
    seenKeys: string[];
    answeredKeys: string[];
    /** The final result, or the JSON-RPC error of a failed task, as the server sent it. */
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    /** Why the task was refused, in this plugin's words. */
    refused?: string;
    /** What the session has to be told and hasn't been yet. */
    announce?: 'finished' | 'input';
    /** The last thing the session was told about. */
    announced?: 'finished' | 'input';
    /** When the session was last woken about this task (ms). */
    lastWakeAt?: number;
    /** How the server was reached when the task started: a task is followed only on that server (core/src/connection.ts). */
    fingerprint?: string;
};

/** The tasks, and when this session was woken (ms), for the hour's budget. */
type File = { tasks: TaskRecord[]; wakes?: number[] };
export const LOCAL_ID = /^t-[0-9a-f]{6}$/;
/** A finished task is kept this long, for its result to be read. */
export const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;
/** The most a stored result may weigh; past it only a note is kept. */
export const MAX_RESULT_BYTES = 1024 * 1024;
/** The most kept of a status message, and of a failed task's error. */
export const MAX_STATUS_CHARS = 4000;
export const MAX_ERROR_BYTES = 16 * 1024;
/** A session not heard from in this long, with no task left, is removed. */
export const KEEP_IDLE_SESSION_MS = 14 * 24 * 3600 * 1000;

const private0700 = (dir: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        chmodSync(dir, 0o700);
    } catch {
        // best effort
    }
};

export class TaskStore {
    readonly dir: string;
    readonly #file: string;
    #data: File;

    constructor(base: string, thread: string) {
        this.dir = join(base, 'threads', thread);
        // Each folder on the way private, an existing one too.
        private0700(base);
        private0700(join(base, 'threads'));
        private0700(this.dir);
        this.#file = join(this.dir, 'tasks.json');
        this.#data = this.#read();
    }

    #read(): File {
        try {
            const j = JSON.parse(readFileSync(this.#file, 'utf8')) as File;
            const wakes = Array.isArray(j.wakes) ? j.wakes.filter((x): x is number => typeof x === 'number') : [];
            return Array.isArray(j.tasks) ? { tasks: j.tasks.filter((t) => LOCAL_ID.test(t.id)), wakes } : { tasks: [], wakes };
        } catch {
            return { tasks: [] };
        }
    }

    /** Reads the file again (another process of the same session may have written it). */
    reload(): void {
        this.#data = this.#read();
    }

    all(): TaskRecord[] {
        return this.#data.tasks;
    }

    get(id: string): TaskRecord | undefined {
        return this.#data.tasks.find((t) => t.id === id);
    }

    newId(): string {
        for (;;) {
            const id = `t-${randomBytes(3).toString('hex')}`;
            if (!this.get(id)) return id;
        }
    }

    add(t: TaskRecord): void {
        this.#data.tasks.push(t);
        this.save();
    }

    /** Applies a change to one task and saves. */
    update(id: string, change: (t: TaskRecord) => void): TaskRecord | undefined {
        const t = this.get(id);
        if (!t) return undefined;
        change(t);
        if (t.result && JSON.stringify(t.result).length > MAX_RESULT_BYTES) t.result = { content: [{ type: 'text', text: '(the result was larger than this plugin keeps, 1 MB, and was dropped)' }], isError: true, dropped: true };
        if (t.statusMessage && t.statusMessage.length > MAX_STATUS_CHARS) t.statusMessage = t.statusMessage.slice(0, MAX_STATUS_CHARS - 1) + '\u2026';
        if (t.error && JSON.stringify(t.error).length > MAX_ERROR_BYTES) t.error = { code: typeof t.error.code === 'number' ? t.error.code : -32603, message: '(the error was larger than this plugin keeps, and was dropped)' };
        this.save();
        return t;
    }

    /** When this session was woken in the last hour. */
    wakes(now = Date.now()): number[] {
        return (this.#data.wakes ?? []).filter((x) => now - x < 3600 * 1000);
    }

    recordWake(at = Date.now()): void {
        this.#data.wakes = [...this.wakes(at), at];
        this.save(at);
    }

    save(now = Date.now()): void {
        // Finished tasks are let go after a week.
        this.#data.tasks = this.#data.tasks.filter((t) => t.outcome === 'open' || now - Date.parse(t.checkedAt ?? t.startedAt) < KEEP_FINISHED_MS);
        this.#data.wakes = (this.#data.wakes ?? []).filter((x) => now - x < 3600 * 1000);
        const tmp = `${this.#file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.#data, null, 1), { mode: 0o600 });
        renameSync(tmp, this.#file);
    }

    static exists(base: string, thread: string): boolean {
        return existsSync(join(base, 'threads', thread, 'tasks.json'));
    }

    /** Whether nothing is left here and the session hasn't been heard from in two weeks. */
    idle(now = Date.now()): boolean {
        if (this.#data.tasks.length) return false;
        try {
            return now - statSync(this.#file).mtimeMs > KEEP_IDLE_SESSION_MS;
        } catch {
            return true;
        }
    }
}
