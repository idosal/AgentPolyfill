// Unit tests for the parts that make a relayed webhook safe to act on: one
// delivery judged the same way however it arrived, and the relay's settings.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Occurrence } from '../src/events-client.ts';
import { PUBLIC_RELAY, readRelaySettings } from '../src/relay.ts';
import { handleDelivery, MAX_REMEMBERED, newSecret, ReplayGuard, sign, type Hook } from '../src/webhooks.ts';
import { temp } from './harness.ts';

const now = () => Math.floor(Date.now() / 1000);
const event = (eventId: string) => JSON.stringify({ eventId, name: 'x', timestamp: 't', data: {} });
const signed = (secret: string, raw: string, ts: number, id = 'msg_' + Math.random().toString(36).slice(2)) => ({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, id, ts, raw) });

function recorder(extra: Partial<Hook> = {}) {
    const got: string[] = [];
    const hook: Hook = { secret: newSecret(), onEvent: (o: Occurrence) => void got.push(o.eventId), ...extra };
    return { hook, got };
}

describe('one delivery, however it arrived', () => {
    test('a relayed delivery is judged against the time the relay received it, not the time it is collected', async () => {
        const { hook, got } = recorder();
        const then = now() - 3600; // delivered an hour ago, while Claude Code was closed
        const held = event('held');
        assert.equal((await handleDelivery(hook, signed(hook.secret, held, then), held, { nowS: then + 20 })).status, 200);
        assert.deepEqual(got, ['held']);
        const late = event('late');
        assert.equal((await handleDelivery(hook, signed(hook.secret, late, then), late)).status, 410, 'the same age with no receipt time is stale: gone, so the server does not retry it');
        assert.equal((await handleDelivery(hook, signed(hook.secret, late, then), late, { nowS: then + 301 })).status, 410, 'signed more than 5 minutes before the relay got it');
        assert.equal((await handleDelivery(hook, signed(hook.secret, late, then + 400), late, { nowS: then })).status, 401, 'stamped well ahead of the clock: refused');
        assert.deepEqual(got, ['held']);
    });

    test('a changed body, another secret, or no signature: refused, and nothing runs', async () => {
        const { hook, got } = recorder();
        const raw = event('e1');
        const h = signed(hook.secret, raw, now());
        assert.equal((await handleDelivery(hook, h, raw.replace('e1', 'e2'))).status, 401);
        assert.equal((await handleDelivery(hook, signed(newSecret(), raw, now()), raw)).status, 401);
        assert.equal((await handleDelivery(hook, { 'webhook-id': 'm', 'webhook-timestamp': String(now()) }, raw)).status, 401);
        assert.deepEqual(got, []);
        assert.equal((await handleDelivery(hook, h, raw)).status, 200);
        assert.deepEqual(got, ['e1']);
    });

    test('a challenge is echoed only when its signature verifies', async () => {
        const { hook } = recorder();
        const raw = JSON.stringify({ type: 'verification', challenge: 'n1' });
        const ok = await handleDelivery(hook, signed(hook.secret, raw, now()), raw);
        assert.deepEqual([ok.status, ok.body], [200, { challenge: 'n1' }]);
        const bad = await handleDelivery(hook, signed(newSecret(), raw, now()), raw);
        assert.deepEqual([bad.status, bad.body], [401, undefined]);
    });

    test('a delivery never taken is taken although newer ones were (it waited at the relay); one already taken is refused, however long ago', async () => {
        const replay = new ReplayGuard();
        let saved = 0;
        const { hook, got } = recorder({ replay, accepted: () => void saved++ });
        const t = now() - 7200;
        // It could not be stored when it first came (503), so the relay kept it; newer ones were taken meanwhile.
        const held = event('held');
        const heldHeaders = signed(hook.secret, held, t - 1800, 'msg_held');
        const first = event('first');
        const firstHeaders = signed(hook.secret, first, t, 'msg_first');
        assert.equal((await handleDelivery(hook, firstHeaders, first, { nowS: t })).status, 200);
        assert.equal(replay.state.newest, t, 'the newest accepted signing time is remembered');
        assert.equal(saved, 1, 'and the watch is told, so it can save that');
        // Handed over again on the next connection, half an hour older than the newest one taken.
        assert.equal((await handleDelivery(hook, heldHeaders, held, { nowS: t - 1800 })).status, 200, 'not a replay: it was never taken (0.4.1 refused it, and its event was lost)');
        assert.deepEqual(got, ['first', 'held']);
        assert.equal(replay.state.newest, t, 'an older delivery does not move the mark back');
        // Somebody who can write to the mailbox presents one already taken, with a receipt time made up to match it.
        const replayed = await handleDelivery(hook, firstHeaders, first, { nowS: t });
        assert.equal(replayed.status, 200, 'answered as already taken');
        const again = await handleDelivery(hook, heldHeaders, held, { nowS: t - 1800 });
        assert.equal(again.status, 200);
        assert.deepEqual(got, ['first', 'held'], 'neither runs twice');
    });

    test('past the ids it can remember, everything signed at or before the forgotten ones is refused for good', async () => {
        const replay = new ReplayGuard();
        const { hook, got } = recorder({ replay });
        const t = now() - 3600;
        for (let i = 0; i <= MAX_REMEMBERED; i++) {
            const e = event(`e${i}`);
            assert.equal((await handleDelivery(hook, signed(hook.secret, e, t + i, `msg_${i}`), e, { nowS: t + i })).status, 200);
        }
        assert.equal(replay.state.recent.length, MAX_REMEMBERED);
        assert.equal(replay.state.floor, t + 1, 'the oldest was forgotten, so its time is the floor');
        const early = event('early');
        const r = await handleDelivery(hook, signed(hook.secret, early, t, 'msg_never_seen'), early, { nowS: t });
        assert.equal(r.status, 410);
        assert.match(r.reason ?? '', /replay/);
        assert.equal(got.length, MAX_REMEMBERED + 1);
    });

    test('the very same signed delivery is taken once, however many others came in between', async () => {
        const replay = new ReplayGuard();
        const { hook, got } = recorder({ replay });
        const t = now() - 3600;
        const raw = event('first');
        const h = signed(hook.secret, raw, t, 'msg_first');
        assert.equal((await handleDelivery(hook, h, raw, { nowS: t })).status, 200);
        // 600 more genuine deliveries inside the same ten minutes: more than any fixed-size memory of ids.
        for (let i = 0; i < 600; i++) {
            const e = event(`e${i}`);
            assert.equal((await handleDelivery(hook, signed(hook.secret, e, t + 1, `msg_${i}`), e, { nowS: t + 1 })).status, 200);
        }
        const again = await handleDelivery(hook, h, raw, { nowS: t });
        assert.equal(again.status, 200, 'a repeat is answered as already taken, so a server retrying it stops');
        assert.equal(got.filter((id) => id === 'first').length, 1, 'but it does not run twice');
        assert.equal(got.length, 601);
    });

    test('a replayed gap or termination is refused like any other replay', async () => {
        const replay = new ReplayGuard();
        const gaps: (string | null)[] = [];
        const { hook } = recorder({ replay, onGap: (c) => void gaps.push(c) });
        const t = now() - 60;
        const gap = JSON.stringify({ type: 'gap', cursor: 'c1' });
        const h = signed(hook.secret, gap, t, 'msg_gap_1');
        assert.equal((await handleDelivery(hook, h, gap, { nowS: t })).status, 200);
        assert.equal((await handleDelivery(hook, h, gap, { nowS: t })).status, 200);
        assert.deepEqual(gaps, ['c1'], 'the gap moved the cursor once');
    });

    test("nothing signed more than eight days ago is taken, whatever the relay says about when it arrived; and the guard's memory survives a restart", async () => {
        const { hook, got } = recorder({ replay: new ReplayGuard() });
        const longAgo = now() - 9 * 24 * 3600;
        const stale = event('stale');
        const r = await handleDelivery(hook, signed(hook.secret, stale, longAgo), stale, { nowS: longAgo });
        assert.equal(r.status, 410);
        assert.match(r.reason ?? '', /too long ago/);
        assert.deepEqual(got, []);

        const before = new ReplayGuard();
        const one = recorder({ replay: before });
        const t = now() - 100;
        const raw = event('kept');
        const h = signed(one.hook.secret, raw, t, 'msg_kept');
        assert.equal((await handleDelivery(one.hook, h, raw, { nowS: t })).status, 200);
        // The watch saves the guard's state; after a restart a new guard is made from it.
        const after = recorder({ secret: one.hook.secret, replay: new ReplayGuard(JSON.parse(JSON.stringify(before.state))) });
        assert.equal((await handleDelivery(after.hook, h, raw, { nowS: t })).status, 200);
        assert.deepEqual(after.got, [], 'taken before the restart, so not taken again after it');
    });

    test('storage failure is a 503, so the delivery is kept and tried again', async () => {
        const hook: Hook = {
            secret: newSecret(),
            onEvent: () => {
                throw new Error('disk full');
            }
        };
        const raw = event('e1');
        assert.equal((await handleDelivery(hook, signed(hook.secret, raw, now()), raw)).status, 503);
    });
});

describe('relay settings', () => {
    const quiet = () => {};
    test("the public relay is used only when asked for by name, and never ahead of a relay of the user's own", () => {
        const home = temp();
        assert.equal(readRelaySettings({ HOME: home } as NodeJS.ProcessEnv, quiet), undefined, 'not asked for: not used');
        const s = readRelaySettings({ HOME: home, MCP_EVENTS_RELAY: 'public' } as NodeJS.ProcessEnv, quiet);
        assert.deepEqual(s && { url: s.url, accessKey: s.accessKey, isPublic: s.isPublic }, { url: PUBLIC_RELAY.url, accessKey: undefined, isPublic: true });
        assert.match(PUBLIC_RELAY.url, /^https:\/\/[a-z0-9.-]+$/);
        assert.equal(readRelaySettings({ HOME: home, MCP_EVENTS_RELAY: ' Public ' } as NodeJS.ProcessEnv, quiet)?.isPublic, true);
        const said: string[] = [];
        assert.equal(readRelaySettings({ HOME: home, MCP_EVENTS_RELAY: 'yes' } as NodeJS.ProcessEnv, (x) => said.push(x)), undefined, 'any other value is not a yes');
        assert.match(said.join(), /other than "public"/);
        const own = readRelaySettings({ HOME: home, MCP_EVENTS_RELAY: 'public', MCP_EVENTS_RELAY_URL: 'https://mine.example.com', MCP_EVENTS_RELAY_ACCESS_KEY: 'abcdefghijklmnop' } as NodeJS.ProcessEnv, quiet);
        assert.deepEqual(own && { url: own.url, isPublic: own.isPublic }, { url: 'https://mine.example.com', isPublic: undefined }, "the user's own relay comes first");
        // The stand-in address is a testing switch, and does nothing without it.
        assert.equal(readRelaySettings({ HOME: home, MCP_EVENTS_RELAY: 'public', MCP_EVENTS_PUBLIC_RELAY_URL: 'https://elsewhere.example.com' } as NodeJS.ProcessEnv, quiet)?.url, PUBLIC_RELAY.url);
    });

    test('from the environment', () => {
        const s = readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'https://relay.example.workers.dev/', MCP_EVENTS_RELAY_ACCESS_KEY: 'abcdefghijklmnop' } as NodeJS.ProcessEnv, quiet);
        assert.deepEqual(s && { url: s.url, accessKey: s.accessKey }, { url: 'https://relay.example.workers.dev', accessKey: 'abcdefghijklmnop' });
        assert.equal(readRelaySettings({ HOME: temp() } as NodeJS.ProcessEnv, quiet), undefined, 'none set: no relay');
    });

    test('the relay address must be https; plain http on this machine is for testing, behind a switch', () => {
        const said: string[] = [];
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'http://relay.example.com' } as NodeJS.ProcessEnv, (s) => said.push(s)), undefined);
        assert.match(said.join('\n'), /https/);
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'http://127.0.0.1:8799' } as NodeJS.ProcessEnv, quiet), undefined, 'a webhook address is https (SEP-3415)');
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'http://127.0.0.1:8799', MCP_EVENTS_DEV: '1' } as NodeJS.ProcessEnv, quiet)?.url, 'http://127.0.0.1:8799');
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'http://relay.example.com', MCP_EVENTS_DEV: '1' } as NodeJS.ProcessEnv, quiet), undefined, 'never plain http to another machine');
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'https://user:pw@relay.example.com' } as NodeJS.ProcessEnv, quiet), undefined, 'no credentials in the address');
        assert.equal(readRelaySettings({ HOME: temp(), MCP_EVENTS_RELAY_URL: 'https://relay.example.com', MCP_EVENTS_RELAY_ACCESS_KEY: 'has spaces in it!!' } as NodeJS.ProcessEnv, quiet), undefined, 'an access key outside its alphabet');
    });

    test('from a private file, which is ignored when others can read it; the environment wins', () => {
        const home = temp();
        mkdirSync(join(home, '.mcp-events'));
        const file = join(home, '.mcp-events', 'relay.json');
        writeFileSync(file, JSON.stringify({ url: 'https://mine.example.workers.dev', accessKey: 'file-access-key-0001' }), { mode: 0o600 });
        const env = { HOME: home } as NodeJS.ProcessEnv;
        assert.deepEqual(readRelaySettings(env, quiet) && { url: readRelaySettings(env, quiet)!.url, accessKey: readRelaySettings(env, quiet)!.accessKey }, { url: 'https://mine.example.workers.dev', accessKey: 'file-access-key-0001' });
        assert.equal(readRelaySettings({ ...env, MCP_EVENTS_RELAY_URL: 'https://other.example.com' }, quiet)?.url, 'https://other.example.com');
        // Not on Windows, where these bits say nothing about who may read the file.
        if (process.platform !== 'win32') {
            chmodSync(file, 0o644);
            const said: string[] = [];
            assert.equal(readRelaySettings(env, (s) => said.push(s)), undefined);
            assert.match(said.join('\n'), /chmod 600/);
        }
        const elsewhere = join(home, 'elsewhere.json');
        writeFileSync(elsewhere, JSON.stringify({ url: 'https://elsewhere.example.com' }), { mode: 0o600 });
        assert.equal(readRelaySettings({ ...env, MCP_EVENTS_RELAY_FILE: elsewhere }, quiet)?.url, 'https://elsewhere.example.com');
    });
});
