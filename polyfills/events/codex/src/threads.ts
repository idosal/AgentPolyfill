// One Codex session (a thread) as this helper serves it: its watches, its events,
// and waking it.
//
// A watch belongs to the thread whose tools/call made it (Codex's `_meta.threadId`).
// Its state is the thread's: <state>/threads/<id>/ (watches, and which process runs
// them) and <state>/sessions/<id>/ (the thread's events, how far they were handed
// over, and the wake count). One process runs a thread's watches; a second one (the
// same session open twice) only lists them, and takes over if the first goes.
//
// Every event is on disk before it is acknowledged to its server. Then, at most as
// often as the wake gate allows (wake.ts), the new events are handed to the thread
// with `codex queue` (waker.ts). Where the hand-over stands is saved only once
// `codex queue` has taken the message, so a failed or interrupted wake is tried
// again, and an event can at worst be announced twice, never not at all.

import { join } from 'node:path';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { Delivery, type Batch } from '../../core/src/delivery.ts';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import type { QueueResult, Wake } from './waker.ts';

/** The first line of every wake: the message lands in the conversation as input, so it says whose it is. */
export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;

export type ThreadOptions = {
    base: string;
    connections: Map<string, EventsConnection>;
    unavailable: () => Unavailable[];
    wake: Wake;
    log: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
};

const MIN_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60000;

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

    constructor(id: string, o: ThreadOptions) {
        const env = o.env ?? process.env;
        this.id = id;
        this.#wake = o.wake;
        this.#log = (s) => o.log(`[${id.slice(0, 8)}] ${s}`);
        this.#batchMs = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
        this.#values = env.MCP_EVENTS_WAKE_VALUES === '1';
        this.project = new ProjectState(o.base, `codex thread ${id}`, { dir: join(o.base, 'threads', id) });
        this.spool = new Spool(o.base, id);
        // How often events may wake this session. Kept with its events, so a helper that restarts carries on counting.
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'));
        // A notice handed to `codex queue` by a helper that stopped before it heard back counts as given.
        if (this.budget.noticeHanded) this.budget.pause();
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: id, log: this.#log, env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
        this.#tools = createTools(() => [...o.connections.values()], o.unavailable, this.manager);
        this.spool.onAppend = (rec) => {
            // An event of a watch that may not wake the session yet waits for its time.
            const gate = this.budget.gate([String(rec.watch ?? '')]);
            if (gate.kind === 'paused') return;
            this.announce(gate.kind === 'wait' ? gate.ms + 50 : this.#batchMs);
        };
    }

    /** Claims this session's watches and resumes them. Returns whether this process runs them. */
    start(): boolean {
        const was = this.manager.owner;
        const owner = this.manager.start();
        if (owner && !was) {
            // Where the hand-over stands, as the process that ran them before left it.
            this.#delivery = new Delivery(this.spool, { values: this.#values });
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    async call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        const answer = await this.#tools.call(name, input);
        if (name === 'list_watches' && this.lastWakeError) return { ...answer, text: `${answer.text}\n\nWaking this session failed the last time it was tried (${this.lastWakeError}); it is tried again.` };
        return answer;
    }

    /** The person wrote to the session: if waking had stopped at its hourly limit, it starts again. */
    spoke(): void {
        if (this.budget.spoke()) this.#log('the user is back: waking starts again');
        if (this.#delivery?.pending) this.announce();
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

    async #queue(text: string): Promise<QueueResult> {
        const r = await this.#wake(this.id, text);
        if (r.ok) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
            if (!r.resumed) this.#log('codex queue took the message but could not resume the session; it runs when the session is next opened');
        } else {
            this.lastWakeError = r.why;
            this.#retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, this.#retryMs * 2));
            this.#log(`waking the session failed: ${r.why}; trying again in ${Math.round(this.#retryMs / 1000)} s`);
        }
        return r;
    }

    async #handOver(): Promise<void> {
        if (this.#waking || this.#stopped) return;
        // Only the process that runs the watches wakes the session.
        if (!this.manager.owner || !this.#delivery) return;
        this.#waking = true;
        let again: number | undefined;
        try {
            const delivery = this.#delivery;
            const batch: Batch | undefined = delivery.take();
            if (!batch) return;
            // Nothing to show (blank lines): only marked as read.
            if (!batch.lines.length) {
                delivery.ack(batch.upto);
                if (delivery.pending) again = this.#batchMs;
                return;
            }
            const gate = this.budget.gate(batch.watches);
            if (gate.kind === 'paused') return;
            if (gate.kind === 'wait') {
                again = gate.ms + 50;
                return;
            }
            if (gate.kind === 'notice') {
                // The events stay where they are; the session is told, once, that waking has stopped.
                this.budget.handNotice();
                const r = await this.#queue([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'));
                if (r.ok) this.budget.pause();
                else again = this.#retryMs;
                return;
            }
            const r = await this.#queue([WAKE_HEADER, ...batch.lines].join('\n'));
            if (!r.ok) {
                again = this.#retryMs;
                return;
            }
            this.budget.woke(batch.watches);
            delivery.ack(batch.upto);
            if (delivery.pending) again = this.#batchMs;
        } finally {
            this.#waking = false;
            // Every early return above lands here too: what is left waits for its time.
            if (again !== undefined) this.announce(again);
        }
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        clearTimeout(this.#timer);
        await this.manager.stop();
    }
}
