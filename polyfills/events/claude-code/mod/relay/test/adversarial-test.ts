// Adversarial tests for the relay (test ids R-...).
//
// The actors: two tenants (A and B) who each opened a mailbox with a key of their own, an outsider
// who knows nothing but what is public, an outsider who learned one of A's webhook addresses (a
// malicious MCP server knows its own), and a hostile relay, against the plugin's real relay client
// (core/src/relay.ts) and its real delivery check (core/src/webhooks.ts).
//
// Each test has an id (R-...). One limit is shown as it
// is (R-M3: an open relay cannot tell an event from anything else shaped like one).

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { mailboxIdOf } from '../src/protocol.ts';
import { connect, newHook, newKey, newSecret, post, sign, sleep, socketStatus, startRelay, upgradeStatus, type Relay } from './harness.ts';
import { PUBLIC_RELAY, RelayClient } from '../../../../core/src/relay.ts';
import { handleDelivery, ReplayGuard, type Hook } from '../../../../core/src/webhooks.ts';

const ADVERSARIAL = 'test/wrangler.adversarial.jsonc';
const V1 = 'mcp-events-relay.v1';
const now = () => Math.floor(Date.now() / 1000);

/** A hook as the plugin makes one, recording what it takes. */
function recordingHook(secret = newSecret()): { hook: Hook; taken: unknown[]; secret: string } {
    const taken: unknown[] = [];
    return { secret, taken, hook: { secret, replay: new ReplayGuard(), onEvent: (o) => void taken.push(o) } };
}

describe('isolation between tenants on a relay anyone may use', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test("no credential B can make opens A's mailbox", async () => {
        const keyA = newKey();
        const keyB = newKey();
        const a = await mailboxIdOf(keyA);
        const tries: [string, string[]][] = [
            ["B's own key", [V1, `key.${keyB}`]],
            ["A's public mailbox name used as the key", [V1, `key.${a}`]],
            ['an empty key', [V1, 'key.']],
            ['two keys, a wrong one first', [V1, `key.${keyB}`, `key.${a}`]],
            ['the key with padding', [V1, `key. ${keyB}`]],
            ['no subprotocol version', [`key.${keyB}`]]
        ];
        for (const [why, p] of tries) assert.equal((await socketStatus(relay.origin, a, p)).status, 401, why);
        // A real upgrade, too, not only the plain GET.
        assert.equal((await upgradeStatus(relay.origin, a, [V1, `key.${keyB}`])).status, 401);
    });

    test("the same hook name in two mailboxes: a delivery to A's address reaches only A", async () => {
        const hook = newHook();
        const sa = await connect(relay.origin, newKey());
        const sb = await connect(relay.origin, newKey());
        await sa.add(hook);
        await sb.add(hook);
        assert.equal((await post(relay.origin, sa.mailbox, hook, { eventId: 'for-a' })).status, 200);
        await sa.next('delivery');
        await sleep(300);
        assert.equal(sb.messages.filter((m) => m.t === 'delivery').length, 0, 'B sees nothing of A');
        await sa.close();
        await sb.close();
    });

    test("B acking or removing in its own mailbox touches nothing of A's", async () => {
        const keyA = newKey();
        const hook = newHook();
        const sa = await connect(relay.origin, keyA);
        await sa.add(hook);
        await sa.close();
        assert.equal((await post(relay.origin, sa.mailbox, hook, { eventId: 'kept' })).status, 200);
        const sb = await connect(relay.origin, newKey());
        await sb.add(hook);
        sb.send({ t: 'ack', seqs: Array.from({ length: 1000 }, (_, i) => i + 1) });
        await sb.remove(hook);
        await sleep(200);
        await sb.close();
        const again = await connect(relay.origin, keyA);
        await again.add(hook);
        const d = await again.next('delivery');
        assert.equal(d.body, JSON.stringify({ eventId: 'kept' }));
        await again.close();
    });

    test('there is no way to list, read or delete a mailbox over HTTP, and no response allows cross-origin reads', async () => {
        const sa = await connect(relay.origin, newKey());
        const hook = newHook();
        await sa.add(hook);
        await sa.close();
        const secretBody = { eventId: 'do-not-leak', data: 'secret-payload-0001' };
        assert.equal((await post(relay.origin, sa.mailbox, hook, secretBody)).status, 200);
        const m = sa.mailbox;
        const probes: [string, string][] = [
            ['GET', `/hooks/${m}/${hook}`],
            ['DELETE', `/hooks/${m}/${hook}`],
            ['PUT', `/hooks/${m}/${hook}`],
            ['OPTIONS', `/hooks/${m}/${hook}`],
            ['GET', `/hooks/${m}`],
            ['GET', `/mailboxes/${m}`],
            ['GET', `/mailboxes/${m}/hooks`],
            ['GET', `/mailboxes/${m}/socket`],
            ['DELETE', `/mailboxes/${m}/socket`],
            ['GET', '/mailboxes'],
            ['GET', `/hooks/${m}/${hook}/../../mailboxes/${m}/socket`]
        ];
        for (const [method, path] of probes) {
            const r = await fetch(relay.origin + path, { method, headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
            const text = await r.text();
            assert.ok([401, 404, 405].includes(r.status), `${method} ${path}: ${r.status}`);
            assert.doesNotMatch(text, /secret-payload|do-not-leak/, `${method} ${path} leaks nothing`);
            assert.equal(r.headers.get('access-control-allow-origin'), null, `${method} ${path}: no CORS`);
        }
        // The delivery is still there for A.
        const back = await connect(relay.origin, newKey(), { mailbox: m }).catch(() => undefined);
        assert.equal(back, undefined);
    });
});

describe('forgery through the relay, against the real plugin client', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test('an outsider who knows the address gets unsigned, mis-signed, re-signed and replayed deliveries stored, and none of them taken', async () => {
        const logs: string[] = [];
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test', isPublic: true }, key: newKey(), log: (s) => logs.push(s) });
        const { hook, taken, secret } = recordingHook();
        const hookId = newHook();
        const url = await client.add(hookId, hook);
        const [, mailbox, h] = new URL(url).pathname.split('/').filter(Boolean) as [string, string, string];
        // The one genuine delivery, as the MCP server signs it.
        const genuine = { eventId: 'evt_genuine', name: 'deploy.finished', data: {} };
        const ts = now();
        assert.equal((await post(relay.origin, mailbox, h, genuine, { id: 'msg_genuine', timestamp: ts, secret })).status, 200);
        await sleep(400);
        assert.equal(taken.length, 1, 'the genuine one is taken');
        // What an outsider can send, and the relay stores (it holds no secret, so it cannot tell).
        const forged = { eventId: 'evt_forged', name: 'deploy.finished', data: { cmd: 'rm -rf /' } };
        const attempts = [
            post(relay.origin, mailbox, h, forged, { secret: newSecret() }), // signed with a secret of its own
            post(relay.origin, mailbox, h, forged, { headers: { 'webhook-signature': 'v1,' + Buffer.alloc(32).toString('base64') } }),
            post(relay.origin, mailbox, h, forged, { id: 'msg_genuine', timestamp: ts, headers: { 'webhook-signature': sign(secret, 'msg_genuine', ts, JSON.stringify(genuine)) } }), // the genuine signature over another body
            post(relay.origin, mailbox, h, genuine, { id: 'msg_genuine', timestamp: ts, secret, subscriptionId: 'sub_other' }) // the genuine delivery again, with an unsigned header changed so the relay keeps it
        ];
        const statuses = await Promise.all((await Promise.all(attempts)).map((r) => r.status));
        assert.deepEqual(statuses, [200, 200, 200, 200], 'the relay keeps them all: it cannot check a signature');
        await sleep(600);
        assert.equal(taken.length, 1, 'nothing more is taken');
        assert.ok(logs.filter((l) => /does not verify/.test(l)).length >= 3, 'the forgeries are dropped as not verifying');
        await client.close();
        // And dropping them acknowledged them: they do not sit in the mailbox.
        const raw = await connect(relay.origin, newKey(), { mailbox }).catch(() => undefined);
        assert.equal(raw, undefined, 'still only its key opens it');
    });

    test('a challenge is echoed only when its signature verifies', async () => {
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test', isPublic: true }, key: newKey() });
        const { hook, secret } = recordingHook();
        const url = await client.add(newHook(), hook);
        const [, mailbox, h] = new URL(url).pathname.split('/').filter(Boolean) as [string, string, string];
        const challenge = { type: 'verification', challenge: 'c-' + randomBytes(8).toString('hex') };
        const bad = await post(relay.origin, mailbox, h, challenge, { secret: newSecret() });
        assert.equal(bad.status, 503, 'refused, and answered as unconfirmed (R-L1)');
        assert.doesNotMatch(await bad.text(), /c-[0-9a-f]{16}/);
        const good = await post(relay.origin, mailbox, h, challenge, { secret });
        assert.equal(good.status, 200);
        assert.deepEqual(await good.json(), { challenge: challenge.challenge });
        await client.close();
    });

    test('R-L1: whoever posts a challenge without the secret cannot tell whether the owner is online', async () => {
        const key = newKey();
        const { hook } = recordingHook();
        const hookId = newHook();
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test', isPublic: true }, key });
        const url = await client.add(hookId, hook);
        const [, mailbox, h] = new URL(url).pathname.split('/').filter(Boolean) as [string, string, string];
        const probe = () => post(relay.origin, mailbox, h, { type: 'verification', challenge: 'x' }, { secret: newSecret() }).then(async (r) => `${r.status} ${r.headers.get('retry-after')} ${await r.text()}`);
        const online = await probe();
        await client.close();
        await sleep(300);
        const offline = await probe();
        assert.equal(online, offline, 'the same status, Retry-After and body, online or not');
        assert.match(online, /^503 /);
    });
});

describe('harm through the relay', { concurrency: false }, () => {
    test('a body over 256 KiB is refused whatever content-length says, and nothing is stored', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1' });
        try {
            const sock = await connect(relay.origin, newKey());
            const hook = newHook();
            await sock.add(hook);
            const big = JSON.stringify({ eventId: 'big', pad: 'x'.repeat(300 * 1024) });
            const ts = now();
            const headers = { 'webhook-id': 'msg_big', 'webhook-timestamp': String(ts), 'webhook-signature': 'v1,AAAA' };
            // A stream with no content-length (chunked).
            const chunked = await fetch(`${relay.origin}/hooks/${sock.mailbox}/${hook}`, {
                method: 'POST',
                headers,
                body: new ReadableStream({
                    start(c) {
                        for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10 * 1024)));
                        c.close();
                    }
                }),
                duplex: 'half'
            } as RequestInit);
            assert.equal(chunked.status, 413);
            assert.equal((await post(relay.origin, sock.mailbox, hook, big)).status, 413);
            await sleep(200);
            assert.equal(sock.messages.filter((m) => m.t === 'delivery').length, 0);
            await sock.close();
        } finally {
            await relay.stop();
        }
    });

    test('R-M1: one network with an IPv6 /48 cannot spend the hourly ceiling on new mailboxes and lock everyone else out', async () => {
        // The public relay's 2,000 an hour, 60 per sender and 200 per network, scaled down: 6, 2 and 3.
        const relay = await startRelay({ NEW_MAILBOXES_PER_HOUR: '6', NEW_MAILBOXES_PER_SENDER_PER_HOUR: '2', NEW_MAILBOXES_PER_NETWORK_PER_HOUR: '3' }, undefined, 0, ADVERSARIAL);
        try {
            const open = async (ip: string) => {
                const key = newKey();
                return (await upgradeStatus(relay.origin, await mailboxIdOf(key), [V1, `key.${key}`], { 'cf-connecting-ip': ip })).status;
            };
            // One attacker: one /48 (2001:db8:a::/48), a different /64 of it for each mailbox.
            const attacker: number[] = [];
            for (let i = 1; i <= 6; i++) attacker.push(await open(`2001:db8:a:${i.toString(16)}::1`));
            // A newcomer from somewhere else entirely.
            const newcomer = await open('198.51.100.7');
            assert.deepEqual(attacker, [101, 101, 101, 429, 429, 429], 'the /48 stops at its own ceiling');
            assert.equal(newcomer, 101, 'someone from another network still gets in');
        } finally {
            await relay.stop();
        }
    });

    test("R-M2: a Cloudflare Worker posting junk to made-up addresses cannot spend another Workers-hosted server's allowance", async () => {
        // The bucket is 20 a minute in the adversarial config (3,000 in the public one).
        const relay = await startRelay({}, undefined, 0, ADVERSARIAL);
        try {
            const WORKER = { 'cf-connecting-ip': '2a06:98c0:3600::103' };
            const sock = await connect(relay.origin, newKey());
            const hook = newHook();
            await sock.add(hook);
            // The attacker's Worker: junk to mailboxes that do not exist.
            const junk: number[] = [];
            for (let i = 0; i < 30; i++) junk.push((await post(relay.origin, await mailboxIdOf(newKey()), newHook(), { eventId: `junk${i}` }, { headers: WORKER })).status);
            assert.ok(junk.every((x) => x === 404), 'each made-up mailbox has a bucket of its own, and none is spent');
            // Junk to one made-up mailbox spends only that mailbox's bucket.
            const one = await mailboxIdOf(newKey());
            const same: number[] = [];
            for (let i = 0; i < 25; i++) same.push((await post(relay.origin, one, newHook(), { eventId: `same${i}` }, { headers: WORKER })).status);
            assert.ok(same.includes(429), "the one mailbox's bucket is spent");
            // A genuine MCP server on Workers, delivering to an address that exists.
            const genuine = await post(relay.origin, sock.mailbox, hook, { eventId: 'real' }, { headers: WORKER });
            await sock.close();
            assert.equal(genuine.status, 200, `a genuine delivery got ${genuine.status}`);
        } finally {
            await relay.stop();
        }
    });

    test('R-M3 (residual): the open relay stores and hands back anything shaped like a webhook', async () => {
        // It holds no secret, so it cannot tell an event from anything else shaped like one. What the
        // fix gives the operator is the next test: an abuse contact, and a way to block one mailbox.
        const relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
        try {
            const key = newKey(); // anyone can make one; nothing ties it to a person or an MCP server
            const drop = await connect(relay.origin, key);
            const hook = newHook();
            await drop.add(hook);
            await drop.close();
            // "Deliveries" with a made-up signature: any JSON object, up to 256 KiB each, from anywhere.
            const payload = { chunk: 0, data: randomBytes(1024).toString('base64') };
            assert.equal((await post(relay.origin, drop.mailbox, hook, payload, { headers: { 'webhook-signature': 'v1,not-a-signature' } })).status, 200);
            const pick = await connect(relay.origin, key);
            await pick.add(hook);
            assert.equal((await pick.next('delivery')).body, JSON.stringify(payload));
            await pick.close();
        } finally {
            await relay.stop();
        }
    });

    test('R-M3: the front page says where to report abuse, and a mailbox the operator blocks is refused', async () => {
        const key = newKey();
        const mailbox = await mailboxIdOf(key);
        const relay = await startRelay({ BLOCKED_MAILBOXES: `someone-else, ${mailbox}` }, undefined, 0, 'wrangler.public.jsonc');
        try {
            const about = (await (await fetch(relay.origin + '/')).json()) as { abuse?: string };
            assert.match(about.abuse ?? '', /^https:\/\//);
            assert.equal((await upgradeStatus(relay.origin, mailbox, [V1, `key.${key}`])).status, 410, 'its socket is refused');
            assert.equal((await post(relay.origin, mailbox, newHook(), { eventId: 'x' })).status, 410, 'so are deliveries to it: 410, so servers stop');
            const other = newKey();
            assert.equal((await upgradeStatus(relay.origin, await mailboxIdOf(other), [V1, `key.${other}`])).status, 101, 'other mailboxes are not affected');
        } finally {
            await relay.stop();
        }
    });

    test('R-H1: the relay holds at most so many mailboxes at once; one that gives its storage back makes room', async () => {
        const relay = await startRelay({ MAX_LIVE_MAILBOXES: '2', CLEANUP_EVERY_MS: '300' }, undefined, 0, ADVERSARIAL);
        try {
            const open = async (key: string) => (await upgradeStatus(relay.origin, await mailboxIdOf(key), [V1, `key.${key}`])).status;
            const [kept, left, third] = [newKey(), newKey(), newKey()];
            const a = await connect(relay.origin, kept);
            await a.add(newHook());
            await a.close();
            await (await connect(relay.origin, left)).close(); // opened, and nothing asked of it
            const full = await upgradeStatus(relay.origin, await mailboxIdOf(third), [V1, `key.${third}`]);
            assert.equal(full.status, 503, 'two live: a third is refused');
            assert.ok(Number(full.retryAfter) > 0);
            assert.equal(await open(kept), 101, 'a mailbox that exists still opens');
            await sleep(2500); // the empty one gives its storage back, and tells the registry
            assert.equal(await open(third), 101, 'its room is free again');
        } finally {
            await relay.stop();
        }
    });

    test("R-L4: a mailbox's byte limit counts the headers stored beside each body", async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', MAX_QUEUED_BYTES: '1000', MAX_QUEUED: '100' });
        try {
            const sock = await connect(relay.origin, newKey());
            const hook = newHook();
            await sock.add(hook);
            await sock.close();
            const statuses: number[] = [];
            // 20 deliveries of a 2-byte body each, with 2 KiB of signature header: ~40 KiB kept under a 1,000-byte limit.
            for (let i = 0; i < 20; i++) statuses.push((await post(relay.origin, sock.mailbox, hook, '{}', { headers: { 'webhook-signature': 'v1,' + 'A'.repeat(2040) } })).status);
            assert.equal(statuses[0], 503, 'one delivery with 2 KiB of headers is already more than 1,000 bytes');
            assert.ok(statuses.every((x) => x === 503));
        } finally {
            await relay.stop();
        }
    });
});

describe('a hostile relay, against the real plugin client', { concurrency: false }, () => {
    type Hostile = { origin: string; received: unknown[]; closedWith: () => number | undefined; close: () => Promise<void> };
    /**
     * A WebSocket server that accepts the plugin's socket. `onOpen` runs once it is open, `onMessage`
     * for each text frame the plugin sends. It records what the plugin sent, and the code of a close.
     */
    async function hostileRelay(o: { onOpen?: (send: (t: string) => void) => void; onMessage?: (m: Record<string, unknown>, send: (t: string) => void) => void }): Promise<Hostile> {
        const server: Server = createServer((_req, res) => void res.writeHead(404).end());
        const sockets = new Set<Socket>();
        const received: unknown[] = [];
        let closedWith: number | undefined;
        server.on('upgrade', (req, socket: Socket) => {
            sockets.add(socket);
            const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${V1}\r\n\r\n`);
            socket.on('error', () => {});
            const send = (t: string) => void socket.write(frame(t));
            let buf = Buffer.alloc(0);
            socket.on('data', (d: Buffer) => {
                buf = Buffer.concat([buf, d]);
                // The plugin's frames: small, masked, unfragmented.
                for (;;) {
                    if (buf.length < 2) return;
                    const op = buf[0]! & 0x0f;
                    let len = buf[1]! & 0x7f;
                    let at = 2;
                    if (len === 126) {
                        if (buf.length < 4) return;
                        len = buf.readUInt16BE(2);
                        at = 4;
                    }
                    if (buf.length < at + 4 + len) return;
                    const mask = buf.subarray(at, at + 4);
                    const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]!));
                    buf = buf.subarray(at + 4 + len);
                    if (op === 8) closedWith = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                    else if (op === 1) {
                        const text = payload.toString();
                        if (text === 'ping') continue;
                        const m = JSON.parse(text) as Record<string, unknown>;
                        received.push(m);
                        o.onMessage?.(m, send);
                    }
                }
            });
            setTimeout(() => o.onOpen?.(send), 100);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        return {
            origin: `http://127.0.0.1:${port}`,
            received,
            closedWith: () => closedWith,
            close: () =>
                new Promise((r) => {
                    for (const s of sockets) s.destroy();
                    server.close(() => r());
                })
        };
    }
    /** One unmasked text frame, as a server sends it. */
    function frame(text: string): Buffer {
        const payload = Buffer.from(text);
        const n = payload.length;
        const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
        return Buffer.concat([head, payload]);
    }

    test('R-L3: after a frame far past what a relay sends, the client drops the connection', async () => {
        // Residual: Node's WebSocket has no limit on a message's size to set, so this one frame is read
        // whole. What the client does is not let the relay go on sending them on that connection.
        const relay = await hostileRelay({ onOpen: (send) => send(JSON.stringify({ t: 'delivery', seq: 1, hook: 'h'.repeat(16), headers: {}, body: 'x'.repeat(4 * 1024 * 1024), receivedAt: 0 })) });
        const logs: string[] = [];
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test' }, key: newKey(), log: (s) => logs.push(s) });
        try {
            await client.connect();
            for (let i = 0; i < 50 && relay.closedWith() === undefined; i++) await sleep(100);
            assert.equal(relay.closedWith(), 4009, 'closed as "frame too large"');
            assert.ok(logs.some((l) => /dropped the connection after an oversized frame/.test(l)));
        } finally {
            await client.close();
            await relay.close();
        }
    });

    test("R-L2: a delivery the public relay held past its retention is not taken, whatever it says about when it arrived", async () => {
        const { hook, taken, secret } = recordingHook();
        const hookId = newHook();
        const delivery = (id: string, signedAt: number, seq: number) => {
            const body = JSON.stringify({ eventId: id, name: 'ci.failed', data: {} });
            // The relay says each arrived a second after it was signed.
            return JSON.stringify({ t: 'delivery', seq, hook: hookId, headers: { 'webhook-id': id, 'webhook-timestamp': String(signedAt), 'webhook-signature': sign(secret, id, signedAt, body) }, body, receivedAt: signedAt + 1 });
        };
        const relay = await hostileRelay({
            onOpen: (send) => send(JSON.stringify({ t: 'hello', v: 1, now: now() })),
            onMessage: (m, send) => {
                if (m.t !== 'add') return;
                send(JSON.stringify({ t: 'ok', n: m.n, queued: 3 }));
                send(delivery('msg_week_old', now() - 7 * 24 * 3600, 1)); // held back a week
                send(delivery('msg_day_old', now() - 26 * 3600, 2)); // past the public relay's 23 hours, with an hour's slack
                send(delivery('msg_fresh', now() - 60, 3));
            }
        });
        // The client takes this stand-in for the public relay.
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test', isPublic: true }, key: newKey() });
        try {
            await client.add(hookId, hook);
            await sleep(500);
            assert.deepEqual(taken.map((o) => (o as { eventId: string }).eventId), ['msg_fresh'], 'only the fresh one is taken');
            const acked = relay.received.filter((m) => (m as { t: string }).t === 'ack').flatMap((m) => (m as { seqs: number[] }).seqs);
            assert.deepEqual(acked.sort(), [1, 2, 3], 'the stale ones are dropped at the relay, not left to come again');
        } finally {
            await client.close();
            await relay.close();
        }
        assert.ok(PUBLIC_RELAY.maxHeldS >= 24 * 3600 && PUBLIC_RELAY.maxHeldS < 2 * 24 * 3600);
        // The check itself, as the client makes it for the public relay.
        const old = now() - 7 * 24 * 3600;
        const body = '{"eventId":"x"}';
        const r = await handleDelivery(recordingHook(secret).hook, { 'webhook-id': 'm', 'webhook-timestamp': String(old), 'webhook-signature': sign(secret, 'm', old, body) }, body, { nowS: old + 1, maxAgeS: PUBLIC_RELAY.maxHeldS });
        assert.equal(r.status, 410);
    });
});
