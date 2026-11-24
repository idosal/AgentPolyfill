// One mailbox: the hooks its owner registered, and the deliveries waiting for
// the owner to collect. One Durable Object per mailbox, so mailboxes share
// nothing. Everything that must outlive a restart is in the object's SQLite
// storage; the only state in memory is a challenge waiting for its answer.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';
import { HOOK_RE, SUBPROTOCOL, type ClientMessage, type DeliveryHeaders, type RelayMessage } from './protocol.ts';

/** Deliveries one mailbox may hold at once, and their total size. Past either, the server is told to retry. */
const MAX_QUEUED = 500;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
/** Hooks one mailbox may have registered at once. */
const MAX_HOOKS = 64;
/** How long a server's verification challenge waits for the plugin's answer. */
const ASK_TIMEOUT_MS = 4000;
/** An uncollected delivery is dropped after a week; a hook nobody used for 30 days is retired. */
const DELIVERY_TTL_S = 7 * 24 * 3600;
const HOOK_IDLE_TTL_S = 30 * 24 * 3600;
/** How long a retired hook keeps answering 410 before it is forgotten (404). */
const TOMBSTONE_TTL_S = 7 * 24 * 3600;
const MAX_FRAME = 256 * 1024;
const MAX_ANSWER_BODY = 64 * 1024;
const CLEANUP_EVERY_MS = 6 * 3600 * 1000;
/** Retired hooks remembered (to answer 410) at most; and challenges waiting for an answer at once. */
const MAX_TOMBSTONES = 256;
const MAX_ASKS = 16;
/** The layout of this mailbox's storage. */
const SCHEMA = 2;

export type Delivery = { hook: string; headers: DeliveryHeaders; body: string; receivedAt: number };
export type DeliverResult = { status: number; body?: string; retryAfter?: number };
type Answer = { status: number; body?: string };
/** What a socket carries: which connection it is, and the hooks it asked for. */
type Attachment = { gen: number; hooks: string[] };

const now = () => Math.floor(Date.now() / 1000);
const positive = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const errorBody = (error: string) => JSON.stringify({ error });
async function sha256(text: string): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Mailbox extends DurableObject<Env> {
    #asks = new Map<string, (a: Answer | undefined) => void>();
    #hasTables = false;
    #gen?: number;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // Keep-alive pings are answered without waking a hibernating mailbox.
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }

    get #sql(): SqlStorage {
        return this.ctx.storage.sql;
    }

    /** Whether this mailbox has ever been used. A delivery to a made-up address must not create storage. */
    #exists(): boolean {
        if (this.#hasTables) return true;
        const n = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'hooks'").one().n;
        if (n > 0) this.#create(); // brings storage made by an earlier version up to date
        return this.#hasTables;
    }

    /** Creates the tables, or brings older ones up to this version. Safe to run any number of times. */
    #create(): void {
        if (this.#hasTables) return;
        this.#sql.exec(`
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS hooks (
                hook TEXT PRIMARY KEY,
                created INTEGER NOT NULL,
                seen INTEGER NOT NULL,
                removed INTEGER NOT NULL DEFAULT 0
            );
        `);
        const version = this.#sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema'").toArray()[0]?.value ?? 0;
        if (version < SCHEMA) {
            // Version 2 keys a delivery by its content as well as its id. Rows held under the first
            // layout are carried over, each under a key of its own (a retry of one would be stored
            // beside it, and the plugin takes each delivery once in any case).
            const old = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").one().n > 0;
            const hasDigest = old && this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pragma_table_info('deliveries') WHERE name = 'digest'").one().n > 0;
            if (old && !hasDigest) this.#sql.exec('ALTER TABLE deliveries RENAME TO deliveries_v1');
            this.#sql.exec(`
                CREATE TABLE IF NOT EXISTS deliveries (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    hook TEXT NOT NULL,
                    webhook_id TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    headers TEXT NOT NULL,
                    body TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    received_at INTEGER NOT NULL,
                    UNIQUE (hook, webhook_id, digest)
                );
            `);
            if (old && !hasDigest) {
                this.#sql.exec("INSERT INTO deliveries (seq, hook, webhook_id, digest, headers, body, size, received_at) SELECT seq, hook, webhook_id, 'v1:' || seq, headers, body, size, received_at FROM deliveries_v1 ORDER BY seq");
                this.#sql.exec('DROP TABLE deliveries_v1');
            }
            this.#sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", SCHEMA);
        }
        this.#hasTables = true;
    }

    /** The number of the connection that reads this mailbox now. Kept in storage: it must survive hibernation. */
    #generation(): number {
        if (this.#gen === undefined) this.#gen = this.#exists() ? (this.#sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'generation'").toArray()[0]?.value ?? 0) : 0;
        return this.#gen;
    }

    // ---- the plugin's socket ---------------------------------------------------------

    /** The Worker has already checked the mailbox key and the access key. */
    async fetch(_request: Request): Promise<Response> {
        // Clear out first, while the hooks the outgoing reader holds still count as in use.
        this.#cleanup();
        // One reader per mailbox: a newer connection (a restarted plugin) replaces an older one. The
        // older socket may still deliver a message or two after this; its number no longer matches,
        // so nothing it says changes the mailbox.
        this.#create();
        const gen = this.#generation() + 1;
        this.#sql.exec("INSERT INTO meta (key, value) VALUES ('generation', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", gen);
        this.#gen = gen;
        for (const old of this.ctx.getWebSockets()) old.close(4001, 'replaced by a newer connection');
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ gen, hooks: [] } satisfies Attachment);
        this.#send(server, { t: 'hello', v: 1, now: now() });
        return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
    }

    #send(ws: WebSocket, m: RelayMessage): void {
        try {
            ws.send(JSON.stringify(m));
        } catch {
            // the socket is closing; what it missed stays queued
        }
    }

    /** Open sockets that asked for this hook on their current connection. */
    #readers(hook: string): WebSocket[] {
        const gen = this.#generation();
        return this.ctx.getWebSockets().filter((ws) => {
            const a = ws.deserializeAttachment() as Attachment | null;
            return ws.readyState === WebSocket.OPEN && a?.gen === gen && a.hooks.includes(hook);
        });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (!att || att.gen !== this.#generation()) return; // a replaced connection: it has no say any more
        if (typeof message !== 'string' || message.length > MAX_FRAME) return this.#send(ws, { t: 'error', message: 'expected a JSON text frame of at most 256 KiB' });
        let m: ClientMessage;
        try {
            m = JSON.parse(message) as ClientMessage;
        } catch {
            return this.#send(ws, { t: 'error', message: 'expected JSON' });
        }
        if (typeof m !== 'object' || m === null) return this.#send(ws, { t: 'error', message: 'expected a JSON object' });
        switch (m.t) {
            case 'add':
            case 'remove': {
                const n = Number(m.n);
                if (typeof m.hook !== 'string' || !HOOK_RE.test(m.hook)) return this.#send(ws, { t: 'error', n, message: 'a hook is 16 to 64 characters of A-Z, a-z, 0-9, "_" and "-"' });
                const attached = att.hooks;
                if (m.t === 'remove') {
                    if (this.#exists()) {
                        this.#sql.exec('UPDATE hooks SET removed = 1, seen = ? WHERE hook = ?', now(), m.hook);
                        this.#sql.exec('DELETE FROM deliveries WHERE hook = ?', m.hook);
                    }
                    ws.serializeAttachment({ gen: att.gen, hooks: attached.filter((h) => h !== m.hook) } satisfies Attachment);
                    if (this.#exists()) {
                        // Retired hooks are remembered so late deliveries get 410, but only so many of them.
                        this.#sql.exec('DELETE FROM hooks WHERE removed = 1 AND hook NOT IN (SELECT hook FROM hooks WHERE removed = 1 ORDER BY seen DESC, hook LIMIT ?)', MAX_TOMBSTONES);
                    }
                    return this.#send(ws, { t: 'ok', n });
                }
                this.#create();
                const known = this.#sql.exec<{ removed: number }>('SELECT removed FROM hooks WHERE hook = ?', m.hook).toArray()[0];
                if (!known || known.removed) {
                    const active = this.#sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hooks WHERE removed = 0').one().n;
                    const most = positive(this.env.MAX_HOOKS, MAX_HOOKS);
                    if (active >= most) return this.#send(ws, { t: 'error', n, message: `this mailbox already has ${most} hooks` });
                }
                this.#sql.exec('INSERT INTO hooks (hook, created, seen, removed) VALUES (?, ?, ?, 0) ON CONFLICT (hook) DO UPDATE SET seen = excluded.seen, removed = 0', m.hook, now(), now());
                if (!attached.includes(m.hook)) ws.serializeAttachment({ gen: att.gen, hooks: [...attached, m.hook] } satisfies Attachment);
                await this.#armCleanup();
                // Everything held for this hook, oldest first. Each comes again on a later connection until it is acked.
                const queued = this.#sql.exec<{ seq: number; headers: string; body: string; received_at: number }>('SELECT seq, headers, body, received_at FROM deliveries WHERE hook = ? ORDER BY seq', m.hook).toArray();
                this.#send(ws, { t: 'ok', n, queued: queued.length });
                for (const d of queued) this.#send(ws, { t: 'delivery', seq: d.seq, hook: m.hook, headers: JSON.parse(d.headers) as DeliveryHeaders, body: d.body, receivedAt: d.received_at });
                return;
            }
            case 'ack': {
                if (!Array.isArray(m.seqs) || !this.#exists()) return;
                for (const seq of m.seqs.slice(0, 1000)) if (Number.isSafeInteger(seq)) this.#sql.exec('DELETE FROM deliveries WHERE seq = ?', seq);
                return;
            }
            case 'answer': {
                const resolve = typeof m.id === 'string' ? this.#asks.get(m.id) : undefined;
                if (!resolve) return; // too late, or never asked
                const status = Number(m.status);
                const body = typeof m.body === 'string' && m.body.length <= MAX_ANSWER_BODY ? m.body : undefined;
                resolve(Number.isInteger(status) && status >= 200 && status <= 599 ? { status, body } : undefined);
                return;
            }
            default:
                return this.#send(ws, { t: 'error', message: 'unknown message type' });
        }
    }

    async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
        try {
            ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, 'closing');
        } catch {
            // already closed
        }
    }

    // ---- an MCP server's delivery ----------------------------------------------------

    /** The Worker has already checked size, encoding, the Standard Webhooks headers and the timestamp. */
    async deliver(d: Delivery): Promise<DeliverResult> {
        if (!this.#exists()) return { status: 404, body: errorBody('no such webhook address') };
        const hook = this.#sql.exec<{ removed: number }>('SELECT removed FROM hooks WHERE hook = ?', d.hook).toArray()[0];
        if (!hook) return { status: 404, body: errorBody('no such webhook address') };
        // 410: the SEP has servers stop retrying this delivery.
        if (hook.removed) return { status: 410, body: errorBody('this webhook address was removed') };
        let parsed: unknown;
        try {
            parsed = JSON.parse(d.body);
        } catch {
            return { status: 400, body: errorBody('the body is not JSON') };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 400, body: errorBody('the body is not a JSON object') };
        if ((parsed as { type?: unknown }).type === 'verification') return this.#ask(d);

        const id = d.headers['webhook-id'];
        // A retry keeps its webhook-id: accept it again without storing it twice. Only the very same
        // delivery counts as a retry: same timestamp, signature, subscription and body. Anyone can
        // POST here under any id, so anything that differs in what the plugin will check is kept as
        // its own delivery, and cannot push a genuine one out.
        const digest = await sha256(`${d.headers['webhook-timestamp']}\n${d.headers['webhook-signature']}\n${d.headers['x-mcp-subscription-id'] ?? ''}\n${d.body}`);
        if (this.#sql.exec('SELECT 1 FROM deliveries WHERE hook = ? AND webhook_id = ? AND digest = ?', d.hook, id, digest).toArray().length) return { status: 200 };
        const size = new TextEncoder().encode(d.body).byteLength;
        const held = this.#sql.exec<{ n: number; bytes: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM deliveries').one();
        if (held.n >= positive(this.env.MAX_QUEUED, MAX_QUEUED) || held.bytes + size > positive(this.env.MAX_QUEUED_BYTES, MAX_QUEUED_BYTES)) {
            return { status: 503, body: errorBody('this mailbox is full until its owner collects'), retryAfter: 60 };
        }
        // Written before the 2xx (the storage write is confirmed before the response leaves this object).
        const seq = this.#sql
            .exec<{ seq: number }>('INSERT INTO deliveries (hook, webhook_id, digest, headers, body, size, received_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq', d.hook, id, digest, JSON.stringify(d.headers), d.body, size, d.receivedAt)
            .one().seq;
        this.#sql.exec('UPDATE hooks SET seen = ? WHERE hook = ?', d.receivedAt, d.hook);
        for (const ws of this.#readers(d.hook)) this.#send(ws, { t: 'delivery', seq, hook: d.hook, headers: d.headers, body: d.body, receivedAt: d.receivedAt });
        return { status: 200 };
    }

    /**
     * A verification challenge. Only a receiver that can verify its signature may echo it, and
     * this relay holds no secret, so it asks the connected plugin and passes the answer on; with
     * no plugin connected it answers 503. (That is this relay's behaviour, not something the
     * server can check: a relay that chose to could echo the challenge itself. It would gain an
     * address confirmed without the plugin's say, and still could not make an event up.)
     */
    async #ask(d: Delivery): Promise<DeliverResult> {
        const readers = this.#readers(d.hook);
        if (!readers.length) return { status: 503, body: errorBody('the receiver is not connected right now'), retryAfter: 30 };
        // Anyone can POST a challenge; only so many wait for an answer at once.
        if (this.#asks.size >= MAX_ASKS) return { status: 503, body: errorBody('too many challenges are waiting'), retryAfter: 5 };
        const id = crypto.randomUUID();
        const answer = await new Promise<Answer | undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), positive(this.env.ASK_TIMEOUT_MS, ASK_TIMEOUT_MS));
            this.#asks.set(id, (a) => {
                clearTimeout(timer);
                resolve(a);
            });
            for (const ws of readers) this.#send(ws, { t: 'ask', id, hook: d.hook, headers: d.headers, body: d.body, receivedAt: d.receivedAt });
        });
        this.#asks.delete(id);
        if (!answer) return { status: 503, body: errorBody('the receiver did not answer in time'), retryAfter: 30 };
        return { status: answer.status, body: answer.body };
    }

    // ---- clearing out ----------------------------------------------------------------

    #cleanup(): void {
        if (!this.#exists()) return;
        const t = now();
        this.#sql.exec('DELETE FROM deliveries WHERE received_at < ?', t - positive(this.env.DELIVERY_TTL_S, DELIVERY_TTL_S));
        // A hook somebody is connected for is in use, however quiet its server has been.
        const inUse = new Set<string>();
        for (const ws of this.ctx.getWebSockets()) for (const h of (ws.deserializeAttachment() as Attachment | null)?.hooks ?? []) inUse.add(h);
        for (const h of inUse) this.#sql.exec('UPDATE hooks SET seen = ? WHERE hook = ? AND removed = 0', t, h);
        const idle = t - positive(this.env.HOOK_IDLE_TTL_S, HOOK_IDLE_TTL_S);
        this.#sql.exec('DELETE FROM deliveries WHERE hook IN (SELECT hook FROM hooks WHERE removed = 0 AND seen < ?)', idle);
        this.#sql.exec('UPDATE hooks SET removed = 1, seen = ? WHERE removed = 0 AND seen < ?', t, idle);
        this.#sql.exec('DELETE FROM hooks WHERE removed = 1 AND seen < ?', t - TOMBSTONE_TTL_S);
    }

    /**
     * How often this mailbox is cleared out: often enough that a delivery outlives its time to live
     * by a twenty-fourth of it at most (an hour, for a day), and never less often than every six hours.
     */
    #cleanupEveryMs(): number {
        const ttlMs = positive(this.env.DELIVERY_TTL_S, DELIVERY_TTL_S) * 1000;
        return Math.min(CLEANUP_EVERY_MS, Math.max(15 * 60 * 1000, Math.floor(ttlMs / 24)));
    }

    async #armCleanup(): Promise<void> {
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.#cleanupEveryMs());
    }

    async alarm(): Promise<void> {
        this.#cleanup();
        if (!this.#exists()) return;
        const left = this.#sql.exec<{ n: number }>('SELECT (SELECT COUNT(*) FROM hooks) + (SELECT COUNT(*) FROM deliveries) AS n').one().n;
        if (left > 0) await this.ctx.storage.setAlarm(Date.now() + this.#cleanupEveryMs());
    }
}
