// Webhook delivery (SEP-3415 webhook mode): the Standard Webhooks signature
// scheme, the one place a delivery is judged, and the local receiver.
//
// A delivery reaches this plugin in one of two ways: POSTed straight to the
// local receiver (through a public forwarder of yours), or collected from
// the relay, which stored it without being able to check it. Either way this
// plugin holds the subscription's secret and is the SEP's "receiver" in full:
// it verifies each signature and timestamp before acting, echoes a
// verification challenge only when the challenge's signature verifies, and
// reports success only after the event is written down.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Occurrence } from './events-client.ts';

/** The largest delivery taken: the size the extension asks servers to stay under. */
const MAX_BODY = 256 * 1024;
const FRESHNESS_S = 5 * 60;

/** `whsec_` + base64 of 32 random bytes (the SEP allows 24 to 64). */
export function newSecret(): string {
    return 'whsec_' + randomBytes(32).toString('base64');
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export type Verdict = { ok: true; id: string; timestamp: number } | { ok: false; reason: string; stale?: boolean };

/** Checks Standard Webhooks headers against one secret: a `v1,` signature that matches, and a fresh timestamp. */
export function verify(secret: string, headers: Record<string, string | string[] | undefined>, body: string, nowS = Math.floor(Date.now() / 1000)): Verdict {
    const h = (k: string) => {
        const v = headers[k];
        return Array.isArray(v) ? v[0] : v;
    };
    const id = h('webhook-id');
    const ts = Number(h('webhook-timestamp'));
    const sigs = (h('webhook-signature') ?? '').split(' ').filter(Boolean);
    if (!id || !Number.isFinite(ts) || sigs.length === 0) return { ok: false, reason: 'missing Standard Webhooks headers' };
    if (nowS - ts > FRESHNESS_S) return { ok: false, reason: 'timestamp more than 5 minutes old', stale: true };
    // Standard Webhooks' tolerance runs both ways: one stamped well ahead of the clock is not taken either.
    if (ts - nowS > FRESHNESS_S) return { ok: false, reason: 'timestamp more than 5 minutes ahead' };
    const expected = Buffer.from(sign(secret, id, ts, body).slice(3), 'base64');
    for (const s of sigs) {
        if (!s.startsWith('v1,')) continue; // v1a (asymmetric) is optional; not checked here
        const got = Buffer.from(s.slice(3), 'base64');
        if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id, timestamp: ts };
    }
    return { ok: false, reason: 'no matching v1 signature' };
}

/** Nothing signed longer ago than this is taken, whatever anyone says about when it arrived (the relay keeps a delivery a week). */
export const MAX_AGE_S = 8 * 24 * 3600;
/** The most delivery ids one watch remembers. Past it, the oldest are forgotten and a floor takes their place. */
export const MAX_REMEMBERED = 1000;

/** The longest cursor kept. A cursor is the server's own text, saved with the watch: one longer than this is treated as no cursor. */
export const MAX_CURSOR = 16 * 1024;

export type ReplayState = { newest?: number; floor?: number; recent: [id: string, timestamp: number][] };

/**
 * Keeps a subscription from taking the same signed delivery twice.
 *
 * A direct POST is fresh by the clock. A delivery the relay held is not: the relay says when
 * it arrived, and that is only its word. So acceptance rests on what this side knows:
 *   - every accepted delivery's id is remembered (for MAX_AGE_S), so each is taken once;
 *   - if there are ever more than MAX_REMEMBERED to remember, the oldest are forgotten and
 *     everything signed at or before their time is refused from then on (never accepted again);
 *   - nothing older than MAX_AGE_S by this machine's clock is taken at all.
 * A delivery that was never taken is taken however much newer ones were taken meanwhile: one
 * the relay kept after this side could not store it (a 503) comes back after them. (Until 0.5.0
 * one signed ten minutes before the newest taken was refused, and its event lost.)
 * Taking a delivery has two steps, begin and commit, so two copies arriving together (by
 * whatever route) cannot both get in: the second finds the first in progress.
 * The state is the watch's, saved with it, so it holds across restarts.
 */
export class ReplayGuard {
    readonly state: ReplayState;
    #inProgress = new Set<string>();

    constructor(state?: ReplayState) {
        this.state = { newest: state?.newest, floor: state?.floor, recent: Array.isArray(state?.recent) ? state.recent.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number') : [] };
    }

    /** Starts taking a delivery. Returns a reason to refuse, `'duplicate'` for one already taken, `'busy'` for one being taken right now, or nothing (then `commit` or `abort` must follow). */
    begin(id: string, timestamp: number, nowS = Math.floor(Date.now() / 1000)): string | undefined {
        if (timestamp < nowS - MAX_AGE_S) return 'signed too long ago';
        const { floor, recent } = this.state;
        if (floor !== undefined && timestamp < floor) return 'signed at or before deliveries already accepted and forgotten (a replay)';
        if (recent.some(([seen]) => seen === id)) return 'duplicate';
        if (this.#inProgress.has(id)) return 'busy';
        this.#inProgress.add(id);
        return undefined;
    }

    /** The delivery was taken: remember it. Returns a way to take that back (if saving the memory fails). */
    commit(id: string, timestamp: number, nowS = Math.floor(Date.now() / 1000)): () => void {
        this.#inProgress.delete(id);
        const s = this.state;
        const before: ReplayState = { newest: s.newest, floor: s.floor, recent: [...s.recent] };
        s.recent.push([id, timestamp]);
        if (s.newest === undefined || timestamp > s.newest) s.newest = timestamp;
        // What is past the age limit is refused by `begin` anyway: it need not be remembered.
        s.recent = s.recent.filter(([, t]) => t >= nowS - MAX_AGE_S);
        // Too many to remember: forget the oldest, and from now on refuse everything signed at or
        // before the newest of the forgotten ones.
        if (s.recent.length > MAX_REMEMBERED) {
            s.recent.sort((a, b) => a[1] - b[1]);
            const forgotten = s.recent.splice(0, s.recent.length - MAX_REMEMBERED);
            s.floor = Math.max(s.floor ?? 0, forgotten[forgotten.length - 1]![1] + 1);
        }
        return () => {
            s.newest = before.newest;
            s.floor = before.floor;
            s.recent = before.recent;
        };
    }

    /** The delivery was not taken after all (it could not be stored): it may be tried again. */
    abort(id: string): void {
        this.#inProgress.delete(id);
    }
}

export type Hook = {
    secret: string;
    /** Persist the event, then resolve; success is reported only after. */
    onEvent: (o: Occurrence, subscriptionId: string | undefined) => Promise<void> | void;
    onGap?: (cursor: string | null, subscriptionId: string | undefined) => Promise<void> | void;
    onTerminated?: (error: { code?: number } | undefined) => Promise<void> | void;
    /** Refuses replays. Every hook has one; a lasting address's is saved with its watch. */
    replay?: ReplayGuard;
    /** Saves the guard's state once a delivery has been taken. If it throws, the delivery counts as not taken. */
    accepted?: () => void;
};

export type Outcome = { status: number; body?: unknown; reason?: string };

/** Whether a body is a verification challenge (which changes nothing, and is the only kind answered live). */
export function isChallenge(raw: string): boolean {
    try {
        const b = JSON.parse(raw) as { type?: unknown } | null;
        return typeof b === 'object' && b !== null && b.type === 'verification';
    } catch {
        return false;
    }
}

/**
 * Judges one delivery and acts on it. `nowS` is when the delivery arrived: now for
 * a direct POST, the relay's receipt time for one the relay held.
 */
export async function handleDelivery(hook: Hook, headers: Record<string, string | string[] | undefined>, raw: string, o: { nowS?: number } = {}): Promise<Outcome> {
    // The same bound however it arrived: the receiver stops reading at this size, and what a relay
    // hands over is measured here (its word on what it let through is not taken).
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) return { status: 413, reason: 'larger than 256 KiB' };
    const v = verify(hook.secret, headers, raw, o.nowS);
    // Stale: not wanted again, so the server is told not to retry it (410). Anything else that does not verify is refused.
    if (!v.ok) return { status: v.stale ? 410 : 401, reason: v.reason };
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return { status: 400, reason: 'the body is not JSON' };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 400, reason: 'the body is not a JSON object' };
    // A challenge changes nothing here, so it needs no replay check.
    if (body.type === 'verification') return { status: 200, body: { challenge: typeof body.challenge === 'string' ? body.challenge : undefined } };
    const refused = hook.replay?.begin(v.id, v.timestamp);
    if (refused === 'duplicate') return { status: 200, reason: 'already taken' }; // a retry of one we have: the server may stop
    if (refused === 'busy') return { status: 503, reason: 'the same delivery is being taken right now' };
    if (refused) return { status: 410, reason: refused }; // recognised as old or already taken: not to be retried
    const h = headers['x-mcp-subscription-id'];
    const subId = Array.isArray(h) ? h[0] : h;
    let undo: (() => void) | undefined;
    try {
        if (typeof body.type === 'string') {
            if (body.type === 'gap') await hook.onGap?.(typeof body.cursor === 'string' && body.cursor.length <= MAX_CURSOR ? body.cursor : null, subId);
            else if (body.type === 'terminated') {
                const code = (body.error as { code?: unknown } | undefined)?.code;
                await hook.onTerminated?.({ code: typeof code === 'number' ? code : undefined });
            }
        } else {
            await hook.onEvent(body as unknown as Occurrence, subId);
        }
        // Remembered only once it is stored, and reported as taken only once the memory itself is saved.
        undo = hook.replay?.commit(v.id, v.timestamp);
        hook.accepted?.();
    } catch {
        undo?.();
        hook.replay?.abort(v.id);
        return { status: 503, reason: 'could not store the delivery' }; // retryable: the server (or the relay) delivers it again
    }
    return { status: 200 };
}

export class Receiver {
    #server?: Server;
    #hooks = new Map<string, Hook>();
    port = 0;
    log: (s: string) => void = () => {};

    async start(port = 0, host = '127.0.0.1'): Promise<number> {
        if (this.#server) return this.port;
        // Whatever arrives, the answer is an HTTP status: a bad request must never take the plugin down.
        this.#server = createServer((req, res) => {
            this.#handle(req, res).catch(() => {
                try {
                    if (!res.headersSent) res.writeHead(400);
                    res.end();
                } catch {
                    // the connection is gone
                }
            });
        });
        this.#server.on('clientError', (_e, socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
            this.#server!.once('error', reject);
            this.#server!.listen(port, host, () => resolve());
        });
        this.port = (this.#server.address() as { port: number }).port;
        return this.port;
    }

    /** Registers a hook and returns its path (`/hooks/<random>`). */
    add(hook: Hook): string {
        const path = '/hooks/' + randomBytes(18).toString('base64url');
        this.#hooks.set(path, hook);
        return path;
    }

    remove(path: string): void {
        this.#hooks.delete(path);
    }

    async close(): Promise<void> {
        await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
        this.#server = undefined;
    }

    async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const reply = (status: number, body?: unknown) => {
            res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
            res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        // Only the path matters, and only if it is one of ours: no URL parsing that could throw.
        const path = (req.url ?? '/').split('?')[0]!;
        if (req.method === 'GET' && path === '/healthz') return reply(200, { ok: true });
        if (req.method !== 'POST') return reply(405);
        const hook = this.#hooks.get(path);
        if (!hook) return reply(404);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
            size += (c as Buffer).length;
            if (size > MAX_BODY) return reply(413);
            chunks.push(c as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const r = await handleDelivery(hook, req.headers as Record<string, string | string[] | undefined>, raw);
        if (r.status === 401 || r.status === 410) this.log(`rejected a delivery to ${path.slice(0, 14)}…: ${r.reason}`);
        else if (r.status === 503) this.log(r.reason ?? 'could not store a delivery');
        return reply(r.status, r.body);
    }
}
