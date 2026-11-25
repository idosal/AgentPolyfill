// One T3 Code thread as the watcher serves it: its watches, its events, and waking it.
//
// A watch belongs to the thread whose agent called watch_event: T3 Code tells each MCP
// server it starts for a thread which thread that is (T3CODE_THREAD_ID). Its state is
// the thread's: <state>/threads/<id>/ (its watches) and <state>/sessions/<id>/ (its
// events, how far they were handed over, and the wake count).
//
// Every event is on disk before it is acknowledged to its server. Then, at most as
// often as the wake gate allows (core wake.ts), the new events are handed to the
// thread with `t3 thread send` (waker.ts). The hand-over is recorded before the
// command runs, and a send T3 Code said it did not take is tried again. One this
// process never heard back about (it ended, or the command timed out) counts as
// handed over and as a wake: a stored event is handed over at most once, and the
// hourly cap holds across restarts. Such an event may go unannounced; it is still
// stored, for recent_events.
//
// This follows the Codex form's ThreadSession (../../codex/src/threads.ts), with
// T3 Code's wake and words. What differs: T3 Code doesn't tell an MCP server whether a
// turn was started by the person, so waking that has stopped for the hour starts again
// by itself an hour later, not when the person writes.

import { join } from 'node:path';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { Delivery, type Batch } from '../../core/src/delivery.ts';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import type { SendResult, Wake } from './waker.ts';

/** The first line of every wake: the message lands in the thread as a message, so it says whose it is. */
export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events polyfill through T3 Code, not typed by the user.)`;

export type ThreadOptions = {
    base: string;
    connections: Map<string, EventsConnection>;
    unavailable: () => Unavailable[];
    wake: Wake;
    log: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
    /** How long the pause past the hour's wakes lasts. Default an hour. */
    liftAfterMs?: number;
};

const PAUSE_LIFTS_AFTER_MS = 3600 * 1000;
const MIN_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60000;

/** A thread id as a folder name. */
export const folderOf = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

export class ThreadSession {
    readonly id: string;
    readonly project: ProjectState;
    readonly spool: Spool;
    readonly budget: WakeBudget;
    readonly manager: WatchManager;
    readonly #tools: ReturnType<typeof createTools>;
    readonly #wake: Wake;
    readonly #log: (s: string) => void;
    readonly #batchMs: number;
    readonly #values: boolean;
    #delivery?: Delivery;
    #timer?: NodeJS.Timeout;
    #at = 0;
    #waking = false;
    #retryMs = 0;
    #stopped = false;
    /** Why the last wake failed, until one succeeds: list_watches says so. */
    lastWakeError?: string;
    /** What the last send that didn't answer (it timed out) carried, until one answers. */
    #unanswered: 'batch' | 'notice' | undefined;
    /** Why this thread can never be woken, once T3 Code has said so. Its events are still stored and readable. */
    unwakeable?: string;

    constructor(id: string, o: ThreadOptions) {
        const env = o.env ?? process.env;
        this.id = id;
        this.#wake = o.wake;
        this.#log = (s) => o.log(`[${id.slice(-8)}] ${s}`);
        this.#batchMs = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
        this.#values = env.MCP_EVENTS_WAKE_VALUES === '1';
        this.project = new ProjectState(o.base, `t3 thread ${id}`, { dir: join(o.base, 'threads', folderOf(id)) });
        this.spool = new Spool(o.base, id);
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'), { liftAfterMs: o.liftAfterMs ?? PAUSE_LIFTS_AFTER_MS });
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: id, log: this.#log, env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
        this.#tools = createTools(() => [...o.connections.values()], o.unavailable, this.manager);
        this.spool.onAppend = (rec) => {
            // An event of a watch that may not wake the thread yet waits for its time.
            const gate = this.budget.gate([String(rec.watch ?? '')]);
            if (gate.kind === 'paused') {
                if (gate.ms !== undefined) this.announce(gate.ms + 50);
                return;
            }
            this.announce(gate.kind === 'wait' ? gate.ms + 50 : this.#batchMs);
        };
    }

    /** Claims this thread's watches and resumes them. Returns whether this process runs them. */
    start(): boolean {
        const was = this.manager.owner;
        const owner = this.manager.start();
        if (owner && !was) {
            this.budget.reload();
            // A notice handed to `t3 thread send` by a watcher that stopped before it heard back counts as given.
            if (this.budget.noticeHanded) this.budget.pause();
            this.#delivery = new Delivery(this.spool, { values: this.#values });
            // A batch handed over by a watcher that ended before it heard back: it counts as handed over
            // and as a wake (at most once), and is never handed over again.
            const handed = this.budget.handed;
            if (handed) {
                this.#delivery.ack(handed.upto);
                this.budget.woke(handed.watches);
                this.#log('a batch handed to t3 thread send by a watcher that ended before it heard back counts as handed over');
            }
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    get watching(): number {
        return this.manager.watches.filter((w) => w.status !== 'ended').length;
    }

    async call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        const answer = await this.#tools.call(name, input);
        if (name !== 'list_watches') return answer;
        if (this.unwakeable) return { ...answer, text: `${answer.text}\n\nThis thread can't be woken (${this.unwakeable}). Its watches still store every event: recent_events and get_event read them.` };
        if (this.lastWakeError && this.#unanswered === 'batch')
            return { ...answer, text: `${answer.text}\n\nThe last wake's t3 thread send did not answer (${this.lastWakeError}), so it may not have reached this thread. Its events count as handed over and are not handed over again; recent_events lists them.` };
        if (this.lastWakeError && this.#unanswered === 'notice')
            return { ...answer, text: `${answer.text}\n\nThe t3 thread send that was to tell this thread that waking had stopped did not answer (${this.lastWakeError}). Waking stays paused; the events that wait are stored, handed over once the pause ends, and recent_events lists them.` };
        if (this.lastWakeError) return { ...answer, text: `${answer.text}\n\nWaking this thread failed the last time it was tried (${this.lastWakeError}); it is tried again.` };
        return answer;
    }

    /** A burst is handed over once, a moment after it starts. A look already due sooner stands. */
    announce(afterMs = this.#batchMs): void {
        if (this.#stopped) return;
        const at = Date.now() + afterMs;
        if (this.#timer && this.#at <= at) return;
        clearTimeout(this.#timer);
        this.#at = at;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            void this.#handOver();
        }, afterMs);
        this.#timer.unref?.();
    }

    async #send(text: string, carries: 'batch' | 'notice'): Promise<SendResult> {
        const r = await this.#wake(this.id, text);
        this.#unanswered = undefined;
        if (r.ok) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
        } else if (r.maybe) {
            this.lastWakeError = r.why;
            this.#unanswered = carries;
            this.#retryMs = 0;
            this.#log(`${r.why}; it may have sent the message, so it counts as ${carries === 'batch' ? 'handed over' : 'given (waking stays paused)'}`);
        } else if (r.unreachable) {
            this.unwakeable = r.why;
            this.lastWakeError = r.why;
            this.#log(`${r.why}; not trying to wake this thread again (its events are still stored)`);
        } else {
            this.lastWakeError = r.why;
            this.#retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, this.#retryMs * 2));
            this.#log(`waking the thread failed: ${r.why}; trying again in ${Math.round(this.#retryMs / 1000)} s`);
        }
        return r;
    }

    async #handOver(): Promise<void> {
        if (this.#waking || this.#stopped || this.unwakeable) return;
        if (!this.manager.owner || !this.#delivery) return;
        this.#waking = true;
        let again: number | undefined;
        try {
            const delivery = this.#delivery;
            const batch: Batch | undefined = delivery.take();
            if (!batch) return;
            if (!batch.lines.length) {
                delivery.ack(batch.upto);
                if (delivery.pending) again = this.#batchMs;
                return;
            }
            const gate = this.budget.gate(batch.watches);
            if (gate.kind === 'paused') {
                if (gate.ms !== undefined) again = gate.ms + 50;
                return;
            }
            if (gate.kind === 'wait') {
                again = gate.ms + 50;
                return;
            }
            if (gate.kind === 'notice') {
                this.budget.handNotice();
                const r = await this.#send([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'), 'notice');
                if (r.ok || r.maybe) {
                    this.budget.pause();
                    return;
                }
                this.budget.dropNotice();
                if (!r.unreachable) again = this.#retryMs;
                return;
            }
            // Write-ahead: recorded as handed over before the command runs. Not recorded, not handed over.
            if (!this.budget.handBatch(batch.watches, batch.upto)) {
                this.lastWakeError = 'the hand-over could not be recorded: wakes.json could not be saved';
                this.#unanswered = undefined;
                this.#log(`${this.lastWakeError}; the thread is not woken until it can be`);
                again = Math.max(MIN_RETRY_MS, this.#retryMs);
                return;
            }
            const r = await this.#send([WAKE_HEADER, ...batch.lines].join('\n'), 'batch');
            if (!r.ok && !r.maybe) {
                this.budget.dropHanded();
                if (!r.unreachable) again = this.#retryMs;
                return;
            }
            delivery.ack(batch.upto);
            this.budget.woke(batch.watches);
            if (delivery.pending) again = this.#batchMs;
        } finally {
            this.#waking = false;
            if (again !== undefined) this.announce(again);
        }
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        clearTimeout(this.#timer);
        await this.manager.stop();
    }
}
