// mcp-events relay: a public address for a local MCP client's webhooks.
//
// An MCP server that delivers events by webhook (SEP-3415) needs an https URL
// to POST to. A plugin on a laptop has none. This Worker is that address: it
// accepts each delivery, writes it down, and hands it to the plugin over a
// WebSocket, at once or when the plugin next connects.
//
// It never holds a subscription's signing secret, so it cannot check or forge
// a signature. It checks what needs no secret (size, encoding, the Standard
// Webhooks headers, the timestamp's freshness) and passes the delivery on
// byte for byte; the plugin verifies the signature. A verification challenge,
// which the SEP lets a receiver echo only when its signature verifies, is
// passed through to the connected plugin and answered by it.

import { ACCESS_KEY_RE, ACCESS_PREFIX, HOOK_RE, HOOKS_PATH, KEY_PREFIX, KEY_RE, MAILBOX_RE, mailboxIdOf, SUBPROTOCOL, type DeliveryHeaders } from './protocol.ts';
import type { Mailbox } from './mailbox.ts';

export { Mailbox } from './mailbox.ts';

export interface Env {
    MAILBOXES: DurableObjectNamespace<Mailbox>;
    /** What a plugin must present to open a mailbox here. A secret; unset means nobody can, unless OPEN_RELAY is "1". */
    ACCESS_KEY?: string;
    OPEN_RELAY?: string;
    /** Limits, in case the defaults don't suit (see mailbox.ts). */
    MAX_QUEUED?: string;
    MAX_QUEUED_BYTES?: string;
    ASK_TIMEOUT_MS?: string;
    DELIVERY_TTL_S?: string;
    HOOK_IDLE_TTL_S?: string;
    MAX_HOOKS?: string;
    /** Who runs this relay, said at its front page. For a relay other people may use. */
    OPERATOR?: string;
    /**
     * Rate limits, for a relay anyone may use (see wrangler.public.jsonc). Each is optional: a relay
     * behind an access key has none. They are approximate, and counted per Cloudflare location.
     */
    DELIVERIES_PER_MAILBOX?: RateLimit;
    DELIVERIES_PER_SENDER?: RateLimit;
    SOCKETS_PER_SENDER?: RateLimit;
}

const DAY_S = 24 * 3600;
/** The address a request came from, as Cloudflare reports it. */
const sender = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';
/** Whether a limit lets this request through. With no such limit configured, it does. */
async function allowed(limit: RateLimit | undefined, key: string): Promise<boolean> {
    if (!limit) return true;
    try {
        return (await limit.limit({ key })).success;
    } catch {
        return true; // a limiter that cannot answer does not take the relay down with it
    }
}
const tooMany = () => json(429, { error: 'too many requests; try again in a minute' }, { 'retry-after': '60' });

/** The SEP lets receivers refuse larger bodies with 413. */
/** The largest delivery kept: the size the Events extension asks servers to stay under. Larger ones get 413. */
const MAX_BODY = 256 * 1024;
/** Standard Webhooks: refuse a timestamp more than five minutes from now. */
const FRESHNESS_S = 5 * 60;
/** Header text the plugin will accept: printable ASCII. Anything else is refused here, not stored. */
const PLAIN = /^[\x20-\x7e]+$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** Compares two strings without the time taken depending on where they differ. */
async function sameText(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
    const p = new Uint8Array(x);
    const q = new Uint8Array(y);
    let diff = 0;
    for (let i = 0; i < p.length; i++) diff |= p[i]! ^ q[i]!;
    return diff === 0;
}

/** Reads a request body, or returns undefined once it passes `limit` bytes. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
    if (Number(request.headers.get('content-length') ?? '0') > limit) return undefined;
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
    }
    return out;
}

async function deliver(request: Request, env: Env, mailbox: string, hook: string): Promise<Response> {
    if (!MAILBOX_RE.test(mailbox) || !HOOK_RE.test(hook)) return json(404, { error: 'no such webhook address' });
    if (request.method !== 'POST') return json(405, { error: 'deliveries are POSTed' }, { allow: 'POST' });
    // Before the body is read or a mailbox is woken: one sender cannot flood the relay, and one
    // mailbox cannot be flooded. A refused delivery is told to come back (the SEP has senders retry).
    if (!(await allowed(env.DELIVERIES_PER_SENDER, sender(request))) || !(await allowed(env.DELIVERIES_PER_MAILBOX, mailbox))) return tooMany();
    const bytes = await readCapped(request, MAX_BODY);
    if (!bytes) return json(413, { error: 'the body is over 256 KiB' });
    let body: string;
    try {
        // Fatal, and keeping any byte-order mark: the text must encode back to the same bytes,
        // because the plugin checks the signature over it.
        body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return json(400, { error: 'the body is not UTF-8' });
    }
    const id = request.headers.get('webhook-id') ?? '';
    const timestamp = request.headers.get('webhook-timestamp') ?? '';
    const signature = request.headers.get('webhook-signature') ?? '';
    // An empty value is no value: a delivery stored with one could never be judged by the plugin.
    const subscription = request.headers.get('x-mcp-subscription-id') || undefined;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id) || !/^\d{1,12}$/.test(timestamp) || !PLAIN.test(signature) || signature.length > 2048 || (subscription !== undefined && (!PLAIN.test(subscription) || subscription.length > 512))) {
        return json(400, { error: 'missing or malformed Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature)' });
    }
    const now = Math.floor(Date.now() / 1000);
    // Stale: not wanted again, so the sender is told not to retry it (410 Gone).
    if (now - Number(timestamp) > FRESHNESS_S) return json(410, { error: 'webhook-timestamp is more than 5 minutes old' });
    if (Number(timestamp) - now > FRESHNESS_S) return json(400, { error: 'webhook-timestamp is more than 5 minutes ahead' });
    const headers: DeliveryHeaders = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature, ...(subscription !== undefined ? { 'x-mcp-subscription-id': subscription } : {}) };
    const r = await env.MAILBOXES.getByName(mailbox).deliver({ hook, headers, body, receivedAt: now });
    return new Response(r.body ?? null, {
        status: r.status,
        headers: { 'cache-control': 'no-store', ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}) }
    });
}

async function socket(request: Request, env: Env, mailbox: string): Promise<Response> {
    if (!MAILBOX_RE.test(mailbox)) return json(404, { error: 'no such mailbox' });
    if (request.method !== 'GET') return json(405, { error: 'the socket is opened with GET' }, { allow: 'GET' });
    if (!(await allowed(env.SOCKETS_PER_SENDER, sender(request)))) return tooMany();
    const accessKey = env.ACCESS_KEY ?? '';
    if (!accessKey && env.OPEN_RELAY !== '1') {
        return json(503, { error: 'This relay has no access key, so nobody can use it yet. Set one (wrangler secret put ACCESS_KEY), or set OPEN_RELAY to "1" to let anyone open a mailbox here.' });
    }
    if (accessKey && !ACCESS_KEY_RE.test(accessKey)) {
        return json(503, { error: 'This relay\'s ACCESS_KEY must be 16 to 128 characters of A-Z, a-z, 0-9, "_" and "-".' });
    }
    const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
    const key = offered.find((p) => p.startsWith(KEY_PREFIX))?.slice(KEY_PREFIX.length) ?? '';
    const access = offered.find((p) => p.startsWith(ACCESS_PREFIX))?.slice(ACCESS_PREFIX.length) ?? '';
    // The mailbox's name is the hash of its key: holding the key is the only way to open it.
    if (!offered.includes(SUBPROTOCOL) || !KEY_RE.test(key) || !(await sameText(await mailboxIdOf(key), mailbox))) return json(401, { error: 'this mailbox opens only with its key' });
    if (accessKey && !(await sameText(access, accessKey))) return json(403, { error: "this relay's access key is required" });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'expected a WebSocket upgrade' }, { upgrade: 'websocket' });
    return env.MAILBOXES.getByName(mailbox).fetch(request);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.pathname === '/healthz' && request.method === 'GET') return json(200, { ok: true });
        // What this is, who runs it and what it keeps, for anyone who looks at the address.
        if (url.pathname === '/' && request.method === 'GET') {
            const ttl = Number(env.DELIVERY_TTL_S);
            return json(200, {
                service: 'mcp-events relay',
                what: 'Holds signed MCP Events (SEP-3415) webhook deliveries until the client that registered the address collects them.',
                operator: env.OPERATOR || null,
                open: env.OPEN_RELAY === '1' && !env.ACCESS_KEY,
                holds: 'Event payloads pass through this server and are kept until collected, or dropped after retentionHours. It holds no signing secret: it cannot create or alter an event, and the client checks every signature itself.',
                retentionHours: (Number.isFinite(ttl) && ttl > 0 ? ttl : 7 * DAY_S) / 3600,
                rateLimited: Boolean(env.DELIVERIES_PER_MAILBOX && env.DELIVERIES_PER_SENDER && env.SOCKETS_PER_SENDER),
                source: 'https://github.com/idosal/MCPolyfill/tree/main/polyfills/claude-code/events/mod/relay'
            });
        }
        // SEP-3415 endpoint verification, option 4: this origin says which paths receive webhooks,
        // so a server that reads this document needs no challenge.
        if (url.pathname === '/.well-known/mcp-webhook-receiver.json' && request.method === 'GET') {
            return json(200, { receivers: [HOOKS_PATH] }, { 'cache-control': 'public, max-age=3600' });
        }
        if (parts.length === 3 && parts[0] === 'hooks') return deliver(request, env, parts[1]!, parts[2]!);
        if (parts.length === 3 && parts[0] === 'mailboxes' && parts[2] === 'socket') return socket(request, env, parts[1]!);
        return json(404, { error: 'not found' });
    }
} satisfies ExportedHandler<Env>;
