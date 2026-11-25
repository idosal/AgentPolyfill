// What Codex says about a tools/call in its `_meta`: which session it is from, and
// what started the turn it is made in.

import { THREAD_ID } from './waker.ts';

type Json = Record<string, unknown>;

/** Which session a call is from: Codex puts it in every tools/call (`threadId`, and the turn metadata's `thread_id`). */
export function threadOf(meta: Json): string | undefined {
    const turn = meta['x-codex-turn-metadata'] as Json | undefined;
    const id = typeof meta.threadId === 'string' ? meta.threadId : typeof turn?.thread_id === 'string' ? turn.thread_id : undefined;
    return id && THREAD_ID.test(id) ? id.toLowerCase() : undefined;
}

/**
 * The turn triggers that mean the person started the turn, as Codex 0.172 sends them: "user" for
 * what is typed in the TUI, "exec" for a `codex exec` run, "realtime" for voice ("voice" too, in
 * case a client names it so). Nothing else counts: a turn the queue started (this plugin's wake
 * among them), a goal, an automation, a hook, a review, a trigger this list does not know, or a
 * call with no turn metadata at all (a Codex before 0.172).
 */
const THE_PERSONS = new Set(['user', 'exec', 'realtime', 'voice']);

export function isThePersons(meta: Json): boolean {
    const trigger = triggerOf(meta);
    return typeof trigger === 'string' && THE_PERSONS.has(trigger);
}

const triggerOf = (meta: Json): unknown => {
    const turn = meta['x-codex-turn-metadata'];
    return typeof turn === 'object' && turn !== null ? (turn as { turn_trigger?: unknown }).turn_trigger : undefined;
};

/**
 * Which app shows the session, as far as one call says. `codex queue` runs a wake in whichever app
 * server has the session open: Codex's own clients show that turn, but an app that runs
 * `codex app-server` itself (T3 Code, say) may not show a turn it did not start.
 *
 * - `codex`: a turn the person started in one of Codex's own clients (THE_PERSONS). Each of them names
 *   what started every turn (`turnTrigger` in Codex's app-server protocol: "source classification for
 *   the caller that starts this turn"), and Codex passes it on in the call's turn metadata.
 * - `unmarked`: a turn with no trigger. Its client says nothing about itself (another app's app
 *   server, or a Codex before 0.172), so the plugin can't tell that a wake would be shown.
 * - `undefined`: a turn something else started (the queue, a goal, an automation, a trigger this list
 *   doesn't know). Codex names those itself, in any app server, so they say nothing about the app.
 */
export type ShownBy = 'codex' | 'unmarked';

export function shownBy(meta: Json): ShownBy | undefined {
    const trigger = triggerOf(meta);
    if (typeof trigger !== 'string' || trigger === '') return 'unmarked';
    return THE_PERSONS.has(trigger) ? 'codex' : undefined;
}
