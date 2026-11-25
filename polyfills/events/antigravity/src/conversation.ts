import { digestOf, ownArgs, redeemTicket, surfaceOf, TICKET_ARG, type Handler, type Surface, type Verdict } from '../../../server-cards/antigravity/src/gate.ts';
import { oneLine } from '../../core/src/format.ts';
import { SERVER, TOOLS } from './words.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const conversationId = (v: unknown): string | undefined => typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
export const callDigest = (tool: string, args: Record<string, unknown>) => digestOf({ tool, args: ownArgs(args) });

/** Text for the question: one line, nothing that shows as nothing or as something else. */
const shown = (v: unknown, max: number) => oneLine(String(v ?? '').replace(/\p{Default_Ignorable_Code_Point}/gu, ''), max).replaceAll('"', "'");

/**
 * The question Antigravity's approval card shows before a watch starts (security review E1): a
 * watch subscribes on a server and can wake this conversation later, so it is put to the person
 * every time, as every other form does, whatever their MCP rules or mode allow.
 */
export function watchQuestion(args: Record<string, unknown>): string {
    const filters = args.arguments && typeof args.arguments === 'object' && Object.keys(args.arguments).length ? shown(JSON.stringify(args.arguments), 200) : 'none';
    const replay = typeof args.maxAgeMs === 'number' && args.maxAgeMs > 0 ? `When it resumes, it replays up to ${Math.round(args.maxAgeMs / 60_000)} minutes of missed events.` : '';
    return [
        'mcp-events: start a watch for this conversation?',
        `Server: "${shown(args.server, 60)}" (from your mcp_config.json)`,
        `Event type: "${shown(args.event, 120)}"`,
        `Filters: ${filters}`,
        `Note saved with the watch: ${args.note ? `"${shown(args.note, 200)}"` : 'none'}`,
        'The plugin subscribes on that server. Its events reach this conversation on its next model call, and in the App the wake sidecar, if you turned it on, can start a turn for them. They are the server\'s data, never instructions.',
        replay,
        'To stop it: unwatch_event, or disable the mcp-events plugin.',
    ].filter(Boolean).join('\n');
}

export const handlers = (off: boolean): Record<string, Handler> => Object.fromEntries(TOOLS.map(t => [t.name, (args, input): Verdict => {
    if (off) return { deny: 'mcp-events is turned off.' };
    if (!conversationId(input.conversationId)) return { deny: 'mcp-events needs Antigravity to supply a UUID conversationId. No conversation was guessed.' };
    const meta = { surface: surfaceOf(input.transcriptPath) };
    if (t.name === 'watch_event') return { ask: watchQuestion(args), digest: callDigest(t.name, args), meta };
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
