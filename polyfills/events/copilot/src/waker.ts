// Waking a Copilot session: `session.send` from the extension, on the session it joined.
//
// The message goes in as an automation turn (`source: "automation-mcp-events"`): Copilot's SDK
// says such a turn "defines the session's task like a user message but carries no human
// authority", and the session's `user.message` event carries that source, which is how this
// extension tells a wake from the person writing. `mode: "enqueue"` puts it behind a turn
// that is running, so it never cuts in; an idle session starts a turn with it at once (seen
// live in the Copilot TUI, 1.0.115). `send` resolves once Copilot has admitted the message.
//
// Each wake also carries a `clientTurnId` of its own. VS Code's Copilot harness shows a turn an
// extension starts only when it was sent with one: without it, it counts the message as one the
// runtime injected, runs the turn, and drops everything it says (seen live in VS Code 1.147:
// "Markdown delta emitted with no active turn; dropping"). Copilot CLI shows the turn either way.
// A wake the person can see is the safer one: what an event sets in motion isn't hidden.

import { randomUUID } from 'node:crypto';
import type { QueueResult } from '../../codex/src/waker.ts';

export const WAKE_SOURCE = 'automation-mcp-events';

export type Sender = { send(o: { prompt: string; source?: string; mode?: 'enqueue' | 'immediate'; clientTurnId?: string }): Promise<string> };

/**
 * Hands `text` to the session. Copilot said no: not handed over, tried again. No answer within
 * `timeoutMs`: it may have been admitted, so it counts as handed over (`maybe`), never sent twice.
 */
export async function sendWake(session: Sender, text: string, timeoutMs = 60000): Promise<QueueResult> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((r) => {
        timer = setTimeout(() => r('late'), timeoutMs);
    });
    try {
        const r = await Promise.race([session.send({ prompt: text, source: WAKE_SOURCE, mode: 'enqueue', clientTurnId: `mcp-events-${randomUUID()}` }).then(() => 'ok' as const), late]);
        if (r === 'late') return { ok: false, why: `Copilot did not answer within ${Math.round(timeoutMs / 1000)} s`, maybe: true };
        return { ok: true, resumed: true };
    } catch (e) {
        const why = e instanceof Error ? e.message.split('\n')[0]!.slice(0, 300) : String(e).slice(0, 300);
        return { ok: false, why: `Copilot refused the message (${why})` };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Whether a `user.message` is the person's own: no source, or "user", and from the root agent.
 * Every other source is something else writing to the session: this extension's wakes
 * (automation-…), another automation, a skill, a sub-agent, the system.
 */
export function isThePersons(data: { source?: unknown; agentId?: unknown } | undefined, agentId?: unknown): boolean {
    if (!data || agentId !== undefined || data.agentId !== undefined) return false;
    return data.source === undefined || data.source === null || data.source === 'user';
}
