// One OpenCode session as this plugin serves it: its watches, its events, and
// waking it.
//
// A watch belongs to the session whose tool call made it (the executor's
// `sessionID`). Its state is the session's: <state>/threads/<id>/ (watches,
// which process runs them, and the OpenCode location it belongs to) and
// <state>/sessions/<id>/ (its events, how far they were handed over, and the
// wake count). One process runs a session's watches; another OpenCode server
// with the same session open only lists them, and takes over if the first goes.
//
// Every event is on disk before it is acknowledged to its server. Then, at most
// as often as the wake gate allows (core/src/wake.ts), the new events are handed
// to the session with `ctx.session.synthetic`: OpenCode admits the message to
// the session's durable inbox, marked as synthetic (not the user's), and with
// `resume: true` it starts a turn in an idle session. The hand-over is recorded
// before the message is sent; one this process never heard back about (it ended
// while OpenCode admitted it) counts as handed over and as a wake, so a stored
// event is handed over at most once and the hourly cap holds across restarts.
//
// This is the Codex form's ThreadSession (polyfills/events/codex/src/threads.ts)
// with OpenCode's way of waking in place of `codex queue`.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Delivery, type Batch } from '../../core/src/delivery.ts';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';

/** The first line of every wake: the message lands in the conversation as input, so it says whose it is. */
export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;

/** `unreachable`: no later try can reach this session (OpenCode no longer has it). */
export type WakeResult = { ok: true } | { ok: false; why: string; unreachable?: true };
export type Wake = (session: string, text: string) => Promise<WakeResult>;

export type SessionOptions = {
    base: string;
    /** The OpenCode location (directory) the session belongs to. */
    directory: string;
    connections: Map<string, EventsConnection>;
    unavailable: () => Unavailable[];
    wake: Wake;
    log: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
};

const MIN_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60000;

export class OpenCodeSession {
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
    /** Why this session can never be woken, once OpenCode said so. Its events are still stored and readable. */
    unwakeable?: string;

    constructor(id: string, o: SessionOptions) {
        const env = o.env ?? process.env;
        this.id = id;
        this.#wake = o.wake;
        this.#log = (s) => o.log(`[${id.slice(-8)}] ${s}`);
        this.#batchMs = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
        this.#values = env.MCP_EVENTS_WAKE_VALUES === '1';
        const dir = join(o.base, 'threads', id);
        this.project = new ProjectState(o.base, `opencode session ${id}`, { dir });
        // Which location runs it: a plugin instance resumes only its own location's sessions.
        writeFileSync(join(dir, 'location.json'), JSON.stringify({ directory: o.directory }) + '\n', { mode: 0o600 });
        this.spool = new Spool(o.base, id);
        // OpenCode shows the plugin the person's own messages (the `prompt` hook), so past the hour's
        // wakes the pause lasts until they write, as in Claude Code.
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'));
        if (this.budget.noticeHanded) this.budget.pause();
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: id, log: this.#log, env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
        this.#tools = createTools(() => [...o.connections.values()], o.unavailable, this.manager);
        this.spool.onAppend = (rec) => {
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
            this.#delivery = new Delivery(this.spool, { values: this.#values });
            // A batch handed to OpenCode by a process that ended before it heard back: it may have been
            // admitted, so it counts as handed over and as a wake (at most once).
            const handed = this.budget.handed;
            if (handed) {
                this.#delivery.ack(handed.upto);
                this.budget.woke(handed.watches);
                this.#log('a batch handed to OpenCode by a process that ended before it heard back counts as handed over');
            }
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        return this.#tools.call(name, input).then((answer) => {
            if (name === 'list_watches' && this.unwakeable) return { ...answer, text: `${answer.text}\n\nThis session can't be woken (${this.unwakeable}). Its watches still store every event: recent_events and get_event read them.` };
            if (name === 'list_watches' && this.lastWakeError) return { ...answer, text: `${answer.text}\n\nWaking this session failed the last time it was tried (${this.lastWakeError}); it is tried again.` };
            return answer;
        });
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

    async #send(text: string): Promise<WakeResult> {
        const r = await this.#wake(this.id, text);
        if (r.ok) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
        } else if (r.unreachable) {
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
                // The events stay where they are; the session is told, once, that waking has stopped.
                this.budget.handNotice();
                const r = await this.#send([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'));
                if (r.ok) {
                    this.budget.pause();
                    return;
                }
                this.budget.dropNotice();
                if (!r.unreachable) again = this.#retryMs;
                return;
            }
            // Write-ahead: recorded as handed over before OpenCode is asked to admit it.
            if (!this.budget.handBatch(batch.watches, batch.upto)) {
                this.#log('the hand-over could not be recorded; the session is not woken until it can be');
                again = Math.max(MIN_RETRY_MS, this.#retryMs);
                return;
            }
            const r = await this.#send([WAKE_HEADER, ...batch.lines].join('\n'));
            if (!r.ok) {
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
