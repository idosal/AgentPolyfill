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

/**
 * The key a sender is counted under: its IPv4 address, or the /64 its IPv6 address is in. One host
 * may use any address in its /64, so counting single IPv6 addresses would let it dodge every per-sender
 * limit, the ceiling on new mailboxes included. An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function senderKey(ip: string | null): string {
    if (!ip) return 'unknown';
    const bare = ip.trim().toLowerCase().replace(/%.*$/, '');
    if (!bare.includes(':')) return bare;
    const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare.replace(/^::/, '0::'));
    if (mapped) return mapped[1]!;
    const [head, tail] = bare.split('::') as [string, string | undefined];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** The header a mailbox reads the sender's address from. The Worker sets it, whatever the request said. */
export const SENDER_HEADER = 'x-relay-sender';
