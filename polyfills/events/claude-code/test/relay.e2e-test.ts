// End to end through the relay: the plugin's MCP server and monitor as real
// processes, the fixture events server upstream, and the relay running in the
// local Workers runtime (as mod/relay/test does). The fixture server delivers its
// webhooks to the relay's address; the plugin collects them over its socket.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { mailboxIdOf } from '../mod/relay/src/protocol.ts';
import { newKey, startRelay } from '../mod/relay/test/harness.ts';
import { RelayClient } from '../src/relay.ts';
import { newSecret, sign } from '../src/webhooks.ts';
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
const fixtureLog = (w: World, file = w.fixtureLog): Logged[] =>
    existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l) as Logged)
        : [];

/** The subscription the fixture server last granted: where it delivers, the secret it signs with, and its id. */
function subscription(w: World, logFile = w.fixtureLog): { url: string; secret: string; id: string } {
    const log = fixtureLog(w, logFile);
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

/** A second MCP server in the world, named `name`: the same fixture, with an upstream and a log of its own. */
function addServer(w: World, name: string): { log: string } {
    const config = JSON.parse(readFileSync(w.config, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const log = join(w.dir, `fixture-${name}.jsonl`);
    const upstream = join(w.dir, `upstream-${name}.jsonl`);
    writeFileSync(upstream, '');
    config.mcpServers[name] = { ...config.mcpServers.tickets!, env: { ...config.mcpServers.tickets!.env, FIXTURE_LOG: log, FIXTURE_UPSTREAM: upstream } };
    writeFileSync(w.config, JSON.stringify(config));
    return { log };
}
const granted = (w: World, file = w.fixtureLog) => fixtureLog(w, file).filter((x) => x.dir === 'out' && x.m.result?.id?.startsWith('sub_')).length;
const mailboxOf = (url: string) => /\/hooks\/([A-Za-z0-9_-]{43})\//.exec(url)?.[1];
const projectOf = (w: World) => join(w.state, 'projects', readdirSync(join(w.state, 'projects'))[0]!);

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

    test("a webhook address, its secret and the mailbox's key are never shown, from the moment they exist, even when a server sends them back", async () => {
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
            const project = join(w.state, 'projects', readdirSync(join(w.state, 'projects'))[0]!);
            const key = Object.values((JSON.parse(readFileSync(join(project, 'relay-mailbox.json'), 'utf8')) as { servers: Record<string, string> }).servers)[0]!;
            // The server knows the address and the secret it was given. It sends them back every way it can.
            const echo = { eventId: `evt-${sub.secret}`, name: 'deploy.finished', timestamp: new Date().toISOString(), data: { service: 'echo-1', address: sub.url, secret: sub.secret, key } };
            assert.equal((await deliver(sub, echo)).status, 200);
            const line = await waitFor(() => monitor.lines.find((l) => l.includes('service=echo-1')), 10000, 'the event');
            const shown = [line, (await plugin.call('get_event', { id: /\[event (e\d+)/.exec(line)![1]! })).text, (await plugin.call('recent_events')).text, (await plugin.call('list_watches')).text, plugin.instructions()].join('\n');
            for (const [what, value] of Object.entries({ 'the webhook address': sub.url, 'the signing secret': sub.secret, "the secret's bare part": sub.secret.slice('whsec_'.length), "the mailbox's key": key })) {
                assert.ok(!shown.includes(value), `${what} is not shown`);
            }
            assert.match(shown, /\[redacted\]/);
            const log = readFileSync(join(w.state, 'mcp-events.log'), 'utf8');
            assert.ok(!log.includes(key) && !log.includes(sub.secret), 'nor written to the log');
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
    // In 0.6.0 a project's watches shared one mailbox, so while Claude Code was closed one server's
    // well-formed junk to its own address could fill it, and the others' deliveries were refused.
    test("each MCP server has a mailbox of its own: while Claude Code is closed, one server's junk fills only its own, and another's deliveries are still taken", async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS, MAX_QUEUED: '3' });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const deploys = addServer(w, 'deploys');
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS };
        let plugin = await startPlugin(w, 'sess-a', env);
        let monitor = startMonitor(w, 'sess-a');
        try {
            for (const server of ['tickets', 'deploys']) {
                const r = await plugin.call('watch_event', { server, event: 'deploy.finished' });
                assert.equal(r.isError, false, r.text);
            }
            await waitFor(() => granted(w) > 0 && granted(w, deploys.log) > 0, 10000, 'both subscriptions');
            const [junkSide, other] = [subscription(w), subscription(w, deploys.log)];
            assert.ok(mailboxOf(junkSide.url) && mailboxOf(other.url));
            assert.notEqual(mailboxOf(junkSide.url), mailboxOf(other.url), "the two servers' addresses are in different mailboxes");

            // Claude Code closes; the first server posts well-formed junk to its own address until its mailbox is full.
            monitor.stop();
            await plugin.stop();
            const junk = () => deliver(junkSide, deploy(`junk_${Math.random()}`, { service: 'junk', status: 'ok' }), { secret: newSecret() });
            for (let i = 0; i < 3; i++) assert.equal((await junk()).status, 200, 'junk that looks like a delivery is stored');
            assert.equal((await junk()).status, 503, 'its own mailbox is full');
            // The other server's delivery is still taken.
            assert.equal((await deliver(other, deploy('evt_other', { service: 'other-server', status: 'ok' }))).status, 200);

            plugin = await startPlugin(w, 'sess-b', env);
            monitor = startMonitor(w, 'sess-b');
            await waitFor(() => monitor.lines.find((l) => l.includes('service=other-server')), 10000, "the other server's event");
            await sleep(800);
            assert.equal(monitor.lines.filter((l) => l.includes('service=other-server')).length, 1, 'once');
            assert.equal(monitor.lines.filter((l) => l.includes('junk')).length, 0, 'and none of the junk');
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });

    test("a watch at the project's one mailbox of 0.6.0 moves to its server's own: what was held there arrives once, the old address is retired, and the old key is forgotten", async () => {
        const relay = await startRelay({ ACCESS_KEY: ACCESS });
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const env = { MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS };
        let plugin = await startPlugin(w, 'sess-a', env);
        let monitor = startMonitor(w, 'sess-a');
        try {
            const r = await plugin.call('watch_event', { server: 'tickets', event: 'deploy.finished' });
            assert.equal(r.isError, false, r.text);
            await waitFor(() => granted(w) > 0, 8000, 'the subscription');
            monitor.stop();
            await plugin.stop();

            // Make the project what 0.6.0 left: one mailbox key for the project, and the watch's address in that mailbox.
            const project = projectOf(w);
            const legacyKey = newKey();
            writeFileSync(join(project, 'relay-mailbox.json'), JSON.stringify({ key: legacyKey, relay: relay.origin }), { mode: 0o600 });
            const saved = JSON.parse(readFileSync(join(project, 'watches.json'), 'utf8')) as { watches: { webhook: { hook: string; url: string; secret: string } }[] };
            const watch = saved.watches[0]!.webhook;
            const oldUrl = `${relay.origin}/hooks/${await mailboxIdOf(legacyKey)}/${watch.hook}`;
            watch.url = oldUrl;
            writeFileSync(join(project, 'watches.json'), JSON.stringify(saved, null, 2));
            const old = new RelayClient({ settings: { url: relay.origin, accessKey: ACCESS, source: 'test' }, key: legacyKey });
            await old.add(watch.hook, { secret: watch.secret, onEvent: () => {} });
            await old.close();
            // While Claude Code is closed, the server delivers to the old address.
            const before = granted(w);
            assert.equal((await deliver({ url: oldUrl, secret: watch.secret, id: 'sub_old' }, deploy('evt_held_old', { service: 'held-at-old', status: 'ok' }))).status, 200);

            plugin = await startPlugin(w, 'sess-b', env);
            monitor = startMonitor(w, 'sess-b');
            await waitFor(() => monitor.lines.find((l) => l.includes('service=held-at-old')), 10000, 'what the old mailbox held');
            await waitFor(() => granted(w) > before, 10000, 'the subscription at the new address');
            const moved = subscription(w);
            assert.ok(mailboxOf(moved.url) && mailboxOf(moved.url) !== (await mailboxIdOf(legacyKey)), "the watch's new address is in its server's own mailbox");
            await waitFor(async () => (await deliver({ url: oldUrl, secret: watch.secret, id: 'sub_old' }, deploy('evt_late_old', { service: 'late-old', status: 'ok' }))).status === 410, 8000, 'the old address to be retired');
            const keys = JSON.parse(readFileSync(join(project, 'relay-mailbox.json'), 'utf8')) as { key?: string; servers: Record<string, string> };
            assert.equal(keys.key, undefined, "the project's old key is forgotten");
            assert.ok(keys.servers.tickets);
            assert.equal((await deliver(moved, deploy('evt_new', { service: 'at-new', status: 'ok' }))).status, 200);
            await waitFor(() => monitor.lines.find((l) => l.includes('service=at-new')), 10000, 'an event at the new address');
            await sleep(800);
            assert.equal(monitor.lines.filter((l) => l.includes('service=held-at-old')).length, 1, 'what was held arrived once');
            assert.equal(monitor.lines.filter((l) => l.includes('late-old')).length, 0);
        } finally {
            monitor.stop();
            await plugin.stop();
            await relay.stop();
        }
    });
});
