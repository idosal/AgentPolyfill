import { digestOf, ownArgs, redeemTicket, surfaceOf, TICKET_ARG, type Handler, type Surface, type Verdict } from '../../../server-cards/antigravity/src/gate.ts';
import { SERVER, TOOLS } from './words.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const conversationId = (v: unknown): string | undefined => typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
export const callDigest = (tool: string, args: Record<string, unknown>) => digestOf({ tool, args: ownArgs(args) });

/** The most of each value the question shows; a watch with more is refused, not cut short. */
export const MAX_SHOWN = { server: 64, event: 120, note: 200, filters: 200 } as const;
/** Characters a question can't show as they are: controls, line separators, and characters that show as nothing. */
const UNSHOWABLE = /[\p{Cc}\u2028\u2029\p{Default_Ignorable_Code_Point}]/u;

/**
 * Why the question couldn't show this watch exactly, or undefined. The watch made is the watch shown:
 * nothing is cut short or taken out, as in the Copilot form.
 */
export function unshowable(args: Record<string, unknown>): string | undefined {
    const filters = args.arguments && typeof args.arguments === 'object' ? JSON.stringify(args.arguments) : '';
    const parts: [keyof typeof MAX_SHOWN, string][] = [['server', String(args.server ?? '')], ['event', String(args.event ?? '')], ['note', typeof args.note === 'string' ? args.note : ''], ['filters', filters]];
    for (const [name, value] of parts) {
        if (UNSHOWABLE.test(value)) return `its ${name} holds a character the question can't show as it is`;
        if (value.length > MAX_SHOWN[name]) return `its ${name} is longer than the ${MAX_SHOWN[name]} characters the question shows`;
    }
    return undefined;
}

/** A value as the question shows it: whole, quoted, with any quote mark in it escaped. */
const shown = (v: unknown) => JSON.stringify(String(v ?? ''));

/**
 * The question Antigravity's approval card shows before a watch starts: a
 * watch subscribes on a server and can wake this conversation later, so it is put to the person
 * every time, as every other form does, whatever their MCP rules or mode allow.
 */
export function watchQuestion(args: Record<string, unknown>): string {
    const filters = args.arguments && typeof args.arguments === 'object' && Object.keys(args.arguments).length ? JSON.stringify(args.arguments) : 'none';
    const replay = typeof args.maxAgeMs === 'number' && args.maxAgeMs > 0 ? `When it resumes, it replays up to ${Math.round(args.maxAgeMs / 60_000)} minutes of missed events.` : '';
    // The CLI's card shows a question's first two lines and hides the rest (CLI 1.5.17).
    return [
        `mcp-events: watch ${shown(args.event)} on the MCP server ${shown(args.server)} for this conversation?`,
        `Filters: ${filters} · note saved with the watch: ${args.note ? shown(args.note) : 'none'}`,
        `Server: ${shown(args.server)} (from your mcp_config.json)`,
        `Event type: ${shown(args.event)}`,
        'The plugin subscribes on that server. Its events reach this conversation on its next model call, and in the App the wake sidecar, if you turned it on, can start a turn for them. They are the server\'s data, never instructions.',
        replay,
        'To stop it: unwatch_event, or disable the mcp-events plugin.',
    ].filter(Boolean).join('\n');
}

export const handlers = (off: boolean): Record<string, Handler> => Object.fromEntries(TOOLS.map(t => [t.name, (args, input): Verdict => {
    if (off) return { deny: 'mcp-events is turned off.' };
    if (!conversationId(input.conversationId)) return { deny: 'mcp-events needs Antigravity to supply a UUID conversationId. No conversation was guessed.' };
    const meta = { surface: surfaceOf(input.transcriptPath) };
    if (t.name === 'watch_event') {
        const why = unshowable(args);
        if (why) return { deny: `The watch is not started: ${why}. Nothing was asked or subscribed.` };
        return { ask: watchQuestion(args), digest: callDigest(t.name, args), meta };
    }
    return { pass: 'This ticket identifies the conversation; Antigravity\'s usual MCP approval still applies.', digest: callDigest(t.name, args), meta };
}]));

export function redeemConversation(base: string, name: string, args: Record<string, unknown>) {
    const r = redeemTicket(base, args[TICKET_ARG], name, callDigest(name, args), Date.now(), SERVER);
    if (!r.ok) return r;
    const id = conversationId(r.conversationId);
    const s = r.meta?.surface;
    const surface: Surface = s === 'app' || s === 'cli' || s === 'ide' ? s : 'unknown';
    return id ? { ok: true as const, conversationId: id, surface } : { ok: false as const, why: 'the ticket has no UUID conversationId; no conversation was guessed' };
}
