// Properties of the functions that what a server, a relay or anyone on the wire sends reaches
// first, checked over generated inputs (fast-check), and, where the input domain is finite,
// over all of it. Each property is the rule in words; a failure prints the smallest input found.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { EVENTS_EXTENSION, EventsConnection, preStandardPolicy } from '../src/events-client.ts';
import { formatBatch, oneLine } from '../src/format.ts';
import { encodeHeaderValue, routingHeaders, scanHeaders } from '../src/routing-headers.ts';
import type { SpoolRecord } from '../src/store.ts';
import { isoDate, Redactor, tameSchema } from '../src/untrusted.ts';
import { WakeBudget } from '../src/wake.ts';
import { handleDelivery, MAX_REMEMBERED, newSecret, ReplayGuard, sign, verify } from '../src/webhooks.ts';
import { temp } from './harness.ts';

const RUNS = { numRuns: 300 };
const now = () => Math.floor(Date.now() / 1000);
const webhookId = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/);
const anyHeaders = fc.dictionary(fc.constantFrom('webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id', 'other'), fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 3 })));
const PRINTABLE = /^[\x20-\x7e]*$/;
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]');

describe('webhook signatures (Standard Webhooks)', () => {
    test('a signature made with the secret verifies; the same with one byte of the body changed, or another secret, does not', () => {
        fc.assert(
            fc.property(webhookId, fc.string({ unit: 'binary', maxLength: 300 }), fc.integer({ min: -299, max: 299 }), fc.nat({ max: 299 }), (id, body, skew, at) => {
                const secret = newSecret();
                const ts = now() + skew;
                const headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, id, ts, body) };
                assert.equal(verify(secret, headers, body).ok, true);
                assert.equal(verify(newSecret(), headers, body).ok, false);
                const changed = body.length ? body.slice(0, at % body.length) + String.fromCharCode((body.charCodeAt(at % body.length) + 1) % 0x10000) + body.slice((at % body.length) + 1) : 'x';
                if (changed !== body) assert.equal(verify(secret, headers, changed).ok, false);
            }),
            RUNS
        );
    });

    test('outside five minutes either way, nothing verifies', () => {
        fc.assert(
            fc.property(webhookId, fc.string({ maxLength: 50 }), fc.integer({ min: 301, max: 10 ** 9 }), fc.boolean(), (id, body, off, ahead) => {
                const secret = newSecret();
                const ts = now() + (ahead ? off : -off);
                assert.equal(verify(secret, { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, id, ts, body) }, body).ok, false);
            }),
            RUNS
        );
    });

    test('any headers and any body: handleDelivery answers a status from its known set, never throws, and acts only on what verifies', async () => {
        await fc.assert(
            fc.asyncProperty(anyHeaders, fc.string({ unit: 'binary', maxLength: 400 }), async (headers, raw) => {
                let acted = 0;
                const hook = { secret: newSecret(), replay: new ReplayGuard(), onEvent: () => void acted++, onGap: () => void acted++, onTerminated: () => void acted++ };
                const r = await handleDelivery(hook, headers, raw);
                assert.ok([200, 400, 401, 410, 413, 503].includes(r.status), String(r.status));
                // Headers made up without the secret cannot verify.
                assert.notEqual(r.status, 200);
                assert.equal(acted, 0);
            }),
            RUNS
        );
    });

    test('a genuine delivery handed over any number of times, in any order among others, is acted on once', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 40 }), async (order) => {
                const secret = newSecret();
                const t = now() - 60;
                const got: string[] = [];
                const hook = { secret, replay: new ReplayGuard(), onEvent: (o: { eventId: string }) => void got.push(o.eventId) };
                for (const n of order) {
                    const raw = JSON.stringify({ eventId: `e${n}`, name: 'x', timestamp: 't', data: {} });
                    const r = await handleDelivery(hook, { 'webhook-id': `msg_${n}`, 'webhook-timestamp': String(t + n), 'webhook-signature': sign(secret, `msg_${n}`, t + n, raw) }, raw, { nowS: t + n });
                    assert.equal(r.status, 200);
                }
                assert.deepEqual([...got].sort(), [...new Set(order)].map((n) => `e${n}`).sort());
            }),
            RUNS
        );
    });
});

describe('the replay memory', () => {
    test('whatever order deliveries come in, and however many, an id is taken at most once; past the memory a floor refuses, and no id is taken twice', () => {
        fc.assert(
            fc.property(fc.array(fc.tuple(fc.nat({ max: 1500 }), fc.nat({ max: 600 })), { minLength: 1, maxLength: 1500 }), (deliveries) => {
                const guard = new ReplayGuard();
                const t0 = now() - 3600;
                const taken = new Set<number>();
                for (const [id, dt] of deliveries) {
                    const verdict = guard.begin(`id-${id}`, t0 + dt);
                    if (verdict !== undefined) continue;
                    assert.ok(!taken.has(id), `id-${id} taken twice`);
                    taken.add(id);
                    guard.commit(`id-${id}`, t0 + dt);
                    // A saved and reloaded guard knows the same (the state is saved with the watch).
                    if (taken.size % 97 === 0) Object.assign(guard, { state: new ReplayGuard(JSON.parse(JSON.stringify(guard.state))).state });
                }
                assert.ok(guard.state.recent.length <= MAX_REMEMBERED);
            }),
            { numRuns: 100 }
        );
    });
});

describe('routing headers (Streamable HTTP)', () => {
    test('a header value is always printable ASCII with no surrounding space, and the Base64 form gives back exactly what was encoded', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (v) => {
                const h = encodeHeaderValue(v);
                assert.match(h, PRINTABLE);
                assert.equal(h, h.trim());
                const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(h);
                if (m) assert.equal(Buffer.from(m[1]!, 'base64').toString('utf8'), Buffer.from(v, 'utf8').toString('utf8'));
                else assert.equal(h, v);
            }),
            { numRuns: 2000 }
        );
    });

    test('any schema: scanHeaders never throws, and every header it accepts is a token, unique but for case', () => {
        fc.assert(
            fc.property(fc.jsonValue({ maxDepth: 6 }), fc.array(fc.tuple(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 })), { maxLength: 6 }), (schema, annotations) => {
                const props: Record<string, unknown> = {};
                for (const [k, h] of annotations) props[k] = { type: 'string', 'x-mcp-header': h };
                for (const s of [schema, { type: 'object', properties: props }]) {
                    const r = scanHeaders(s);
                    if ('declarations' in r) {
                        const names = r.declarations.map((d) => d.header.toLowerCase());
                        assert.equal(new Set(names).size, names.length);
                        for (const d of r.declarations) assert.match(d.header, /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
                    }
                }
            }),
            { numRuns: 1000 }
        );
    });

    test('any request body: routingHeaders never throws, and every value it sets is a valid header value', () => {
        fc.assert(
            fc.property(fc.jsonValue({ maxDepth: 4 }), fc.constantFrom('events/poll', 'events/stream', 'events/subscribe', 'events/unsubscribe', 'events/list', 'tools/call'), fc.string({ unit: 'binary', maxLength: 40 }), (args, method, name) => {
                const out = routingHeaders({ method, params: { name, arguments: args } }, () => [{ path: ['a'], header: 'A' }, { path: ['b', 'c'], header: 'B-C' }]);
                for (const v of Object.values(out)) assert.match(v, PRINTABLE);
                assert.equal('Mcp-Name' in out, method !== 'events/list' && method !== 'tools/call');
            }),
            { numRuns: 1000 }
        );
    });
});

describe('what a server writes, before it is kept or shown', () => {
    test('tameSchema never throws, and what it keeps is at most 16 KiB and 9 levels deep', () => {
        const depth = (v: unknown): number => (typeof v === 'object' && v !== null ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0);
        fc.assert(
            fc.property(fc.anything({ maxDepth: 12, maxKeys: 70 }), (s) => {
                const t = tameSchema(s);
                if (t === undefined) return;
                assert.ok(JSON.stringify(t).length <= 16 * 1024);
                assert.ok(depth(t) <= 9);
            }),
            { numRuns: 500 }
        );
    });

    test('oneLine: one line, no control characters, no longer than asked', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 400 }), fc.integer({ min: 2, max: 200 }), (s, max) => {
                const l = oneLine(s, max);
                assert.doesNotMatch(l, CONTROL);
                assert.ok(l.length <= max);
            }),
            { numRuns: 2000 }
        );
    });

    test('isoDate gives back what it was given, or nothing', () => {
        fc.assert(fc.property(fc.oneof(fc.string(), fc.date({ noInvalidDate: true }).map((d) => d.toISOString()), fc.anything()), (v) => assert.ok(isoDate(v) === undefined || isoDate(v) === v)), { numRuns: 1000 });
    });

    test('the wake message carries nothing a server wrote: whatever the event, its lines name only the watch, the count and ids, each on one line', () => {
        const record = fc.record({
            id: fc.stringMatching(/^e[0-9]{1,4}$/),
            watch: fc.stringMatching(/^w-[0-9a-f]{6}$/),
            server: fc.constantFrom('tickets', 'deploys'),
            event: fc.constantFrom('ticket.created', 'deploy.failed'),
            eventId: fc.string({ unit: 'binary', minLength: 1, maxLength: 60 }),
            data: fc.dictionary(fc.string({ maxLength: 10 }), fc.string({ unit: 'binary', minLength: 9, maxLength: 60 }).map((s) => `PAYLOAD${s}`), { maxKeys: 4 })
        });
        fc.assert(
            fc.property(fc.array(record, { minLength: 1, maxLength: 8 }), (rs) => {
                const lines = formatBatch(rs.map((r) => ({ ...r, kind: 'event', receivedAt: '2026-11-24T00:00:00Z' }) as SpoolRecord));
                for (const l of lines) {
                    assert.doesNotMatch(l, CONTROL);
                    assert.ok(!l.includes('PAYLOAD'), l);
                }
            }),
            { numRuns: 500 }
        );
    });

    test('once a secret is known, it appears nowhere in what is scrubbed', () => {
        const piece = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '[', ']', 'r', 'e', 'd'), minLength: 8, maxLength: 12 });
        fc.assert(
            fc.property(fc.array(piece, { minLength: 1, maxLength: 4 }), fc.array(fc.oneof(piece, fc.string({ unit: fc.constantFrom('a', 'b', 'c', '[', ']', 'r', 'e', 'd', ' '), maxLength: 6 })), { maxLength: 8 }), (known, parts) => {
                const r = new Redactor();
                r.add(...known);
                const out = r.scrub(parts.join(''));
                for (const s of known) assert.ok(!out.includes(s), `${JSON.stringify(s)} is still in ${JSON.stringify(out)}`);
            }),
            { numRuns: 3000 }
        );
    });
});

describe('the extension rule, over every case', () => {
    test('events/* goes only to a server that advertised the extension on 2026-07-28 or later, or, where that is allowed, the earlier top-level form', () => {
        const extensions = [undefined, null, 'yes', {}, { listChanged: true }];
        const topLevel = [undefined, null, 1, {}];
        const revisions = [undefined, '2025-11-25', '2026-07-28', '2027-01-01'];
        let cases = 0;
        for (const ext of extensions)
            for (const events of topLevel)
                for (const revision of revisions)
                    for (const preStandard of [false, true]) {
                        const caps: Record<string, unknown> = {};
                        if (ext !== undefined) caps.extensions = { [EVENTS_EXTENSION]: ext };
                        if (events !== undefined) caps.events = events;
                        const c = new EventsConnection('s', { url: 'https://upstream.invalid/mcp' }, { preStandard });
                        c.client = { getNegotiatedProtocolVersion: () => revision, getServerCapabilities: () => caps } as never;
                        const advertised = typeof ext === 'object' && ext !== null && typeof revision === 'string' && revision >= '2026-07-28';
                        const sketch = !advertised && preStandard && typeof events === 'object' && events !== null;
                        assert.equal(c.declaration, advertised ? 'extensions' : sketch ? 'pre-standard' : undefined, JSON.stringify({ ext, events, revision, preStandard }));
                        cases++;
                    }
        assert.equal(cases, 160);
    });

    test('MCP_EVENTS_PRE_STANDARD: any value is read without failing; "off" and its spellings allow the earlier form for no server', () => {
        fc.assert(
            fc.property(fc.option(fc.string({ maxLength: 30 }), { nil: undefined }), fc.string({ maxLength: 10 }), (v, server) => {
                assert.equal(typeof preStandardPolicy(v)(server), 'boolean');
            }),
            { numRuns: 1000 }
        );
        for (const off of ['off', 'OFF', ' off ', '0', 'false', 'no', 'none']) assert.equal(preStandardPolicy(off)('anything'), false);
    });
});

describe('the wake budget', () => {
    test('whatever arrives and whenever, across helper restarts: no more than the hour\'s wakes between two messages of the person, and one watch starts a wake at most once in its gap', () => {
        const GAP = 60_000;
        const PER_HOUR = 3;
        const op = fc.oneof(
            fc.record({ k: fc.constant('wait'), ms: fc.integer({ min: 1, max: 30 * 60_000 }) }),
            fc.record({ k: fc.constant('events'), watches: fc.uniqueArray(fc.constantFrom('w1', 'w2', 'w3'), { minLength: 1, maxLength: 3 }) }),
            fc.record({ k: fc.constant('spoke') }),
            fc.record({ k: fc.constant('restart') })
        );
        fc.assert(
            fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
                const file = join(temp(), 'wakes.json');
                let b = new WakeBudget({ gapMs: GAP, perHour: PER_HOUR }, file);
                let t = 1_000_000;
                const wakes: number[] = [];
                const started = new Map<string, number>();
                let since = 0; // how many wakes there had been when the person last spoke
                for (const o of ops) {
                    if (o.k === 'wait') t += o.ms;
                    else if (o.k === 'restart') b = new WakeBudget({ gapMs: GAP, perHour: PER_HOUR }, file);
                    else if (o.k === 'spoke') {
                        b.spoke();
                        since = wakes.length;
                    } else {
                        const g = b.gate(o.watches, t);
                        if (g.kind === 'notice') b.pause();
                        if (g.kind !== 'go') continue;
                        // The watch that is due starts it; the others ride along.
                        const due = o.watches.filter((w) => t - (started.get(w) ?? -Infinity) >= GAP);
                        assert.ok(due.length > 0, 'a wake is started by a watch whose gap is up');
                        for (const w of o.watches) started.set(w, t);
                        b.woke(o.watches, t);
                        wakes.push(t);
                        const inHour = wakes.filter((x, i) => x > t - 3600_000 && i >= since);
                        assert.ok(inHour.length <= PER_HOUR, `${inHour.length} wakes within an hour`);
                    }
                }
            }),
            { numRuns: 500 }
        );
    });
});
