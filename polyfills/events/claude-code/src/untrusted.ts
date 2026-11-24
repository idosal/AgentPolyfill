// Everything an MCP server or the relay sends is untrusted, and much of what this
// plugin says ends up in front of a model: its instructions, the line that wakes a
// session, tool results, and the status of a watch.
//
// The rule: an event's payload is the server's data and is shown as such, the way a
// tool result is. Everything else this plugin says is in its own words: errors come
// from a fixed vocabulary (a code, a category this plugin recognises), and names must
// look like names.

/** An event type or argument name: letters, digits and a little punctuation. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
/** A plain property name. */
export const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** A typed text value that may be shown in the wake line: one token, no spaces. */
export const TOKEN = /^[A-Za-z0-9_.:/@#+-]{1,64}$/;

/** An error whose message this plugin wrote itself, so it is safe to show. */
export class LocalError extends Error {}

const CODES: Record<number, string> = {
    [-32020]: 'header mismatch',
    [-32023]: 'not found',
    [-32024]: 'forbidden',
    [-32025]: 'too many subscriptions or streams',
    [-32026]: 'not supported',
    [-32027]: 'the server could not reach or verify the webhook address',
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
 * What went wrong, in this plugin's own words. A server's (or the relay's) own error text is
 * never repeated: it is whatever they chose to write, and this ends up in front of a model.
 */
export function describeError(e: unknown): string {
    if (e instanceof LocalError) return e.message;
    const code = errorCode(e);
    if (code !== undefined) return `the server answered error ${code}${CODES[code] ? ` (${CODES[code]})` : ''}`;
    const sys = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
    // The last two are the MCP SDK's: the server went away, or never answered the opening exchange.
    if (typeof sys === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(sys)) return /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_|EHOST|ENET|EPIPE|UND_ERR|CONNECTION_CLOSED$|ERA_NEGOTIATION_FAILED$)/.test(sys) ? `could not connect (${sys})` : `a local error (${sys})`;
    return 'the request failed';
}

/** A date the server gave, if it is one; otherwise nothing. */
export function isoDate(v: unknown): string | undefined {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : undefined;
}

/**
 * A schema a server sent, bounded before it is kept or shown: in depth, in the number of
 * values, in the length of any name or text, and in size as a whole. One that is still too
 * large is not kept at all.
 */
const MAX_SCHEMA_BYTES = 16 * 1024;

export function tameSchema(schema: unknown): unknown {
    let budget = 400; // values
    const walk = (v: unknown, depth: number): unknown => {
        if (--budget < 0 || depth > 8) return undefined;
        if (Array.isArray(v)) return v.slice(0, 64).map((x) => walk(x, depth + 1));
        if (typeof v !== 'object' || v === null) return typeof v === 'string' && v.length > 512 ? undefined : v;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v).slice(0, 64)) {
            if (k.length > 64) continue;
            const w = walk(x, depth + 1);
            if (w !== undefined) out[k] = w;
        }
        return out;
    };
    if (typeof schema !== 'object' || schema === null) return undefined;
    const tamed = walk(schema, 0);
    if (budget < 0 || tamed === undefined) return undefined;
    return JSON.stringify(tamed).length > MAX_SCHEMA_BYTES ? undefined : tamed;
}

/** Removes known secrets from text bound for a log. */
export class Redactor {
    #secrets = new Set<string>();

    add(...secrets: (string | undefined)[]): void {
        for (const s of secrets) {
            if (typeof s !== 'string' || s.length < 8) continue;
            this.#secrets.add(s);
            // Also without a scheme word in front ("Bearer x"), and the bare part of a whsec_ secret.
            const bare = s.replace(/^(Bearer|Basic|Token)\s+/i, '').replace(/^whsec_/, '');
            if (bare.length >= 8) this.#secrets.add(bare);
        }
    }

    scrub(text: string): string {
        let out = text;
        for (const s of this.#secrets) out = out.split(s).join('[redacted]');
        return out;
    }

    /** The same, for every string inside a value (an event's data, a description). */
    scrubDeep<T>(v: T, depth = 0): T {
        if (typeof v === 'string') return this.scrub(v) as T;
        if (depth > 32 || typeof v !== 'object' || v === null) return v;
        if (Array.isArray(v)) return v.map((x) => this.scrubDeep(x, depth + 1)) as T;
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.scrub(k), this.scrubDeep(x, depth + 1)])) as T;
    }
}

/**
 * The secrets this process knows (tokens from the user's config, the relay's keys, webhook
 * secrets). They are taken out of the log, and out of anything a server sends before it is
 * shown: a server that echoes back the token it was given does not get it printed.
 */
export const secrets = new Redactor();
