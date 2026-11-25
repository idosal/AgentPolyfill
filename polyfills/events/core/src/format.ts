// What Claude is told when events arrive, and how one event reads in a list.
//
// Event payloads are untrusted (SEP-3415: "the same caution as tool results").
// The message that wakes a session is a prompt, not a tool result, so by
// default it carries nothing a server wrote: only which watch, how many
// events, and their ids. Claude reads the payload with get_event or
// recent_events, whose answers are tool results. (MCP_EVENTS_WAKE_VALUES=1
// puts a few short payload fields back in the wake message.)

import type { SpoolRecord } from './store.ts';
import { KEY, NAME, TOKEN } from './untrusted.ts';

export const LINE_PREFIX = '[mcp-events]';

export function oneLine(s: unknown, max = 120): string {
    const text = String(s ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI escapes
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
        // Quotation marks of every kind become the plain one, which is escaped wherever text is quoted.
        .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb\uff02]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * A few of the payload's top-level fields, `key=value`, each short: numbers, booleans and text.
 * Text that is one plain token is shown bare; anything else is quoted and cut to a line's worth.
 * Nested values and anything past the first few are only counted.
 */
export function summarize(data: Record<string, unknown> | undefined, n = 6): { text: string; more: number } {
    if (!data || typeof data !== 'object') return { text: '', more: 0 };
    const parts: string[] = [];
    const entries = Object.entries(data);
    for (const [k, v] of entries) {
        if (parts.length >= n) break;
        if (!KEY.test(k)) continue;
        if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') parts.push(`${k}=${String(v)}`);
        else if (typeof v === 'string' && v.length) parts.push(`${k}=${TOKEN.test(v) ? v : JSON.stringify(oneLine(v, 80))}`);
    }
    return { text: parts.join(', '), more: entries.length - parts.length };
}

/**
 * One event as one line. It says which server and which event type (the watch's own names), a few
 * triage fields of the payload, and how to get the rest. The payload is the server's data, shown
 * the way a tool result would be: flattened, shortened, and never as this plugin's own words.
 */
/**
 * An event type's name as a wake or a notice shows it. The name is the server's text, and those
 * messages start a turn, so it is shown only when it reads as a name (ticket.created, hn.comment),
 * as the tools show names. Any other is left out; list_watches and get_event give it, as tool results.
 */
export function shownEvent(name: string | undefined): string {
    return name && NAME.test(name) ? name : 'an event type whose name is not a plain name (list_watches shows it)';
}

export function formatRecord(r: SpoolRecord): string {
    if (r.kind === 'notice') return `${LINE_PREFIX} ${oneLine(r.text, 300)}`;
    const { text, more } = summarize(r.data);
    const rest = more > 0 ? `get_event ${r.id} returns all of it (${more} more field${more === 1 ? '' : 's'})` : `get_event ${r.id} returns the record`;
    const note = r.note ? ` Note saved with this watch: "${oneLine(r.note, 160)}".` : '';
    // What happened comes first: a terminal cuts a long line short, and the ids matter least.
    return `${LINE_PREFIX} ${oneLine(r.server, 40)} · ${oneLine(r.event, 80)}${text ? `: ${text}` : ''} [event ${r.id}, watch ${r.watch}; ${rest}].${note}`;
}

/** Several events with their fields: the first few in full, then a count. */
function withValues(records: SpoolRecord[], max = 3): string[] {
    if (records.length <= max + 1) return records.map(formatRecord);
    const shown = records.slice(0, max).map(formatRecord);
    const rest = records.slice(max);
    const ids = rest.map((r) => r.id);
    shown.push(`${LINE_PREFIX} …and ${rest.length} more events (${ids[0]}–${ids[ids.length - 1]}); call recent_events to see them.`);
    return shown;
}

/** Notices shown in one wake message; the rest are counted. */
const MAX_NOTICES = 3;

/** Ids, a few of them: `e1`, `e1, e2, e3`, `e1, e2, e3, e4, e5 and 7 more`. */
function someIds(ids: string[], max = 5): string {
    return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} and ${ids.length - max} more`;
}

/**
 * The message that wakes a session, as lines: one per watch that has new events, saying how many
 * and which, and nothing from their payloads. A notice (this mod's own words) is a line of its own.
 * With `values`, each event is a line with a few of its fields, as recent_events shows them.
 */
export function formatBatch(records: SpoolRecord[], o: { values?: boolean } = {}): string[] {
    if (o.values) return withValues(records);
    const lines: string[] = [];
    const byWatch = new Map<string, SpoolRecord[]>();
    const notices = records.filter((r) => r.kind === 'notice');
    for (const r of notices.slice(0, MAX_NOTICES)) lines.push(formatRecord(r));
    if (notices.length > MAX_NOTICES) lines.push(`${LINE_PREFIX} …and ${notices.length - MAX_NOTICES} more notices; recent_events lists them.`);
    for (const r of records) if (r.kind !== 'notice') byWatch.set(r.watch ?? '', [...(byWatch.get(r.watch ?? '') ?? []), r]);
    for (const [watch, events] of byWatch) {
        const first = events[0]!;
        const ids = events.map((r) => r.id);
        const how = events.length === 1 ? `get_event ${ids[0]} returns it` : 'recent_events lists them, get_event returns one';
        // The note is what Claude wrote when it set the watch; the newest is the one in force.
        const noted = events.findLast((r) => r.note)?.note;
        const note = noted ? ` Note saved with this watch: "${oneLine(noted, 160)}".` : '';
        const event = shownEvent(first.event);
        lines.push(
            `${LINE_PREFIX} ${oneLine(first.server, 40)} · ${event}: ${events.length} new event${events.length === 1 ? '' : 's'} [${events.length === 1 ? 'event' : 'events'} ${someIds(ids)}; watch ${watch}; ${how}].${note}`
        );
    }
    return lines;
}
