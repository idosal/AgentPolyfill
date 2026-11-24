// A small MCP server that implements the server side of the Events extension
// (SEP-3415) by hand, over stdio, so the plugin is tested against something
// that shares no code with it.
//
// Its "upstream" is an append-only JSONL file (FIXTURE_UPSTREAM): every server
// process reads the same file, so events survive restarts and a cursor (a line
// number) can be replayed. test/emit.ts appends to it.
//
// Event types:
//   ticket.created   delivery poll, push, webhook   arguments { priority? }
//   deploy.finished  delivery webhook only           arguments { service? }
//
// Env:
//   FIXTURE_UPSTREAM     the upstream file (required)
//   FIXTURE_LOG          append one line per message received/sent (optional)
//   FIXTURE_CAPS         "extensions" (default, the SEP's form), "toplevel"
//                        (pre-SEP `capabilities.events`, which ChatGPT reads), or "both"
//   FIXTURE_REVISION     "new" (default: answers server/discover with 2026-07-28)
//                        or "legacy" (refuses server/discover; initialize only)
//   FIXTURE_ALLOW_HTTP   "1" lets webhook callbacks use http:// (tests only)
//   FIXTURE_HEARTBEAT_MS default heartbeat grant (default 15000)
//   FIXTURE_TICKET_DELIVERY  delivery modes for ticket.created (default poll,push,webhook)
//   FIXTURE_POLL_MS      nextPollMs to recommend (default 500)

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, watchFile } from 'node:fs';
import { createInterface } from 'node:readline';

const UPSTREAM = process.env.FIXTURE_UPSTREAM;
if (!UPSTREAM) throw new Error('FIXTURE_UPSTREAM is required');
if (!existsSync(UPSTREAM)) writeFileSync(UPSTREAM, '');
const LOG = process.env.FIXTURE_LOG;
const CAPS = process.env.FIXTURE_CAPS ?? 'extensions';
const REVISION = process.env.FIXTURE_REVISION === 'legacy' ? 'legacy' : 'new';
const ALLOW_HTTP = process.env.FIXTURE_ALLOW_HTTP === '1';
// "1": says it sends notifications/events/list_changed, and, a moment after a client opts in on
// subscriptions/listen, adds an event type (alert.raised) and says so.
const LIST_CHANGED = process.env.FIXTURE_LIST_CHANGED === '1';
const HEARTBEAT_DEFAULT = Number(process.env.FIXTURE_HEARTBEAT_MS ?? 15000);
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';

const ERR = { NotFound: -32023, Forbidden: -32024, Unsupported: -32026, CallbackEndpointError: -32027, InvalidParams: -32602 };

type Upstream = { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; _meta?: Record<string, unknown> };
type Json = Record<string, unknown>;

const log = (dir: string, m: unknown) => LOG && appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, dir, m }) + '\n');
const send = (m: Json) => {
    log('out', m);
    process.stdout.write(JSON.stringify(m) + '\n');
};

const EVENT_TYPES = [
    {
        name: 'ticket.created',
        description: 'Fires when a new support ticket is created.',
        delivery: (process.env.FIXTURE_TICKET_DELIVERY ?? 'poll,push,webhook').split(','),
        inputSchema: { type: 'object', properties: { priority: { type: 'string', enum: ['low', 'normal', 'high'] } } },
        payloadSchema: {
            type: 'object',
            properties: {
                ticketId: { type: 'string', pattern: '^[A-Z0-9-]{1,20}$' },
                title: { type: 'string', 'x-mcp-content': true },
                priority: { type: 'string', enum: ['low', 'normal', 'high'] }
            }
        }
    },
    {
        name: 'deploy.finished',
        description: 'Fires when a deploy finishes (webhook delivery only, like many servers built for ChatGPT).',
        delivery: ['webhook'],
        inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
        payloadSchema: {
            type: 'object',
            properties: { service: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' }, status: { type: 'string', enum: ['ok', 'failed'] }, url: { type: 'string', format: 'uri' } }
        }
    }
];

// Tests add event types of their own (hostile names and descriptions among them).
for (const extra of JSON.parse(process.env.FIXTURE_EXTRA_TYPES ?? '[]') as (typeof EVENT_TYPES)[number][]) EVENT_TYPES.push(extra);
// What of the environment this server was started with a test may ask about.
log('note', { environment: Object.keys(process.env).filter((k) => /^(MCP_EVENTS_|SHELL_SECRET|FIXTURE_UPSTREAM$)/.test(k)).sort() });

function readUpstream(): Upstream[] {
    return readFileSync(UPSTREAM!, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Upstream);
}

// Cursor = "line:<n>": every upstream event before line n has been seen.
const cursorOf = (n: number) => `line:${n}`;
function parseCursor(c: unknown): number | null {
    if (c === null || c === undefined) return null;
    const m = /^line:(\d+)$/.exec(String(c));
    if (!m) throw rpcError(ERR.InvalidParams, 'Invalid cursor');
    return Number(m[1]);
}

function matches(e: Upstream, name: string, args: Json): boolean {
    if (e.name !== name) return false;
    for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined && e.data[k] !== v) return false;
    return true;
}

function rpcError(code: number, message: string, data?: unknown) {
    return Object.assign(new Error(message), { rpc: { code, message, ...(data === undefined ? {} : { data }) } });
}

function eventType(name: unknown) {
    const t = EVENT_TYPES.find((e) => e.name === name);
    if (!t) throw rpcError(ERR.NotFound, 'Event type not found', { kind: 'event' });
    return t;
}

function requireMode(name: unknown, mode: string) {
    const t = eventType(name);
    if (!t.delivery.includes(mode)) throw rpcError(ERR.Unsupported, `Delivery mode ${mode} not supported`, { feature: 'delivery', mode });
    return t;
}

function startPosition(cursor: unknown, maxAgeMs: unknown, all: Upstream[]): { start: number; truncated: boolean } {
    const c = parseCursor(cursor);
    if (c === null) return { start: all.length, truncated: false }; // null = start from now
    let start = Math.min(c, all.length);
    let truncated = false;
    if (typeof maxAgeMs === 'number') {
        const floor = Date.now() - maxAgeMs;
        while (start < all.length && Date.parse(all[start]!.timestamp) < floor) {
            start++;
            truncated = true;
        }
    }
    return { start, truncated };
}

const occurrence = (e: Upstream, cursor?: string) => ({ eventId: e.eventId, name: e.name, timestamp: e.timestamp, data: e.data, ...(e._meta ? { _meta: e._meta } : {}), ...(cursor === undefined ? {} : { cursor }) });

// ---- capabilities -----------------------------------------------------------
function capabilities(): Json {
    const caps: Json = { tools: {} };
    if (CAPS === 'extensions' || CAPS === 'both') caps.extensions = { 'io.modelcontextprotocol/events': { listChanged: LIST_CHANGED } };
    if (CAPS === 'toplevel' || CAPS === 'both') caps.events = { listChanged: false };
    return caps;
}

// ---- poll -------------------------------------------------------------------
function poll(p: Json): Json {
    requireMode(p.name, 'poll');
    const all = readUpstream();
    const { start, truncated } = startPosition(p.cursor, p.maxAgeMs, all);
    const max = typeof p.maxEvents === 'number' ? p.maxEvents : 100;
    const events: unknown[] = [];
    let i = start;
    for (; i < all.length && events.length < max; i++) if (matches(all[i]!, p.name as string, p.arguments as Json)) events.push(occurrence(all[i]!));
    return { resultType: 'complete', events, cursor: cursorOf(i), truncated, hasMore: i < all.length, nextPollMs: Number(process.env.FIXTURE_POLL_MS ?? 500) };
}

// ---- push -------------------------------------------------------------------
const streams = new Map<string | number, () => void>();
function stream(id: string | number, p: Json) {
    requireMode(p.name, 'push');
    const all = readUpstream();
    const { start, truncated } = startPosition(p.cursor, p.maxAgeMs, all);
    const heartbeatMs = Math.max(500, Math.min(60000, typeof p.heartbeatMs === 'number' ? p.heartbeatMs : HEARTBEAT_DEFAULT));
    let pos = start;
    const meta = { [SUB_ID]: id };
    send({ jsonrpc: '2.0', method: 'notifications/events/active', params: { cursor: cursorOf(pos), truncated, heartbeatMs, _meta: meta } });
    const flush = () => {
        const now = readUpstream();
        for (; pos < now.length; pos++) {
            const e = now[pos]!;
            if (matches(e, p.name as string, p.arguments as Json)) {
                send({ jsonrpc: '2.0', method: 'notifications/events/event', params: { ...occurrence(e, cursorOf(pos + 1)), _meta: { ...meta, ...(e._meta ?? {}) } } });
            }
        }
    };
    flush();
    const tick = setInterval(flush, 150);
    const beat = setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/events/heartbeat', params: { cursor: cursorOf(pos), _meta: meta } }), heartbeatMs);
    streams.set(id, () => {
        clearInterval(tick);
        clearInterval(beat);
        streams.delete(id);
        log('note', { streamClosed: id });
    });
}

// ---- webhook ----------------------------------------------------------------
type Sub = { id: string; name: string; args: Json; url: string; secret: string; pos: number; refreshBefore: string; timer?: NodeJS.Timeout };
const subs = new Map<string, Sub>();
const verified = new Set<string>();
const PRINCIPAL = 'stdio-local'; // stdio: the launching user is the principal

function sign(secret: string, id: string, ts: number, body: string): string {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

async function post(sub: Sub, body: Json, webhookId: string): Promise<Response> {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000); // regenerated on every attempt
    return fetch(sub.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'content-type': 'application/json',
            'webhook-id': webhookId,
            'webhook-timestamp': String(ts),
            'webhook-signature': sign(sub.secret, webhookId, ts, raw),
            'X-MCP-Subscription-Id': sub.id
        },
        body: raw
    });
}

async function verify(sub: Sub): Promise<void> {
    const key = `${PRINCIPAL} ${sub.url}`;
    if (verified.has(key)) return;
    const challenge = randomBytes(16).toString('hex');
    let res: Response;
    try {
        res = await post(sub, { type: 'verification', challenge }, `msg_verification_${randomUUID()}`);
    } catch (e) {
        log('note', { verifyError: String(e) });
        throw rpcError(ERR.CallbackEndpointError, 'Callback endpoint unreachable', { reason: 'connection_refused' });
    }
    const text = await res.text().catch(() => '');
    let echoed: unknown;
    try {
        echoed = (JSON.parse(text) as Json).challenge;
    } catch {
        echoed = undefined;
    }
    if (!res.ok || echoed !== challenge) throw rpcError(ERR.CallbackEndpointError, 'Callback endpoint verification failed', { reason: 'challenge_failed' });
    verified.add(key);
}

async function deliverLoop(sub: Sub) {
    const all = readUpstream();
    while (sub.pos < all.length && subs.get(sub.id) === sub) {
        const e = all[sub.pos]!;
        if (!matches(e, sub.name, sub.args)) {
            sub.pos++;
            continue;
        }
        let ok = false;
        for (let attempt = 0; attempt < 4 && !ok; attempt++) {
            try {
                const res = await post(sub, occurrence(e, cursorOf(sub.pos + 1)), e.eventId);
                ok = res.ok;
                log('note', { delivered: e.eventId, status: res.status });
            } catch (err) {
                log('note', { deliverError: String(err) });
            }
            if (!ok) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        }
        if (!ok) break; // retry on the next tick
        sub.pos++;
    }
}

async function subscribe(p: Json): Promise<Json> {
    requireMode(p.name, 'webhook');
    const d = (p.delivery ?? {}) as Json;
    if (d.mode !== 'webhook' || typeof d.url !== 'string') throw rpcError(ERR.InvalidParams, 'delivery.mode must be webhook with a url');
    const url = new URL(d.url);
    if (url.protocol !== 'https:' && !(ALLOW_HTTP && url.protocol === 'http:')) throw rpcError(ERR.InvalidParams, 'Callback URL must be https');
    const secret = String(d.secret ?? '');
    const raw = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.alloc(0);
    if (raw.length < 24 || raw.length > 64) throw rpcError(ERR.InvalidParams, 'delivery.secret must be whsec_ + base64 of 24-64 bytes');
    const args = (p.arguments ?? {}) as Json;
    const id = 'sub_' + createHmac('sha256', 'fixture').update(JSON.stringify([PRINCIPAL, d.url, p.name, args])).digest('hex').slice(0, 16);
    const all = readUpstream();
    const existing = subs.get(id);
    const ttl = typeof p.ttlMs === 'number' ? Math.min(p.ttlMs, 3600000) : 600000;
    const refreshBefore = new Date(Date.now() + ttl).toISOString();
    let truncated = false;
    let pos: number;
    if (existing) {
        pos = existing.pos;
        existing.secret = secret;
        existing.refreshBefore = refreshBefore;
    } else {
        const s = startPosition(p.cursor, p.maxAgeMs, all);
        pos = s.start;
        truncated = s.truncated;
        const sub: Sub = { id, name: p.name as string, args, url: d.url, secret, pos, refreshBefore };
        await verify(sub); // proof of intent before any delivery
        subs.set(id, sub);
        sub.timer = setInterval(() => {
            if (Date.parse(sub.refreshBefore) < Date.now()) {
                clearInterval(sub.timer);
                subs.delete(id);
                log('note', { expired: id });
                return;
            }
            void deliverLoop(sub);
        }, 200);
    }
    return { resultType: 'complete', id, refreshBefore, cursor: cursorOf(existing ? existing.pos : pos), truncated };
}

function unsubscribe(p: Json): Json {
    const d = (p.delivery ?? {}) as Json;
    const id = 'sub_' + createHmac('sha256', 'fixture').update(JSON.stringify([PRINCIPAL, d.url, p.name, p.arguments ?? {}])).digest('hex').slice(0, 16);
    const sub = subs.get(id);
    if (sub) {
        clearInterval(sub.timer);
        subs.delete(id);
    }
    return { resultType: 'complete' };
}

// ---- dispatch -----------------------------------------------------------------
async function handle(m: Json) {
    const id = m.id as string | number | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => send({ jsonrpc: '2.0', id, result });
    try {
        switch (m.method) {
            case 'server/discover':
                if (REVISION === 'legacy') throw rpcError(-32601, 'Method not found');
                return reply({
                    resultType: 'complete',
                    supportedVersions: ['2026-07-28'],
                    capabilities: capabilities(),
                    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-events', version: '1.0.0' } },
                    ttlMs: 0,
                    cacheScope: 'private'
                });
            case 'initialize':
                return reply({ protocolVersion: '2025-11-25', capabilities: capabilities(), serverInfo: { name: 'fixture-events', version: '1.0.0' } });
            case 'notifications/initialized':
                return;
            case 'notifications/cancelled': {
                const close = streams.get(p.requestId as string | number);
                if (close) close();
                return;
            }
            case 'ping':
                return reply({});
            case 'tools/list':
                return reply({ resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'private' });
            case 'subscriptions/listen': {
                if (!LIST_CHANGED || (p.notifications as Json | undefined)?.eventsListChanged !== true) throw rpcError(-32601, 'Method not found');
                // The request stays open: an acknowledgement first, then change notices tagged with its id.
                send({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: { eventsListChanged: true }, _meta: { [SUB_ID]: id } } });
                setTimeout(() => {
                    EVENT_TYPES.push({ name: 'alert.raised', description: 'An alert was raised (added while running).', delivery: ['poll'], inputSchema: { type: 'object', properties: {} }, payloadSchema: { type: 'object', properties: {} } } as (typeof EVENT_TYPES)[number]);
                    send({ jsonrpc: '2.0', method: 'notifications/events/list_changed', params: { _meta: { [SUB_ID]: id } } });
                }, Number(process.env.FIXTURE_ADD_TYPE_AFTER_MS ?? 700));
                return;
            }
            case 'events/list':
                return reply({ resultType: 'complete', events: EVENT_TYPES });
            case 'events/poll':
                return reply(poll(p));
            case 'events/stream':
                return stream(id!, p);
            case 'events/subscribe':
                return reply(await subscribe(p));
            case 'events/unsubscribe':
                return reply(unsubscribe(p));
            default:
                if (id !== undefined) throw rpcError(-32601, `Method not found: ${String(m.method)}`);
        }
    } catch (e) {
        const rpc = (e as { rpc?: Json }).rpc ?? { code: -32603, message: String(e) };
        if (id !== undefined) send({ jsonrpc: '2.0', id, error: rpc });
    }
}

createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let m: Json;
    try {
        m = JSON.parse(line);
    } catch {
        return;
    }
    log('in', m);
    void handle(m);
});
process.stdin.on('end', () => process.exit(0));
watchFile(UPSTREAM, { interval: 200 }, () => {}); // keep fs polling warm
