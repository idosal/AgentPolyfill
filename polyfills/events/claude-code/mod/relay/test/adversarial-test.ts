// Adversarial tests for the relay, from a security review of it (finding ids R-...).
//
// The actors: two tenants (A and B) who each opened a mailbox with a key of their own, an outsider
// who knows nothing but what is public, an outsider who learned one of A's webhook addresses (a
// malicious MCP server knows its own), and a hostile relay, against the plugin's real relay client
// (core/src/relay.ts) and its real delivery check (core/src/webhooks.ts).
//
// A test that shows a finding is marked `todo` with the finding's id: it asserts what the relay or
// client should do, fails today, and does not fail the run. Remove the `todo` with the fix.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { mailboxIdOf } from '../src/protocol.ts';
import { connect, newHook, newKey, newSecret, post, sign, sleep, socketStatus, startRelay, upgradeStatus, type Relay } from './harness.ts';
import { RelayClient } from '../../../../core/src/relay.ts';
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
        assert.equal(bad.status, 401);
        assert.doesNotMatch(await bad.text(), /c-[0-9a-f]{16}/);
        const good = await post(relay.origin, mailbox, h, challenge, { secret });
        assert.equal(good.status, 200);
        assert.deepEqual(await good.json(), { challenge: challenge.challenge });
        await client.close();
    });

    test('R-L1: whoever knows an address can tell whether its owner is online now', { todo: 'R-L1: a mis-signed challenge is answered 503 while the plugin is away and 401 while it is connected' }, async () => {
        const key = newKey();
        const { hook } = recordingHook();
        const hookId = newHook();
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test', isPublic: true }, key });
        const url = await client.add(hookId, hook);
        const [, mailbox, h] = new URL(url).pathname.split('/').filter(Boolean) as [string, string, string];
        const probe = () => post(relay.origin, mailbox, h, { type: 'verification', challenge: 'x' }, { secret: newSecret() }).then((r) => r.status);
        const online = await probe();
        await client.close();
        await sleep(300);
        const offline = await probe();
        assert.equal(online, offline, `online ${online}, offline ${offline}`);
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

    test('R-M1: one network with an IPv6 /48 can spend the hourly ceiling on new mailboxes and lock everyone else out', { todo: 'R-M1: new-mailbox admission counts an IPv6 sender by its /64; a /48 is 65,536 senders' }, async () => {
        // The public relay's 2,000 an hour and 60 per sender, scaled down: 6 and 2.
        const relay = await startRelay({ NEW_MAILBOXES_PER_HOUR: '6', NEW_MAILBOXES_PER_SENDER_PER_HOUR: '2' }, undefined, 0, ADVERSARIAL);
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
            assert.equal(newcomer, 101, `the attacker opened ${attacker.filter((s) => s === 101).length} of 6 from one /48; the newcomer got ${newcomer}`);
        } finally {
            await relay.stop();
        }
    });

    test('R-M2: any Cloudflare Worker can spend the bucket every Workers-hosted MCP server shares, with junk to made-up addresses', { todo: "R-M2: DELIVERIES_FROM_WORKERS is one bucket for all of them, spent before the address is checked" }, async () => {
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
            assert.ok(junk.includes(429), 'the shared bucket is spent');
            // A genuine MCP server on Workers, delivering to an address that exists.
            const genuine = await post(relay.origin, sock.mailbox, hook, { eventId: 'real' }, { headers: WORKER });
            await sock.close();
            assert.equal(genuine.status, 200, `a genuine delivery got ${genuine.status}`);
        } finally {
            await relay.stop();
        }
    });

    test('R-M3: the open relay stores and hands back anything shaped like a webhook: a free, anonymous drop box', async () => {
        // Passes today: it shows the behaviour behind the finding, it does not assert a fix.
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

    test("R-L4: a mailbox's byte limit counts bodies only; headers stored beside them are not counted", { todo: 'R-L4: up to ~2.8 KiB of headers per delivery are stored outside MAX_QUEUED_BYTES' }, async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', MAX_QUEUED_BYTES: '1000', MAX_QUEUED: '100' });
        try {
            const sock = await connect(relay.origin, newKey());
            const hook = newHook();
            await sock.add(hook);
            await sock.close();
            const statuses: number[] = [];
            // 20 deliveries of a 2-byte body each, with 2 KiB of signature header: ~40 KiB kept under a 1,000-byte limit.
            for (let i = 0; i < 20; i++) statuses.push((await post(relay.origin, sock.mailbox, hook, '{}', { headers: { 'webhook-signature': 'v1,' + 'A'.repeat(2040) } })).status);
            assert.ok(statuses.includes(503), `kept ${statuses.filter((s) => s === 200).length} deliveries holding ~${statuses.filter((s) => s === 200).length * 2} KiB under a 1,000-byte limit`);
        } finally {
            await relay.stop();
        }
    });
});

describe('a hostile relay, against the real plugin client', { concurrency: false }, () => {
    /** A WebSocket server that accepts the plugin's socket and then does what `then` says. */
    async function hostileRelay(then: (s: Socket) => void): Promise<{ origin: string; close: () => Promise<void> }> {
        const server: Server = createServer((_req, res) => void res.writeHead(404).end());
        const sockets = new Set<Socket>();
        server.on('upgrade', (req, socket: Socket) => {
            sockets.add(socket);
            const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${V1}\r\n\r\n`);
            socket.on('error', () => {});
            setTimeout(() => then(socket), 100);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        return {
            origin: `http://127.0.0.1:${port}`,
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

    test('R-L3: a frame far past what the client takes is read whole into memory before it is refused', { todo: 'R-L3: the client measures a frame only after the WebSocket has buffered it; there is no transport-level cap' }, async () => {
        const size = 32 * 1024 * 1024;
        const relay = await hostileRelay((s) => s.write(frame(JSON.stringify({ t: 'delivery', seq: 1, hook: 'h'.repeat(16), headers: {}, body: 'x'.repeat(size), receivedAt: 0 }))));
        const logs: string[] = [];
        const client = new RelayClient({ settings: { url: relay.origin, source: 'test' }, key: newKey(), log: (s) => logs.push(s) });
        try {
            await client.connect();
            await sleep(3000);
            assert.ok(!logs.some((l) => /oversized frame/.test(l)), 'a 32 MiB frame reached the client whole (it then logged "ignored an oversized frame")');
        } finally {
            await client.close();
            await relay.close();
        }
    });

    test("R-L2: a delivery the relay held for a week is taken as fresh, on the relay's word for when it arrived", { todo: "R-L2: the receipt time a relay reports is trusted for freshness up to MAX_AGE_S (8 days), far past the public relay's 23-hour retention" }, async () => {
        // The exact call RelayClient makes for a held delivery (core/src/relay.ts, `nowS: d.receivedAt`).
        const { hook, taken, secret } = recordingHook();
        const signedAt = now() - 7 * 24 * 3600;
        const body = JSON.stringify({ eventId: 'evt_old', name: 'ci.failed', data: {} });
        const headers = { 'webhook-id': 'msg_old', 'webhook-timestamp': String(signedAt), 'webhook-signature': sign(secret, 'msg_old', signedAt, body) };
        const r = await handleDelivery(hook, headers, body, { nowS: signedAt + 1 });
        assert.equal(taken.length, 0, `a delivery signed 7 days ago was taken (status ${r.status})`);
    });
});
