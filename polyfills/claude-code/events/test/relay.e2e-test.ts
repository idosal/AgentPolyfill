// End to end through the relay: the plugin's MCP server and monitor as real
// processes, the fixture events server upstream, and the relay running in the
// local Workers runtime (as mod/relay/test does). The fixture server delivers its
// webhooks to the relay's address; the plugin collects them over its socket.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { describe, test } from 'node:test';
import { startRelay } from '../mod/relay/test/harness.ts';
import { sign } from '../src/webhooks.ts';
import { sleep, startMonitor, startPlugin, waitFor, world, type World } from './harness.ts';

const ACCESS = 'e2e-access-key-0123456789';
const now = () => Math.floor(Date.now() / 1000);
const watchId = (text: string) => /as (w-[0-9a-f]+)/.exec(text)?.[1];
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as { port: number }).port;
            s.close(() => resolve(p));
        });
    });

type Logged = { dir: string; m: { method?: string; params?: { delivery?: { url?: string; secret?: string } }; result?: { id?: string } } };
const fixtureLog = (w: World): Logged[] =>
    existsSync(w.fixtureLog)
        ? readFileSync(w.fixtureLog, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l) as Logged)
        : [];

/** The subscription the fixture server last granted: where it delivers, the secret it signs with, and its id. */
function subscription(w: World): { url: string; secret: string; id: string } {
    const log = fixtureLog(w);
    const asked = log.filter((r) => r.dir === 'in' && r.m.method === 'events/subscribe').at(-1)?.m.params?.delivery;
    const id = log.filter((r) => r.dir === 'out' && r.m.result?.id?.startsWith('sub_')).at(-1)?.m.result?.id;
    assert.ok(asked?.url && asked.secret && id, 'the fixture logged a subscription');
    return { url: asked.url, secret: asked.secret, id };
}

/** One webhook delivery, POSTed the way the MCP server does it. */
function deliver(sub: { url: string; secret: string; id: string }, occurrence: Record<string, unknown>, o: { secret?: string; body?: string; id?: string } = {}): Promise<Response> {
    const raw = JSON.stringify(occurrence);
    const id = o.id ?? 'msg_' + Math.random().toString(36).slice(2);
    const ts = now();
    return fetch(sub.url, {
        method: 'POST',
        body: o.body ?? raw,
        headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(o.secret ?? sub.secret, id, ts, raw), 'x-mcp-subscription-id': sub.id }
    });
}
const deploy = (eventId: string, data: Record<string, unknown>) => ({ eventId, name: 'deploy.finished', timestamp: new Date().toISOString(), data });

describe('webhook delivery through the relay', { concurrency: false }, () => {
    test("a webhook-only event type: the server's challenge is answered by the plugin, and its signed delivery reaches Claude", async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS };
        const plugin = await startPlugin(w, 'sess-a', env);
        const monitor = startMonitor(w);
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished', arguments: { service: 'api' }, note: 'Check the deploy' });
            assert.equal(r.isError, false, r.text);
            assert.match(r.text, /by webhook, through your relay \(which keeps/);
            assert.ok(!r.text.includes(relay.origin), 'the relay\'s address stays out of the conversation');
            await waitFor(() => fixtureLog(w).some((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')), 8000, 'the subscription to be granted (which needs the challenge echoed)');
            const sub = subscription(w);
            assert.match(sub.url, new RegExp(`^${relay.origin}/hooks/[A-Za-z0-9_-]{43}/[A-Za-z0-9_-]{16,64}$`), 'the server was given an address on the relay');
            w.emit('deploy.finished', { service: 'api', status: 'ok', url: 'https://deploys/1' });
            w.emit('deploy.finished', { service: 'web', status: 'ok' });
            const line = await waitFor(() => monitor.lines.find((l) => l.includes('deploy.finished')), 10000, 'the relayed event');
            assert.match(line, /service=api, status=ok/);
            await sleep(800);
            assert.equal(monitor.lines.filter((l) => l.includes('service=web')).length, 0, "the server's own filter still applies");

            const id = watchId(r.text)!;
            await plugin.call('unwatch_event', { watch: id });
            await waitFor(() => w.fixtureMethods().includes('events/unsubscribe'), 5000, 'events/unsubscribe');
            await waitFor(async () => (await deliver(sub, deploy('late', { service: 'api' }))).status === 410 || undefined, 5000, 'the address to be retired').catch(() => undefined);
            assert.equal((await deliver(sub, deploy('late-2', { service: 'api' }))).status, 410, 'after unwatch the address is gone for good');
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test('events delivered while Claude Code is closed wait at the relay and arrive once; the subscription is not cancelled on exit', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS };
        let plugin = await startPlugin(w, 'sess-a', env);
        let monitor = startMonitor(w, 'sess-a');
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished', note: 'Check the deploy' });
            assert.equal(r.isError, false, r.text);
            await waitFor(() => fixtureLog(w).some((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')), 8000, 'the subscription');
            const sub = subscription(w);
            w.emit('deploy.finished', { service: 'api', status: 'ok', url: 'https://deploys/before' });
            await waitFor(() => monitor.lines.find((l) => l.includes('deploy.finished')), 10000, 'the first event');

            // Claude Code closes.
            monitor.stop();
            await plugin.stop();
            await sleep(500);
            assert.equal(w.fixtureMethods().includes('events/unsubscribe'), false, 'closing does not end the subscription: its address outlives the session');

            // The server keeps delivering. (The fixture server is a child of the plugin and went
            // with it, so the test delivers in its place, signed with the subscription's secret.)
            assert.equal((await deliver(sub, deploy('evt_closed_1', { service: 'closed-1', status: 'ok' }))).status, 200);
            assert.equal((await deliver(sub, deploy('evt_closed_2', { service: 'closed-2', status: 'failed' }))).status, 200);

            // Claude Code opens again, as a new session.
            plugin = await startPlugin(w, 'sess-b', env);
            monitor = startMonitor(w, 'sess-b');
            await waitFor(() => monitor.lines.find((l) => l.includes('service=closed-2')), 10000, 'the events held by the relay');
            await sleep(800);
            const held = monitor.lines.filter((l) => l.includes('deploy.finished'));
            assert.equal(held.filter((l) => l.includes('service=closed-1, status=ok')).length, 1, 'the first held event, once');
            assert.equal(held.filter((l) => l.includes('service=closed-2, status=failed')).length, 1, 'the second held event, once');
            assert.ok(held.findIndex((l) => l.includes('closed-1')) <= held.findIndex((l) => l.includes('closed-2')), 'in the order they were delivered');
            assert.equal(held.filter((l) => l.includes('deploys/before')).length, 0, 'what the earlier session already saw is not shown again');

            await waitFor(() => fixtureLog(w).filter((x) => x.dir === 'in' && x.m.method === 'events/subscribe').length >= 2, 8000, 'the refresh after the restart');
            const again = subscription(w);
            assert.deepEqual([again.url, again.secret], [sub.url, sub.secret], 'the watch kept its address and secret, so this is a refresh of the same subscription');
            const list = JSON.parse((await plugin.call('list_watches')).text) as { id: string; status: string; webhook?: unknown }[];
            assert.equal(list.length, 1);
            assert.equal(list[0]!.id, watchId(r.text));
            assert.equal(JSON.stringify(list).includes(sub.secret), false, 'the signing secret is never shown');
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test('a forged, altered or replayed delivery put in the mailbox never reaches Claude; the genuine ones do', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS };
        const plugin = await startPlugin(w, 'sess-a', env);
        const monitor = startMonitor(w);
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished' });
            assert.equal(r.isError, false, r.text);
            await waitFor(() => fixtureLog(w).some((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')), 8000, 'the subscription');
            const sub = subscription(w);

            // Anyone who learns the address can POST to it. The relay cannot tell (it has no secret) and takes these.
            const forged = await deliver(sub, deploy('forged', { service: 'forged-1', status: 'ok' }), { secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') });
            assert.equal(forged.status, 200);
            const genuine = deploy('altered', { service: 'genuine-1', status: 'ok' });
            const altered = await deliver(sub, genuine, { body: JSON.stringify(genuine).replace('genuine-1', 'tampered-1') });
            assert.equal(altered.status, 200);

            const real = deploy('evt_real', { service: 'real-1', status: 'ok' });
            assert.equal((await deliver(sub, real, { id: 'msg_real_1' })).status, 200);
            await waitFor(() => monitor.lines.find((l) => l.includes('service=real-1')), 10000, 'the genuine event');
            // The same signed delivery again, after it was collected: the relay stores it anew, the plugin has seen that event.
            await sleep(500);
            assert.equal((await deliver(sub, real, { id: 'msg_real_1' })).status, 200);
            await sleep(1500);
            assert.equal(monitor.lines.filter((l) => l.includes('service=real-1')).length, 1, 'a replayed delivery is not shown twice');
            assert.equal(monitor.lines.filter((l) => /forged-1|tampered-1|genuine-1/.test(l)).length, 0);
            const recent = (await plugin.call('recent_events')).text;
            assert.match(recent, /real-1/);
            assert.doesNotMatch(recent, /forged-1|tampered-1|genuine-1/);
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test('the plugin finds its way back after the relay restarts, and collects what arrived meanwhile', async () => {
        const port = await freePort();
        let relay = await startRelay({ ACCESS_KEY: ACCESS }, undefined, port);
        const stateDir = relay.stateDir;
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS, MCP_EVENTS_RELAY_BACKOFF_MS: '300' };
        const plugin = await startPlugin(w, 'sess-a', env);
        const monitor = startMonitor(w);
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished' });
            assert.equal(r.isError, false, r.text);
            await waitFor(() => fixtureLog(w).some((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')), 8000, 'the subscription');
            const sub = subscription(w);
            await relay.stop(true);
            relay = await startRelay({ ACCESS_KEY: ACCESS }, stateDir, port);
            assert.equal((await deliver(sub, deploy('evt_after_restart', { service: 'after-restart', status: 'ok' }))).status, 200);
            await waitFor(() => monitor.lines.find((l) => l.includes('service=after-restart')), 15000, 'the event delivered after the relay came back');
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test('the public relay, turned on by name: no access key, the same checks, and the user is told whose server it is', async () => {
        // A stand-in for the public relay: the same Worker and settings (wrangler.public.jsonc), run locally.
        const relay = await startRelay({}, undefined, 0, 'wrangler.public.jsonc');
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_RELAY: 'public', MCP_EVENTS_PUBLIC_RELAY_URL: relay.origin });
        const monitor = startMonitor(w);
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished' });
            assert.equal(r.isError, false, r.text);
            assert.match(r.text, /through the public relay run by Ido Salomon, the author of this mod \(you turned it on with MCP_EVENTS_RELAY=public\)/);
            assert.match(r.text, /event payloads pass through that server, which keeps them for up to 24 hours/);
            assert.match(r.text, /\/mcp-events:relay-setup sets up a relay of your own/);
            assert.ok(!r.text.includes(relay.origin), 'its address stays out of the conversation');
            await waitFor(() => fixtureLog(w).some((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')), 8000, 'the subscription');
            const sub = subscription(w);
            assert.equal((await deliver(sub, deploy('evt_public', { service: 'through-public', status: 'ok' }))).status, 200);
            await waitFor(() => monitor.lines.find((l) => l.includes('through-public')), 8000, 'the event');
            // Forged with another secret: stored by the relay (it holds no secret), refused by the mod.
            await deliver({ ...sub, secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') }, deploy('evt_forged', { service: 'forged', status: 'ok' }));
            await sleep(1500);
            assert.equal(monitor.lines.filter((l) => l.includes('forged')).length, 0);
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test('with a wrong access key the watch fails with the reason, and nothing is subscribed', async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: 'not-the-access-key-0000' });
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished' });
            assert.equal(r.isError, true);
            assert.match(r.text, /relay/i);
            assert.match(r.text, /access key/i);
            assert.equal(w.fixtureMethods().includes('events/subscribe'), false);
        } finally {
            await plugin.stop();
            await relay.stop();
        }
    });
});
