// Tests of the client's hardening: what is redacted, what a relay may hand over, which relay a
// saved mailbox key is for, and collecting again from a relay that sends what it holds once per
// connection. The wake limit and the wake message are in wake-test.ts; the relay's own are in
// mod/relay/test.

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Occurrence } from '../src/events-client.ts';
import { dropLegacyMailboxKey, legacyMailboxKey, RelayClient, serverMailboxKey } from '../src/relay.ts';
import { handleDelivery, MAX_CURSOR, newSecret, sign, type Hook } from '../src/webhooks.ts';
import { sleep, startMonitor, startPlugin, temp, waitFor, world } from './harness.ts';

const now = () => Math.floor(Date.now() / 1000);
const headersFor = (secret: string, raw: string, id = 'msg_' + Math.random().toString(36).slice(2), ts = now()) => ({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, id, ts, raw) });
const HOOK = 'h'.repeat(24);
const settings = { url: 'https://relay.example', source: 'test' };

/** A stand-in for the relay's end: each connection is a new socket, and `onMessage` sees which one. */
function fakeRelay(onMessage: (m: { t: string; n?: number; hook?: string; seqs?: number[] }, send: (frame: unknown) => void, connection: number) => void) {
    const sent: { t: string; n?: number; hook?: string; seqs?: number[]; connection: number }[] = [];
    let connections = 0;
    const socket = () => {
        const connection = ++connections;
        const listeners: Record<string, ((e: never) => void)[]> = {};
        const fire = (type: string, e: unknown) => (listeners[type] ?? []).forEach((l) => l(e as never));
        const ws = {
            readyState: 0,
            addEventListener: (type: string, l: (e: never) => void) => void (listeners[type] ??= []).push(l),
            send: (data: string) => {
                if (data === 'ping') return;
                const m = JSON.parse(data);
                sent.push({ ...m, connection });
                onMessage(m, (frame) => setImmediate(() => ws.readyState === 1 && fire('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) })), connection);
            },
            close: () => {
                ws.readyState = 3;
                setImmediate(() => fire('close', { code: 1000 }));
            }
        };
        setImmediate(() => {
            ws.readyState = 1;
            fire('open', {});
        });
        return ws as unknown as WebSocket;
    };
    return { socket, sent, connections: () => connections };
}

describe('what a server sends back is not shown, wherever in the event it puts it', () => {
    test("a secret in an event's id is taken out of get_event and recent_events", async () => {
        const token = 'tok_live_9f8e7d6c5b4a3210';
        // A local server's environment values are among the secrets this process knows.
        const w = world({ FIXTURE_TOKEN: token });
        const plugin = await startPlugin(w);
        const monitor = startMonitor(w);
        try {
            assert.equal((await plugin.call('watch_event', { server: 'tickets', event: 'ticket.created' })).isError, false);
            await waitFor(() => w.fixtureMethods().includes('events/stream'), 8000, 'events/stream');
            await sleep(300);
            w.emit('ticket.created', { ticketId: 'T-1', echoed: token }, `evt-${token}`);
            const line = await waitFor(() => monitor.lines.find((l) => l.includes('T-1')), 8000, 'the event');
            const got = (await plugin.call('get_event', { id: /\[event (e\d+)/.exec(line)![1]! })).text;
            assert.ok(!got.includes(token), 'not in what get_event returns');
            assert.match(got, /"eventId": "evt-\[redacted\]"/);
            assert.ok(![line, (await plugin.call('recent_events')).text].join('\n').includes(token));
        } finally {
            monitor.stop();
            await plugin.stop();
        }
    });
});

describe('what a relay hands over is bounded here, not on its word', () => {
    test('a delivery over 256 KiB is refused however it arrived, correctly signed or not', async () => {
        const got: string[] = [];
        const hook: Hook = { secret: newSecret(), onEvent: (o: Occurrence) => void got.push(o.eventId) };
        const big = JSON.stringify({ eventId: 'big', name: 'x', timestamp: 't', data: { blob: 'é'.repeat(140 * 1024) } }); // under 256 Ki characters, over 256 KiB as UTF-8
        assert.ok(big.length < 256 * 1024 && Buffer.byteLength(big) > 256 * 1024);
        const r = await handleDelivery(hook, headersFor(hook.secret, big), big, { nowS: now() });
        assert.equal(r.status, 413);
        assert.deepEqual(got, []);
        const fine = JSON.stringify({ eventId: 'fine', name: 'x', timestamp: 't', data: {} });
        assert.equal((await handleDelivery(hook, headersFor(hook.secret, fine), fine)).status, 200);
        assert.deepEqual(got, ['fine']);
    });

    test('a cursor too long to be one is not kept', async () => {
        const cursors: (string | null)[] = [];
        const hook: Hook = { secret: newSecret(), onEvent: () => {}, onGap: (c) => void cursors.push(c) };
        for (const cursor of ['c'.repeat(200 * 1024), 'c'.repeat(MAX_CURSOR), 'next']) {
            const raw = JSON.stringify({ type: 'gap', cursor });
            assert.equal((await handleDelivery(hook, headersFor(hook.secret, raw), raw)).status, 200);
        }
        assert.deepEqual(cursors.map((c) => c?.length ?? null), [null, MAX_CURSOR, 4]);
    });

    test('deliveries waiting to be judged are bounded in bytes: the rest stay at the relay, unacknowledged', async () => {
        const secret = newSecret();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const got: string[] = [];
        const body = (n: number) => JSON.stringify({ eventId: `e${n}`, name: 'x', timestamp: 't', data: { pad: 'x'.repeat(100 * 1024) } });
        const relay = fakeRelay((m, send) => {
            if (m.t !== 'add') return;
            send({ t: 'ok', n: m.n, queued: 0 });
            for (let n = 1; n <= 30; n++) send({ t: 'delivery', seq: n, hook: HOOK, headers: headersFor(secret, body(n), `msg_${n}`), body: body(n), receivedAt: now() });
        });
        const client = new RelayClient({ settings, key: 'k'.repeat(43), socket: relay.socket, maxWaitingBytes: 1024 * 1024 });
        await client.add(HOOK, {
            secret,
            onEvent: async (o) => {
                await held; // the first one takes its time: the rest pile up behind it
                got.push(o.eventId);
            }
        });
        await sleep(300);
        release();
        await waitFor(() => got.length >= 9, 5000, 'the ones that fitted');
        await sleep(200);
        assert.ok(got.length >= 9 && got.length <= 10, `about a megabyte's worth were taken, not all thirty: ${got.length}`);
        const acked = relay.sent.filter((m) => m.t === 'ack').flatMap((m) => m.seqs ?? []);
        assert.deepEqual(acked, got.map((id) => Number(id.slice(1))), 'and only those were acknowledged');
        await client.close();
    });

    test('a frame larger than any delivery can be is not read, and the relay that sent it loses the connection', async () => {
        const secret = newSecret();
        const got: string[] = [];
        const logged: string[] = [];
        const relay = fakeRelay((m, send) => {
            if (m.t !== 'add') return;
            send({ t: 'ok', n: m.n, queued: 0 });
            send(JSON.stringify({ t: 'delivery', seq: 1, hook: HOOK, headers: {}, body: 'x'.repeat(900 * 1024), receivedAt: now() }));
        });
        const client = new RelayClient({ settings, key: 'k'.repeat(43), socket: relay.socket, log: (s) => logged.push(s), backoffMs: 60000 });
        await client.add(HOOK, { secret, onEvent: (o) => void got.push(o.eventId) });
        await sleep(100);
        assert.deepEqual(logged.filter((l) => l.includes('oversized')).length, 1);
        assert.ok(logged.some((l) => /dropped the connection/.test(l)), 'it cannot go on sending them on that connection');
        assert.ok(logged.some((l) => /reconnecting in 60000 ms/.test(l)), 'and the next connection waits');
        assert.deepEqual(relay.sent.filter((m) => m.t === 'ack'), [], 'it was not parsed, so not even acknowledged');
        assert.deepEqual(got, []);
        await client.close();
    });
});

describe('a mailbox key is for the relay it was made for', () => {
    test('a saved key that does not say which relay it is for is not shown to any; one for another relay is not either', () => {
        const dir = temp();
        const file = join(dir, 'relay-mailbox.json');
        const old = 'k'.repeat(43);
        writeFileSync(file, JSON.stringify({ key: old }), { mode: 0o644 });
        assert.equal(legacyMailboxKey(dir, 'https://relay-one.example'), undefined, 'a key with no relay named is not reused');
        const made = serverMailboxKey(dir, 'https://relay-one.example', 'tickets');
        assert.notEqual(made, old);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { relay: 'https://relay-one.example', servers: { tickets: made } });
        assert.equal(serverMailboxKey(dir, 'https://relay-one.example', 'tickets'), made, 'the same relay gets the same key');
        if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, 'and the file is readable only by its owner');
        assert.notEqual(serverMailboxKey(dir, 'https://relay-two.example', 'tickets'), made, 'another relay gets another');
    });
});

describe('one mailbox per MCP server', () => {
    test("each server has a mailbox key of its own; the project's key from before 0.7.0 is kept, for its relay, until it is dropped", () => {
        const dir = temp();
        const file = join(dir, 'relay-mailbox.json');
        const relay = 'https://relay-one.example';
        const legacy = 'L'.repeat(43);
        // What 0.6.0 left: one key for the project's watches.
        writeFileSync(file, JSON.stringify({ key: legacy, relay }), { mode: 0o600 });
        assert.equal(legacyMailboxKey(dir, relay), legacy);
        assert.equal(legacyMailboxKey(dir, 'https://relay-two.example'), undefined, 'not for another relay');
        const tickets = serverMailboxKey(dir, relay, 'tickets');
        const deploys = serverMailboxKey(dir, relay, 'deploys');
        assert.notEqual(tickets, deploys, 'two servers, two mailboxes');
        assert.ok(![tickets, deploys].includes(legacy), "and neither is the project's old one");
        assert.equal(legacyMailboxKey(dir, relay), legacy, 'which is kept while a watch may still be there');
        dropLegacyMailboxKey(dir, relay);
        assert.equal(legacyMailboxKey(dir, relay), undefined);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { relay, servers: { tickets, deploys } }, 'the servers\' keys stay');
    });
});

describe('a relay that sends what it holds once per connection', () => {
    test('collecting again for an address, after a delivery came while nobody here collected for it, starts a new connection', async () => {
        const secret = newSecret();
        const got: string[] = [];
        const body = JSON.stringify({ eventId: 'in-the-gap', name: 'x', timestamp: 't', data: {} });
        const delivery = () => ({ t: 'delivery', seq: 7, hook: HOOK, headers: headersFor(secret, body, 'msg_gap'), body, receivedAt: now() });
        let push: ((frame: unknown) => void) | undefined;
        const relay = fakeRelay((m, send, connection) => {
            if (m.t !== 'add') return;
            push = send;
            // As the relay does: what it holds is sent when a hook is first asked for on a connection, and not again.
            send({ t: 'ok', n: m.n, queued: connection === 2 ? 1 : 0 });
            if (connection === 2) send(delivery());
        });
        const client = new RelayClient({ settings, key: 'k'.repeat(43), socket: relay.socket });
        const hook: Hook = { secret, onEvent: (o) => void got.push(o.eventId) };
        await client.add(HOOK, hook);
        await client.remove(HOOK, false); // the watch's run ends; its address is kept
        push!(delivery()); // the relay still sends for it on this connection
        await sleep(100);
        assert.deepEqual(got, [], 'nobody collects for it just now');
        assert.deepEqual(relay.sent.filter((m) => m.t === 'ack'), [], 'so it stays at the relay');
        await client.add(HOOK, hook);
        assert.equal(relay.connections(), 2, 'a new connection, on which the relay sends what it still holds');
        assert.deepEqual(got, ['in-the-gap']);
        await sleep(400); // acks go out together, a moment after the first
        assert.deepEqual(relay.sent.filter((m) => m.t === 'ack').map((m) => [m.connection, m.seqs]), [[2, [7]]]);
        await client.close();
    });
});

describe('acknowledgements', () => {
    test('go to the relay together, not one message per delivery', async () => {
        const secret = newSecret();
        const got: string[] = [];
        const body = (n: number) => JSON.stringify({ eventId: `e${n}`, name: 'x', timestamp: 't', data: {} });
        const relay = fakeRelay((m, send) => {
            if (m.t !== 'add') return;
            send({ t: 'ok', n: m.n, queued: 0 });
            for (let n = 1; n <= 40; n++) send({ t: 'delivery', seq: n, hook: HOOK, headers: headersFor(secret, body(n), `msg_${n}`), body: body(n), receivedAt: now() });
        });
        const client = new RelayClient({ settings, key: 'k'.repeat(43), socket: relay.socket });
        await client.add(HOOK, { secret, onEvent: (o) => void got.push(o.eventId) });
        await waitFor(() => got.length === 40, 5000, 'all forty');
        await sleep(400);
        const acks = relay.sent.filter((m) => m.t === 'ack');
        assert.deepEqual(acks.flatMap((m) => m.seqs ?? []).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1), 'each acknowledged');
        assert.ok(acks.length <= 3, `in a few messages, not forty: ${acks.length}`);
        await client.close();
    });

    test('still to be sent when the client closes are sent before it does', async () => {
        const secret = newSecret();
        const raw = JSON.stringify({ eventId: 'last', name: 'x', timestamp: 't', data: {} });
        const relay = fakeRelay((m, send) => {
            if (m.t !== 'add') return;
            send({ t: 'ok', n: m.n, queued: 1 });
            send({ t: 'delivery', seq: 9, hook: HOOK, headers: headersFor(secret, raw, 'msg_last'), body: raw, receivedAt: now() });
        });
        const client = new RelayClient({ settings, key: 'k'.repeat(43), socket: relay.socket });
        await client.add(HOOK, { secret, onEvent: () => {} });
        await client.close();
        assert.deepEqual(relay.sent.filter((m) => m.t === 'ack').flatMap((m) => m.seqs ?? []), [9]);
    });
});
