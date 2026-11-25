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
 * The turn triggers that mean the person started the turn in one of Codex's own apps, each from where
 * it is set (Codex at rust-v0.172.0, and the ChatGPT desktop app as installed):
 * - "user": a prompt typed in the TUI (codex-rs/tui/src/chatwidget/input_submission.rs, the
 *   `AppCommand::user_turn` call).
 * - "composer": a message sent in the ChatGPT desktop app, its default (`turnTrigger: t.turnTrigger ??
 *   "composer"` in the app's bundle, app.asar). Read from the installed app and its rollouts, not run.
 * - "exec": a `codex exec` run (codex-rs/exec/src/lib.rs and exec/src/remote.rs).
 * - "realtime": a voice turn (codex-rs/core/src/session/realtime_handoff.rs).
 * Nothing else counts: a turn the queue started (this plugin's wake among them), a goal, an
 * automation, a hook, a review, a trigger this list does not know, or a call with no turn metadata
 * at all (a Codex before 0.172).
 */
const THE_PERSONS = new Set(['user', 'composer', 'exec', 'realtime']);

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
 * server has the session open: Codex's own apps show that turn, but an app that runs
 * `codex app-server` itself (T3 Code, say) may not show a turn it did not start.
 *
 * - `codex`: a turn the person started in one of Codex's own apps (THE_PERSONS). Each of them names
 *   what started every turn (`turnTrigger` in Codex's app-server protocol: "source classification for
 *   the caller that starts this turn"), and Codex passes it on in the call's turn metadata.
 * - `undefined`, nothing said: a turn the queue started (codex-rs/ext/queue/src/service.rs). Codex
 *   names it so in any app server, so it says nothing about the app.
 * - `unmarked`, anything else: no trigger (another app's app server, which sets none, or a Codex before
 *   0.172), or one this list doesn't count (a goal, an automation, an app that names its turns its own
 *   way). The plugin can't tell that a wake would be shown, so until the person's next turn it isn't.
 */
export type ShownBy = 'codex' | 'unmarked';

export function shownBy(meta: Json): ShownBy | undefined {
    const trigger = triggerOf(meta);
    if (trigger === 'queue') return undefined;
    return typeof trigger === 'string' && THE_PERSONS.has(trigger) ? 'codex' : 'unmarked';
}
