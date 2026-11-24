// The MCP endpoint on the wire: both protocol eras, the request-metadata headers, the Events
// methods and their errors, and the limits that do not need Cloudflare's runtime.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkChannel, mintChannel } from '../src/channel.ts';
import { argsHash, canonical, decodeCursor, encodeCursor, MAX_CURSOR_CHARS } from '../src/cursor.ts';
import { decodeHeaderValue, handlePost, MAX_REQUEST_BYTES, originAllowed } from '../src/mcp.ts';
import { clip, excerpt, httpsUrl } from '../src/text.ts';
import { fixtureText } from './helpers.ts';
import { HOSTS, MAX_BODY, readCapped, UPSTREAM_CAPS } from '../src/upstream.ts';
import { allow, clientKeyOf, windowTake } from '../src/limits.ts';
import { fakeLoader, fixtureJson } from './helpers.ts';

const V = '2026-07-28';
const SECRET = 'test-secret-0123456789abcdef0123456789';
const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' } };
const deps = (over: Partial<Parameters<typeof handlePost>[1]> = {}) => ({ loader: fakeLoader({ 'https://registry.npmjs.org/': { latest: '1.0.0' } }).loader, origin: 'https://feeds.example', secret: SECRET, now: Date.now(), allowMint: async () => true, ...over });

type Out = { status: number; body: { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } } };
async function send(method: string, params: Record<string, unknown> = {}, o: { headers?: Record<string, string | null>; id?: unknown; raw?: string; d?: ReturnType<typeof deps> } = {}): Promise<Out> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': V, 'mcp-method': method };
    if (typeof params.name === 'string') h['mcp-name'] = params.name;
    for (const [k, v] of Object.entries(o.headers ?? {})) {
        if (v === null) delete h[k];
        else h[k] = v;
    }
    const body = o.raw ?? JSON.stringify({ jsonrpc: '2.0', id: o.id ?? 1, method, params: { _meta: meta, ...params } });
    const res = await handlePost(new Request('https://feeds.example/mcp', { method: 'POST', headers: h, body }), o.d ?? deps());
    const text = await res.text();
    return { status: res.status, body: text.startsWith('data:') ? { result: { sse: text } } : text ? JSON.parse(text) : {} };
}

describe('modern era (2026-07-28)', () => {
    test('server/discover advertises the Events extension under capabilities.extensions', async () => {
        const r = await send('server/discover');
        assert.equal(r.status, 200);
        const res = r.body.result!;
        assert.equal(res.resultType, 'complete');
        assert.deepEqual((res.capabilities as Record<string, unknown>).extensions, { 'io.modelcontextprotocol/events': {} });
        assert.equal((res.capabilities as Record<string, unknown>).events, undefined, 'no pre-standard top-level "events" key');
        assert.ok((res.supportedVersions as string[]).includes(V));
        assert.equal(typeof res.ttlMs, 'number');
        assert.equal(res.cacheScope, 'public');
        assert.equal(((res._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo'] as { name: string }).name, 'event-feeds');
    });

    test('events/list: every type poll-only, with input and payload schemas', async () => {
        const r = await send('events/list');
        const events = r.body.result!.events as { name: string; delivery: string[]; inputSchema: { type: string }; payloadSchema: { type: string }; description: string }[];
        assert.deepEqual(events.map((e) => e.name), ['demo.button', 'hn.comment', 'hn.story', 'npm.release', 'github.release', 'usgs.earthquake']);
        for (const e of events) {
            assert.deepEqual(e.delivery, ['poll']);
            assert.equal(e.inputSchema.type, 'object');
            assert.equal(e.payloadSchema.type, 'object');
            assert.ok(e.description.length > 60);
        }
        assert.equal(r.body.result!.nextCursor, undefined);
        assert.equal((await send('events/list', { cursor: 'x' })).body.error!.code, -32602);
    });

    test('events/poll answers a complete result; the first poll starts from now', async () => {
        const r = await send('events/poll', { name: 'npm.release', arguments: { package: 'left-pad' }, cursor: null });
        assert.equal(r.status, 200);
        const res = r.body.result!;
        assert.equal(res.resultType, 'complete');
        assert.deepEqual(res.events, []);
        assert.equal(typeof res.cursor, 'string');
        assert.equal(res.truncated, false);
        assert.equal(res.hasMore, false);
        assert.equal(res.nextPollMs, 60_000);
    });

    test('errors use the SEP-3415 codes', async () => {
        const nf = await send('events/poll', { name: 'no.such.event', arguments: {} });
        assert.equal(nf.body.error!.code, -32023);
        assert.deepEqual(nf.body.error!.data, { kind: 'event' });
        const bad = await send('events/poll', { name: 'npm.release', arguments: { package: 'Not Valid!' } });
        assert.equal(bad.body.error!.code, -32602);
        const extra = await send('events/poll', { name: 'npm.release', arguments: { package: 'react', url: 'https://evil.example' } });
        assert.equal(extra.body.error!.code, -32602);
        assert.match(extra.body.error!.message, /unknown argument/);
        const push = await send('events/stream', { name: 'npm.release', arguments: { package: 'react' } });
        assert.equal(push.body.error!.code, -32026);
        assert.deepEqual(push.body.error!.data, { feature: 'deliveryMode', value: 'push' });
        assert.equal((await send('events/stream', { name: 'nope', arguments: {} })).body.error!.code, -32023, 'an unknown name is NotFound before Unsupported');
        const hook = await send('events/subscribe', { name: 'npm.release', arguments: { package: 'react' }, delivery: { mode: 'webhook', url: 'https://x.example/h', secret: 'whsec_' + 'A'.repeat(32) } });
        assert.equal(hook.body.error!.code, -32024, 'webhook needs an authenticated principal: Forbidden');
        assert.equal((await send('events/unsubscribe', { name: 'npm.release', arguments: {}, delivery: { url: 'https://x.example/h' } })).body.error!.code, -32024);
        const noName = await send('events/poll', { arguments: {} });
        assert.equal(noName.status, 200);
        assert.equal(noName.body.error!.code, -32602, 'a poll with no name is InvalidParams, not a header mismatch');
        const mx = await send('events/poll', { name: 'npm.release', arguments: { package: 'react' }, maxEvents: 0 });
        assert.equal(mx.body.error!.code, -32602);
    });

    test('request metadata headers are checked against the body', async () => {
        const noMethod = await send('events/list', {}, { headers: { 'mcp-method': null } });
        assert.equal(noMethod.status, 400);
        assert.equal(noMethod.body.error!.code, -32020);
        const wrongMethod = await send('events/list', {}, { headers: { 'mcp-method': 'tools/list' } });
        assert.equal(wrongMethod.status, 400);
        assert.equal(wrongMethod.body.error!.code, -32020);
        const noName = await send('events/poll', { name: 'npm.release', arguments: { package: 'react' } }, { headers: { 'mcp-name': null } });
        assert.equal(noName.status, 400);
        assert.equal(noName.body.error!.code, -32020);
        const wrongName = await send('events/poll', { name: 'npm.release', arguments: { package: 'react' } }, { headers: { 'mcp-name': 'hn.story' } });
        assert.equal(wrongName.body.error!.code, -32020);
        const b64 = await send('events/poll', { name: 'npm.release', arguments: { package: 'react' } }, { headers: { 'mcp-name': `=?base64?${btoa('npm.release')}?=` } });
        assert.equal(b64.status, 200, 'a Base64-sentinel Mcp-Name is decoded before comparing');
        const versionMismatch = await send('events/list', {}, { headers: { 'mcp-protocol-version': '2025-11-25' } });
        assert.equal(versionMismatch.status, 200, 'a legacy header selects the legacy era, where events/* does not exist');
        assert.equal(versionMismatch.body.error!.code, -32601);
        const unknown = await send('events/list', {}, { headers: { 'mcp-protocol-version': '2099-01-01' } });
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.error!.code, -32022);
        assert.ok((unknown.body.error!.data!.supported as string[]).includes(V));
    });

    test('required _meta fields', async () => {
        const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } } });
        const r = await send('events/list', {}, { raw });
        assert.equal(r.status, 400);
        assert.equal(r.body.error!.code, -32602);
        const mism = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2026-12-01' } } });
        assert.equal((await send('events/list', {}, { raw: mism })).body.error!.code, -32020);
    });

    test('unknown methods are 404 with Method not found; notifications are 202', async () => {
        const r = await send('resources/list');
        assert.equal(r.status, 404);
        assert.equal(r.body.error!.code, -32601);
        const n = await handlePost(new Request('https://feeds.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': V, 'mcp-method': 'notifications/cancelled' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) }), deps());
        assert.equal(n.status, 202);
    });

    test('subscriptions/listen is acknowledged with an empty filter and closed', async () => {
        const r = await send('subscriptions/listen', { notifications: { toolsListChanged: true } }, { id: 7 });
        const frames = String(r.body.result!.sse).trim().split('\n\n').map((f) => JSON.parse(f.replace(/^data: /, '')));
        assert.equal(frames[0].method, 'notifications/subscriptions/acknowledged');
        assert.deepEqual(frames[0].params.notifications, {});
        assert.equal(frames[0].params._meta['io.modelcontextprotocol/subscriptionId'], 7);
        assert.equal(frames[1].id, 7);
        assert.equal(frames[1].result.resultType, 'complete');
    });

    test('tools: new_demo_button gives a working channel; find_hn_story searches', async () => {
        const list = await send('tools/list');
        assert.deepEqual((list.body.result!.tools as { name: string }[]).map((t) => t.name), ['new_demo_button', 'find_hn_story', 'read_event_text']);
        const made = await send('tools/call', { name: 'new_demo_button', arguments: {} });
        const sc = made.body.result!.structuredContent as { url: string; channel: string; readMessageWith: { tool: string; arguments: Record<string, string> } };
        assert.deepEqual(sc.readMessageWith.arguments.event, 'demo.button', 'it says how to read a press message');
        assert.equal(sc.readMessageWith.arguments.channel, sc.channel);
        assert.match(sc.url, /^https:\/\/feeds\.example\/b\/b[A-Za-z0-9_-]{30}$/);
        assert.equal((await checkChannel(SECRET, sc.channel, Date.now())).ok, true);
        const limited = await send('tools/call', { name: 'new_demo_button', arguments: {} }, { d: deps({ allowMint: async () => false }) });
        assert.equal(limited.body.result!.isError, true);
        const d = deps({ loader: fakeLoader({ 'https://hn.algolia.com/api/v1/search?': fixtureJson('hn-find.json') }).loader });
        const found = await send('tools/call', { name: 'find_hn_story', arguments: { query: 'show hn rust' } }, { d });
        assert.ok(((found.body.result!.structuredContent as { stories: unknown[] }).stories).length > 0);
        assert.equal((await send('tools/call', { name: 'nope', arguments: {} })).body.error!.code, -32602);
    });
});

describe('read_event_text: the text behind an event, fetched on demand', () => {
    const call = (args: Record<string, unknown>, routes: Record<string, unknown>, presses: Record<string, unknown> = {}) =>
        send('tools/call', { name: 'read_event_text', arguments: args }, { d: deps({ loader: fakeLoader(routes, presses).loader }) });
    const text = (r: Out) => ((r.body.result!.content as { text: string }[])[0]!.text);
    test('a Hacker News comment: author and plain, capped text, as plain data with nothing added', async () => {
        const r = await call({ event: 'hn.comment', id: '50621511' }, { 'https://hacker-news.firebaseio.com/v0/item/50621511.json': fixtureJson('hn-item-comment.json') });
        const sc = r.body.result!.structuredContent as Record<string, string>;
        assert.deepEqual(JSON.parse(text(r)), sc, 'the text content is the same fields as JSON');
        assert.deepEqual(Object.keys(sc).sort(), ['author', 'id', 'postedAt', 'text', 'type']);
        assert.equal(sc.author, 'tgma');
        assert.match(sc.text, /^Right, tautologically so\. We don't get/);
        assert.doesNotMatch(sc.text, /<p>|&#x27;|\n/);
    });
    test('a story id that does not exist, and ids that are not ids, are refused', async () => {
        assert.equal((await call({ event: 'hn.story', id: '999999999' }, { 'https://hacker-news.firebaseio.com/': null })).body.result!.isError, true);
        assert.equal((await call({ event: 'hn.story', id: '../../etc' }, {})).body.result!.isError, true);
        assert.equal((await call({ event: 'usgs.earthquake', id: 'https://evil.example/' }, {})).body.result!.isError, true);
        assert.equal((await call({ event: 'github.release', id: 'v1', repo: 'evil.example/../x' }, {})).body.result!.isError, true);
        assert.equal((await call({ event: 'npm.release', id: 'x' }, {})).body.result!.isError, true);
        assert.equal((await call({ event: 'hn.story', id: '1', url: 'https://x' }, {})).body.result!.isError, true);
    });
    test('release notes, a quake\'s place, a button message', async () => {
        const gh = await call({ event: 'github.release', repo: 'cloudflare/workers-sdk', id: 'wrangler@4.167.0' }, { 'https://github.com/cloudflare/workers-sdk/releases.atom': fixtureText('gh-workers-sdk-releases.atom') });
        const g = gh.body.result!.structuredContent as Record<string, string>;
        assert.equal(g.title, 'wrangler@4.167.0');
        assert.ok(g.notes.length > 50 && g.notes.length <= 1500 && !/[<\n]/.test(g.notes));
        const q = await call({ event: 'usgs.earthquake', id: 'aka2026xfzdkr' }, { 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/aka2026xfzdkr.geojson': fixtureJson('usgs-detail.json') });
        assert.equal((q.body.result!.structuredContent as Record<string, string>).place, '6 km ENE of Fox, Alaska');
        const ch = 'b' + 'A'.repeat(30);
        const b = await call({ event: 'demo.button', channel: ch, id: '1' }, {}, { [ch]: [{ n: 1, ts: 1795480408000, m: 'ship it' }] });
        assert.equal((b.body.result!.structuredContent as Record<string, string>).message, 'ship it');
        assert.deepEqual(Object.keys(b.body.result!.structuredContent as object).sort(), ['message', 'press', 'pressedAt']);
        const byEventId = await call({ event: 'demo.button', channel: ch, id: 'press-1' }, {}, { [ch]: [{ n: 1, ts: 1795480408000, m: 'ship it' }] });
        assert.equal((byEventId.body.result!.structuredContent as Record<string, string>).message, 'ship it', 'the eventId form works too');
    });
});

describe('legacy era (initialize)', () => {
    test('initialize without a session; tools only, no events capability', async () => {
        const raw = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } });
        const res = await handlePost(new Request('https://feeds.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: raw }), deps());
        assert.equal(res.headers.get('mcp-session-id'), null);
        const r = (await res.json()) as { result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } } };
        assert.equal(r.result.protocolVersion, '2025-06-18');
        assert.deepEqual(r.result.capabilities, { tools: {} });
        const tl = await send('tools/list', {}, { headers: { 'mcp-protocol-version': '2025-06-18', 'mcp-method': null }, raw: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
        assert.equal((tl.body.result!.tools as unknown[]).length, 3);
        const unknownVersion = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '1' } } });
        const r2 = (await (await handlePost(new Request('https://feeds.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: unknownVersion }), deps())).json()) as { result: { protocolVersion: string } };
        assert.equal(r2.result.protocolVersion, '2025-11-25');
    });
});

describe('limits', () => {
    test('request bodies over 64 KiB, batches and non-JSON are refused', async () => {
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list', params: { _meta: meta, pad: 'x'.repeat(MAX_REQUEST_BYTES) } });
        assert.equal((await send('events/list', {}, { raw: big })).status, 413);
        assert.equal((await send('events/list', {}, { raw: '[{"jsonrpc":"2.0","id":1,"method":"ping"}]' })).status, 400);
        assert.equal((await send('events/list', {}, { raw: '{nope' })).body.error!.code, -32700);
    });
    test('maxEvents is capped at 50 whatever the client asks', async () => {
        // Exercised through the cursor logic in sources.test.ts; here only that a large value is accepted.
        const r = await send('events/poll', { name: 'npm.release', arguments: { package: 'react' }, maxEvents: 100000 });
        assert.equal(r.status, 200);
    });
    test('cursors are size-capped and bound to type and arguments', () => {
        const h = argsHash({ package: 'react', tag: 'latest' });
        assert.equal(h, argsHash({ tag: 'latest', package: 'react' }), 'argument order does not matter');
        assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
        const c = encodeCursor({ k: 'np', h, s: ['latest@1'] });
        assert.deepEqual(decodeCursor(c, 'np', h).s, ['latest@1']);
        assert.throws(() => decodeCursor('A'.repeat(MAX_CURSOR_CHARS + 1), 'np', h), /too long/);
        assert.throws(() => decodeCursor(c, 'gr', h), /different event type/);
    });
    test('payload text is plain and clipped; links are http(s) only', () => {
        assert.equal(excerpt('<p>Hi &amp; <i>bye</i>&#x27;s</p>', 100), "Hi & bye's");
        assert.equal(Array.from(clip('word '.repeat(100), 50)).length <= 50, true);
        assert.equal(httpsUrl('javascript:alert(1)'), undefined);
        assert.equal(httpsUrl('https://example.com/a'), 'https://example.com/a');
        assert.equal(excerpt('a‮b\u0007c', 10), 'a b c');
    });
    test('upstream bodies over 1 MB are dropped; only five hosts are ever fetched', async () => {
        assert.equal(await readCapped(new Response('x'.repeat(MAX_BODY + 1))), undefined);
        assert.equal(await readCapped(new Response('{"ok":1}')), '{"ok":1}');
        assert.deepEqual([...HOSTS].sort(), ['earthquake.usgs.gov', 'github.com', 'hacker-news.firebaseio.com', 'hn.algolia.com', 'registry.npmjs.org']);
    });
    test('Origin: none, own, https and localhost pass; others are refused', () => {
        const self = 'https://feeds.example';
        assert.equal(originAllowed(null, self), true);
        assert.equal(originAllowed(self, self), true);
        assert.equal(originAllowed('https://claude.ai', self), true);
        assert.equal(originAllowed('http://localhost:6274', self), true);
        assert.equal(originAllowed('http://evil.example', self), false);
        assert.equal(originAllowed('null', self), false);
    });
    test('header values: Base64 sentinel decoding, control characters refused', () => {
        assert.equal(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?='), 'Hello, 世界');
        assert.equal(decodeHeaderValue('plain.name'), 'plain.name');
        assert.equal(decodeHeaderValue('bad\u0001'), undefined);
    });
});

describe('rate limits fail closed; upstream caps', () => {
    test('clients are counted by IPv4 address or IPv6 /64', () => {
        assert.equal(clientKeyOf('203.0.113.7'), '203.0.113.7');
        assert.equal(clientKeyOf('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
        assert.equal(clientKeyOf('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64', 'any address in the /64 is the same client');
        assert.equal(clientKeyOf('2001:0DB8::1'), '2001:db8:0:0::/64');
        assert.equal(clientKeyOf('::1'), '0:0:0:0::/64');
        assert.equal(clientKeyOf(null), 'unknown');
    });
    test('a limiter that errors refuses', async () => {
        assert.equal(await allow({ limit: async () => ({ success: true }) }, 'k'), true);
        assert.equal(await allow({ limit: async () => ({ success: false }) }, 'k'), false);
        assert.equal(await allow({ limit: async () => { throw new Error('limiter down'); } }, 'k'), false);
    });
    test('the per-host window counts to the cap, refuses, and opens again next minute', () => {
        const st = { minute: 0, count: 0 };
        const t = 1_795_480_000_000;
        let n = 0;
        for (let i = 0; i < 200; i++) if (windowTake(st, 120, t + i)) n++;
        assert.equal(n, 120);
        assert.equal(windowTake(st, 120, t + 60_000), true);
        assert.deepEqual(Object.keys(UPSTREAM_CAPS).sort(), [...HOSTS].sort(), 'every allowed host has a cap');
        assert.ok(Object.values(UPSTREAM_CAPS).every((c) => c > 0 && c <= 120));
    });
});

describe('demo-button channels', () => {
    test('minted ids check out for an hour, then expire; forged ones fail', async () => {
        const now = Date.now();
        const id = await mintChannel(SECRET, now);
        assert.match(id, /^b[A-Za-z0-9_-]{30}$/);
        assert.equal((await checkChannel(SECRET, id, now + 59 * 60_000)).ok, true);
        assert.deepEqual((await checkChannel(SECRET, id, now + 61 * 60_000)).ok, false);
        assert.equal(((await checkChannel(SECRET, id, now + 61 * 60_000)) as { why: string }).why, 'expired');
        assert.equal((await checkChannel('another-secret-xxxxxxxxxxxxxxxxxxxxxx', id, now)).ok, false);
        const flipped = id.slice(0, 5) + (id[5] === 'A' ? 'B' : 'A') + id.slice(6);
        assert.equal((await checkChannel(SECRET, flipped, now)).ok, false, 'changing the time or the random part breaks the signature');
        assert.notEqual(await mintChannel(SECRET, now), id, 'each one is new');
    });
});
