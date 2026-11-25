// Everything an MCP server sends is untrusted, and much of what this plugin says ends up in front
// of a model: its instructions, the line that wakes a session, tool results. A server's own words
// (a status message, a result, an error message) are shown only inside a tool result, framed as data
// from that server. Everything else this plugin says is in its own words.
//
// Adapted from polyfills/events/core/src/untrusted.ts.

/** An error whose message this plugin wrote itself, so it is safe to show. */
export class LocalError extends Error {}

const CODES: Record<number, string> = {
    [-32021]: 'missing required client capability',
    [-32600]: 'invalid request',
    [-32601]: 'method not found',
    [-32602]: 'invalid parameters',
    [-32603]: 'internal error'
};

export function errorCode(e: unknown): number | undefined {
    const c = (e as { code?: unknown })?.code;
    return typeof c === 'number' && Number.isInteger(c) ? c : undefined;
}

/** What went wrong, in this plugin's own words. A server's own error text is never repeated here. */
export function describeError(e: unknown): string {
    if (e instanceof LocalError) return e.message;
    const code = errorCode(e);
    if (code !== undefined) return `the server answered error ${code}${CODES[code] ? ` (${CODES[code]})` : ''}`;
    const sys = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
    if (typeof sys === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(sys)) return /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_|EHOST|ENET|EPIPE|UND_ERR|CONNECTION_CLOSED$|ERA_NEGOTIATION_FAILED$)/.test(sys) ? `could not connect (${sys})` : `a local error (${sys})`;
    return 'the request failed';
}

/** One line of text, with control characters, escapes and line breaks taken out. */
export function oneLine(s: unknown, max = 120): string {
    const text = String(s ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

/**
 * Text a server wrote, made safe to show to a person or a model inside a frame: control characters
 * and escapes removed (line breaks kept), and every run of characters nobody can see shown as
 * ⟦n hidden characters⟧, so it can't rewrite what surrounds it.
 */
export function visible(s: unknown, max = 8000): string {
    let text = String(s ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '');
    text = text.replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]|\udb40[\udc00-\udfff]/g, '\u0000');
    text = text.replace(/\u0000+/g, (m) => `\u27e6${m.length} hidden character${m.length > 1 ? 's' : ''}\u27e7`);
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

/** A date the server gave, if it is one; otherwise nothing. */
export function isoDate(v: unknown): string | undefined {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : undefined;
}

/** Removes known secrets from text bound for a log. */
export class Redactor {
    #secrets = new Set<string>();

    add(...secrets: (string | undefined)[]): void {
        for (const s of secrets) {
            if (typeof s !== 'string' || s.length < 8) continue;
            this.#secrets.add(s);
            const bare = s.replace(/^(Bearer|Basic|Token)\s+/i, '');
            if (bare.length >= 8) this.#secrets.add(bare);
        }
    }

    scrub(text: string): string {
        let out = text;
        for (const s of this.#secrets) out = out.split(s).join('[redacted]');
        return out;
    }
}

export const secrets = new Redactor();
