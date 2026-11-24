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
    const turn = meta['x-codex-turn-metadata'];
    if (typeof turn !== 'object' || turn === null) return false;
    const trigger = (turn as { turn_trigger?: unknown }).turn_trigger;
    return typeof trigger === 'string' && THE_PERSONS.has(trigger);
}
