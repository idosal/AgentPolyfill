import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mailboxIdOf } from '../src/protocol.ts';
import { connect, newHook, newKey, newSecret, post, sign, sleep, socketStatus, startRelay, stubbornSocket, upgradeStatus, type Relay } from './harness.ts';

const ACCESS = 'test-access-key-0123456789';
const now = () => Math.floor(Date.now() / 1000);

describe('relay with an access key', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({ ACCESS_KEY: ACCESS, ASK_TIMEOUT_MS: '400', MAX_QUEUED: '5' });
    });
    after(async () => {
        await relay.stop();
    });

    test('answers health checks and publishes the well-known receiver document', async () => {
        assert.deepEqual(await (await fetch(`${relay.origin}/healthz`)).json(), { ok: true });
        const doc = await fetch(`${relay.origin}/.well-known/mcp-webhook-receiver.json`);
        assert.equal(doc.status, 200);
        assert.deepEqual(await doc.json(), { receivers: ['/hooks/'] });
        assert.equal((await fetch(`${relay.origin}/anything-else`)).status, 404);
    });

    test('only the mailbox key opens a mailbox, and only with the access key', async () => {
        const key = newKey();
        const mailbox = await mailboxIdOf(key);
        const v1 = 'mcp-events-relay.v1';
        assert.equal((await socketStatus(relay.origin, mailbox, [])).status, 401, 'no credentials');
        assert.equal((await socketStatus(relay.origin, mailbox, [v1, `key.${newKey()}`, `access.${ACCESS}`])).status, 401, "another mailbox's key");
        assert.equal((await socketStatus(relay.origin, mailbox, [v1, `key.${key}`])).status, 403, 'no access key');
        assert.equal((await socketStatus(relay.origin, mailbox, [v1, `key.${key}`, 'access.wrong-access-key-000000'])).status, 403, 'wrong access key');
        assert.equal((await socketStatus(relay.origin, mailbox, [`key.${key}`, `access.${ACCESS}`])).status, 401, 'protocol version not offered');
        assert.equal((await socketStatus(relay.origin, mailbox, [v1, `key.${key}`, `access.${ACCESS}`])).status, 426, 'right credentials, but not a WebSocket upgrade');
        await assert.rejects(connect(relay.origin, key), /refused|closed/, 'a real socket without the access key is refused');
        await assert.rejects(connect(relay.origin, newKey(), { access: ACCESS, mailbox }), /refused|closed/, "a real socket with another mailbox's key is refused");
        const sock = await connect(relay.origin, key, { access: ACCESS });
        assert.equal(sock.ws.protocol, v1);
        const hello = await sock.next('hello');
        assert.equal(hello.v, 1);
        assert.ok(Math.abs(hello.now - now()) < 5);
        await sock.close();
    });

    test('a hook nobody registered is not an address: 404', async () => {
        const mailbox = await mailboxIdOf(newKey());
        assert.equal((await post(relay.origin, mailbox, newHook(), { eventId: 'e1' })).status, 404);
        assert.equal((await post(relay.origin, 'not-a-mailbox', newHook(), { eventId: 'e1' })).status, 404);
        assert.equal((await fetch(`${relay.origin}/hooks/${mailbox}/${newHook()}`)).status, 405);
    });

    test('a delivery is stored, then handed over unchanged with its headers and receipt time; an ack removes it', async () => {
        const key = newKey();
        const hook = newHook();
        const secret = newSecret();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        // Odd spacing, an escape and non-ASCII text: the body must come through byte for byte.
        const body = '{ "eventId":"evt_1",  "name":"deploy.finished", "data":{"note":"caf\\u00e9 – déjà vu ✓"} }';
        const ts = now();
        const res = await post(relay.origin, sock.mailbox, hook, body, { id: 'msg_abc-1', timestamp: ts, secret, subscriptionId: 'sub_9' });
        assert.equal(res.status, 200);
        const d = await sock.next('delivery');
        assert.equal(d.hook, hook);
        assert.equal(d.body, body);
        assert.deepEqual(d.headers, { 'webhook-id': 'msg_abc-1', 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, 'msg_abc-1', ts, body), 'x-mcp-subscription-id': 'sub_9' });
        assert.ok(Math.abs(d.receivedAt - ts) <= 2);
        assert.equal(sign(secret, d.headers['webhook-id'], Number(d.headers['webhook-timestamp']), d.body), d.headers['webhook-signature'], 'the signature still verifies over what was handed on');
        sock.send({ t: 'ack', seqs: [d.seq] });
        await sleep(150);
        await sock.close();

        const again = await connect(relay.origin, key, { access: ACCESS });
        await again.add(hook);
        await sleep(300);
        assert.equal(again.messages.filter((m) => m.t === 'delivery').length, 0, 'an acked delivery is gone');
        await again.close();
    });

    test('deliveries wait while nobody is connected, arrive in order, and come again until acked', async () => {
        const key = newKey();
        const hook = newHook();
        const first = await connect(relay.origin, key, { access: ACCESS });
        await first.add(hook);
        await first.close();

        for (const n of [1, 2, 3]) assert.equal((await post(relay.origin, first.mailbox, hook, { eventId: `e${n}` })).status, 200);

        const second = await connect(relay.origin, key, { access: ACCESS });
        await sleep(200);
        assert.equal(second.messages.filter((m) => m.t === 'delivery').length, 0, 'nothing is sent for a hook until this connection adds it');
        await second.add(hook);
        await second.next('delivery', (m) => m.body.includes('"e3"'));
        const got = second.messages.filter((m) => m.t === 'delivery');
        assert.deepEqual(got.map((m) => JSON.parse(m.body).eventId), ['e1', 'e2', 'e3']);
        second.send({ t: 'ack', seqs: [got[0]!.seq] });
        await sleep(150);
        await second.close();

        const third = await connect(relay.origin, key, { access: ACCESS });
        await third.add(hook);
        await third.next('delivery', (m) => m.body.includes('"e3"'));
        assert.deepEqual(third.messages.filter((m) => m.t === 'delivery').map((m) => JSON.parse(m.body).eventId), ['e2', 'e3']);
        await third.close();
    });

    test('a retry with the same webhook-id is stored once', async () => {
        const key = newKey();
        const hook = newHook();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        // A retry repeats the first send exactly, timestamp included: with a new timestamp it is a new delivery.
        const timestamp = Math.floor(Date.now() / 1000);
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'e1' }, { id: 'msg_same', timestamp })).status, 200);
        await sleep(1100);
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'e1' }, { id: 'msg_same', timestamp })).status, 200);
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'e2' }, { id: 'msg_other' })).status, 200);
        await sock.next('delivery', (m) => m.body.includes('"e2"'));
        assert.equal(sock.messages.filter((m) => m.t === 'delivery').length, 2);
        await sock.close();
    });

    test("a verification challenge goes to the connected plugin, and the plugin's answer goes back to the server", async () => {
        const key = newKey();
        const hook = newHook();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        const challenge = { type: 'verification', challenge: 'nonce-123' };

        const echoed = post(relay.origin, sock.mailbox, hook, challenge, { id: 'msg_verification_1' });
        const ask = await sock.next('ask', (m) => m.headers['webhook-id'] === 'msg_verification_1');
        assert.equal(ask.hook, hook);
        assert.deepEqual(JSON.parse(ask.body), challenge);
        sock.send({ t: 'answer', id: ask.id, status: 200, body: JSON.stringify({ challenge: 'nonce-123' }) });
        const ok = await echoed;
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { challenge: 'nonce-123' });

        const refused = post(relay.origin, sock.mailbox, hook, challenge, { id: 'msg_verification_2' });
        const ask2 = await sock.next('ask', (m) => m.headers['webhook-id'] === 'msg_verification_2');
        sock.send({ t: 'answer', id: ask2.id, status: 401 });
        // Not passed on as such: the same answer as when nobody is connected, so that whoever posts a
        // challenge without the secret cannot tell whether the plugin is online.
        assert.equal((await refused).status, 503, "the plugin's refusal is answered as unconfirmed");

        const unanswered = await post(relay.origin, sock.mailbox, hook, challenge, { id: 'msg_verification_3' });
        assert.equal(unanswered.status, 503, 'no answer in time: the server may try again');

        assert.equal(sock.messages.filter((m) => m.t === 'delivery').length, 0, 'a challenge is never stored as a delivery');
        await sock.close();
        await sleep(100);
        const offline = await post(relay.origin, sock.mailbox, hook, challenge, { id: 'msg_verification_4' });
        assert.equal(offline.status, 503, 'nobody connected: the relay cannot answer a challenge itself');
    });

    test('malformed deliveries are refused before anything is stored', async () => {
        const key = newKey();
        const hook = newHook();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        const url = `${relay.origin}/hooks/${sock.mailbox}/${hook}`;
        const good = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(now()), 'webhook-signature': 'v1,AAAA' };
        const send = (headers: Record<string, string>, body: BodyInit = '{"eventId":"e1"}') => fetch(url, { method: 'POST', body, headers });

        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'old' }, { timestamp: now() - 301 })).status, 410, 'older than 5 minutes: gone, not to be retried');
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'future' }, { timestamp: now() + 301 })).status, 400, 'more than 5 minutes ahead');
        for (const missing of Object.keys(good)) {
            const h: Record<string, string> = { ...good };
            delete h[missing];
            assert.equal((await send(h)).status, 400, `no ${missing}`);
        }
        assert.equal((await send({ ...good, 'webhook-id': 'has spaces' })).status, 400, 'webhook-id outside its alphabet');
        assert.equal((await send({ ...good, 'webhook-timestamp': 'soon' })).status, 400, 'timestamp is not a number');
        assert.equal((await send(good, 'not json')).status, 400, 'not JSON');
        assert.equal((await send(good, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))).status, 400, 'not UTF-8');
        assert.equal((await send(good, Buffer.alloc(256 * 1024 + 1, 0x20))).status, 413, 'over 256 KiB');
        assert.equal((await send({ ...good, 'webhook-signature': 'v1,caf\u00e9' })).status, 400, 'header text that is not plain');
        assert.equal((await send(good)).status, 200, 'the well-formed one is accepted');
        await sock.next('delivery');
        assert.equal(sock.messages.filter((m) => m.t === 'delivery').length, 1);
        // An empty optional header is no header: what is stored is something the plugin can judge (and so can clear).
        assert.equal((await send({ ...good, 'webhook-id': 'msg_2', 'x-mcp-subscription-id': '' })).status, 200);
        const second = await sock.next('delivery', (m) => m.t === 'delivery' && m.headers['webhook-id'] === 'msg_2');
        assert.deepEqual(Object.keys((second as { headers: object }).headers).sort(), ['webhook-id', 'webhook-signature', 'webhook-timestamp']);
        await sock.close();
    });

    test('a removed hook answers 410 and its queue is dropped', async () => {
        const key = newKey();
        const hook = newHook();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        await sock.close();
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'e1' })).status, 200);

        const again = await connect(relay.origin, key, { access: ACCESS });
        await again.remove(hook);
        assert.equal((await post(relay.origin, again.mailbox, hook, { eventId: 'e2' })).status, 410);
        await again.add(hook);
        await sleep(300);
        assert.equal(again.messages.filter((m) => m.t === 'delivery').length, 0, 'what was queued for the removed hook is gone');
        await again.close();
    });

    test("one mailbox's key reads nothing of another's, and a newer connection replaces the older", async () => {
        const a = await connect(relay.origin, newKey(), { access: ACCESS });
        const b = await connect(relay.origin, newKey(), { access: ACCESS });
        const hook = newHook();
        await a.add(hook);
        await b.add(hook); // the same hook name in another mailbox is another address
        assert.equal((await post(relay.origin, a.mailbox, hook, { eventId: 'for-a' })).status, 200);
        await a.next('delivery');
        await sleep(200);
        assert.equal(b.messages.filter((m) => m.t === 'delivery').length, 0);

        const a2 = await connect(relay.origin, 'unused', { access: ACCESS, mailbox: a.mailbox }).catch(() => undefined);
        assert.equal(a2, undefined, 'knowing a mailbox name is not enough to connect to it');
        await b.close();
        await a.close();

        const key = newKey();
        const older = await connect(relay.origin, key, { access: ACCESS });
        await older.add(hook);
        const newer = await connect(relay.origin, key, { access: ACCESS });
        await newer.add(hook);
        for (let i = 0; i < 30 && !older.closed(); i++) await sleep(100);
        assert.equal(older.closed()?.code, 4001, 'the older connection is closed');
        assert.equal((await post(relay.origin, newer.mailbox, hook, { eventId: 'e1' })).status, 200);
        await newer.next('delivery');
        await newer.close();
    });

    test('a full mailbox answers 503 until deliveries are acked', async () => {
        const key = newKey();
        const hook = newHook();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        for (let n = 1; n <= 5; n++) assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: `e${n}` })).status, 200);
        const full = await post(relay.origin, sock.mailbox, hook, { eventId: 'e6' });
        assert.equal(full.status, 503);
        assert.ok(full.headers.get('retry-after'));
        await sock.next('delivery', (m) => m.body.includes('"e5"'));
        sock.send({ t: 'ack', seqs: sock.messages.filter((m) => m.t === 'delivery').map((m) => m.seq) });
        await sleep(150);
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'e6' })).status, 200);
        await sock.close();
    });

    test('once replaced, a connection has no say: what it sends afterwards changes nothing', async () => {
        const key = newKey();
        const hook = newHook();
        const mailbox = await mailboxIdOf(key);
        // The older connection keeps its end open and keeps sending after the relay has replaced it.
        const older = await stubbornSocket(relay.origin, mailbox, ['mcp-events-relay.v1', `key.${key}`, `access.${ACCESS}`]);
        older.send({ t: 'add', n: 1, hook });
        await sleep(300);
        assert.equal((await post(relay.origin, mailbox, hook, { eventId: 'kept' })).status, 200);
        const newer = await connect(relay.origin, key, { access: ACCESS });
        await newer.next('hello');
        older.send({ t: 'remove', n: 2, hook });
        older.send({ t: 'ack', seqs: [1, 2, 3, 4, 5] });
        await sleep(500);
        assert.equal((await post(relay.origin, mailbox, hook, { eventId: 'after' })).status, 200, 'the hook was not retired by the replaced connection');
        await newer.add(hook);
        await newer.next('delivery', (m) => m.body.includes('"after"'));
        assert.deepEqual(newer.messages.filter((m) => m.t === 'delivery').map((m) => JSON.parse(m.body).eventId), ['kept', 'after'], 'and its queue is intact');
        older.end();
        await newer.close();
    });

    test('a different body under a known webhook-id is kept beside the genuine delivery, not instead of it', async () => {
        const key = newKey();
        const hook = newHook();
        const secret = newSecret();
        const sock = await connect(relay.origin, key, { access: ACCESS });
        await sock.add(hook);
        // Somebody who knows the address and guesses the id gets there first, with something unsigned.
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'junk' }, { id: 'msg_guessed' })).status, 200);
        const ts = now();
        const genuine = await post(relay.origin, sock.mailbox, hook, { eventId: 'genuine' }, { id: 'msg_guessed', secret, timestamp: ts });
        assert.equal(genuine.status, 200);
        const again = await post(relay.origin, sock.mailbox, hook, { eventId: 'genuine' }, { id: 'msg_guessed', secret, timestamp: ts });
        assert.equal(again.status, 200, 'the very same delivery again is a retry');
        // Somebody holding a copy of the genuine delivery sends it again with only its timestamp changed
        // (which breaks its signature). That is a different delivery, not a retry of the genuine one.
        const body = JSON.stringify({ eventId: 'genuine' });
        const shifted = await fetch(`${relay.origin}/hooks/${sock.mailbox}/${hook}`, { method: 'POST', body, headers: { 'webhook-id': 'msg_guessed', 'webhook-timestamp': String(ts + 1), 'webhook-signature': sign(secret, 'msg_guessed', ts, body) } });
        assert.equal(shifted.status, 200);
        await sock.next('delivery', (m) => m.headers['webhook-timestamp'] === String(ts + 1));
        await sleep(200);
        const got = sock.messages.filter((m) => m.t === 'delivery');
        assert.deepEqual(got.map((m) => JSON.parse(m.body).eventId), ['junk', 'genuine', 'genuine'], 'each distinct delivery is handed over once; the plugin tells them apart by signature');
        assert.deepEqual(got.map((m) => m.headers['webhook-timestamp']), [got[0]!.headers['webhook-timestamp'], String(ts), String(ts + 1)]);
        await sock.close();
    });

    test('only so many challenges wait for an answer at once', async () => {
        const sock = await connect(relay.origin, newKey(), { access: ACCESS });
        const hook = newHook();
        await sock.add(hook);
        const answers = await Promise.all(Array.from({ length: 24 }, (_, i) => post(relay.origin, sock.mailbox, hook, { type: 'verification', challenge: `n${i}` }, { id: `msg_verification_flood_${i}` })));
        assert.ok(answers.every((r) => r.status === 503), 'none was answered, so all are told to try again');
        assert.ok(sock.messages.filter((m) => m.t === 'ask').length <= 16, 'and the plugin was asked about at most 16');
        await sock.close();
    });

    test('bad requests on the socket get an error, not a disconnect', async () => {
        const sock = await connect(relay.origin, newKey(), { access: ACCESS });
        sock.send({ t: 'add', n: 1, hook: 'short' });
        const e = await sock.next('error', (m) => m.n === 1);
        assert.match(e.message, /hook/);
        sock.ws.send('not json');
        await sock.next('error', (m) => m.n === undefined);
        sock.ws.send('ping');
        await sock.add(newHook());
        assert.equal(sock.closed(), undefined);
        await sock.close();
    });
});

describe('what the relay stores survives a restart', { concurrency: false }, () => {
    test('queued deliveries and registered hooks are on disk, not in memory', async () => {
        const key = newKey();
        const hook = newHook();
        let relay = await startRelay({ ACCESS_KEY: ACCESS });
        const stateDir = relay.stateDir;
        try {
            const sock = await connect(relay.origin, key, { access: ACCESS });
            await sock.add(hook);
            await sock.close();
            assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'kept' })).status, 200);
            await relay.stop(true);

            relay = await startRelay({ ACCESS_KEY: ACCESS }, stateDir);
            assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'after' })).status, 200, 'the hook is still registered');
            const again = await connect(relay.origin, key, { access: ACCESS });
            await again.add(hook);
            await again.next('delivery', (m) => m.body.includes('"after"'));
            assert.deepEqual(again.messages.filter((m) => m.t === 'delivery').map((m) => JSON.parse(m.body).eventId), ['kept', 'after']);
            await again.close();
        } finally {
            await relay.stop();
        }
    });
});

describe('old deliveries and idle hooks are cleared out', { concurrency: false }, () => {
    test('a delivery nobody collected within the retention time is dropped; so is a hook nobody used', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS, DELIVERY_TTL_S: '1', HOOK_IDLE_TTL_S: '3' });
        try {
            const key = newKey();
            const hook = newHook();
            const sock = await connect(relay.origin, key, { access: ACCESS });
            await sock.add(hook);
            await sock.close();
            assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'stale' })).status, 200);
            await sleep(2200);
            const again = await connect(relay.origin, key, { access: ACCESS }); // connecting runs the clean-up
            await again.add(hook);
            assert.equal((await post(relay.origin, again.mailbox, hook, { eventId: 'fresh' })).status, 200);
            await again.next('delivery', (m) => m.body.includes('"fresh"'));
            assert.deepEqual(again.messages.filter((m) => m.t === 'delivery').map((m) => JSON.parse(m.body).eventId), ['fresh']);
            await again.close();

            await sleep(4200);
            const later = await connect(relay.origin, key, { access: ACCESS });
            await later.next('hello');
            assert.equal((await post(relay.origin, later.mailbox, hook, { eventId: 'late' })).status, 410, 'an idle hook is retired');
            await later.close();
        } finally {
            await relay.stop();
        }
    });
});

describe('a hook somebody is connected for is in use', { concurrency: false }, () => {
    test('it is not retired for being quiet while its reader is there', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS, HOOK_IDLE_TTL_S: '2' });
        try {
            const key = newKey();
            const hook = newHook();
            const reader = await connect(relay.origin, key, { access: ACCESS });
            await reader.add(hook);
            await sleep(3200); // quiet for longer than the idle time, with the reader attached throughout
            const next = await connect(relay.origin, key, { access: ACCESS }); // connecting runs the clean-up
            await next.next('hello');
            assert.equal((await post(relay.origin, next.mailbox, hook, { eventId: 'still-here' })).status, 200, 'the hook was in use, so it is still an address');
            await next.close();
        } finally {
            await relay.stop();
        }
    });
});

describe('relay with no access key', { concurrency: false }, () => {
    test('refuses every socket until it is given a key or is opened on purpose', async () => {
        const closedRelay = await startRelay({});
        try {
            const key = newKey();
            const r = await socketStatus(closedRelay.origin, await mailboxIdOf(key), ['mcp-events-relay.v1', `key.${key}`]);
            assert.equal(r.status, 503);
            assert.match(r.body, /ACCESS_KEY/);
            await assert.rejects(connect(closedRelay.origin, key));
        } finally {
            await closedRelay.stop();
        }
        const open = await startRelay({ OPEN_RELAY: '1' });
        try {
            const sock = await connect(open.origin, newKey());
            await sock.add(newHook());
            await sock.close();
        } finally {
            await open.stop();
        }
    });
});

describe('a relay anyone may use (wrangler.public.jsonc)', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test('its front page says who runs it, that anyone may use it, what passes through it and for how long', async () => {
        const about = (await (await fetch(relay.origin + '/')).json()) as { operator: string; open: boolean; retentionHours: number; holds: string; source: string };
        assert.match(about.operator, /\S/);
        assert.equal(about.open, true);
        assert.equal(about.retentionHours, 23, 'dropped after 23 hours; with the hourly clear-out, within a day');
        assert.equal((about as { rateLimited?: boolean }).rateLimited, true);
        assert.match(about.holds, /pass through this server/);
        assert.match(about.holds, /no signing secret/);
        assert.match(about.source, /^https:\/\/github\.com\//);
        assert.equal((about as { newMailboxesPerHour?: number }).newMailboxesPerHour, 2000);
        assert.equal((about as { newMailboxesPerSenderPerHour?: number }).newMailboxesPerSenderPerHour, 60);
    });

    test('no access key is asked for, and a mailbox still opens only with its own key', async () => {
        const key = newKey();
        const sock = await connect(relay.origin, key);
        const hook = newHook();
        await sock.add(hook);
        assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: 'mine' })).status, 200);
        assert.equal((await sock.next('delivery')).body, JSON.stringify({ eventId: 'mine' }));
        const other = await socketStatus(relay.origin, sock.mailbox, ['mcp-events-relay.v1', `key.${newKey()}`]);
        assert.equal(other.status, 401, "someone else's key does not open it");
        await sock.close();
    });

    test('one mailbox has at most 16 webhook addresses', async () => {
        const sock = await connect(relay.origin, newKey());
        for (let i = 0; i < 16; i++) await sock.add(newHook());
        sock.send({ t: 'add', n: 999, hook: newHook() });
        const refused = await sock.next('error', (m) => m.n === 999);
        assert.match(refused.message, /already has 16 hooks/);
        await sock.close();
    });

});

describe('a relay anyone may use: how much one address and one mailbox take', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test('one mailbox holds at most 100 deliveries, and one address takes at most about 120 a minute: past either, the sender is told to come back', async () => {
        const sock = await connect(relay.origin, newKey());
        const hook = newHook();
        await sock.add(hook);
        await sock.close();
        // Enough that more than 120 fall inside one minute of the limiter's clock, wherever that minute starts.
        const statuses: number[] = [];
        let retryAfter: string | null = null;
        for (let i = 0; i < 260; i++) {
            const r = await post(relay.origin, sock.mailbox, hook, { eventId: `e${i}` });
            statuses.push(r.status);
            if (r.status === 429) retryAfter ??= r.headers.get('retry-after');
        }
        assert.deepEqual(statuses.slice(0, 100), Array(100).fill(200), 'the first hundred are kept');
        assert.equal(statuses[100], 503, 'the mailbox is full');
        assert.ok(statuses.includes(429), 'the rate limit is reached');
        assert.equal(retryAfter, '60');
        assert.ok(statuses.every((x) => x === 200 || x === 503 || x === 429));
        // Another mailbox is not held back by this one.
        const quiet = await connect(relay.origin, newKey());
        const h2 = newHook();
        await quiet.add(h2);
        assert.equal((await post(relay.origin, quiet.mailbox, h2, { eventId: 'fine' })).status, 200);
        await quiet.close();
    });
});

describe('a relay anyone may use: one server cannot use up what another may receive', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test("junk sent to the mailbox, and a flood to one address, leave another address's allowance alone", async () => {
        const sock = await connect(relay.origin, newKey());
        const [mine, theirs] = [newHook(), newHook()];
        await sock.add(mine);
        await sock.add(theirs);
        // Collect as the plugin does, so the mailbox never fills.
        sock.ws.addEventListener('message', (e) => {
            const m = JSON.parse(String(e.data)) as { t: string; seq?: number };
            if (m.t === 'delivery') sock.send({ t: 'ack', seqs: [m.seq!] });
        });
        // More than an address's allowance for a minute (120), none of it a real delivery: with no
        // headers at all, and well formed but to an address that was never registered.
        const junk: number[] = [];
        for (let i = 0; i < 70; i++) junk.push((await fetch(`${relay.origin}/hooks/${sock.mailbox}/${newHook()}`, { method: 'POST', body: '{}' })).status);
        for (let i = 0; i < 70; i++) junk.push((await post(relay.origin, sock.mailbox, newHook(), { eventId: `junk${i}` })).status);
        assert.deepEqual([...new Set(junk)].sort(), [400, 404]);
        assert.equal((await post(relay.origin, sock.mailbox, mine, { eventId: 'genuine-1' })).status, 200, 'junk does not use up a real address');

        // A server that floods its own address is held back; the address beside it is not.
        const flood: number[] = [];
        for (let i = 0; i < 125; i++) flood.push((await post(relay.origin, sock.mailbox, theirs, { eventId: `f${i}` })).status);
        assert.ok(flood.every((x) => x === 200 || x === 429), `only kept or told to come back: ${[...new Set(flood)]}`);
        assert.equal((await post(relay.origin, sock.mailbox, mine, { eventId: 'genuine-2' })).status, 200, "another address's flood does not use up this one");
        await sock.next('delivery', (m) => m.body.includes('genuine-2'));
        await sock.close();
    });
});

describe('what one connection may ask of the relay', { concurrency: false }, () => {
    test('asking again for a hook already asked for on this connection sends nothing again', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        try {
            const sock = await connect(relay.origin, newKey(), { access: ACCESS });
            const hook = newHook();
            await sock.add(hook);
            for (const n of [1, 2, 3]) assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: `e${n}` })).status, 200);
            await sock.next('delivery', (m) => m.body.includes('"e3"'));
            for (let i = 0; i < 5; i++) {
                sock.send({ t: 'add', n: 100 + i, hook });
                assert.equal((await sock.next('ok', (m) => m.n === 100 + i)).queued, 0);
            }
            await sleep(300);
            assert.equal(sock.messages.filter((m) => m.t === 'delivery').length, 3, 'each held delivery was sent once on this connection');
            await sock.close();
        } finally {
            await relay.stop();
        }
    });

    test('a connection that sends more messages in a minute than a client has reason to is closed; so is one that sends an oversized frame', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS, SOCKET_MESSAGES_PER_MINUTE: '20' });
        try {
            const chatty = await connect(relay.origin, newKey(), { access: ACCESS });
            // Enough that more than 20 fall inside one minute, wherever that minute starts.
            for (let i = 0; i < 45; i++) if (chatty.ws.readyState === WebSocket.OPEN) chatty.send({ t: 'ack', seqs: [] });
            for (let i = 0; i < 50 && !chatty.closed(); i++) await sleep(100);
            assert.equal(chatty.closed()?.code, 4008);

            const big = await connect(relay.origin, newKey(), { access: ACCESS });
            big.ws.send('x'.repeat(300 * 1024));
            for (let i = 0; i < 50 && !big.closed(); i++) await sleep(100);
            assert.equal(big.closed()?.code, 1009);
        } finally {
            await relay.stop();
        }
    });
});

describe('a relay set to refuse what it cannot limit', { concurrency: false }, () => {
    test('with REQUIRE_LIMITS and no limiter to ask, it takes neither a connection nor a delivery', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', REQUIRE_LIMITS: '1' });
        try {
            const key = newKey();
            const mailbox = await mailboxIdOf(key);
            const opened = await upgradeStatus(relay.origin, mailbox, ['mcp-events-relay.v1', `key.${key}`]);
            assert.equal(opened.status, 503);
            assert.equal(opened.retryAfter, '60');
            const r = await post(relay.origin, mailbox, newHook(), { eventId: 'e1' });
            assert.equal(r.status, 503);
            assert.equal(r.headers.get('retry-after'), '60');
        } finally {
            await relay.stop();
        }
    });
});

describe('a ceiling on new mailboxes', { concurrency: false }, () => {
    const protocols = (key: string) => ['mcp-events-relay.v1', `key.${key}`];

    test('past what the relay opens in an hour, a new mailbox is refused and one that exists still opens', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', NEW_MAILBOXES_PER_HOUR: '2' });
        try {
            const first = newKey();
            const a = await connect(relay.origin, first);
            await a.add(newHook());
            await a.close();
            await (await connect(relay.origin, newKey())).close();
            const third = newKey();
            const refused = await upgradeStatus(relay.origin, await mailboxIdOf(third), protocols(third));
            assert.equal(refused.status, 429);
            assert.match(refused.body, /as many new mailboxes/);
            assert.ok(Number(refused.retryAfter) > 0);
            await (await connect(relay.origin, first)).close();
        } finally {
            await relay.stop();
        }
    });

    test('one address opens only so many in an hour', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', NEW_MAILBOXES_PER_SENDER_PER_HOUR: '1' });
        try {
            await (await connect(relay.origin, newKey())).close();
            const second = newKey();
            const refused = await upgradeStatus(relay.origin, await mailboxIdOf(second), protocols(second));
            assert.equal(refused.status, 429);
            assert.match(refused.body, /from this address/);
        } finally {
            await relay.stop();
        }
    });

    test('a mailbox with no address and nobody connected gives its storage back; one with an address is kept', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', NEW_MAILBOXES_PER_HOUR: '2', CLEANUP_EVERY_MS: '300' });
        try {
            const [kept, left] = [newKey(), newKey()];
            const a = await connect(relay.origin, kept);
            await a.add(newHook());
            await a.close();
            await (await connect(relay.origin, left)).close(); // opened, and nothing asked of it
            await sleep(2000); // several clear-outs
            // The hour's two are spent, so only a mailbox that still exists can be opened now.
            assert.equal((await upgradeStatus(relay.origin, await mailboxIdOf(kept), protocols(kept))).status, 101, 'a mailbox with an address is still there');
            assert.equal((await upgradeStatus(relay.origin, await mailboxIdOf(left), protocols(left))).status, 429, 'the empty one was given back, so opening it is opening a new one');
        } finally {
            await relay.stop();
        }
    });
});

describe('an address is in use while its owner collects, not while things arrive', { concurrency: false }, () => {
    test('deliveries from anyone do not keep an abandoned address from being retired', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS, HOOK_IDLE_TTL_S: '3' });
        try {
            const key = newKey();
            const hook = newHook();
            const sock = await connect(relay.origin, key, { access: ACCESS });
            await sock.add(hook);
            await sock.close();
            for (let i = 0; i < 7; i++) {
                assert.equal((await post(relay.origin, sock.mailbox, hook, { eventId: `junk${i}` })).status, 200);
                await sleep(700);
            }
            const later = await connect(relay.origin, key, { access: ACCESS }); // connecting runs the clean-up
            await later.next('hello');
            assert.equal((await post(relay.origin, later.mailbox, hook, { eventId: 'late' })).status, 410, 'nobody collected for longer than the idle time, so it is retired');
            await later.close();
        } finally {
            await relay.stop();
        }
    });
});

describe('a sender is counted by its IPv6 /64, not by each address in it', { concurrency: false }, () => {
    test('new mailboxes from many addresses in one /64 count as one sender; another /64 and an IPv4 address do not', async () => {
        const relay = await startRelay({ OPEN_RELAY: '1', NEW_MAILBOXES_PER_SENDER_PER_HOUR: '1' });
        try {
            const open = async (ip: string) => {
                const key = newKey();
                return (await upgradeStatus(relay.origin, await mailboxIdOf(key), ['mcp-events-relay.v1', `key.${key}`], { 'cf-connecting-ip': ip })).status;
            };
            assert.equal(await open('2001:db8:1:2::1'), 101);
            assert.equal(await open('2001:db8:1:2::2'), 429, 'a second address in the same /64 is the same sender');
            assert.equal(await open('2001:db8:1:2:ffff:ffff:ffff:ffff'), 429);
            assert.equal(await open('2001:db8:1:3::1'), 101, 'another /64 is another sender');
            assert.equal(await open('203.0.113.9'), 101);
            assert.equal(await open('203.0.113.10'), 101, 'each IPv4 address is a sender of its own');
        } finally {
            await relay.stop();
        }
    });
});

describe('MCP servers hosted on Cloudflare Workers, which all arrive from one address', { concurrency: false }, () => {
    let relay: Relay;
    before(async () => {
        relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
    });
    after(() => relay.stop());

    test("are counted in a bucket of their own, larger than one machine's", async () => {
        const sock = await connect(relay.origin, newKey());
        const hooks = [newHook(), newHook(), newHook()];
        for (const h of hooks) await sock.add(h);
        sock.ws.addEventListener('message', (e) => {
            const m = JSON.parse(String(e.data)) as { t: string; seq?: number };
            if (m.t === 'delivery') sock.send({ t: 'ack', seqs: [m.seq!] });
        });
        // More than one machine may send in a minute (300), spread over three addresses so that no
        // address's own allowance (120) is reached.
        const statuses: number[] = [];
        for (let i = 0; i < 330; i++) statuses.push((await post(relay.origin, sock.mailbox, hooks[i % 3]!, { eventId: `w${i}` }, { headers: { 'cf-connecting-ip': '2a06:98c0:3600::103' } })).status);
        assert.ok(!statuses.includes(429), `none was refused as too many from one sender: ${[...new Set(statuses)]}`);
        assert.ok(statuses.every((x) => x === 200 || x === 503), 'kept, or the mailbox was full for a moment');
        await sock.close();
    });
});
