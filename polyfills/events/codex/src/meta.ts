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
 * Whether the turn a call is made in was started by the person: typed in Codex ("user" in 0.172),
 * a `codex exec` run, or voice. A turn started from the queue (this plugin's wake among them),
 * a goal, an automation or a review is not. With no turn metadata at all (an older Codex) a
 * call is taken to be the person's.
 */
export function isThePersons(meta: Json): boolean {
    const turn = meta['x-codex-turn-metadata'];
    if (typeof turn !== 'object' || turn === null) return true;
    const trigger = (turn as { turn_trigger?: unknown }).turn_trigger;
    if (typeof trigger !== 'string') return true;
    return !/^(queue|goal|daemon_recovery|memory_consolidation|guardian_review|automation.*|subagent.*)$/.test(trigger);
}
