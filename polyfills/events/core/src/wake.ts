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

import { readFileSync, writeFileSync } from 'node:fs';
import { LINE_PREFIX } from './format.ts';
import { host } from './host.ts';

const HOUR_MS = 3600 * 1000;

export type Gate =
    /** Wake now. */
    | { kind: 'go' }
    /** Not yet: look again in `ms`. */
    | { kind: 'wait'; ms: number }
    /** The hour's wakes are spent: say so, once. */
    | { kind: 'notice' }
    /** Said already: nothing until the person speaks. */
    | { kind: 'paused' };

type Saved = { last?: Record<string, number>; wakes?: number[]; paused?: boolean; noticeHanded?: boolean };

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

    /** `file`: where the count is kept, so a helper that restarts does not start the hour again. */
    constructor(limits: { gapMs: number; perHour: number }, file?: string) {
        this.gapMs = limits.gapMs;
        this.perHour = limits.perHour;
        this.#file = file;
        if (!file) return;
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
            for (const [k, v] of Object.entries(saved.last ?? {})) if (typeof v === 'number') this.#last.set(k, v);
            this.#wakes = (saved.wakes ?? []).filter((t) => typeof t === 'number');
            this.#paused = saved.paused === true;
            this.#noticeHanded = saved.noticeHanded === true;
        } catch {
            // nothing kept yet
        }
    }

    get paused(): boolean {
        return this.#paused;
    }

    /** Whether the notice was handed over and not yet acknowledged (by this helper or an earlier one). */
    get noticeHanded(): boolean {
        return this.#noticeHanded;
    }

    #save(): void {
        if (!this.#file) return;
        try {
            writeFileSync(this.#file, JSON.stringify({ last: Object.fromEntries(this.#last), wakes: this.#wakes, paused: this.#paused, noticeHanded: this.#noticeHanded } satisfies Saved), { mode: 0o600 });
        } catch {
            // counted in memory all the same
        }
    }

    /** Whether events waiting for these watches may wake the session now. */
    gate(watches: string[], now = Date.now()): Gate {
        if (this.#paused) return { kind: 'paused' };
        // A wake starts when any one of the watches is due; what waits for the others goes with it.
        const waits = watches.map((w) => Math.max(0, (this.#last.get(w) ?? -Infinity) + this.gapMs - now));
        const wait = waits.length ? Math.min(...waits) : 0;
        if (wait > 0) return { kind: 'wait', ms: wait };
        this.#wakes = this.#wakes.filter((t) => now - t < HOUR_MS);
        if (this.perHour > 0 && this.#wakes.length >= this.perHour) return { kind: 'notice' };
        return { kind: 'go' };
    }

    /** The session was woken with events of these watches. */
    woke(watches: string[], now = Date.now()): void {
        for (const w of watches) this.#last.set(w, now);
        this.#wakes.push(now);
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
    pause(): void {
        this.#paused = true;
        this.#noticeHanded = false;
        this.#save();
    }

    /** The person sent a message of their own: the hour starts again. Returns whether waking had been stopped. */
    spoke(): boolean {
        const was = this.#paused;
        if (!was && !this.#wakes.length) return false;
        this.#paused = false;
        this.#wakes = [];
        this.#save();
        return was;
    }

    /** What the session is told, once, when the hour's wakes are spent. */
    notice(waiting: number): string {
        return `${LINE_PREFIX} This session has been woken by events ${this.perHour} times in the last hour, so the mcp-events ${host.kind} has stopped waking it. ${waiting} event${waiting === 1 ? ' is' : 's are'} waiting, and more may arrive: recent_events lists them. Nothing is lost. ${host.resumeWaking}`;
    }
}
