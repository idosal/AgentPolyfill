// Drives a running event-feeds (local `wrangler dev` or the deployed Worker) over plain HTTP, as an
// Events client would, and checks every answer. Live: it reads real upstreams through the server.
//
//   node --no-warnings test/smoke.ts [base-url]          default http://127.0.0.1:8797
//   SMOKE_LIMITS=1 node --no-warnings test/smoke.ts URL  also trips the per-address rate limit

import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8797').replace(/\/$/, '');
const V = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'event-feeds-smoke', version: '0' } };
let id = 0;
const ok = (s: string) => console.log(`✓ ${s}`);

async function rpc(method: string, params: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': V, 'mcp-method': method };
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
    const t0 = performance.now();
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { _meta: meta, ...params } }) });
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
    return { status: res.status, ms: Math.round(performance.now() - t0), ...body };
}

const front = await fetch(`${BASE}/`);
assert.equal(front.status, 200);
const html = await front.text();
assert.match(html, /claude mcp add --transport http feeds .*\/mcp/);
assert.match(front.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
ok('front page answers, with the add line and a strict CSP');

const d = await rpc('server/discover');
assert.equal(d.status, 200);
assert.deepEqual((d.result!.capabilities as Record<string, unknown>).extensions, { 'io.modelcontextprotocol/events': {} });
ok(`server/discover: Events extension advertised (${d.ms} ms)`);

const l = await rpc('events/list');
const names = (l.result!.events as { name: string; delivery: string[] }[]).map((e) => `${e.name}[${e.delivery}]`);
ok(`events/list: ${names.join(', ')}`);

assert.equal((await fetch(`${BASE}/mcp`)).status, 405);
ok('GET /mcp is 405 (no standalone stream)');

const legacy = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }) });
const lj = (await legacy.json()) as { result: { protocolVersion: string; capabilities: Record<string, unknown> } };
assert.equal(lj.result.protocolVersion, '2025-06-18');
assert.equal(legacy.headers.get('mcp-session-id'), null);
ok('legacy initialize (2025-06-18): answered without a session, tools only');

// The button, end to end.
const made = await rpc('tools/call', { name: 'new_demo_button', arguments: {} });
const sc = made.result!.structuredContent as { url: string; channel: string };
assert.ok(sc.url.startsWith(`${BASE}/b/`));
const page = await fetch(sc.url);
assert.equal(page.status, 200);
assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
ok(`new_demo_button: ${sc.url.replace(sc.channel, sc.channel.slice(0, 6) + '…')} opens`);
const p0 = await rpc('events/poll', { name: 'demo.button', arguments: { channel: sc.channel }, cursor: null });
assert.deepEqual(p0.result!.events, []);
assert.equal(p0.result!.nextPollMs, 2000);
const pressAt = Date.now();
const pr = await fetch(`${BASE}/api/press`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ channel: sc.channel, message: 'smoke test' }) });
assert.deepEqual(await pr.json(), { ok: true, press: 1 });
const fast = await fetch(`${BASE}/api/press`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ channel: sc.channel }) });
assert.equal(fast.status, 429, 'one press a second');
const p1 = await rpc('events/poll', { name: 'demo.button', arguments: { channel: sc.channel }, cursor: p0.result!.cursor });
const ev = (p1.result!.events as { eventId: string; data: Record<string, unknown> }[])[0]!;
assert.deepEqual(Object.keys(ev.data).sort(), ['hasMessage', 'press', 'pressedAt']);
assert.equal(ev.data.press, 1);
assert.equal(ev.data.hasMessage, true);
ok(`a press is an event on the next poll (${Date.now() - pressAt} ms after the press, poll took ${p1.ms} ms), with no text in it`);
const txt = await rpc('tools/call', { name: 'read_event_text', arguments: { event: 'demo.button', channel: sc.channel, id: '1' } });
assert.equal((txt.result!.structuredContent as { message: string }).message, 'smoke test');
assert.deepEqual(Object.keys(txt.result!.structuredContent as object).sort(), ['message', 'press', 'pressedAt']);
ok('read_event_text returns the message as plain data');
const p2 = await rpc('events/poll', { name: 'demo.button', arguments: { channel: sc.channel }, cursor: p1.result!.cursor });
assert.deepEqual(p2.result!.events, []);
ok('and only once');
const foreign = await fetch(`${BASE}/api/press`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ channel: sc.channel }) });
assert.equal(foreign.status, 403);
const forged = await rpc('events/poll', { name: 'demo.button', arguments: { channel: 'b' + 'A'.repeat(30) }, cursor: null });
assert.equal(forged.error?.code, -32602);
ok('presses from other sites and forged channels are refused');

// Each live feed: the first poll anchors a cursor; the second answers from the shared edge cache.
const feeds: [string, Record<string, unknown>][] = [
    ['hn.comment', { story: 50611576 }],
    ['hn.story', {}],
    ['npm.release', { package: 'wrangler' }],
    ['github.release', { repo: 'cloudflare/workers-sdk' }],
    ['usgs.earthquake', { minMagnitude: 0 }]
];
for (const [name, args] of feeds) {
    const a = await rpc('events/poll', { name, arguments: args, cursor: null });
    assert.equal(a.status, 200, `${name}: ${JSON.stringify(a.error)}`);
    assert.equal(typeof a.result!.cursor, 'string');
    const b = await rpc('events/poll', { name, arguments: args, cursor: a.result!.cursor });
    assert.equal(b.status, 200, `${name}: ${JSON.stringify(b.error)}`);
    for (const e of b.result!.events as { data: Record<string, unknown> }[]) for (const v of Object.values(e.data)) assert.ok(typeof v !== 'string' || /^[A-Za-z0-9@._:,\/+#?=%-]+$/.test(v), `${name}: ${String(v)}`);
    ok(`${name}: anchored (${a.ms} ms), polled again (${b.ms} ms, ${(b.result!.events as unknown[]).length} new, nextPollMs ${b.result!.nextPollMs})`);
}
const notStory = await rpc('events/poll', { name: 'hn.comment', arguments: { story: 50621511 }, cursor: null });
assert.equal(notStory.error?.code, -32602);
const noPkg = await rpc('events/poll', { name: 'npm.release', arguments: { package: 'this-package-does-not-exist-zz9' }, cursor: null });
assert.equal(noPkg.error?.code, -32602);
const noRepo = await rpc('events/poll', { name: 'github.release', arguments: { repo: 'idosal/definitely-not-a-repo-zz9' }, cursor: null });
assert.equal(noRepo.error?.code, -32602);
ok(`wrong arguments are refused: "${notStory.error!.message.slice(0, 70)}…", "${noPkg.error!.message}", "${noRepo.error!.message}"`);

const hn = await rpc('tools/call', { name: 'read_event_text', arguments: { event: 'hn.comment', id: '50621511' } });
assert.equal(typeof (hn.result!.structuredContent as { text: string }).text, 'string');
ok(`read_event_text on a real HN comment: author ${(hn.result!.structuredContent as { author: string }).author}, ${String((hn.result!.structuredContent as { text: string }).text).length} characters of text`);

if (process.env.SMOKE_LIMITS === '1') {
    // One client's share of a host's fetches: 14 polls for made-up package names (each one a fetch that
    // misses the cache). The first 10 reach npm (which says "no such package"); the rest are refused
    // here without reaching npm, and nothing else's feed is touched.
    const tag = Math.random().toString(36).slice(2, 8);
    const answers = [];
    for (let i = 0; i < 14; i++) answers.push(await rpc('events/poll', { name: 'npm.release', arguments: { package: `event-feeds-probe-${tag}-${i}` }, cursor: null }));
    const reached = answers.filter((a) => a.error?.code === -32602).length;
    const held = answers.filter((a) => a.error?.code === -32603 && /busy/.test(a.error.message)).length;
    // The run's own earlier npm reads count against the same share, so fewer than 10 may get through.
    assert.ok(reached <= 10 && reached + held === 14 && held >= 4, JSON.stringify(answers.map((a) => a.error?.message)));
    const other = await rpc('events/poll', { name: 'npm.release', arguments: { package: 'wrangler' }, cursor: null });
    assert.equal(other.status, 200, 'a cached feed still answers this client');
    ok(`per-client share: of 14 uncached npm reads, ${reached} reached npm and ${held} were held back; cached feeds still answer`);

    let limited = 0;
    const many = await Promise.all(Array.from({ length: 280 }, () => rpc('ping')));
    for (const r of many) if (r.status === 429) limited++;
    assert.ok(limited > 0, 'the per-address limit trips');
    ok(`280 requests to /mcp at once: ${limited} refused with 429 by the per-address limit`);
    const pages = await Promise.all(Array.from({ length: 80 }, () => fetch(`${BASE}/robots.txt`).then((r) => r.status)));
    const pl = pages.filter((x) => x === 429).length;
    assert.ok(pl > 0, 'the page limit trips');
    ok(`80 page loads at once: ${pl} refused with 429 by the page limit`);
}
console.log('SMOKE OK');
