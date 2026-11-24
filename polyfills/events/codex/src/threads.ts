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
// with `codex queue` (waker.ts). The hand-over is recorded before `codex queue` runs,
// and a wake Codex said it did not take is tried again. One this process never heard
// back about (it ended, or `codex queue` timed out) counts as handed over and as a
// wake: a stored event is handed over at most once, and the hourly cap holds across restarts
// (for a session open in one window; with two, see the README's Limits).
// Such an event may go unannounced; it is still stored, for recent_events.

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
    /** How long the pause past the hour's wakes lasts when the person never writes. Default an hour. */
    liftAfterMs?: number;
};

const PAUSE_LIFTS_AFTER_MS = 3600 * 1000;
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
    /**
     * Why this session can never be woken, once `codex queue` has said so (a ChatGPT desktop-app chat,
     * which is not a local Codex session). Its events are still stored and readable; it is not tried again.
     */
    unwakeable?: string;

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
        // Past the hour's wakes the pause lifts when the person's own turn calls a tool, or by itself
        // after an hour: Codex shows the plugin the person only through a call's turn metadata.
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'), { liftAfterMs: o.liftAfterMs ?? PAUSE_LIFTS_AFTER_MS });
        // A notice handed to `codex queue` by a helper that stopped before it heard back counts as given.
        if (this.budget.noticeHanded) this.budget.pause();
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: id, log: this.#log, env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
        this.#tools = createTools(() => [...o.connections.values()], o.unavailable, this.manager);
        this.spool.onAppend = (rec) => {
            // An event of a watch that may not wake the session yet waits for its time.
            const gate = this.budget.gate([String(rec.watch ?? '')]);
            if (gate.kind === 'paused') {
                if (gate.ms !== undefined) this.announce(gate.ms + 50);
                return;
            }
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
            // A batch that process handed to `codex queue` and ended before it heard back about: it may
            // have woken the session, so it counts as handed over and as a wake (at most once), and is
            // never handed over again.
            const handed = this.budget.handed;
            if (handed) {
                this.#delivery.ack(handed.upto);
                this.budget.woke(handed.watches);
                this.#log('a batch handed to codex queue by a helper that ended before it heard back counts as handed over');
            }
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    async call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        const answer = await this.#tools.call(name, input);
        if (name === 'list_watches' && this.unwakeable) return { ...answer, text: `${answer.text}\n\nThis chat can't be woken: it isn't a local Codex session, which is all codex queue reaches (a ChatGPT desktop-app chat, say). Its watches still store every event: recent_events and get_event read them. Waking works in the Codex TUI.` };
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
        } else if (r.maybe) {
            // It may have queued the message: counted as handed over, never handed over again.
            this.lastWakeError = undefined;
            this.#retryMs = 0;
            this.#log(`${r.why}; it may have queued the message, so it counts as handed over`);
        } else if (r.unreachable) {
            // No later try can reach it: stop trying. Events go on being stored, for recent_events and get_event.
            this.unwakeable = r.why;
            this.lastWakeError = r.why;
            this.#log(`${r.why}; not trying to wake this session again (its events are still stored)`);
        } else {
            this.lastWakeError = r.why;
            this.#retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, this.#retryMs * 2));
            this.#log(`waking the session failed: ${r.why}; trying again in ${Math.round(this.#retryMs / 1000)} s`);
        }
        return r;
    }

    async #handOver(): Promise<void> {
        if (this.#waking || this.#stopped || this.unwakeable) return;
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
            if (gate.kind === 'paused') {
                // Looked at again when the pause lifts by itself, if nobody speaks first.
                if (gate.ms !== undefined) again = gate.ms + 50;
                return;
            }
            if (gate.kind === 'wait') {
                again = gate.ms + 50;
                return;
            }
            if (gate.kind === 'notice') {
                // The events stay where they are; the session is told, once, that waking has stopped.
                this.budget.handNotice();
                const r = await this.#queue([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'));
                if (r.ok || r.maybe) {
                    this.budget.pause();
                    return;
                }
                // Codex said it did not take it: the session was not told, so a helper that starts
                // later must not start paused by it; the notice is tried again. Only this answer
                // clears it: a notice still in `codex queue` when the person writes may be shown after
                // their call, and a helper that starts before the answer counts it as given.
                this.budget.dropNotice();
                if (!r.unreachable) again = this.#retryMs;
                return;
            }
            // Write-ahead: the batch is recorded as handed over before `codex queue` runs. If this process
            // ends before it hears back, the next one finds the record and counts the batch, instead of
            // handing it over a second time (a wake no budget knew of). Not recorded, not handed over.
            if (!this.budget.handBatch(batch.watches, batch.upto)) {
                this.#log('the hand-over could not be recorded; the session is not woken until it can be');
                again = Math.max(MIN_RETRY_MS, this.#retryMs);
                return;
            }
            const r = await this.#queue([WAKE_HEADER, ...batch.lines].join('\n'));
            if (!r.ok && !r.maybe) {
                // Codex said it did not take it: nothing was handed over. Tried again later, unless no
                // try can ever reach this session.
                this.budget.dropHanded();
                if (!r.unreachable) again = this.#retryMs;
                return;
            }
            // Marked handed over first, then counted (which clears the record, in the same write): a
            // process ending between the two leaves the record, and the next counts it once.
            delivery.ack(batch.upto);
            this.budget.woke(batch.watches);
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
