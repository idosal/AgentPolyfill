// How often events may wake a session.
//
// Every wake is a turn: it costs the person's plan or API spend, and it is one
// more chance for whatever a server sent to be acted on. A server decides how
// often its events come, so the mod decides how often they wake:
//
// - a watch starts a wake at most once in GAP (a minute). Events that come
//   sooner wait, and are handed over together when the time is up;
// - a session is woken at most PER_HOUR (30) times in an hour. When the next
//   wake would pass that, the session is told once that events are waiting, and
//   is not woken again until the person sends a message of their own.
//
// Nothing is dropped: events stay in the session's store, where recent_events
// and get_event read them. MCP_EVENTS_WAKE_GAP_S and MCP_EVENTS_WAKES_PER_HOUR
// change the two numbers; 0 turns either off.

import { readFileSync } from 'node:fs';
import { LINE_PREFIX } from './format.ts';
import { host } from './host.ts';
import { writeAtomic } from './store.ts';

const HOUR_MS = 3600 * 1000;

export type Gate =
    /** Wake now. */
    | { kind: 'go' }
    /** Not yet: look again in `ms`. */
    | { kind: 'wait'; ms: number }
    /** The hour's wakes are spent: say so, once. */
    | { kind: 'notice' }
    /** Said already: nothing until the person speaks (or, where the pause lifts by itself, for `ms`). */
    | { kind: 'paused'; ms?: number };

/** A batch handed to the host and not yet counted: its watches, and where it ends in the session's store. */
export type Handed = { watches: string[]; upto: number };

type Saved = { last?: Record<string, number>; wakes?: number[]; paused?: boolean; pausedAt?: number; noticeHanded?: boolean; handed?: Handed };

export function wakeLimits(env: NodeJS.ProcessEnv): { gapMs: number; perHour: number } {
    const num = (v: string | undefined, fallback: number) => {
        const n = Number(v);
        return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return { gapMs: num(env.MCP_EVENTS_WAKE_GAP_S, 60) * 1000, perHour: Math.floor(num(env.MCP_EVENTS_WAKES_PER_HOUR, 30)) };
}

export class WakeBudget {
    readonly gapMs: number;
    readonly perHour: number;
    readonly #file?: string;
    /** When each watch last started (or was part of) a wake. */
    #last = new Map<string, number>();
    /** When this session was woken, within the last hour. */
    #wakes: number[] = [];
    #paused = false;
    /**
     * The notice was handed over and its acknowledgement not yet heard. Kept on disk: a helper that
     * restarted between the submit and the ack is told of it by the hooks module, as of a batch,
     * and needs to know that what it is told of is the notice. Once Claude Code took the notice it
     * counts as given, whenever its ack comes, as it does for the helper that handed it over.
     */
    #noticeHanded = false;
    /**
     * How long the pause lasts when nobody speaks, where it lifts by itself (Codex, where the person
     * can be seen only through the turn metadata of a tool call). Unset: until the person speaks.
     */
    readonly #liftAfterMs?: number;
    /** When waking stopped, for a pause that lifts by itself. */
    #pausedAt?: number;
    /**
     * A batch handed to the host and not yet counted, recorded before the host is asked (Codex's
     * `codex queue`): a helper that ends before it hears back leaves it here, and the next one counts
     * it instead of handing the batch over again. The Claude Code mod does not use it (its hooks
     * module says which batch it submitted).
     */
    #handed?: Handed;

    /**
     * `file`: where the count is kept, so a helper that restarts does not start the hour again.
     * `o.liftAfterMs`: the pause also lifts by itself after this long.
     */
    constructor(limits: { gapMs: number; perHour: number }, file?: string, o: { liftAfterMs?: number } = {}) {
        this.gapMs = limits.gapMs;
        this.perHour = limits.perHour;
        this.#file = file;
        this.#liftAfterMs = typeof o.liftAfterMs === 'number' && o.liftAfterMs > 0 ? o.liftAfterMs : undefined;
        this.reload();
    }

    /**
     * Reads the count as last saved, in place of what this one holds: the constructor's read. A
     * process that takes a session over from one that ended calls it, since what it read when it first
     * saw the session may since have been changed by the one that ran it (Codex, two windows).
     */
    reload(): void {
        this.#last = new Map();
        this.#wakes = [];
        this.#paused = false;
        this.#pausedAt = undefined;
        this.#noticeHanded = false;
        this.#handed = undefined;
        if (!this.#file) return;
        try {
            const saved = JSON.parse(readFileSync(this.#file, 'utf8')) as Saved;
            for (const [k, v] of Object.entries(saved.last ?? {})) if (typeof v === 'number') this.#last.set(k, v);
            this.#wakes = (saved.wakes ?? []).filter((t) => typeof t === 'number');
            this.#paused = saved.paused === true;
            if (typeof saved.pausedAt === 'number') this.#pausedAt = saved.pausedAt;
            this.#noticeHanded = saved.noticeHanded === true;
            const h = saved.handed;
            if (h && Array.isArray(h.watches) && typeof h.upto === 'number') this.#handed = { watches: h.watches.filter((w) => typeof w === 'string'), upto: h.upto };
        } catch {
            // nothing kept yet
        }
    }

    /** The batch handed to the host and not yet counted, if a helper ended before it heard back. */
    get handed(): Handed | undefined {
        return this.#handed;
    }

    get paused(): boolean {
        return this.#paused;
    }

    /** Whether the notice was handed over and not yet acknowledged (by this helper or an earlier one). */
    get noticeHanded(): boolean {
        return this.#noticeHanded;
    }

    /**
     * Saves the count whole (writeAtomic: written in full and flushed beside the file, then put in its
     * place), so a crash leaves the old file or the new one, never half of one (which would read as
     * nothing kept, and lose a hand-over's record). Returns whether it was saved.
     */
    #save(): boolean {
        if (!this.#file) return true;
        try {
            writeAtomic(this.#file, JSON.stringify({ last: Object.fromEntries(this.#last), wakes: this.#wakes, paused: this.#paused, pausedAt: this.#pausedAt, noticeHanded: this.#noticeHanded, handed: this.#handed } satisfies Saved));
            return true;
        } catch {
            // counted in memory all the same
            return false;
        }
    }

    /** Whether events waiting for these watches may wake the session now. */
    gate(watches: string[], now = Date.now()): Gate {
        if (this.#paused) {
            if (this.#liftAfterMs === undefined) return { kind: 'paused' };
            // A pause kept from before it could lift by itself counts from now.
            if (this.#pausedAt === undefined) {
                this.#pausedAt = now;
                this.#save();
            }
            const left = this.#pausedAt + this.#liftAfterMs - now;
            if (left > 0) return { kind: 'paused', ms: left };
            // Nobody spoke for the whole of it: the hour starts again, as it does when someone does.
            this.#paused = false;
            this.#pausedAt = undefined;
            this.#wakes = [];
            this.#save();
        }
        // A wake starts when any one of the watches is due; what waits for the others goes with it.
        const waits = watches.map((w) => Math.max(0, (this.#last.get(w) ?? -Infinity) + this.gapMs - now));
        const wait = waits.length ? Math.min(...waits) : 0;
        if (wait > 0) return { kind: 'wait', ms: wait };
        this.#wakes = this.#wakes.filter((t) => now - t < HOUR_MS);
        if (this.perHour > 0 && this.#wakes.length >= this.perHour) return { kind: 'notice' };
        return { kind: 'go' };
    }

    /**
     * A batch of these watches is about to be handed to the host, which may wake the session before
     * this process hears back: recorded first, on disk. Returns whether it was recorded; if not, the
     * batch must not be handed over now.
     */
    handBatch(watches: string[], upto: number): boolean {
        this.#handed = { watches: [...watches], upto };
        if (this.#save()) return true;
        // Not on disk, so not handed over: a later save must not write it either.
        this.#handed = undefined;
        return false;
    }

    /** The host said it did not take the batch: nothing was handed over after all. */
    dropHanded(): void {
        if (!this.#handed) return;
        this.#handed = undefined;
        this.#save();
    }

    /**
     * The host said it did not take the notice (Codex's `codex queue` failed): it was not handed over,
     * so a helper that starts later does not start paused by a notice the session was never shown.
     */
    dropNotice(): void {
        if (!this.#noticeHanded) return;
        this.#noticeHanded = false;
        this.#save();
    }

    /** The session was woken with events of these watches. It counts the batch recorded by handBatch, if any, in the same write. */
    woke(watches: string[], now = Date.now()): void {
        for (const w of watches) this.#last.set(w, now);
        this.#wakes.push(now);
        this.#handed = undefined;
        // A notice handed over before, and never acknowledged, was never shown.
        this.#noticeHanded = false;
        // Watches come and go: forget the ones not heard from for an hour.
        for (const [w, t] of this.#last) if (now - t > HOUR_MS) this.#last.delete(w);
        this.#save();
    }

    /** The notice is being handed over; it counts as given once its acknowledgement comes. */
    handNotice(): void {
        if (this.#noticeHanded) return;
        this.#noticeHanded = true;
        this.#save();
    }

    /** The session was told that waking has stopped. */
    pause(now = Date.now()): void {
        this.#paused = true;
        this.#noticeHanded = false;
        if (this.#liftAfterMs !== undefined) this.#pausedAt = now;
        this.#save();
    }

    /** The person sent a message of their own: the hour starts again. Returns whether waking had been stopped. */
    spoke(): boolean {
        const was = this.#paused;
        if (!was && !this.#wakes.length) return false;
        this.#paused = false;
        this.#pausedAt = undefined;
        this.#wakes = [];
        this.#save();
        return was;
    }

    /** What the session is told, once, when the hour's wakes are spent. */
    notice(waiting: number): string {
        return `${LINE_PREFIX} This session has been woken by events ${this.perHour} times in the last hour, so the mcp-events ${host.kind} has stopped waking it. ${waiting} event${waiting === 1 ? ' is' : 's are'} waiting, and more may arrive: recent_events lists them. Nothing is lost. ${host.resumeWaking}`;
    }
}
