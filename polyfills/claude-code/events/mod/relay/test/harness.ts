// Runs the relay in the local Workers runtime (wrangler's programmatic dev
// server) and talks to it the way its two callers do: an MCP server POSTing
// signed webhooks over HTTP, and the plugin over a WebSocket.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Unstable_DevWorker } from 'wrangler';
import { ACCESS_PREFIX, KEY_PREFIX, mailboxIdOf, SUBPROTOCOL, type ClientMessage, type RelayMessage } from '../src/protocol.ts';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `stop(true)` keeps the relay's storage, to start it again on it. */
export type Relay = { worker: Unstable_DevWorker; origin: string; stateDir: string; stop: (keep?: boolean) => Promise<void> };

/**
 * Starts the relay with the given variables. Pass `stateDir` (and `port`) to start it again on the
 * same storage (and address); `config` to start it as another deployment (`wrangler.public.jsonc`).
 * Its storage is removed when it stops, unless it is stopped with `stop(true)`.
 */
export async function startRelay(vars: Record<string, string> = {}, stateDir?: string, port = 0, config = 'wrangler.jsonc'): Promise<Relay> {
    process.env.WRANGLER_SEND_METRICS = 'false';
    process.env.WRANGLER_WRITE_LOGS = 'false';
    process.env.WRANGLER_LOG_PATH = path.join(ROOT, '.test-state', 'wrangler.log');
    process.env.CI = 'true';
    mkdirSync(path.join(ROOT, '.test-state'), { recursive: true });
    const dir = stateDir ?? mkdtempSync(path.join(ROOT, '.test-state', 'relay-'));
    const { unstable_dev } = await import('wrangler');
    const worker = await unstable_dev(path.join(ROOT, 'src/index.ts'), {
        config: path.join(ROOT, config),
        local: true,
        ip: '127.0.0.1',
        port,
        inspectorPort: 0,
        persist: true,
        persistTo: dir,
        logLevel: 'none',
        vars,
        experimental: { disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false }
    });
    const stop = async (keep = false) => {
        await worker.stop();
        if (!keep) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    };
    return { worker, origin: `http://127.0.0.1:${worker.port}`, stateDir: dir, stop };
}

export const newKey = () => randomBytes(32).toString('base64url');
export const newHook = () => randomBytes(18).toString('base64url');
export const newSecret = () => 'whsec_' + randomBytes(32).toString('base64');

export function sign(secret: string, id: string, timestamp: number, body: string): string {
    return 'v1,' + createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export type PostOptions = { id?: string; timestamp?: number; secret?: string; subscriptionId?: string; headers?: Record<string, string> };

/** POSTs one webhook delivery the way an MCP server does. */
export async function post(origin: string, mailbox: string, hook: string, body: unknown, o: PostOptions = {}): Promise<Response> {
    const id = o.id ?? `msg_${randomUUID().replace(/-/g, '')}`;
    const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return fetch(`${origin}/hooks/${mailbox}/${hook}`, {
        method: 'POST',
        body: text,
        headers: {
            'content-type': 'application/json',
            'webhook-id': id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': sign(o.secret ?? 'whsec_' + Buffer.alloc(32, 1).toString('base64'), id, timestamp, text),
            ...(o.subscriptionId ? { 'x-mcp-subscription-id': o.subscriptionId } : {}),
            ...o.headers
        }
    });
}

/** The HTTP status of a socket request sent without upgrading (so refusals can be read). */
export function socketStatus(origin: string, mailbox: string, protocols: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(`${origin}/mailboxes/${mailbox}/socket`, { method: 'GET', headers: protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {} }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * A WebSocket client that does not take no for an answer: it ignores a close from the other
 * side and can keep sending, as a replaced connection's last messages might still arrive.
 */
export function stubbornSocket(origin: string, mailbox: string, protocols: string[]): Promise<{ send: (m: ClientMessage) => void; end: () => void }> {
    const u = new URL(origin);
    return new Promise((resolve, reject) => {
        const s = netConnect(Number(u.port), u.hostname, () => {
            s.write(
                `GET /mailboxes/${mailbox}/socket HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${protocols.join(', ')}\r\n\r\n`
            );
        });
        let head = '';
        const onData = (d: Buffer) => {
            head += d.toString('latin1');
            if (!head.includes('\r\n\r\n')) return;
            s.off('data', onData);
            s.on('data', () => {}); // whatever the relay says from here on, including "close", is ignored
            if (!head.startsWith('HTTP/1.1 101')) return reject(new Error('not upgraded: ' + head.split('\r\n')[0]));
            resolve({
                send: (m) => {
                    const payload = Buffer.from(JSON.stringify(m));
                    const mask = randomBytes(4);
                    const len = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
                    const masked = Buffer.alloc(payload.length);
                    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
                    s.write(Buffer.concat([Buffer.from([0x81]), len, mask, masked]));
                },
                end: () => s.destroy()
            });
        };
        s.on('data', onData);
        s.on('error', reject);
    });
}

export type Sock = {
    ws: WebSocket;
    mailbox: string;
    messages: RelayMessage[];
    closed: () => { code: number; reason: string } | undefined;
    send: (m: ClientMessage) => void;
    /** Waits for the first message (from the start, or after `from`) that matches. */
    next: <T extends RelayMessage['t']>(t: T, match?: (m: Extract<RelayMessage, { t: T }>) => boolean, timeoutMs?: number) => Promise<Extract<RelayMessage, { t: T }>>;
    /** Sends `add` and waits for its `ok`. */
    add: (hook: string) => Promise<void>;
    remove: (hook: string) => Promise<void>;
    close: () => Promise<void>;
};

/** Opens the plugin's socket to a mailbox. Rejects if the relay refuses it. */
export async function connect(origin: string, key: string, o: { access?: string; mailbox?: string } = {}): Promise<Sock> {
    const mailbox = o.mailbox ?? (await mailboxIdOf(key));
    const url = `${origin.replace(/^http/, 'ws')}/mailboxes/${mailbox}/socket`;
    const ws = new WebSocket(url, [SUBPROTOCOL, KEY_PREFIX + key, ...(o.access ? [ACCESS_PREFIX + o.access] : [])]);
    const messages: RelayMessage[] = [];
    const waiters = new Set<() => void>();
    let closed: { code: number; reason: string } | undefined;
    let n = 0;
    ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return;
        messages.push(JSON.parse(e.data) as RelayMessage);
        for (const w of waiters) w();
    });
    ws.addEventListener('close', (e) => {
        closed = { code: e.code, reason: e.reason };
        for (const w of waiters) w();
    });
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('the relay refused the socket')), { once: true });
        ws.addEventListener('close', () => reject(new Error('the relay closed the socket before it opened')), { once: true });
    });
    const sock: Sock = {
        ws,
        mailbox,
        messages,
        closed: () => closed,
        send: (m) => ws.send(JSON.stringify(m)),
        next: (t, match, timeoutMs = 5000) =>
            new Promise((resolve, reject) => {
                let seen = 0;
                const check = () => {
                    for (; seen < messages.length; seen++) {
                        const m = messages[seen]!;
                        if (m.t === t && (!match || match(m as never))) {
                            cleanup();
                            return resolve(m as never);
                        }
                    }
                };
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`timed out waiting for a "${t}" message; got ${JSON.stringify(messages).slice(0, 400)}`));
                }, timeoutMs);
                const cleanup = () => {
                    clearTimeout(timer);
                    waiters.delete(check);
                };
                waiters.add(check);
                check();
            }),
        add: async (hook) => {
            const id = ++n;
            sock.send({ t: 'add', n: id, hook });
            await sock.next('ok', (m) => m.n === id);
        },
        remove: async (hook) => {
            const id = ++n;
            sock.send({ t: 'remove', n: id, hook });
            await sock.next('ok', (m) => m.n === id);
        },
        close: () =>
            new Promise((resolve) => {
                if (closed) return resolve();
                ws.addEventListener('close', () => resolve(), { once: true });
                ws.close();
            })
    };
    return sock;
}
