// One Hermes session as this helper serves it: its watches, its events, and waking it.
//
// A watch belongs to the session whose tool call made it. Hermes names a session by its
// session key (the TUI's and Desktop's durable `ses_…`-style id, or a messaging chat's
// routing key); the plugin passes it with every call. On disk a session is a folder named
// by a digest of its key: <state>/watch-sessions/<id>/ (its watches, and which process
// runs them, with the key in session.json) and <state>/sessions/<id>/ (its events, how
// far they were handed over, and the wake count).
//
// Every event is on disk before it is acknowledged to its server. Then, at most as often
// as the wake gate allows (core/src/wake.ts), the new events are handed to the session:
// the plugin calls ctx.inject_message(text, session_key=…), which starts a turn in an idle
// session and queues behind a busy one. The hand-over is recorded before the plugin is
// asked; a wake Hermes said it did not take is tried again later. One this helper never
// heard back about (the plugin did not answer) counts as handed over and as a wake: a stored
// event is handed over at most once, and the hourly cap holds across restarts.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { Delivery, type Batch } from '../../core/src/delivery.ts';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';

/** The first line of every wake: the message lands in the conversation as the user's input, so it says whose it is. */
export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;

/** A watch's id, as the shared client makes them. */
const WATCH_ID = /^w-[0-9a-f]{6}$/;
/** The plugin's own part of a wake line: the event ids and the watch (core/src/format.ts). */
const IDS_AND_WATCH = /\[(?:event|events) (e\d+(?:, e\d+)*(?: and \d+ more)?); watch (w-[0-9a-f]{6}); /g;
const NOTICE_OF = /^\[mcp-events\] Watch (w-[0-9a-f]{6}) /;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A wake line with nothing a server wrote in it. The shared client's lines name the event type and,
 * in a notice, can quote what the server said; a Hermes wake reaches the model as the user's
 * message, not as a tool result, so here each line is written again from the plugin's own data:
 * the watch id, the server's name from Hermes's config, the event ids, and the note the user
 * approved with the watch. What the server sent is read with get_event and recent_events.
 */
export function plainWake(line: string, watches: ReadonlyMap<string, { server: string; note?: string }>): string {
    const found = [...line.matchAll(IDS_AND_WATCH)].at(-1);
    if (found) {
        const [, ids, id] = found;
        const w = watches.get(id!);
        const where = w ? ` (MCP server ${JSON.stringify(w.server.replace(HIDDEN, ''))})` : '';
        const note = w?.note ? ` Note saved with this watch: ${JSON.stringify(w.note.replace(HIDDEN, ' ').slice(0, 160))}.` : '';
        const one = !ids!.includes(',') && !ids!.includes(' more');
        return `${LINE_PREFIX} Watch ${id}${where}: new event${one ? '' : 's'} ${ids}; ${one ? `get_event ${ids} returns it` : 'get_event returns one, recent_events lists them'}.${note}`;
    }
    const notice = NOTICE_OF.exec(line);
    if (notice && WATCH_ID.test(notice[1]!)) return `${LINE_PREFIX} There is a notice about watch ${notice[1]}: recent_events shows it, and list_watches its state.`;
    if (/^\[mcp-events\] …and \d+ more notices; recent_events lists them\.$/.test(line)) return line;
    return `${LINE_PREFIX} There is a notice about your watches: recent_events shows it.`;
}

/**
 * What came of asking Hermes to take a message. `ok`: it accepted it (an idle session starts a
 * turn, a busy one runs it next). `maybe`: no answer, so it may have been taken; counted as handed
 * over. Otherwise it was refused, with Hermes's reason where the plugin knows it.
 */
export type WakeResult = { ok: true } | { ok: false; why: string; maybe?: true };
export type Wake = (key: string, text: string) => Promise<WakeResult>;

export type SessionOptions = {
    base: string;
    connections: Map<string, EventsConnection>;
    unavailable: () => Unavailable[];
    wake: Wake;
    log: (s: string) => void;
    env: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
    /** How long the pause past the hour's wakes lasts when the person never writes. Default an hour. */
    liftAfterMs?: number;
};

const PAUSE_LIFTS_AFTER_MS = 3600 * 1000;
const MIN_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60000;

/** The folder name of a session: a digest of its key, so any key is a safe name and two keys never share one. */
export function sessionId(key: string): string {
    return 'h' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export const watchesDir = (base: string, id: string) => join(base, 'watch-sessions', id);

/** The key a saved session folder belongs to, or undefined. */
export function savedKey(base: string, id: string): string | undefined {
    try {
        const j = JSON.parse(readFileSync(join(watchesDir(base, id), 'session.json'), 'utf8')) as { key?: unknown };
        return typeof j.key === 'string' && sessionId(j.key) === id ? j.key : undefined;
    } catch {
        return undefined;
    }
}

export class HermesSession {
    readonly key: string;
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

    constructor(key: string, o: SessionOptions) {
        this.key = key;
        this.id = sessionId(key);
        this.#wake = o.wake;
        this.#log = (s) => o.log(`[${this.id.slice(1, 9)}] ${s}`);
        this.#batchMs = Number(o.env.MCP_EVENTS_BATCH_MS ?? 1000);
        // Payload fields in the wake (MCP_EVENTS_WAKE_VALUES) would put the server's words in a user
        // message; the Hermes form never does.
        this.#values = false;
        const dir = watchesDir(o.base, this.id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, 'session.json'), JSON.stringify({ key }) + '\n', { mode: 0o600 });
        this.project = new ProjectState(o.base, `hermes session ${this.id}`, { dir });
        this.spool = new Spool(o.base, this.id);
        // Kept with its events, so a helper that restarts carries on counting. Past the hour's wakes the
        // pause lifts when the person next writes (the plugin's pre_llm_call hook says so), or after an hour.
        this.budget = new WakeBudget(wakeLimits(o.env), join(this.spool.dir, 'wakes.json'), { liftAfterMs: o.liftAfterMs ?? PAUSE_LIFTS_AFTER_MS });
        if (this.budget.noticeHanded) this.budget.pause();
        this.manager = new WatchManager({ connections: o.connections, project: this.project, spool: this.spool, session: this.id, log: this.#log, env: o.env, connectTimeoutMs: o.connectTimeoutMs, redact: secrets });
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
            // A batch handed to Hermes by a helper that ended before it heard back: it may have woken
            // the session, so it counts as handed over and as a wake, and is never handed over again.
            const handed = this.budget.handed;
            if (handed) {
                this.#delivery.ack(handed.upto);
                this.budget.woke(handed.watches);
                this.#log('a batch handed over by a helper that ended before it heard back counts as handed over');
            }
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    async call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        const answer = await this.#tools.call(name, input);
        if (name === 'list_watches' && this.lastWakeError) return { ...answer, text: `${answer.text}\n\nWaking this session failed the last time it was tried (${this.lastWakeError}); it is tried again, and when the user next writes here.` };
        return answer;
    }

    /** The person wrote to the session: waking starts again if it had stopped at its hourly limit, and what waits is handed over. */
    spoke(): void {
        if (this.budget.spoke()) this.#log('the user is back: waking starts again');
        this.#retryMs = 0;
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
        let r: WakeResult;
        try {
            r = await this.#wake(this.key, text);
        } catch (e) {
            r = { ok: false, why: e instanceof Error ? e.message : String(e), maybe: true };
        }
        if (r.ok) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
        } else if (r.maybe) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
            this.#log(`${r.why}; Hermes may have taken the message, so it counts as handed over`);
        } else {
            this.lastWakeError = r.why;
            this.#retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, this.#retryMs * 2));
            this.#log(`waking the session failed: ${r.why}; trying again in ${Math.round(this.#retryMs / 1000)} s`);
        }
        return r;
    }

    async #handOver(): Promise<void> {
        if (this.#waking || this.#stopped) return;
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
                if (r.ok || r.maybe) {
                    this.budget.pause();
                    return;
                }
                this.budget.dropNotice();
                again = this.#retryMs;
                return;
            }
            // Write-ahead: recorded as handed over before Hermes is asked. Not recorded, not handed over.
            if (!this.budget.handBatch(batch.watches, batch.upto)) {
                this.#log('the hand-over could not be recorded; the session is not woken until it can be');
                again = Math.max(MIN_RETRY_MS, this.#retryMs);
                return;
            }
            const watches = new Map(this.manager.watches.map((w) => [w.id, { server: w.server, note: w.note }]));
            const r = await this.#send([WAKE_HEADER, ...batch.lines.map((l) => plainWake(l, watches))].join('\n'));
            if (!r.ok && !r.maybe) {
                this.budget.dropHanded();
                again = this.#retryMs;
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
