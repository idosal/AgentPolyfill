// Asking a rate limiter, in one place: the Worker and the mailboxes both do.
// Free of Workers-only APIs, so the tests can run it under Node.

/** `down`: the limit could not be checked, and this relay is set to refuse when that happens. */
export type Verdict = 'yes' | 'no' | 'down';

/** What a Workers rate-limit binding offers. */
export type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };

/**
 * Whether a limit lets this request through.
 *
 * A relay behind an access key has no limits configured and needs none: `required` is false and a
 * missing limiter lets everything through. A relay anyone may use sets REQUIRE_LIMITS, and then a
 * limiter that is missing or cannot answer refuses the request: an open relay with its limits off
 * is free storage for whoever notices.
 */
export async function allowed(limit: Limiter | undefined, key: string, required: boolean): Promise<Verdict> {
    if (!limit) return required ? 'down' : 'yes';
    try {
        return (await limit.limit({ key })).success ? 'yes' : 'no';
    } catch {
        return required ? 'down' : 'yes';
    }
}

export const TOO_MANY = { status: 429, error: 'too many requests; try again in a minute', retryAfter: 60 } as const;
export const LIMITS_DOWN = { status: 503, error: 'this relay cannot check its limits right now; try again in a minute', retryAfter: 60 } as const;

/** The header a mailbox reads the sender's address from. The Worker sets it, whatever the request said. */
export const SENDER_HEADER = 'x-relay-sender';

/**
 * Who is sending, for the limits that count per sender. An IPv4 address is itself. An IPv6 address
 * is its /64: one home, office or server usually has a whole /64 and can send from any address in
 * it, so counting each address apart would let one sender count as millions. An IPv4 address
 * written as IPv6 (`::ffff:a.b.c.d`) is the IPv4 address.
 */
export function senderKey(ip: string): string {
    const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
    if (mapped) return mapped[1]!;
    if (!raw.includes(':')) return raw || 'unknown';
    // An embedded IPv4 tail (a:b::1.2.3.4) is two groups.
    let text = raw;
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (v4) text = text.slice(0, v4.index) + [((+v4[1]! << 8) | +v4[2]!).toString(16), ((+v4[3]! << 8) | +v4[4]!).toString(16)].join(':');
    const halves = text.split('::');
    if (halves.length > 2) return raw;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
    return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * The network a sender belongs to, for the ceiling on new mailboxes: an IPv6 sender's /48, an
 * IPv4 sender itself. One /48 holds 65,536 /64s, and tunnel brokers hand out a /48 for free, so a
 * ceiling counted only per /64 is no ceiling for whoever holds one.
 */
export function networkKey(ip: string): string {
    const s = senderKey(ip);
    const m = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(s);
    return m ? `${m[1]}:${m[2]}:${m[3]}::/48` : s;
}

/**
 * Where a request a Cloudflare Worker makes to another Cloudflare site comes from: Cloudflare sets
 * `CF-Connecting-IP` to one address for every Worker (2a06:98c0:3600::103). So every MCP server
 * hosted on Workers is one sender here, and is counted in a bucket of its own, larger than one
 * machine's, rather than in one machine's.
 */
export const WORKERS_SENDER = senderKey('2a06:98c0:3600::103');
