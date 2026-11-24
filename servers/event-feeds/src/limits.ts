// The limit primitives, kept free of Workers-only imports so they can be tested anywhere.

/**
 * The key a client is counted under: its IPv4 address, or the /64 its IPv6 address is in (one host can
 * use any address in its /64, so counting single IPv6 addresses would let it dodge every limit).
 */
export function clientKeyOf(ip: string | null): string {
    if (!ip) return 'unknown';
    if (!ip.includes(':')) return ip;
    // An IPv4 address written as IPv6 (::ffff:a.b.c.d, or ::ffff:hhhh:hhhh) is that IPv4 client.
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (dotted) return dotted[1]!;
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex) {
        const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16);
        return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    // Expand "::" and keep the first four groups.
    const [head, tail] = ip.split('::') as [string, string | undefined];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return groups.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Asks a rate limiter. A limiter that cannot answer refuses: every route fails closed. */
export async function allow(rl: { limit(o: { key: string }): Promise<{ success: boolean }> }, key: string): Promise<boolean> {
    try {
        return (await rl.limit({ key })).success === true;
    } catch {
        return false;
    }
}

export type GateState = { minute: number; count: number; per: Map<string, number> };
export type GateAnswer = 'ok' | 'client' | 'host';

/**
 * One upstream host's fetch budget for the current minute: at most `cap` fetches for the whole service,
 * and at most `perClient` of them for any one client, so one client cannot spend everyone's minute.
 * A client over its share is refused without touching the host's count.
 */
export function gateTake(state: GateState, cap: number, perClient: number, client: string, now: number): GateAnswer {
    const minute = Math.floor(now / 60_000);
    if (minute !== state.minute) {
        state.minute = minute;
        state.count = 0;
        state.per.clear();
    }
    const mine = state.per.get(client) ?? 0;
    if (mine >= perClient) return 'client';
    if (state.count >= cap) return 'host';
    // Bounded: a minute holds at most `cap` clients that were let through.
    state.per.set(client, mine + 1);
    state.count++;
    return 'ok';
}

/** A fixed one-minute window: counts a take, and refuses once `cap` takes were counted this minute. */
export function windowTake(state: { minute: number; count: number }, cap: number, now: number): boolean {
    const minute = Math.floor(now / 60_000);
    if (minute !== state.minute) {
        state.minute = minute;
        state.count = 0;
    }
    if (state.count >= cap) return false;
    state.count++;
    return true;
}
