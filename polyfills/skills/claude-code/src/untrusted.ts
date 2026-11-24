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
