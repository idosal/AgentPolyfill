// Everything an MCP server sends is untrusted, and much of what this mod says ends
// up in front of a model: the skill listing, tool results, the status command.
//
// The rule: a skill's own text (its description, its files) is the server's data and
// is shown as such, tagged with the server it came from. Everything else this mod
// says is in its own words: errors come from a fixed vocabulary, and names must look
// like names.

/** An error whose message this mod wrote itself, so it is safe to show. */
export class LocalError extends Error {}

const CODES: Record<number, string> = {
    [-32600]: 'invalid request',
    [-32601]: 'method not found',
    [-32602]: 'invalid parameters',
    [-32603]: 'internal error'
};

export function errorCode(e: unknown): number | undefined {
    const c = (e as { code?: unknown })?.code;
    return typeof c === 'number' && Number.isInteger(c) ? c : undefined;
}

/**
 * What went wrong, in this mod's own words. A server's own error text is never
 * repeated: it is whatever the server chose to write, and this ends up in front of a model.
 */
export function describeError(e: unknown): string {
    if (e instanceof LocalError) return e.message;
    const code = errorCode(e);
    if (code !== undefined) return `the server answered error ${code}${CODES[code] ? ` (${CODES[code]})` : ''}`;
    const sys = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
    if (typeof sys === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(sys)) return /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_|EHOST|ENET|EPIPE|UND_ERR)/.test(sys) ? `could not connect (${sys})` : `a local error (${sys})`;
    return 'the request failed';
}

/** One line of a server's text for a listing: no control characters, no line breaks, bounded. */
export function oneLine(text: unknown, max: number): string {
    // eslint-disable-next-line no-control-regex
    const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Control characters (C0, DEL, C1), direction-changing marks and invisible characters. A terminal
 * may act on them (erase a line, move the cursor, set the clipboard) and they can make text read
 * other than it is, so no URI a server sends may hold one. The same set as the Server Cards
 * core's UNSAFE_TEXT.
 */
// eslint-disable-next-line no-control-regex, no-misleading-character-class
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const UNSAFE_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * What a URI cannot hold: anything but printable ASCII. RFC 3986 writes every other character
 * percent-encoded, so a URI holding a space, a control, a mark that changes direction, an
 * invisible character (a soft hyphen, a filler, a tag character that can carry hidden ASCII to a
 * model) or any other non-ASCII character is not taken as one.
 */
export const NOT_URI_TEXT = /[^\x21-\x7e]/;

/**
 * Characters that show nothing, or change how the text around them reads: zero-width and format
 * marks, direction marks (U+061C among them), the soft hyphen, the Hangul fillers and the tag
 * characters. Taken out of a server's text before it is shown in a listing; controls are
 * oneLine's to remove.
 */
export const INVISIBLE_TEXT = /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/u;

/** A server's text for a person to read: every UNSAFE_TEXT character removed but line breaks and tabs. */
export function shownText(text: string): string {
    return text.replace(UNSAFE_BUT_LINES, '');
}

/** Removes known secrets (tokens from the user's config) from text that will be shown or logged. */
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

/** The secrets this process knows: header values from the user's MCP config. */
export const secrets = new Redactor();
