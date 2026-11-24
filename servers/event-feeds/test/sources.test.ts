// Cursor logic of each event type, through events/poll, against recorded upstream responses.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pollEvents } from '../src/events.ts';
import { RpcError } from '../src/rpc.ts';
import { parseReleases } from '../src/sources/github.ts';
import { algoliaPage, decode, fakeLoader, fixtureJson, fixtureText, type Hit } from './helpers.ts';

const ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0/item/';
const comments = fixtureJson<{ hits: Hit[] }>('hn-comments.json').hits; // 50, newest first
const story = fixtureJson('hn-item-story.json');
const NOW = (comments[0]!.created_at_i + 30) * 1000;

type R = { events: { eventId: string; name: string; timestamp: string; data: Record<string, unknown> }[]; cursor: string; truncated: boolean; hasMore: boolean; nextPollMs: number; resultType: string };
const poll = async (loader: Parameters<typeof pollEvents>[1], name: string, args: unknown, cursor: string | null, extra: Record<string, unknown> = {}, now = NOW) =>
    (await pollEvents({ name, arguments: args, cursor, ...extra }, loader, now)) as unknown as R;

async function rejects(p: Promise<unknown>, code: number, re?: RegExp) {
    await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === code && (!re || re.test(e.message)));
}

describe('hn.comment', () => {
    const args = { story: 50611576 };
    const older = comments.slice(3); // the thread before the three newest comments arrived

    test('null cursor starts from now: no events, a cursor, the recommended interval', async () => {
        const { loader, asked } = fakeLoader({ [ALGOLIA]: algoliaPage(older), [FIREBASE]: story });
        const r = await poll(loader, 'hn.comment', args, null);
        assert.equal(r.resultType, 'complete');
        assert.deepEqual(r.events, []);
        assert.equal(r.truncated, false);
        assert.equal(r.hasMore, false);
        assert.equal(r.nextPollMs, 30_000);
        assert.equal(typeof r.cursor, 'string');
        assert.ok(asked.some((u) => u.startsWith(FIREBASE + '50611576.json')), 'the story was checked once at the start');
        assert.ok(asked.some((u) => u.includes('tags=comment,story_50611576&hitsPerPage=50')));
    });

    test('new comments arrive once, oldest first, with small plain payloads', async () => {
        const a = fakeLoader({ [ALGOLIA]: algoliaPage(older), [FIREBASE]: story });
        const c0 = (await poll(a.loader, 'hn.comment', args, null)).cursor;
        const b = fakeLoader({ [ALGOLIA]: algoliaPage(comments) });
        const r = await poll(b.loader, 'hn.comment', args, c0);
        assert.deepEqual(
            r.events.map((e) => e.eventId),
            comments.slice(0, 3).map((h) => h.objectID).reverse()
        );
        assert.ok(!b.asked.some((u) => u.startsWith(FIREBASE)), 'the story check runs only when a subscription starts');
        for (const e of r.events) {
            assert.equal(e.name, 'hn.comment');
            assert.match(e.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
            assert.equal(e.data.url, `https://news.ycombinator.com/item?id=${e.eventId}`);
            assert.equal(e.data.storyId, '50611576');
            assert.deepEqual(Object.keys(e.data).sort(), ['id', 'parentId', 'postedAt', 'storyId', 'url'], 'ids, a time and a link: no author or text');
        }
        const again = await poll(b.loader, 'hn.comment', args, r.cursor);
        assert.deepEqual(again.events, [], 'nothing twice');
    });

    test('a comment the index adds late (an older id after newer ones) is still delivered', async () => {
        const missing = comments[10]!;
        const a = fakeLoader({ [ALGOLIA]: algoliaPage(comments.filter((h) => h !== missing)), [FIREBASE]: story });
        const c0 = (await poll(a.loader, 'hn.comment', args, null)).cursor;
        const r = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', args, c0);
        assert.deepEqual(r.events.map((e) => e.eventId), [missing.objectID]);
        assert.equal(r.truncated, false);
    });

    test('maxEvents gives a partial batch with hasMore, and the rest on the next poll', async () => {
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments.slice(5)), [FIREBASE]: story }).loader, 'hn.comment', args, null)).cursor;
        const l = fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader;
        const r1 = await poll(l, 'hn.comment', args, c0, { maxEvents: 2 });
        assert.equal(r1.events.length, 2);
        assert.equal(r1.hasMore, true);
        const r2 = await poll(l, 'hn.comment', args, r1.cursor, { maxEvents: 2 });
        const r3 = await poll(l, 'hn.comment', args, r2.cursor, { maxEvents: 2 });
        assert.equal(r3.hasMore, false);
        const all = [...r1.events, ...r2.events, ...r3.events].map((e) => e.eventId);
        assert.deepEqual(all, comments.slice(0, 5).map((h) => h.objectID).reverse());
    });

    test('a page that no longer reaches back to the cursor reports truncated, once', async () => {
        // The cursor was made when only the oldest comment existed; the page is now full of newer ones.
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage([comments[49]!]), [FIREBASE]: story }).loader, 'hn.comment', args, null)).cursor;
        const later = comments.map((h, i) => ({ ...h, objectID: String(Number(h.objectID) + 1000), created_at_i: h.created_at_i + 3600 + i }));
        const l = fakeLoader({ [ALGOLIA]: algoliaPage(later) }).loader;
        const r = await poll(l, 'hn.comment', args, c0, {}, (later[0]!.created_at_i + 10) * 1000);
        assert.equal(r.truncated, true);
        assert.equal(r.events.length, 20, 'delivers from the oldest it has, up to the default batch');
        assert.equal(r.hasMore, true);
        const r2 = await poll(l, 'hn.comment', args, r.cursor, {}, (later[0]!.created_at_i + 10) * 1000);
        assert.equal(r2.truncated, false, 'the gap is reported on the first response only');
    });

    test('author and repliesTo filter the thread', async () => {
        const author = 'NetMageSCW';
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage([]), [FIREBASE]: story }).loader, 'hn.comment', { ...args, author }, null, {}, (comments[49]!.created_at_i - 10) * 1000)).cursor;
        const r = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', { ...args, author }, c0);
        assert.deepEqual(r.events.map((e) => e.eventId).sort(), comments.filter((h) => h.author === author).map((h) => h.objectID).sort());
        const c1 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage([]), [FIREBASE]: story }).loader, 'hn.comment', { ...args, repliesTo: 50611576 }, null, {}, (comments[49]!.created_at_i - 10) * 1000)).cursor;
        const r1 = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', { ...args, repliesTo: 50611576 }, c1);
        assert.equal(r1.events.length, comments.filter((h) => h.parent_id === 50611576).length);
    });

    test('maxAgeMs: a stale cursor skips what is older than the floor and says so', async () => {
        const start = (comments[49]!.created_at_i - 60) * 1000;
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage([]), [FIREBASE]: story }).loader, 'hn.comment', args, null, {}, start)).cursor;
        const floorAt = comments[4]!.created_at_i; // keep only comments at or after the fifth newest
        const now = NOW;
        const r = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', args, c0, { maxAgeMs: now - floorAt * 1000 }, now);
        assert.equal(r.truncated, true, 'the floor advanced past the cursor');
        assert.ok(r.events.every((e) => Date.parse(e.timestamp) >= floorAt * 1000));
        assert.ok(r.events.length >= 5 && r.events.length < 50);
        // A fresh cursor with the same maxAgeMs replays nothing extra and is not truncated.
        const r2 = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', args, r.cursor, { maxAgeMs: 60_000 }, now);
        assert.deepEqual(r2.events, []);
        assert.equal(r2.truncated, false);
    });

    test('maxAgeMs is measured from when the cursor was made, not from the newest comment in a quiet thread', async () => {
        // A thread whose newest comment is days old, polled a minute ago: nothing is skipped, no truncation.
        const quiet = comments.slice(40);
        const now = (quiet[0]!.created_at_i + 3 * 86400) * 1000;
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage(quiet), [FIREBASE]: story }).loader, 'hn.comment', args, null, {}, now - 60_000)).cursor;
        const r = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(quiet) }).loader, 'hn.comment', args, c0, { maxAgeMs: 300_000 }, now);
        assert.equal(r.truncated, false);
        // The same cursor kept for an hour: the floor has passed it.
        const r2 = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(quiet) }).loader, 'hn.comment', args, c0, { maxAgeMs: 300_000 }, now + 3_600_000);
        assert.equal(r2.truncated, true);
    });

    test('a comment id given as the story is refused with a way out', async () => {
        const { loader } = fakeLoader({ [FIREBASE]: fixtureJson('hn-item-comment.json'), [ALGOLIA]: algoliaPage([]) });
        await rejects(poll(loader, 'hn.comment', { story: 50621511 }, null), -32602, /is a comment, not a story.*repliesTo/);
        const none = fakeLoader({ [FIREBASE]: null, [ALGOLIA]: algoliaPage([]) });
        await rejects(poll(none.loader, 'hn.comment', { story: 999999999 }, null), -32602, /no item/);
    });

    test('a cursor is bound to its event type and arguments', async () => {
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments), [FIREBASE]: story }).loader, 'hn.comment', args, null)).cursor;
        await rejects(poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.comment', { story: 1 }, c0), -32602, /different arguments/);
        await rejects(poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments) }).loader, 'hn.story', {}, c0), -32602, /different event type/);
        await rejects(poll(fakeLoader({}).loader, 'hn.comment', args, 'not-a-cursor!'), -32602, /invalid cursor/);
    });

    test('an upstream failure keeps the place and backs off; at the start it is an error', async () => {
        const c0 = (await poll(fakeLoader({ [ALGOLIA]: algoliaPage(comments), [FIREBASE]: story }).loader, 'hn.comment', args, null)).cursor;
        const down = fakeLoader({ [ALGOLIA]: () => ({ ok: false, why: 'unavailable' }) }).loader;
        const r = await poll(down, 'hn.comment', args, c0);
        assert.deepEqual(r.events, []);
        assert.equal(r.cursor, c0);
        assert.equal(r.nextPollMs, 120_000);
        await rejects(poll(fakeLoader({ [FIREBASE]: story, [ALGOLIA]: () => ({ ok: false, why: 'unavailable' }) }).loader, 'hn.comment', args, null), -32603);
        // A page that is not what Algolia sends counts as a failure, not as "no comments".
        const r2 = await poll(fakeLoader({ [ALGOLIA]: { hello: 1 } }).loader, 'hn.comment', args, c0);
        assert.equal(r2.cursor, c0);
    });
});

describe('fresh answers from Algolia', () => {
    test('the query names a 7-day window that changes once per poll interval', async () => {
        const at = (now: number) => {
            const a = fakeLoader({ [ALGOLIA]: algoliaPage([]), [FIREBASE]: story });
            return poll(a.loader, 'hn.comment', { story: 50611576 }, null, {}, now).then(() => a.asked.find((u) => u.startsWith(ALGOLIA))!);
        };
        const t = 1_795_480_040_000; // 20 s into a 30 s bucket (buckets start at multiples of 30 s)
        const u1 = await at(t);
        assert.match(u1, /numericFilters=created_at_i%3E(\d+)/);
        assert.equal(Number(/created_at_i%3E(\d+)/.exec(u1)![1]), Math.floor(t / 30_000) * 30 - 604800);
        assert.equal(await at(t + 5_000), u1, 'the same URL within one interval (one shared cached read)');
        assert.notEqual(await at(t + 15_000), u1, 'a new URL in the next interval (a fresh answer)');
    });
});

describe('hn.story', () => {
    const stories = fixtureJson<{ hits: Hit[] }>('hn-stories-rust.json').hits;
    test('new stories matching the query; the query is part of the upstream page, not the cursor', async () => {
        const a = fakeLoader({ [ALGOLIA]: algoliaPage(stories.slice(2)) });
        const c0 = (await poll(a.loader, 'hn.story', { query: 'Rust' }, null)).cursor;
        assert.ok(a.asked[0]!.includes('tags=story&query=rust&typoTolerance=false&restrictSearchableAttributes=title&hitsPerPage=30'));
        const r = await poll(fakeLoader({ [ALGOLIA]: algoliaPage(stories) }).loader, 'hn.story', { query: 'Rust' }, c0, {}, (stories[0]!.created_at_i + 5) * 1000);
        assert.deepEqual(r.events.map((e) => e.eventId), [stories[1]!.objectID, stories[0]!.objectID]);
        const d = r.events[1]!.data;
        assert.equal(d.url, `https://news.ycombinator.com/item?id=${stories[0]!.objectID}`);
        assert.equal(d.title, undefined, 'the title is read with read_event_text, not carried in the event');
        assert.equal(r.nextPollMs, 60_000);
    });
    test('kind and author select the Algolia tags', async () => {
        const a = fakeLoader({ [ALGOLIA]: algoliaPage([]) });
        await poll(a.loader, 'hn.story', { kind: 'show_hn', author: 'pg' }, null);
        assert.ok(a.asked[0]!.startsWith(`${ALGOLIA}?tags=show_hn,author_pg&hitsPerPage=30`));
    });
});

describe('npm.release', () => {
    const tags = fixtureJson<Record<string, string>>('npm-typescript-dist-tags.json');
    const NPM = 'https://registry.npmjs.org/-/package/';
    test('latest moving is one event; other tags are ignored unless asked for', async () => {
        const c0 = (await poll(fakeLoader({ [NPM]: tags }).loader, 'npm.release', { package: 'typescript' }, null)).cursor;
        const moved = { ...tags, latest: '7.0.3', next: '7.1.0-dev.20261124.1' };
        const r = await poll(fakeLoader({ [NPM]: moved }).loader, 'npm.release', { package: 'typescript' }, c0);
        assert.deepEqual(r.events.map((e) => e.data), [{ package: 'typescript', version: '7.0.3', tag: 'latest', url: 'https://www.npmjs.com/package/typescript/v/7.0.3' }]);
        assert.equal(r.events[0]!.eventId, 'typescript@7.0.3#latest');
        const again = await poll(fakeLoader({ [NPM]: moved }).loader, 'npm.release', { package: 'typescript' }, r.cursor);
        assert.deepEqual(again.events, []);
    });
    test('tag "*" watches every tag', async () => {
        const c0 = (await poll(fakeLoader({ [NPM]: tags }).loader, 'npm.release', { package: 'typescript', tag: '*' }, null)).cursor;
        const r = await poll(fakeLoader({ [NPM]: { ...tags, latest: '7.0.3', next: '7.1.0-dev.20261124.1' } }).loader, 'npm.release', { package: 'typescript', tag: '*' }, c0);
        assert.deepEqual(r.events.map((e) => e.data.tag).sort(), ['latest', 'next']);
    });
    test('a scoped name is encoded into the registry path; an unknown package is refused at the start', async () => {
        const a = fakeLoader({ [NPM]: { latest: '1.0.0' } });
        await poll(a.loader, 'npm.release', { package: '@modelcontextprotocol/sdk' }, null);
        assert.equal(a.asked[0], `${NPM}@modelcontextprotocol%2fsdk/dist-tags`);
        await rejects(poll(fakeLoader({ [NPM]: () => ({ ok: false, why: 'not_found' }) }).loader, 'npm.release', { package: 'no-such-pkg-zz9' }, null), -32602, /no package named/);
    });
});

describe('github.release', () => {
    const atom = fixtureText('gh-workers-sdk-releases.atom');
    const GH = 'https://github.com/';
    test('the recorded feed parses into ten releases', () => {
        const rs = parseReleases(atom);
        assert.equal(rs.length, 10);
        assert.equal(rs[0]!.tag, 'wrangler@4.167.0');
        assert.equal(rs[0]!.url, 'https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.167.0');
        assert.equal(rs[0]!.author, 'petebacondarwin');
        assert.ok(rs.every((r) => r.notes.length <= 1500 && !/<|&lt;|&amp;/.test(r.notes)));
        assert.throws(() => parseReleases('<html>not a feed</html>'));
    });
    test('new releases arrive once; the URL is built from the checked repo name only', async () => {
        const without = atom.replace(/<entry>[\s\S]*?<\/entry>/, '').replace(/<entry>[\s\S]*?<\/entry>/, '');
        const a = fakeLoader({ [GH]: without });
        const c0 = (await poll(a.loader, 'github.release', { repo: 'cloudflare/workers-sdk' }, null)).cursor;
        assert.equal(a.asked[0], 'https://github.com/cloudflare/workers-sdk/releases.atom');
        const r = await poll(fakeLoader({ [GH]: atom }).loader, 'github.release', { repo: 'cloudflare/workers-sdk' }, c0);
        assert.deepEqual(r.events.map((e) => e.data.tag), ['miniflare@5.20261123.0-beta', 'wrangler@4.167.0']);
        assert.equal(r.events[1]!.eventId, 'tag:github.com,2008:Repository/426659329/wrangler@4.167.0');
        assert.equal(r.events[1]!.data.repo, 'cloudflare/workers-sdk');
        assert.equal(r.nextPollMs, 120_000);
        await rejects(poll(fakeLoader({ [GH]: () => ({ ok: false, why: 'not_found' }) }).loader, 'github.release', { repo: 'someone/private-thing' }, null), -32602, /no public repository/);
    });
});

describe('usgs.earthquake', () => {
    const feed = fixtureJson<{ metadata: { generated: number }; features: { id: string; properties: { mag: number; time: number } }[] }>('usgs-sample.geojson');
    const USGS = 'https://earthquake.usgs.gov/';
    const gen = feed.metadata.generated;
    const withFeatures = (fs: typeof feed.features, generated = gen) => ({ ...feed, metadata: { ...feed.metadata, generated }, features: fs });
    test('only quakes at or above the magnitude, each once', async () => {
        const c0 = (await poll(fakeLoader({ [USGS]: withFeatures(feed.features.slice(5), gen - 60_000) }).loader, 'usgs.earthquake', { minMagnitude: 2 }, null, {}, gen - 60_000)).cursor;
        const r = await poll(fakeLoader({ [USGS]: withFeatures(feed.features) }).loader, 'usgs.earthquake', { minMagnitude: 2 }, c0, {}, gen);
        const want = feed.features.slice(0, 5).filter((f) => f.properties.mag >= 2).map((f) => f.id);
        assert.deepEqual(r.events.map((e) => e.eventId).sort(), want.sort());
        assert.ok(r.events.every((e) => (e.data.magnitude as number) >= 2 && e.data.place === undefined && e.data.url === `https://earthquake.usgs.gov/earthquakes/eventpage/${e.eventId}`));
        assert.equal(r.truncated, false);
    });
    test('near a point: distance filter, and the distance in the payload', async () => {
        const f0 = feed.features[0] as unknown as { geometry: { coordinates: number[] } };
        const [lon, lat] = f0.geometry.coordinates as [number, number];
        const near = { minMagnitude: -1, latitude: lat, longitude: lon, radiusKm: 50 };
        const c0 = (await poll(fakeLoader({ [USGS]: withFeatures([]) }).loader, 'usgs.earthquake', near, null, {}, gen)).cursor;
        const r = await poll(fakeLoader({ [USGS]: withFeatures(feed.features) }).loader, 'usgs.earthquake', near, c0, {}, gen);
        assert.ok(r.events.length >= 1);
        assert.ok(r.events.every((e) => (e.data.distanceKm as number) <= 50));
        await rejects(poll(fakeLoader({}).loader, 'usgs.earthquake', { latitude: 10 }, null), -32602, /together/);
    });
    test('a cursor older than the feed reaches back is truncated', async () => {
        const c0 = (await poll(fakeLoader({ [USGS]: withFeatures([], gen - 2 * 3_600_000) }).loader, 'usgs.earthquake', {}, null, {}, gen - 2 * 3_600_000)).cursor;
        const r = await poll(fakeLoader({ [USGS]: withFeatures(feed.features) }).loader, 'usgs.earthquake', {}, c0, {}, gen);
        assert.equal(r.truncated, true);
        assert.ok(decode(r.cursor).w === gen);
    });
});

describe('demo.button', () => {
    const ch = 'b' + 'A'.repeat(30);
    test('presses on the channel, in order, with the typed message', async () => {
        const presses = { [ch]: [] as unknown[] };
        const l = fakeLoader({}, presses).loader;
        const c0 = (await poll(l, 'demo.button', { channel: ch }, null)).cursor;
        presses[ch] = [{ n: 1, ts: NOW - 2000, m: 'ship it' }, { n: 2, ts: NOW - 1000 }];
        const r = await poll(l, 'demo.button', { channel: ch }, c0);
        assert.deepEqual(r.events.map((e) => e.data), [{ press: 1, hasMessage: true, pressedAt: new Date(NOW - 2000).toISOString().replace(/\.\d{3}Z/, 'Z') }, { press: 2, hasMessage: false, pressedAt: new Date(NOW - 1000).toISOString().replace(/\.\d{3}Z/, 'Z') }]);
        assert.equal(r.nextPollMs, 2000);
        assert.deepEqual((await poll(l, 'demo.button', { channel: ch }, r.cursor)).events, []);
    });
    test('an expired or unknown channel is refused on every poll, so the watch ends', async () => {
        const l = fakeLoader({}, { [ch]: [] }).loader;
        const c0 = (await poll(l, 'demo.button', { channel: ch }, null)).cursor;
        const gone = fakeLoader({}, {}).loader;
        await rejects(poll(gone, 'demo.button', { channel: ch }, c0), -32602, /expired/);
        await rejects(poll(gone, 'demo.button', { channel: 'nope' }, null), -32602, /channel/);
    });
});

describe('no third-party text in any event', () => {
    // Ids, numbers, booleans, timestamps and links built by the server: every string is one token, no spaces.
    const TOKEN = /^[A-Za-z0-9@._:,\/+#?=%-]{1,400}$/;
    const check = (events: R['events']) => {
        for (const e of events) {
            assert.match(e.eventId, TOKEN);
            for (const [k, v] of Object.entries(e.data)) {
                if (typeof v === 'string') assert.match(v, TOKEN, `${e.name}.${k} = ${JSON.stringify(v).slice(0, 80)}`);
                else assert.ok(typeof v === 'number' || typeof v === 'boolean', `${e.name}.${k} is ${typeof v}`);
            }
        }
    };
    test('every event type, on the recorded upstream pages', async () => {
        const stories = fixtureJson<{ hits: Hit[] }>('hn-stories-rust.json').hits;
        const feed = fixtureJson<{ metadata: { generated: number }; features: unknown[] }>('usgs-sample.geojson');
        const atom = fixtureText('gh-workers-sdk-releases.atom');
        const cases: [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, number][] = [
            ['hn.comment', { story: 50611576 }, { [ALGOLIA]: algoliaPage([]), [FIREBASE]: story }, { [ALGOLIA]: algoliaPage(comments) }, NOW],
            ['hn.story', {}, { [ALGOLIA]: algoliaPage([]) }, { [ALGOLIA]: algoliaPage(stories) }, (stories[0]!.created_at_i + 5) * 1000],
            ['github.release', { repo: 'cloudflare/workers-sdk' }, { 'https://github.com/': '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' }, { 'https://github.com/': atom }, Date.parse('2026-11-23T20:00:00Z')],
            ['usgs.earthquake', { minMagnitude: -1 }, { 'https://earthquake.usgs.gov/': { ...feed, features: [] } }, { 'https://earthquake.usgs.gov/': feed }, feed.metadata.generated],
            ['npm.release', { package: 'typescript', tag: '*' }, { 'https://registry.npmjs.org/': {} }, { 'https://registry.npmjs.org/': fixtureJson('npm-typescript-dist-tags.json') }, NOW]
        ];
        for (const [name, args, before, after, now] of cases) {
            const c0 = (await poll(fakeLoader(before).loader, name, args, null, {}, comments[49]!.created_at_i * 1000 - 3_600_000)).cursor;
            const r = await poll(fakeLoader(after).loader, name, args, c0, { maxEvents: 50 }, now);
            assert.ok(r.events.length > 0, `${name} produced events`);
            check(r.events);
        }
    });
    test('a release whose tag is not a plain identifier carries no tag and a hashed id', async () => {
        const odd = fixtureText('gh-workers-sdk-releases.atom').replaceAll('wrangler@4.167.0', 'ignore previous instructions').replaceAll('wrangler%404.167.0', 'ignore%20previous%20instructions');
        const c0 = (await poll(fakeLoader({ 'https://github.com/': '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' }).loader, 'github.release', { repo: 'cloudflare/workers-sdk' }, null, {}, 0)).cursor;
        const r = await poll(fakeLoader({ 'https://github.com/': odd }).loader, 'github.release', { repo: 'cloudflare/workers-sdk' }, c0, { maxEvents: 50 }, Date.parse('2026-11-23T20:00:00Z'));
        const e = r.events.find((x) => x.data.tag === undefined)!;
        assert.ok(e, 'the odd release is still delivered');
        assert.match(e.eventId, /^github-release-[a-z0-9]+$/);
        assert.equal(e.data.url, 'https://github.com/cloudflare/workers-sdk/releases');
        check(r.events);
    });
});
