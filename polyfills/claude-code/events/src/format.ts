// The one line Claude sees per event (the monitor prints it; Claude Code shows
// it as "Monitor event: …" and wakes the session).
//
// Event payloads are untrusted (SEP-3415: "the same caution as tool results").
// So the line carries only a few short fields, flattened to one line with
// control characters and escapes removed, under the server's name.
// Claude fetches the rest with get_event.

import type { SpoolRecord } from './store.ts';
import { KEY, TOKEN } from './untrusted.ts';

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
export function formatRecord(r: SpoolRecord): string {
    if (r.kind === 'notice') return `${LINE_PREFIX} ${oneLine(r.text, 300)}`;
    const { text, more } = summarize(r.data);
    const rest = more > 0 ? `get_event ${r.id} returns all of it (${more} more field${more === 1 ? '' : 's'})` : `get_event ${r.id} returns the record`;
    const note = r.note ? ` Note saved with this watch: "${oneLine(r.note, 160)}".` : '';
    // What happened comes first: a terminal cuts a long line short, and the ids matter least.
    return `${LINE_PREFIX} ${oneLine(r.server, 40)} · ${oneLine(r.event, 80)}${text ? `: ${text}` : ''} [event ${r.id}, watch ${r.watch}; ${rest}].${note}`;
}

/** Several events at once: the first few in full, then a count. */
export function formatBatch(records: SpoolRecord[], max = 3): string[] {
    if (records.length <= max + 1) return records.map(formatRecord);
    const shown = records.slice(0, max).map(formatRecord);
    const rest = records.slice(max);
    const ids = rest.map((r) => r.id);
    shown.push(`${LINE_PREFIX} …and ${rest.length} more events (${ids[0]}–${ids[ids.length - 1]}); call recent_events to see them.`);
    return shown;
}
