// The plugin's side of the relay (see relay/README.md).
//
// A webhook-only MCP server needs a public https address to deliver to. With a
// relay set up, each webhook watch gets a lasting address on it, in its MCP
// server's own mailbox, and this client collects what arrives at one mailbox over
// one WebSocket: at once while Claude Code is open, and on the next start for
// what arrived while it was closed.
//
// The relay is not trusted with anything. It never gets a subscription's
// secret; every delivery it hands over goes through the same check as a direct
// one (handleDelivery), and a server's verification challenge is answered
// here. A relay that misbehaves can delay or drop events. It cannot make one up,
// and nothing it says in its own words is passed on: its errors are reported as
// "the relay refused", never quoted, because what this plugin reports reaches a model.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACCESS_KEY_RE, ACCESS_PREFIX, HOOK_RE, KEY_PREFIX, KEY_RE, mailboxIdOf, SUBPROTOCOL, type ClientMessage, type RelayMessage } from '../mod/relay/src/protocol.ts';
import { LocalError } from './untrusted.ts';
import { handleDelivery, isChallenge, type Hook } from './webhooks.ts';

export type RelaySettings = { url: string; accessKey?: string; source: string; /** The public relay, which someone else runs. */ isPublic?: true };

/**
 * A relay anyone may use, for people with no Cloudflare account of their own to deploy one to. It
 * is never used unless the user asks for it by name (MCP_EVENTS_RELAY=public): whoever runs a relay
 * can read the event payloads that pass through it. Its source is mod/relay, deployed from
 * wrangler.public.jsonc.
 */
export const PUBLIC_RELAY = { url: 'https://mcp-events-public-relay.idosalomon.workers.dev', operator: 'Ido Salomon, the author of this mod', retention: '24 hours' };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checked(url: unknown, accessKey: unknown, source: string, log: (s: string) => void, dev = false): RelaySettings | undefined {
    const ignore = (why: string) => void log(`relay settings from ${source} ignored: ${why}`);
    if (typeof url !== 'string' || !url.trim()) return ignore('no url');
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return ignore('the url cannot be read');
    }
    // A webhook address must be https (SEP-3415). Plain http on this machine is for testing only (MCP_EVENTS_DEV=1).
    if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return ignore('the url must be https');
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return ignore('the url must be just the relay\'s address, e.g. https://mcp-events-relay.example.workers.dev');
    if (accessKey !== undefined && accessKey !== '' && (typeof accessKey !== 'string' || !ACCESS_KEY_RE.test(accessKey))) return ignore('the access key must be 16 to 128 characters of A-Z, a-z, 0-9, "_" and "-"');
    return { url: u.origin, ...(accessKey ? { accessKey: accessKey as string } : {}), source };
}

/**
 * Where the relay is, if one is set up. A relay of the user's own comes first:
 *   MCP_EVENTS_RELAY_URL (and MCP_EVENTS_RELAY_ACCESS_KEY), or else a private file,
 *   ~/.mcp-events/relay.json ({ "url": "...", "accessKey": "..." }), which `npm run setup`
 *   in mod/relay writes. MCP_EVENTS_RELAY_FILE names another file.
 * With none of those, and only if the user asked for it by name (MCP_EVENTS_RELAY=public), the
 * public relay.
 */
export function readRelaySettings(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = () => {}): RelaySettings | undefined {
    return ownRelaySettings(env, log) ?? publicRelaySettings(env, log);
}

function publicRelaySettings(env: NodeJS.ProcessEnv, log: (s: string) => void): RelaySettings | undefined {
    const asked = (env.MCP_EVENTS_RELAY ?? '').trim().toLowerCase();
    if (!asked) return undefined;
    if (asked !== 'public') return void log('MCP_EVENTS_RELAY is set to something other than "public", and is ignored');
    // For tests on one machine only: a stand-in for the public relay.
    const standIn = env.MCP_EVENTS_DEV === '1' ? env.MCP_EVENTS_PUBLIC_RELAY_URL : undefined;
    const settings = checked(standIn || PUBLIC_RELAY.url, undefined, 'MCP_EVENTS_RELAY=public', log, env.MCP_EVENTS_DEV === '1');
    return settings && { ...settings, isPublic: true };
}

function ownRelaySettings(env: NodeJS.ProcessEnv, log: (s: string) => void): RelaySettings | undefined {
    if (env.MCP_EVENTS_RELAY_URL) return checked(env.MCP_EVENTS_RELAY_URL, env.MCP_EVENTS_RELAY_ACCESS_KEY, 'MCP_EVENTS_RELAY_URL', log, env.MCP_EVENTS_DEV === '1');
    const path = env.MCP_EVENTS_RELAY_FILE || join(env.HOME || homedir(), '.mcp-events', 'relay.json');
    const ignore = (why: string) => void log(`relay settings in ${path} ignored: ${why}`);
    let fd: number | undefined;
    try {
        // Check and read the same open file. NONBLOCK lets a FIFO be refused without waiting.
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile()) return ignore('not a regular file');
        // Windows keeps who may read a file in its ACL, not in these bits (which always read as open
        // there), and a file under the user's own profile folder is the user's.
        if (process.platform !== 'win32' && stat.mode & 0o077) return ignore('group or others can read it; use chmod 600');
        if (process.getuid && stat.uid !== process.getuid()) return ignore('not owned by the current user');
        let value: { url?: unknown; accessKey?: unknown };
        try {
            value = JSON.parse(readFileSync(fd, 'utf8')) as typeof value;
        } catch {
            return ignore('cannot read JSON');
        }
        if (typeof value !== 'object' || value === null) return ignore('not a JSON object');
        return checked(value.url, value.accessKey, path, log, env.MCP_EVENTS_DEV === '1');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ignore('cannot read the file');
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * The mailbox keys of a project, kept in its state folder, readable only by the user: one mailbox
 * per MCP server (from 0.7.0), so that what one server posts to its own addresses can fill only
 * its own mailbox, never another server's. `legacy` is the one mailbox a project had before 0.7.0,
 * kept only while a watch still has its address there (the watch moves to its server's mailbox the
 * next time it runs). Keys belong to the relay they were made for: they are not shown to another
 * one, and keys saved without saying which relay they are for are not used at all.
 */
type SavedKeys = { relay?: unknown; key?: unknown; servers?: unknown };
const keysFile = (dir: string) => join(dir, 'relay-mailbox.json');

function readKeys(dir: string, relay: string): { servers: Record<string, string>; legacy?: string } {
    const file = keysFile(dir);
    if (!existsSync(file)) return { servers: {} };
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedKeys;
        if (saved.relay !== relay) return { servers: {} };
        if (process.platform !== 'win32') chmodSync(file, 0o600);
        const servers: Record<string, string> = {};
        if (typeof saved.servers === 'object' && saved.servers !== null && !Array.isArray(saved.servers)) {
            for (const [name, key] of Object.entries(saved.servers as Record<string, unknown>)) if (typeof key === 'string' && KEY_RE.test(key)) servers[name] = key;
        }
        return { servers, ...(typeof saved.key === 'string' && KEY_RE.test(saved.key) ? { legacy: saved.key } : {}) };
    } catch {
        // unreadable: new keys are made (watches at the old addresses subscribe again at the new)
        return { servers: {} };
    }
}

function writeKeys(dir: string, relay: string, keys: { servers: Record<string, string>; legacy?: string }): void {
    writeFileSync(keysFile(dir), JSON.stringify({ relay, servers: keys.servers, ...(keys.legacy ? { key: keys.legacy } : {}) }) + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(keysFile(dir), 0o600);
}

/** The key of one MCP server's mailbox in this project: made once, then kept. */
export function serverMailboxKey(dir: string, relay: string, server: string): string {
    const keys = readKeys(dir, relay);
    const have = keys.servers[server];
    if (have) return have;
    keys.servers[server] = randomBytes(32).toString('base64url');
    writeKeys(dir, relay, keys);
    return keys.servers[server];
}

/** The key of the one mailbox this project had before 0.7.0, while it is kept. */
export function legacyMailboxKey(dir: string, relay: string): string | undefined {
    return readKeys(dir, relay).legacy;
}

/** Forgets the project's old mailbox: no watch has its address there any more. */
export function dropLegacyMailboxKey(dir: string, relay: string): void {
    const keys = readKeys(dir, relay);
    if (!keys.legacy) return;
    delete keys.legacy;
    writeKeys(dir, relay, keys);
}

export type RelayOptions = {
    settings: RelaySettings;
    key: string;
    log?: (s: string) => void;
    /** First wait before reconnecting; doubles up to a minute. */
    backoffMs?: number;
    /** Whether this process still runs the project's watches. A mailbox another process took over is taken back only if so. */
    owner?: () => boolean;
    /** Opens the socket (tests stand in for the relay with one of their own). */
    socket?: (url: string, protocols: string[]) => WebSocket;
    /** The most bytes of delivery bodies waiting to be judged at once (tests lower it). */
    maxWaitingBytes?: number;
};

type Pending = { resolve: (m: Extract<RelayMessage, { t: 'ok' }>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const REQUEST_TIMEOUT_MS = 10000;
const FLUSH_TIMEOUT_MS = 20000;
const PING_EVERY_MS = 25000;
const PONG_WITHIN_MS = 10000;
/** After another connection took this mailbox over, wait before taking it back, so two processes don't trade it forever. */
const REPLACED_WAIT_MS = 30000;
/**
 * The largest frame taken from the relay: a delivery's body is at most 256 KiB (handleDelivery
 * measures it), which as a JSON string inside the frame is at most about twice that, plus headers.
 * And the most deliveries waiting to be judged, in number and in bytes of body.
 */
const MAX_FRAME = 768 * 1024;
const MAX_WAITING = 2000;
/** Acks are sent together: at most this many in one message (the relay takes up to 1,000), at most this long after the first. */
const ACK_BATCH = 500;
const ACK_EVERY_MS = 200;
/** More than a relay holds for one mailbox by default (16 MiB), so what a relay kept while Claude Code was closed fits. */
const MAX_WAITING_BYTES = 24 * 1024 * 1024;
const HEADER = /^[\x20-\x7e]{1,2048}$/;

export class RelayClient {
    readonly url: string;
    #o: RelayOptions;
    #log: (s: string) => void;
    #mailbox?: string;
    #hooks = new Map<string, Hook>();
    #ws?: WebSocket;
    #open?: Promise<void>;
    #pending = new Map<number, Pending>();
    #n = 0;
    #closed = false;
    /** Deliveries are judged one at a time, in the order the relay sent them. */
    #work: Promise<void> = Promise.resolve();
    /** Per hook: how many held deliveries an `add` is still waiting for. */
    #flush = new Map<string, { left: number; done: () => void }>();
    #waiting = 0;
    #waitingBytes = 0;
    #acks: number[] = [];
    #ackTimer?: NodeJS.Timeout;
    /** Hooks asked for on the current connection. */
    #attached = new Set<string>();
    /**
     * Hooks the relay still sends for on this connection although collecting for them stopped here
     * (the relay is told only when an address is retired), and which of those had a delivery arrive
     * meanwhile. The relay sends what it holds for a hook once per connection, so collecting such a
     * hook again takes a new connection.
     */
    #stale = new Set<string>();
    #missed = new Set<string>();
    #backoff: number;
    #retry?: NodeJS.Timeout;
    #ping?: NodeJS.Timeout;
    #pong?: NodeJS.Timeout;

    constructor(o: RelayOptions) {
        this.#o = o;
        this.url = o.settings.url;
        this.#log = o.log ?? (() => {});
        this.#backoff = o.backoffMs ?? 1000;
    }

    async #mailboxId(): Promise<string> {
        this.#mailbox ??= await mailboxIdOf(this.#o.key);
        return this.#mailbox;
    }

    #protocols(): string[] {
        return [SUBPROTOCOL, KEY_PREFIX + this.#o.key, ...(this.#o.settings.accessKey ? [ACCESS_PREFIX + this.#o.settings.accessKey] : [])];
    }

    /** Opens the socket, or says plainly why the relay would not have it. */
    connect(): Promise<void> {
        if (this.#closed) return Promise.reject(new LocalError('the relay connection is closed'));
        this.#open ??= this.#dial().catch(async () => {
            this.#open = undefined;
            throw new LocalError(await this.#diagnose());
        });
        return this.#open;
    }

    async #dial(): Promise<void> {
        const mailbox = await this.#mailboxId();
        const ws = (this.#o.socket ?? ((u, p) => new WebSocket(u, p)))(`${this.url.replace(/^http/, 'ws')}/mailboxes/${mailbox}/socket`, this.#protocols());
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error('no answer in time'));
            }, REQUEST_TIMEOUT_MS);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            ws.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('the connection was refused'));
            }, { once: true });
        });
        this.#ws = ws;
        this.#attached.clear();
        this.#stale.clear();
        this.#missed.clear();
        ws.addEventListener('message', (e) => this.#onMessage(ws, e.data));
        ws.addEventListener('close', (e) => this.#onClose(ws, e.code));
        this.#backoff = this.#o.backoffMs ?? 1000;
        this.#ping = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send('ping');
            this.#pong ??= setTimeout(() => ws.close(), PONG_WITHIN_MS);
            this.#pong.unref();
        }, PING_EVERY_MS);
        this.#ping.unref();
    }

    /** A refused WebSocket says nothing about why, so ask the same address over plain HTTP. Only the status is used: the relay's own words are not repeated. */
    async #diagnose(): Promise<string> {
        const where = `the relay at ${this.url}`;
        try {
            const mailbox = await this.#mailboxId();
            const u = new URL(`${this.url}/mailboxes/${mailbox}/socket`);
            const status = await new Promise<number>((resolve, reject) => {
                // Asked as the WebSocket itself asks, so the answer is the one the WebSocket got.
                const headers = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-protocol': this.#protocols().join(', ') };
                const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'GET', headers, timeout: 8000 }, (res) => {
                    resolve(res.statusCode ?? 0);
                    res.destroy(); // the body is not read
                });
                req.on('upgrade', (_res, socket) => {
                    socket.destroy();
                    resolve(101);
                });
                req.on('timeout', () => req.destroy(new Error('timed out')));
                req.on('error', reject);
                req.end();
            });
            if (status === 403) return `${where} needs its access key, and the one given is missing or wrong. Set MCP_EVENTS_RELAY_ACCESS_KEY, or "accessKey" in ~/.mcp-events/relay.json (\`npm run setup\` in relay/ writes it).`;
            if (status === 401) return `${where} refused this project's mailbox key.`;
            if (status === 503)
                return this.#o.settings.isPublic
                    ? `${where} is not accepting connections right now (it refuses them while it cannot check its limits). Try again later, or set up a relay of your own (/mcp-events:relay-setup).`
                    : `${where} is not accepting connections (status 503): a relay with no access key set refuses everyone (see relay/README.md), and one that requires rate limits refuses while it cannot check them.`;
            if (status === 426) return `${where} accepts these credentials, but the WebSocket could not be opened.`;
            if (status === 429) return `${where} is not opening new mailboxes or connections right now (it limits how many it opens). Try again later${this.#o.settings.isPublic ? ', or set up a relay of your own (/mcp-events:relay-setup)' : ''}.`;
            if (status === 101) return `${where} accepted the connection on a second try; try again.`;
            return `${where} answered status ${status}. Is that address an mcp-events relay?`;
        } catch (e) {
            const sys = (e as { code?: unknown })?.code;
            return `cannot reach ${where}${typeof sys === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(sys) ? ` (${sys})` : ''}`;
        }
    }

    /**
     * Acknowledges a delivery. Acks go out together, a moment after the first, so that a busy
     * project sends the relay one message for many deliveries: the relay closes a connection that
     * sends more messages in a minute than a client has reason to.
     */
    #ack(seq: number): void {
        this.#acks.push(seq);
        if (this.#acks.length >= ACK_BATCH) return this.#flushAcks();
        if (this.#ackTimer) return;
        this.#ackTimer = setTimeout(() => this.#flushAcks(), ACK_EVERY_MS);
        this.#ackTimer.unref();
    }

    #flushAcks(): void {
        clearTimeout(this.#ackTimer);
        this.#ackTimer = undefined;
        if (!this.#acks.length) return;
        // Acks that cannot be sent now are not kept: unacknowledged deliveries come again on the next
        // connection, and the watch's replay guard takes each only once.
        this.#send({ t: 'ack', seqs: this.#acks.splice(0) });
    }

    #send(m: ClientMessage): void {
        if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(m));
    }

    #request(m: { t: 'add' | 'remove'; hook: string }): Promise<Extract<RelayMessage, { t: 'ok' }>> {
        const n = ++this.#n;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(n);
                reject(new LocalError(`the relay did not answer (${m.t})`));
            }, REQUEST_TIMEOUT_MS);
            this.#pending.set(n, { resolve, reject, timer });
            this.#send({ ...m, n });
        });
    }

    #onMessage(ws: WebSocket, data: unknown): void {
        if (ws !== this.#ws || typeof data !== 'string') return;
        if (data === 'pong') {
            clearTimeout(this.#pong);
            this.#pong = undefined;
            return;
        }
        if (data.length > MAX_FRAME) return void this.#log('relay: ignored an oversized frame');
        let m: RelayMessage;
        try {
            m = JSON.parse(data) as RelayMessage;
        } catch {
            return;
        }
        // The relay is not trusted to send well-formed frames either.
        if (typeof m !== 'object' || m === null || typeof (m as { t?: unknown }).t !== 'string') return;
        if (m.t === 'ok' || m.t === 'error') {
            const p = typeof m.n === 'number' ? this.#pending.get(m.n) : undefined;
            if (!p) return;
            clearTimeout(p.timer);
            this.#pending.delete(m.n as number);
            if (m.t === 'ok') p.resolve(m);
            else p.reject(new LocalError('the relay refused the request')); // its own words are not repeated
        } else if (m.t === 'delivery') {
            const d = m;
            const headers = d.headers as Record<string, unknown> | undefined;
            const sound =
                Number.isSafeInteger(d.seq) && typeof d.hook === 'string' && HOOK_RE.test(d.hook) && typeof d.body === 'string' && Number.isFinite(d.receivedAt) && typeof headers === 'object' && headers !== null &&
                Object.values(headers).every((v) => typeof v === 'string' && HEADER.test(v));
            if (!sound) {
                // It can never be taken, so it is not left to take up the mailbox's room (anyone who knows a
                // webhook address can post one): it is dropped at the relay, as a delivery that fails its signature is.
                if (Number.isSafeInteger(d.seq)) this.#ack(d.seq);
                return void this.#log('relay: dropped a malformed delivery');
            }
            // More waiting than could be real: leave the rest at the relay, which sends them again on the next connection.
            const bytes = d.body.length;
            if (this.#waiting >= MAX_WAITING || this.#waitingBytes + bytes > (this.#o.maxWaitingBytes ?? MAX_WAITING_BYTES)) {
                if (this.#hooks.has(d.hook)) this.#missed.add(d.hook);
                return;
            }
            this.#waiting++;
            this.#waitingBytes += bytes;
            this.#work = this.#work.then(async () => {
                try {
                    const hook = this.#hooks.get(d.hook);
                    // Not collected for here just now: it stays at the relay, and is asked for again when it is.
                    if (!hook) this.#missed.add(d.hook);
                    if (hook) {
                        let r: { status: number; reason?: string };
                        try {
                            r = await handleDelivery(hook, d.headers, d.body, { nowS: d.receivedAt });
                        } catch {
                            r = { status: 503, reason: 'could not judge a delivery' };
                        }
                        // 503: it could not be written down. Leave it at the relay; it comes again on the next connection.
                        if (r.status === 503) this.#log(`relay: ${r.reason}`);
                        else {
                            if (r.status !== 200) this.#log(`relay: dropped a delivery that does not verify (${r.reason})`);
                            this.#ack(d.seq);
                        }
                    }
                } finally {
                    this.#waiting--;
                    this.#waitingBytes -= bytes;
                    const f = this.#flush.get(d.hook);
                    if (f && --f.left <= 0) f.done();
                }
            });
        } else if (m.t === 'ask') {
            const a = m;
            if (typeof a.id !== 'string' || typeof a.hook !== 'string' || typeof a.body !== 'string' || typeof a.headers !== 'object' || a.headers === null) return;
            // Only a challenge is answered live. An event or a control message sent this way is not taken:
            // those go through the queue, one at a time.
            if (!isChallenge(a.body)) return;
            void (async () => {
                const hook = this.#hooks.get(a.hook);
                if (!hook) return; // not ours: the relay tells the server to try again
                // A challenge is live, so it is judged against this machine's clock, not the relay's word.
                let status = 503;
                let body: unknown;
                try {
                    ({ status, body } = await handleDelivery(hook, a.headers, a.body));
                } catch {
                    // answered 503: the server tries again
                }
                this.#send({ t: 'answer', id: a.id, status, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
            })();
        }
    }

    #onClose(ws: WebSocket, code: number, reopening = false): void {
        if (ws !== this.#ws) return;
        clearTimeout(this.#ackTimer);
        this.#ackTimer = undefined;
        this.#acks = [];
        clearInterval(this.#ping);
        clearTimeout(this.#pong);
        this.#pong = undefined;
        this.#open = undefined;
        this.#ws = undefined;
        for (const [n, p] of this.#pending) {
            clearTimeout(p.timer);
            p.reject(new LocalError('the relay connection closed'));
            this.#pending.delete(n);
        }
        for (const f of this.#flush.values()) f.done();
        if (reopening || this.#closed || this.#hooks.size === 0) return;
        if (code === 4001 && this.#o.owner && !this.#o.owner()) {
            // Another process runs this project's watches now, and has the mailbox: leave it be.
            this.#log('relay: another Claude Code session took over this project\'s watches and its mailbox; this one stops collecting');
            return;
        }
        const wait = code === 4001 ? Math.max(REPLACED_WAIT_MS, this.#backoff) : this.#backoff;
        if (code === 4001) this.#log('relay: another connection took over this mailbox; trying again shortly');
        else this.#log(`relay: connection closed (${code}); reconnecting in ${wait} ms`);
        this.#backoff = Math.min(this.#backoff * 2, 60000);
        this.#schedule(wait);
    }

    #schedule(ms: number): void {
        clearTimeout(this.#retry);
        this.#retry = setTimeout(() => void this.#resume(), ms);
        this.#retry.unref();
    }

    /** Connects if need be, and asks for every hook not yet asked for on this connection (which also collects what the relay held). */
    async #ensure(): Promise<void> {
        await this.connect();
        clearTimeout(this.#retry);
        for (const hook of [...this.#hooks.keys()]) if (!this.#attached.has(hook)) await this.#attach(hook);
    }

    async #resume(): Promise<void> {
        if (this.#closed || this.#hooks.size === 0) return;
        try {
            await this.#ensure();
        } catch (e) {
            this.#log(`relay: ${e instanceof LocalError ? e.message : 'could not reconnect'}`);
            if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.close(); // its close handler schedules the next try
            else {
                this.#schedule(this.#backoff);
                this.#backoff = Math.min(this.#backoff * 2, 60000);
            }
        }
    }

    /** Asks the relay for a hook's deliveries, and waits until the ones it already held have been judged. */
    async #attach(hook: string): Promise<void> {
        const ok = await this.#request({ t: 'add', hook });
        this.#attached.add(hook);
        this.#stale.delete(hook);
        const held = Number(ok.queued ?? 0);
        if (held <= 0) return;
        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.#flush.delete(hook);
                resolve();
            };
            const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
            this.#flush.set(hook, { left: held, done });
        });
    }

    /**
     * Gives a hook an address on the relay and starts collecting for it. Resolves with the
     * address once everything the relay already held for the hook has been judged.
     */
    async add(hook: string, h: Hook): Promise<string> {
        if (!HOOK_RE.test(hook)) throw new LocalError('not a hook name');
        this.#hooks.set(hook, h);
        try {
            // The relay will not send again, on this connection, what it sent while nobody here collected
            // for this hook: start a new connection, on which it sends all it still holds.
            if (this.#stale.has(hook) && this.#missed.has(hook)) this.#reopen();
            await this.#ensure();
        } catch (e) {
            this.#hooks.delete(hook);
            throw e;
        }
        return `${this.url}/hooks/${await this.#mailboxId()}/${hook}`;
    }

    /** Stops collecting for a hook. `forget` also retires its address at the relay, for good. */
    async remove(hook: string, forget: boolean): Promise<void> {
        this.#hooks.delete(hook);
        if (this.#attached.delete(hook) && !forget) this.#stale.add(hook);
        if (forget && this.#ws?.readyState === WebSocket.OPEN) await this.#request({ t: 'remove', hook }).catch((e) => this.#log(`relay: ${e instanceof LocalError ? e.message : 'could not retire an address'}`));
    }

    /** Drops the current connection without waiting for it, so the next `connect` starts a new one. */
    #reopen(): void {
        const ws = this.#ws;
        if (!ws) return;
        this.#flushAcks();
        this.#onClose(ws, 1000, true);
        try {
            ws.close();
        } catch {
            // already closing
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
        clearTimeout(this.#retry);
        clearInterval(this.#ping);
        clearTimeout(this.#pong);
        await Promise.race([this.#work, new Promise((r) => setTimeout(r, 2000))]);
        this.#flushAcks();
        this.#ws?.close();
    }
}
