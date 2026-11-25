import { digestOf, ownArgs, redeemTicket, surfaceOf, TICKET_ARG, type Handler, type Surface } from '../../../server-cards/antigravity/src/gate.ts';
import { TOOLS } from './words.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const conversationId = (v: unknown): string | undefined => typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
export const callDigest = (tool: string, args: Record<string, unknown>) => digestOf({ tool, args: ownArgs(args) });
export const handlers = (off: boolean): Record<string, Handler> => Object.fromEntries(TOOLS.map(t => [t.name, (args, input) => {
    if (off) return { deny: 'mcp-events is turned off.' };
    if (!conversationId(input.conversationId)) return { deny: 'mcp-events needs Antigravity to supply a UUID conversationId. No conversation was guessed.' };
    return { pass: 'This ticket identifies the conversation; Antigravity\'s usual MCP approval still applies.', digest: callDigest(t.name, args), meta: { surface: surfaceOf(input.transcriptPath) } };
}]));

export function redeemConversation(base: string, name: string, args: Record<string, unknown>) {
    const r = redeemTicket(base, args[TICKET_ARG], name, callDigest(name, args));
    if (!r.ok) return r;
    const id = conversationId(r.conversationId);
    const s = r.meta?.surface;
    const surface: Surface = s === 'app' || s === 'cli' || s === 'ide' ? s : 'unknown';
    return id ? { ok: true as const, conversationId: id, surface } : { ok: false as const, why: 'the ticket has no UUID conversationId; no conversation was guessed' };
}
