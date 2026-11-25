// Polls a session's open tasks until each reaches a terminal status or is cancelled (C5, C6), at the
// interval the server last gave (C5: never more often; a floor of a second guards against a server
// that asks for none). Each answer is checked (protocol.ts) before it is kept. When a task finishes,
// vanishes, expires, or asks for input not seen before (C11), the session is told, through
// `onAnnounce`; what it is told is the host's business (a wake, in Codex).

import { ServerError, type TasksConnection } from './connection.ts';
import { TERMINAL, type TaskStatus } from './protocol.ts';
import type { TaskRecord, TaskStore } from './store.ts';
import { describeError } from './untrusted.ts';

export type RunnerOptions = {
    store: TaskStore;
    /** The connection to a server by its name, opened if need be; nothing if it can't be reached. */
    connection: (server: string) => Promise<TasksConnection | undefined>;
    /** Something changed that the session should be told about (a record's `announce` is set). */
    onAnnounce: (t: TaskRecord) => void;
    log?: (s: string) => void;
    now?: () => number;
    minPollMs?: number;
    defaultPollMs?: number;
};

const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** The most a task's outstanding questions may weigh. */
export const MAX_INPUT_BYTES = 256 * 1024;
/** setTimeout's limit; a longer interval is waited in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class TaskRunner {
    readonly #o: RunnerOptions;
    readonly #timers = new Map<string, NodeJS.Timeout>();
    readonly #failures = new Map<string, number>();
    #stopped = false;

    constructor(o: RunnerOptions) {
        this.#o = o;
    }

    get #now(): number {
        return (this.#o.now ?? Date.now)();
    }

    /** Polls every open task of the store (after a restart, from where each left off: C7). */
    start(): void {
        for (const t of this.#o.store.all()) if (t.outcome === 'open') this.schedule(t.id, 0);
    }

    schedule(id: string, delayMs?: number): void {
        if (this.#stopped) return;
        clearTimeout(this.#timers.get(id));
        const t = this.#o.store.get(id);
        if (!t || t.outcome !== 'open') return;
        const wait = Math.min(MAX_TIMER_MS, delayMs ?? this.interval(t));
        const timer = setTimeout(() => void this.poll(id).catch((e) => this.#o.log?.(`[${id}] poll failed (${describeError(e)})`)), wait);
        timer.unref?.();
        this.#timers.set(id, timer);
    }

    /** The server's interval (C5), with a floor; the default when it gave none. */
    interval(t: TaskRecord): number {
        return Math.max(this.#o.minPollMs ?? 1000, t.pollIntervalMs ?? this.#o.defaultPollMs ?? 5000);
    }

    stopPolling(id: string): void {
        clearTimeout(this.#timers.get(id));
        this.#timers.delete(id);
    }

    /** One `tasks/get` for a task, and what follows from the answer. */
    async poll(id: string): Promise<TaskRecord | undefined> {
        this.#timers.delete(id);
        const store = this.#o.store;
        store.reload();
        const t = store.get(id);
        if (!t || t.outcome !== 'open') return t;
        const log = (s: string) => this.#o.log?.(`[${id}] ${s}`);
        // The TTL backstop: past createdAt + ttlMs, a task that still hasn't finished may be considered unusable.
        if (t.ttlMs !== null && this.#now > Date.parse(t.createdAt) + t.ttlMs + this.interval(t)) {
            log('its time to live has passed with no result');
            return this.#finish(t, 'expired');
        }
        const conn = await this.#o.connection(t.server);
        if (!conn) return this.#retry(t, 'the server could not be reached');
        // The task belongs to the server it started on: if that name now leads somewhere else, the task id
        // (which may be a bearer token) is not sent there.
        if (t.fingerprint && conn.fingerprint !== t.fingerprint) {
            log('the server of that name is now reached in another way; the task is left alone');
            return this.#finish(t, 'refused', `the server named ${t.server} in your config is no longer the one the task started on`);
        }
        let answer;
        try {
            answer = await conn.getTask(t.taskId, t.status);
        } catch (e) {
            if (e instanceof ServerError && e.code === -32602) {
                log('the server no longer knows this task');
                return this.#finish(t, 'gone');
            }
            return this.#retry(t, describeError(e));
        }
        this.#failures.delete(id);
        if ('invalid' in answer) {
            log(`refused the server's answer: ${answer.invalid}`);
            return this.#finish(t, 'refused', answer.invalid);
        }
        if (answer.inputRequests && JSON.stringify(answer.inputRequests).length > MAX_INPUT_BYTES) {
            log('its questions were larger than this plugin takes');
            return this.#finish(t, 'refused', 'its questions were larger than this plugin takes (256 KB)');
        }
        const before = t.status;
        let told = false;
        const updated = store.update(id, (r) => {
            r.status = answer.status;
            r.statusMessage = answer.statusMessage;
            r.lastUpdatedAt = answer.lastUpdatedAt;
            r.ttlMs = answer.ttlMs;
            r.pollIntervalMs = answer.pollIntervalMs;
            r.checkedAt = new Date(this.#now).toISOString();
            r.inputRequests = answer.status === 'input_required' ? answer.inputRequests : undefined;
            if (answer.status === 'completed') r.result = answer.result;
            if (answer.status === 'failed') r.error = answer.error;
            if (TERMINAL.has(answer.status)) {
                r.outcome = answer.status as 'completed' | 'failed' | 'cancelled';
                r.announce = 'finished';
                told = true;
            } else if (answer.status === 'input_required') {
                // Only requests not put to the session before (C11).
                const fresh = Object.keys(answer.inputRequests ?? {}).filter((k) => !r.seenKeys.includes(k) && !r.answeredKeys.includes(k));
                if (fresh.length) {
                    r.seenKeys.push(...fresh);
                    r.announce = 'input';
                    told = true;
                }
            }
        })!;
        if (before !== updated.status) log(`${before} \u2192 ${updated.status}`);
        if (told) this.#o.onAnnounce(updated);
        if (updated.outcome === 'open') this.schedule(id);
        return updated;
    }

    #retry(t: TaskRecord, why: string): TaskRecord {
        const n = (this.#failures.get(t.id) ?? 0) + 1;
        this.#failures.set(t.id, n);
        const delay = Math.min(MAX_BACKOFF_MS, this.interval(t) * 2 ** Math.min(n, 10));
        this.#o.log?.(`[${t.id}] ${why}; trying again in ${Math.round(delay / 1000)} s`);
        this.schedule(t.id, delay);
        return t;
    }

    #finish(t: TaskRecord, outcome: 'expired' | 'gone' | 'refused', why?: string): TaskRecord {
        const r = this.#o.store.update(t.id, (x) => {
            x.outcome = outcome;
            x.announce = 'finished';
            x.checkedAt = new Date(this.#now).toISOString();
            if (why) x.refused = why;
        })!;
        this.#o.onAnnounce(r);
        return r;
    }

    stop(): void {
        this.#stopped = true;
        for (const t of this.#timers.values()) clearTimeout(t);
        this.#timers.clear();
    }
}

export const isTerminal = (s: TaskStatus): boolean => TERMINAL.has(s);
