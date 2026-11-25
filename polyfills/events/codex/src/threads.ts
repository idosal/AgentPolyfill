// One Codex session (a thread) as this helper serves it: its watches, its events,
// and waking it.
//
// A watch belongs to the thread whose tools/call made it (Codex's `_meta.threadId`).
// Its state is the thread's: <state>/threads/<id>/ (watches, and which process runs
// them) and <state>/sessions/<id>/ (the thread's events, how far they were handed
// over, and the wake count). One process runs a thread's watches; a second one (the
// same session open twice) only lists them, and takes over if the first goes. Only the
// one running them writes the wake count; one taking over reads it again first.
//
// Every event is on disk before it is acknowledged to its server. Then, at most as
// often as the wake gate allows (wake.ts), the new events are handed to the thread
// with `codex queue` (waker.ts). The hand-over is recorded before `codex queue` runs,
// and a wake Codex said it did not take is tried again. One this process never heard
// back about (it ended, or `codex queue` timed out) counts as handed over and as a
// wake: a stored event is handed over at most once, and the hourly cap holds across
// restarts and takeovers. Such an event may go unannounced; it is still stored, for
// recent_events.
//
// A session is woken only while the plugin can tell that the app showing it shows a turn the wake
// starts (meta.ts, shownBy): `codex queue` runs it in whichever app server has the session open, and
// an app that runs Codex through an app server of its own may not show a turn it didn't start. Each
// call that says so is recorded in <state>/threads/<id>/shown-by.json, by any process; the latest
// one wins, and the one running the watches reads it before each hand-over. Until it says Codex's
// own app, events are stored and nothing is handed over.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventsConnection } from '../../core/src/events-client.ts';
import { Delivery, type Batch } from '../../core/src/delivery.ts';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { ProjectState, Spool, writeAtomic } from '../../core/src/store.ts';
import { createTools, type ToolAnswer, type Unavailable } from '../../core/src/tools.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import type { ShownBy } from './meta.ts';
import type { QueueResult, Wake } from './waker.ts';

/** The first line of every wake: the message lands in the conversation as input, so it says whose it is. */
export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;

/** Why a session isn't woken, while no call has said that Codex's own app shows it. */
export function notShown(by: ShownBy | undefined): string {
    return (
        (by === 'unmarked'
            ? "This session isn't woken by events: the last of its turns that called the plugin wasn't one you started in Codex's own app (it named nothing that started it, or something the plugin doesn't count, such as a goal or an automation), so the plugin can't tell that the app this session is open in shows a turn that a wake starts. "
            : "This session isn't woken by events yet: no turn you started in Codex's own app has called the plugin. ") +
        "Codex's TUI and the ChatGPT desktop app say what started each turn (Codex 0.172 or newer). An app that runs Codex through an app server of its own (T3 Code, say) doesn't, and codex queue would run the wake inside that app, which may not show it. " +
        "The watches still store every event: recent_events and get_event read them. Waking starts again once a turn you start in Codex's own app (the TUI, the desktop app, codex exec, or by voice) calls one of the plugin's tools."
    );
}

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
    /** What the session is called in the store's claim (another host that runs this class names its own). Default "codex thread". */
    label?: string;
    /** What hands the message over, in the log. Default "codex queue". */
    wakeName?: string;
    /**
     * The host shows a turn a wake starts, whatever app the session is open in (Copilot: its own
     * session.send, with a turn id VS Code shows). Then no call has to say so first, and the shown
     * gate below never holds a wake. Default false: Codex's rule (meta.ts, shownBy) applies.
     */
    hostShowsWakes?: boolean;
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
    readonly #wakeName: string;
    readonly #hostShowsWakes: boolean;
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
     * What the last `codex queue` that didn't answer (it timed out) carried, until one answers: a
     * batch, counted as handed over and not tried again, or the notice, counted as given.
     */
    #unanswered: 'batch' | 'notice' | undefined;
    /**
     * Why this session can never be woken, once `codex queue` has said so (a ChatGPT desktop-app chat,
     * which is not a local Codex session). Its events are still stored and readable; it is not tried again.
     */
    unwakeable?: string;
    /** Where the latest call that said which app shows this session left it (shown-by.json); written by any process. */
    readonly #shownFile: string;
    /** Whether the log has said that waking waits for Codex's own app, since it last changed. */
    #heldLogged = false;

    constructor(id: string, o: ThreadOptions) {
        const env = o.env ?? process.env;
        this.id = id;
        this.#wake = o.wake;
        this.#log = (s) => o.log(`[${id.slice(0, 8)}] ${s}`);
        this.#batchMs = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
        this.#wakeName = o.wakeName ?? 'codex queue';
        this.#hostShowsWakes = o.hostShowsWakes === true;
        this.#values = env.MCP_EVENTS_WAKE_VALUES === '1';
        this.project = new ProjectState(o.base, `${o.label ?? 'codex thread'} ${id}`, { dir: join(o.base, 'threads', id) });
        this.spool = new Spool(o.base, id);
        this.#shownFile = join(this.project.dir, 'shown-by.json');
        // How often events may wake this session. Kept with its events, so a helper that restarts carries on counting.
        // Past the hour's wakes the pause lifts when the person's own turn calls a tool, or by itself
        // after an hour: Codex shows the plugin the person only through a call's turn metadata.
        // Only the process that runs the watches writes it: start() reads it again when this one does.
        this.budget = new WakeBudget(wakeLimits(env), join(this.spool.dir, 'wakes.json'), { liftAfterMs: o.liftAfterMs ?? PAUSE_LIFTS_AFTER_MS });
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
            // The wake count as the process that ran them before left it: what this process read when it
            // first saw the session (a second window, say) may be out of date by now.
            this.budget.reload();
            // A notice handed to `codex queue` by a helper that stopped before it heard back counts as given.
            if (this.budget.noticeHanded) this.budget.pause();
            // Where the hand-over stands, as that process left it.
            this.#delivery = new Delivery(this.spool, { values: this.#values });
            // A batch that process handed to `codex queue` and ended before it heard back about: it may
            // have woken the session, so it counts as handed over and as a wake (at most once), and is
            // never handed over again.
            const handed = this.budget.handed;
            if (handed) {
                this.#delivery.ack(handed.upto);
                this.budget.woke(handed.watches);
                this.#log(`a batch handed to ${this.#wakeName} by a helper that ended before it heard back counts as handed over`);
            }
            if (this.manager.watches.length) this.#log(`runs ${this.manager.watches.length} watch(es)`);
            if (this.#delivery.pending) this.announce();
        }
        return owner;
    }

    /** Whether a wake would be seen: the host always shows one, or a call said Codex's own app shows this session. */
    #shows(): boolean {
        return this.#hostShowsWakes || this.shownBy === 'codex';
    }

    /** Which app shows this session, as the latest call that said so left it (any process's). */
    get shownBy(): ShownBy | undefined {
        try {
            const by = (JSON.parse(readFileSync(this.#shownFile, 'utf8')) as { by?: unknown }).by;
            return by === 'codex' || by === 'unmarked' ? by : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * A call said which app shows this session (meta.ts, shownBy), or, with `undefined`, nothing about
     * it. Recorded for every process; once it is Codex's own app, events that waited are handed over.
     */
    shown(by: ShownBy | undefined): void {
        if (!by || this.shownBy === by) return;
        try {
            writeAtomic(this.#shownFile, JSON.stringify({ by, at: new Date().toISOString() }) + '\n');
        } catch {
            // Not saved: this call counts for nothing, and waking stays as it was.
            return;
        }
        this.#heldLogged = false;
        this.#log(by === 'codex' ? "a turn the user started in Codex's own app called the plugin: the session may be woken" : "a turn the user didn't start in Codex's own app called the plugin (no trigger, as from another app's app server or a Codex before 0.172, or one not counted): the session isn't woken");
        if (by === 'codex' && this.manager.owner && this.#delivery?.pending) this.announce();
    }

    /** Another process's call may have said, since a hand-over was held, that Codex's own app shows the session. */
    recheck(): void {
        if (this.#heldLogged && this.manager.owner && this.#delivery?.pending && this.shownBy === 'codex') this.announce();
    }

    async call(name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
        const answer = await this.#tools.call(name, input);
        const held = !this.unwakeable && !this.#shows();
        if ((name === 'list_watches' || name === 'watch_event') && !answer.isError && held) return { ...answer, text: `${answer.text}\n\n${notShown(this.shownBy)}` };
        if (name === 'list_watches' && this.unwakeable) return { ...answer, text: `${answer.text}\n\nThis chat can't be woken: it isn't a local Codex session, which is all codex queue reaches (a ChatGPT desktop-app chat, say). Its watches still store every event: recent_events and get_event read them. Waking works in the Codex TUI.` };
        if (name === 'list_watches' && this.lastWakeError && this.#unanswered === 'batch')
            return { ...answer, text: `${answer.text}\n\nThe last wake's ${this.#wakeName} did not answer (${this.lastWakeError}), so it may not have woken this session. Its events count as handed over and are not handed over again; recent_events lists them.` };
        if (name === 'list_watches' && this.lastWakeError && this.#unanswered === 'notice')
            return { ...answer, text: `${answer.text}\n\nThe ${this.#wakeName} that was to tell this session that waking had stopped did not answer (${this.lastWakeError}), so the session may not have been told. Waking stays paused; the events that wait are stored, handed over once the pause ends, and recent_events lists them.` };
        if (name === 'list_watches' && this.lastWakeError) return { ...answer, text: `${answer.text}\n\nWaking this session failed the last time it was tried (${this.lastWakeError}); it is tried again.` };
        return answer;
    }

    /**
     * The person wrote to the session: if waking had stopped at its hourly limit, it starts again. Only
     * in the process that runs the watches: another (the same session open in a second window) holds
     * a count it read earlier, and saving that would undo what the one running them has saved since,
     * a hand-over's record among it.
     */
    spoke(): void {
        if (!this.manager.owner) {
            this.#log("the user wrote in a window that doesn't run this session's watches; the pause, if any, is left to the one that does");
            return;
        }
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

    async #queue(text: string, carries: 'batch' | 'notice'): Promise<QueueResult> {
        const r = await this.#wake(this.id, text);
        this.#unanswered = undefined;
        if (r.ok) {
            this.lastWakeError = undefined;
            this.#retryMs = 0;
            if (!r.resumed) this.#log(`${this.#wakeName} took the message but could not resume the session; it runs when the session is next opened`);
        } else if (r.maybe) {
            // It may have queued the message: a batch counts as handed over, never handed over again;
            // the notice counts as given. list_watches says so, as it may not have reached the session.
            this.lastWakeError = r.why;
            this.#unanswered = carries;
            this.#retryMs = 0;
            this.#log(`${r.why}; it may have queued the message, so it counts as ${carries === 'batch' ? 'handed over' : 'given (waking stays paused)'}`);
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
            // No call has said that Codex's own app shows this session: a wake could run where nobody
            // sees it. The events wait, stored, and no wake is counted; a call that says so starts it.
            const by = this.shownBy;
            if (!this.#shows()) {
                if (!this.#heldLogged) this.#log(`not waking the session: ${by === 'unmarked' ? "the last of its turns that called the plugin wasn't one the user started in Codex's own app" : "no turn the user started in Codex's own app has called the plugin yet"}; the events are stored`);
                this.#heldLogged = true;
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
                const r = await this.#queue([WAKE_HEADER, this.budget.notice(batch.events)].join('\n'), 'notice');
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
                this.lastWakeError = 'the hand-over could not be recorded: wakes.json could not be saved';
                this.#unanswered = undefined;
                this.#log(`${this.lastWakeError}; the session is not woken until it can be`);
                again = Math.max(MIN_RETRY_MS, this.#retryMs);
                return;
            }
            const r = await this.#queue([WAKE_HEADER, ...batch.lines].join('\n'), 'batch');
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
