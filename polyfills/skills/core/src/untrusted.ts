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
// eslint-disable-next-line no-control-regex
const CONTROLS_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * What a URI cannot hold: anything but printable ASCII. RFC 3986 writes every other character
 * percent-encoded, so a URI holding a space, a control, a mark that changes direction, an
 * invisible character (a soft hyphen, a filler, a tag character that can carry hidden ASCII to a
 * model) or any other non-ASCII character is not taken as one.
 */
export const NOT_URI_TEXT = /[^\x21-\x7e]/;

/**
 * Characters that show nothing, or change how the text around them reads: Unicode's
 * Default_Ignorable_Code_Point. That is the zero-width and format marks, the direction marks
 * (U+061C among them), the soft hyphen, the combining grapheme joiner, the Hangul fillers, the
 * variation selectors (each can hide a byte) and the tag characters (which can spell hidden ASCII
 * to a model). Taken out of a server's text before it is shown in a listing; controls are
 * oneLine's to remove.
 */
export const INVISIBLE_TEXT = /\p{Default_Ignorable_Code_Point}/u;
const HIDDEN_RUN = /\p{Default_Ignorable_Code_Point}+/gu;

/** How many INVISIBLE_TEXT characters a server's text holds. */
export function countHidden(text: string): number {
    let n = 0;
    for (const run of text.matchAll(HIDDEN_RUN)) n += [...run[0]].length;
    return n;
}

/**
 * A server's text for a person to read: controls removed (line breaks and tabs kept), and each
 * run of INVISIBLE_TEXT characters shown as a marker with its count, `\u27E63 hidden characters\u27E7`, so
 * the person sees that text is there which a model would read and they would not.
 */
export function shownText(text: string): string {
    // The line and paragraph separators (U+2028, U+2029) end a line, as \n does, so each piece is a
    // line of its own wherever lines are marked. (oneLine turns them into spaces.)
    const separators = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');
    return text.replace(separators, '\n').replace(CONTROLS_BUT_LINES, '').replace(HIDDEN_RUN, (run) => {
        const n = [...run].length;
        return `${String.fromCodePoint(0x27e6)}${n} hidden character${n === 1 ? '' : 's'}${String.fromCodePoint(0x27e7)}`;
    });
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
