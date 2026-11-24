// One Pi session as this extension serves it: its watches, its events, and
// waking it.
//
// A watch belongs to the Pi session whose model asked for it (its session id).
// Its state is the session's: <state>/sessions/<id>/watches (the watches, and
// which process runs them) and <state>/sessions/<id> (its events, how far they
// were handed over, and the wake count). Resuming the session resumes its
// watches from their cursors.
//
// Every event is on disk before it is acknowledged to its server. Then, at most
// as often as the wake gate allows (core/wake.ts), the new events are handed to
// the session with `pi.sendMessage(..., { triggerTurn: true })`: Pi adds them to
// the conversation as a message of this extension's own, and starts a turn if
// the session is idle, or after the current one. The message says which watches
// have new events and their ids; the payloads stay on disk for get_event.
//
// The hand-over happens in this process, so there is no answer to wait for: what
// `sendMessage` took is marked handed over at once. If it throws (the session is
// being replaced), nothing is marked, and the events wait for the next start.

import { join } from 'node:path';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { Delivery } from '../../core/src/delivery.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { WAKE_HEADER } from './words.ts';

/** Hands a message to the session. `wake`: start a turn (now if idle, else after the current one). Throws if Pi did not take it. */
export type Send = (text: string, o: { wake: boolean }) => void;

export type SessionOptions = {
    base: string;
    connections: Map<string, EventsConnection>;
    unavailable: () => Unavailable[];
    send: Send;
    log: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
};

export class PiSession {
    readonly id: string;
    readonly project: ProjectState;
    readonly spool: Spool;
    readonly budget: WakeBudget;
    readonly manager: WatchManager;
    readonly #tools: ReturnType<typeof createTools>;
    readonly #send: Send;
    readonly #log: (s: string) => void;
    readonly #batchMs: number;
    #delivery?: Delivery;
    #timer?: NodeJS.Timeout;
    #at = 0;
    #stopped = false;
    /** Why the last hand-over failed, until one succeeds. */
    lastWakeError?: string;

    constructor(id: string, o: SessionOptions) {
        const env = o.env ?? process.env;
        this.id = id;
        this.#send = o.send;
        this.#log = (s) => o.log(`[${id.slice(0, 8)}] ${s}`);
        this.#batchMs = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
        this.project = new ProjectState(o.base, `pi session ${id}`, { dir: join(o.base, 'watches', id) });
        this.spool = new Spool(o.base, id);
        // Past the hour's wakes, waking starts again when the person writes: Pi tells the extension (the `input` event).
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'));
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: id, log: this.#log, env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
        this.#tools = createTools(() => [...o.connections.values()], o.unavailable, this.manager);
        this.spool.onAppend = (rec) => {
            const gate = this.budget.gate([String(rec.watch ?? '')]);
            if (gate.kind === 'paused') return;
            this.announce(gate.kind === 'wait' ? gate.ms + 50 : this.#batchMs);
        };
    }

    get limits(): { gapMs: number; perHour: number } {
        return { gapMs: this.budget.gapMs, perHour: this.budget.perHour };
    }

    /** Claims this session's watches and resumes them. Returns whether this process runs them. */
    start(): boolean {
        const was = this.manager.owner;
        const owner = this.manager.start();
        if (owner && !was) {
            this.#delivery = new Delivery(this.spool, { values: process.env.MCP_EVENTS_WAKE_VALUES === '1' });
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    instructions(): string {
        return this.#tools.instructions();
    }

    call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        return this.#tools.call(name, input);
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
            this.#handOver();
        }, afterMs);
        this.#timer.unref?.();
    }

    #handOver(): void {
        if (this.#stopped || !this.manager.owner || !this.#delivery) return;
        const delivery = this.#delivery;
        let again: number | undefined;
        try {
            const batch = delivery.take();
            if (!batch) return;
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
                // Said once, without starting a turn: the model sees it with the person's next message.
                this.#send([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'), { wake: false });
                this.budget.pause();
                return;
            }
            this.#send([WAKE_HEADER, ...batch.lines].join('\n'), { wake: true });
            delivery.ack(batch.upto);
            this.budget.woke(batch.watches);
            this.lastWakeError = undefined;
            if (delivery.pending) again = this.#batchMs;
        } catch (e) {
            this.lastWakeError = e instanceof Error ? e.message : String(e);
            this.#log(`the events could not be handed to the session (${secrets.scrub(this.lastWakeError)}); tried again in 5 s`);
            again = 5000;
        } finally {
            if (again !== undefined) this.announce(again);
        }
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        clearTimeout(this.#timer);
        await this.manager.stop();
    }
}
