// Hardening rules for this server, one test each: a client's share of upstream fetches, GitHub event ids,
// control characters in text, and IPv4-mapped IPv6 addresses.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pollEvents } from '../src/events.ts';
import { clientKeyOf, gateTake } from '../src/limits.ts';
import { handlePost } from '../src/mcp.ts';
import { MAX_EVENT_ID, releaseEventId } from '../src/sources/github.ts';
import { excerpt, plain } from '../src/text.ts';
import { forgetMemo, PER_CLIENT_MISSES, staleKeyOf, workerLoader } from '../src/upstream.ts';
import { algoliaPage, decode, fakeLoader, fixtureJson, type Hit } from './helpers.ts';

describe('one client cannot spoil a feed for everyone', () => {
    test('each client gets at most its share of a host\'s fetches; a refused client does not spend the host\'s minute', () => {
        const st = { minute: 0, count: 0, per: new Map<string, number>() };
        const t = 1_795_480_000_000;
        const greedy = Array.from({ length: 240 }, () => gateTake(st, 120, PER_CLIENT_MISSES, '198.51.100.7', t));
        assert.equal(greedy.filter((a) => a === 'ok').length, PER_CLIENT_MISSES);
        assert.equal(greedy.filter((a) => a === 'client').length, 240 - PER_CLIENT_MISSES);
        assert.equal(st.count, PER_CLIENT_MISSES, 'refusals do not count against the host');
        assert.equal(gateTake(st, 120, PER_CLIENT_MISSES, '203.0.113.9', t), 'ok', 'another client still gets fetches');
        // The host's cap still holds across many clients.
        let ok = 0;
        for (let i = 0; i < 50; i++) for (let j = 0; j < 10; j++) if (gateTake(st, 120, PER_CLIENT_MISSES, `c${i}`, t) === 'ok') ok++;
        assert.equal(st.count, 120);
        assert.equal(gateTake(st, 120, PER_CLIENT_MISSES, 'fresh', t), 'host');
        assert.equal(gateTake(st, 120, PER_CLIENT_MISSES, '198.51.100.7', t + 60_000), 'ok', 'a new minute opens again');
    });

    test('when the gate refuses (or cannot be asked) or the upstream fails, the last good copy answers, marked stale', async () => {
        const store = new Map<string, { body: string; type: string }>();
        (globalThis as { caches?: unknown }).caches = {
            default: {
                match: async (r: Request) => (store.has(r.url) ? new Response(store.get(r.url)!.body, { headers: { 'content-type': store.get(r.url)!.type } }) : undefined),
                put: async (r: Request, res: Response) => void store.set(r.url, { body: await res.text(), type: res.headers.get('content-type') ?? '' })
            }
        };
        let answer: 'ok' | 'client' | 'host' | 'throw' = 'ok';
        const takes: unknown[][] = [];
        const env = {
            GATES: { idFromName: (n: string) => n, get: () => ({ take: async (...a: unknown[]) => { takes.push(a); if (answer === 'throw') throw new Error('gate down'); return answer; } }) },
            CHANNEL_SECRET: ''
        };
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
        let fetched = 0;
        let status = 200;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            fetched++;
            const r = new Response(status === 200 ? JSON.stringify({ latest: '1.0.0' }) : 'down', { status, headers: { 'content-type': 'application/json' } });
            Object.defineProperty(r, 'url', { value: url });
            return r;
        }) as typeof fetch;
        try {
            const url = 'https://registry.npmjs.org/-/package/d1-test/dist-tags';
            const l = workerLoader(env as never, ctx as never, '198.51.100.7');
            const first = await l.json(url, 55);
            await Promise.all(pending);
            assert.deepEqual(first, { ok: true, body: { latest: '1.0.0' } });
            assert.deepEqual(takes[0]!.slice(0, 3), [120, PER_CLIENT_MISSES, '198.51.100.7'], 'the gate is told who is asking');
            assert.ok(store.has(staleKeyOf(url)), 'a stale copy is kept beside the fresh one');
            for (const [why, setup] of [['host', () => (answer = 'host')], ['client', () => (answer = 'client')], ['throw', () => (answer = 'throw')], ['upstream 500', () => { answer = 'ok'; status = 500; }]] as [string, () => void][]) {
                store.delete(url); // the fresh copy has expired
                forgetMemo();
                setup();
                const before = fetched;
                const r = await l.json(url, 55);
                assert.deepEqual(r, { ok: true, body: { latest: '1.0.0' }, stale: true }, why);
                if (why !== 'upstream 500') assert.equal(fetched, before, `${why}: nothing is fetched`);
            }
            // With no stale copy, a refusal is still "busy".
            answer = 'client';
            forgetMemo();
            assert.deepEqual(await l.json('https://registry.npmjs.org/-/package/never-cached/dist-tags', 55), { ok: false, why: 'busy' });
        } finally {
            globalThis.fetch = realFetch;
            delete (globalThis as { caches?: unknown }).caches;
        }
    });

    test('a stale page starts a new watch without replaying the past; an existing watch keeps its place at its usual interval', async () => {
        const ALG = 'https://hn.algolia.com/api/v1/search_by_date';
        const comments = fixtureJson<{ hits: Hit[] }>('hn-comments.json').hits;
        const story = fixtureJson('hn-item-story.json');
        const now = (comments[0]!.created_at_i + 600) * 1000;
        const staleOnly = (body: unknown) => ({ json: async (u: string) => (u.startsWith(ALG) ? { ok: true as const, body, stale: true as const } : { ok: true as const, body: story }), text: async () => ({ ok: false as const, why: 'unavailable' as const }), presses: async () => ({ ok: false as const, why: 'not_found' as const }) });
        // Started from a copy that lacks the 10 newest comments (they were posted before the watch started).
        const r0 = (await pollEvents({ name: 'hn.comment', arguments: { story: 50611576 }, cursor: null }, staleOnly(algoliaPage(comments.slice(10))), now)) as { cursor: string; events: unknown[] };
        assert.deepEqual(r0.events, []);
        assert.equal(decode(r0.cursor).f, now);
        const newer = { ...comments[0]!, objectID: '99999999999', created_at_i: comments[0]!.created_at_i + 700 };
        const r1 = (await pollEvents({ name: 'hn.comment', arguments: { story: 50611576 }, cursor: r0.cursor }, fakeLoader({ [ALG]: algoliaPage([newer, ...comments]) }).loader, now + 200_000)) as { events: { eventId: string }[] };
        assert.deepEqual(r1.events.map((e) => e.eventId), ['99999999999'], 'the 10 older comments are not replayed; the one after the start is delivered');
        // An existing watch given a stale copy: no events, same cursor, the usual interval (not a back-off).
        const r2 = (await pollEvents({ name: 'hn.comment', arguments: { story: 50611576 }, cursor: r0.cursor }, staleOnly(algoliaPage(comments)), now + 1000)) as { cursor: string; events: unknown[]; nextPollMs: number };
        assert.deepEqual(r2.events, []);
        assert.equal(r2.cursor, r0.cursor);
        assert.equal(r2.nextPollMs, 30_000);
    });
});

describe('find_hn_story returns titles as plain, capped data (no added label: none is defined by any spec)', () => {
    test('stories only, titles at most 200 characters', async () => {
        const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
        const res = await handlePost(
            new Request('https://feeds.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'find_hn_story' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_hn_story', arguments: { query: 'show hn rust' }, _meta: meta } }) }),
            { loader: fakeLoader({ 'https://hn.algolia.com/api/v1/search?': fixtureJson('hn-find.json') }).loader, origin: 'https://feeds.example', secret: 'x'.repeat(32), now: Date.now(), allowMint: async () => true }
        );
        const r = (await res.json()) as { result: { content: { text: string }[]; structuredContent: { stories: { title: string }[] } } };
        assert.match(r.result.content[0]!.text, /^Stories \(id, title\), most relevant first:/);
        assert.deepEqual(Object.keys(r.result.structuredContent), ['stories']);
        assert.ok(r.result.structuredContent.stories.length > 0);
        assert.ok(r.result.structuredContent.stories.every((s) => s.title.length <= 200 && !/[\n<]/.test(s.title)));
    });
});

describe('a GitHub eventId is short or hashed', () => {
    test('a short, plain feed id is kept; a long or odd one is hashed', () => {
        assert.equal(releaseEventId({ id: 'tag:github.com,2008:Repository/426659329/wrangler@4.167.0', tag: 'wrangler@4.167.0' }), 'tag:github.com,2008:Repository/426659329/wrangler@4.167.0');
        const longTag = 'v1.0.0-' + 'a'.repeat(90);
        const id = releaseEventId({ id: `tag:github.com,2008:Repository/1/${longTag}`, tag: longTag });
        assert.match(id, /^github-release-[a-z0-9]+$/);
        assert.ok(id.length < 30);
        assert.match(releaseEventId({ id: 'tag:github.com,2008:Repository/1/odd tag', tag: 'odd tag' }), /^github-release-/);
        assert.match(releaseEventId({ id: 'something-else-entirely', tag: 'v1' }), /^github-release-/);
        assert.equal(MAX_EVENT_ID, 100);
    });
});

describe('C1 control characters are stripped', () => {
    test('&#x9b; (CSI) and the rest of U+0080-U+009F become spaces', () => {
        assert.equal(excerpt('a&#x9b;31mb', 50), 'a 31mb');
        assert.equal(plain('x\u0085y\u009fz\u0080w'), 'x y z w');
        assert.equal(plain('café  ok'), 'café ok', 'ordinary Latin-1 letters stay');
    });
});

describe('IPv4-mapped IPv6 addresses count as their IPv4 address', () => {
    test('dotted and hex forms', () => {
        assert.equal(clientKeyOf('::ffff:203.0.113.9'), '203.0.113.9');
        assert.equal(clientKeyOf('::FFFF:cb00:7109'), '203.0.113.9');
        assert.notEqual(clientKeyOf('::ffff:203.0.113.9'), clientKeyOf('::ffff:198.51.100.1'));
        assert.equal(clientKeyOf('2001:db8:1:2::5'), '2001:db8:1:2::/64');
    });
});
