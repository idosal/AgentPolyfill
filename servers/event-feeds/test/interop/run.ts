// Interop: the mcp-events client (the MCPolyfill polyfill's helper process, driven by its own test
// harness exactly as Claude Code's hooks module drives it) against a running event-feeds.
//
//   node --no-warnings test/interop/run.ts [base-url]       default: the deployed server
//   MCP_EVENTS_PLUGIN=/path/to/mcp-events  (the polyfill's source; default ../../polyfills/claude-code/events
//                                           in the MCPolyfill repository; read, not changed)
//   INTEROP_FEEDS=0                         skip the wait for a real Hacker News comment
//
// It prints one line per check and exits non-zero on the first failure.

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = (process.argv[2] ?? 'https://event-feeds.idosalomon.workers.dev').replace(/\/$/, '');
// The polyfill's source: next to this server in the MCPolyfill repository, or a checkout of its own.
const inRepo = fileURLToPath(new URL('../../../../polyfills/claude-code/events', import.meta.url));
const PLUGIN = process.env.MCP_EVENTS_PLUGIN ?? (existsSync(join(inRepo, 'test', 'harness.ts')) ? inRepo : inRepo);
const h = (await import(pathToFileURL(join(PLUGIN, 'test', 'harness.ts')).href)) as typeof import('./harness-types.ts');
const ok = (s: string) => console.log(`✓ ${s}`);
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

const dir = h.temp('event-feeds-interop-');
const config = join(dir, 'servers.json');
writeFileSync(config, JSON.stringify({ mcpServers: { feeds: { type: 'http', url: `${BASE}/mcp` } } }));
const w = { dir, config, state: join(dir, 'state'), project: join(dir, 'project') };

async function newChannel(): Promise<string> {
    const r = await fetch(`${BASE}/b/new`, { redirect: 'manual' });
    const loc = r.headers.get('location') ?? '';
    const ch = /\/b\/(b[A-Za-z0-9_-]{30})$/.exec(loc)?.[1];
    assert.ok(ch, `a new button page (got ${r.status} ${loc})`);
    return ch;
}
const press = async (channel: string, message?: string) => {
    const r = await fetch(`${BASE}/api/press`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ channel, message }) });
    const j = (await r.json()) as { ok: boolean; press?: number; error?: string };
    assert.ok(j.ok, j.error);
    return Date.now();
};

let plugin: Awaited<ReturnType<typeof h.startPlugin>> | undefined;
let monitor: ReturnType<typeof h.startMonitor> | undefined;
let failed = false;
try {
    plugin = await h.startPlugin(w as never, 'sess-a');
    monitor = h.startMonitor(w as never, 'sess-a');
    const ins = plugin.instructions();
    assert.match(ins, /feeds \/ demo\.button \(poll\)/, ins);
    for (const name of ['hn.comment', 'hn.story', 'npm.release', 'github.release', 'usgs.earthquake']) assert.match(ins, new RegExp(`feeds / ${name.replace('.', '\\.')} \\(poll\\)`));
    ok(`the helper discovered all six event types, poll only (${since()})`);
    const listed = (await plugin.call('list_event_types')).text;
    const types = JSON.parse(listed.slice(listed.indexOf('\n') + 1)) as { servers: { server: string; declares: string; eventTypes: { name: string }[] }[] };
    const feeds = types.servers.find((s) => s.server === 'feeds')!;
    assert.equal(feeds.declares, 'extensions');
    ok('declared as SEP-3415 defines it (capabilities.extensions, protocol revision 2026-07-28)');

    // The button: a watch, an idle session, a press, a wake.
    const ch = await newChannel();
    const r = await plugin.call('watch_event', { server: 'feeds', event: 'demo.button', arguments: { channel: ch }, note: 'Say what was typed.' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /by poll/);
    ok(`watch_event demo.button → ${/by poll[^.]*/.exec(r.text)?.[0]}`);
    await h.waitFor(async () => JSON.parse((await plugin!.call('list_watches')).text)[0]?.cursor !== undefined || JSON.parse((await plugin!.call('list_watches')).text)[0]?.status === 'active' || undefined, 15000, 'the watch to be active');
    await h.sleep(2500);
    const pressed = await press(ch, 'interop says hi');
    const line = await h.waitFor(() => monitor!.lines.find((l) => l.includes('demo.button')), 15000, 'the press to wake the session');
    const latency = Date.now() - pressed;
    console.log('  woke with:', line.slice(0, 160));
    assert.match(line, /press=1/);
    assert.match(line, /hasMessage=true/);
    assert.doesNotMatch(line, /interop says hi/, 'the message is not in the event');
    ok(`a press woke the idle session ${(latency / 1000).toFixed(1)} s later; the event carries no text`);
    await h.sleep(4500);
    assert.equal(monitor.lines.filter((l) => l.includes('demo.button')).length, 1);
    ok('and only once');

    // The client keeps the place, the server keeps nothing: presses while the client is closed arrive on reopen.
    monitor.stop();
    await plugin.stop();
    plugin = undefined;
    await press(ch, 'while closed');
    await h.sleep(1200);
    await press(ch, 'still closed');
    plugin = await h.startPlugin(w as never, 'sess-b');
    monitor = h.startMonitor(w as never, 'sess-b');
    await h.waitFor(() => monitor!.lines.filter((l) => l.includes('demo.button')).length >= 2 || undefined, 20000, 'the two presses made while closed');
    await h.sleep(3000);
    const after = monitor.lines.filter((l) => l.includes('demo.button'));
    assert.equal(after.length, 2, JSON.stringify(after));
    assert.ok(after.some((l) => l.includes('press=2')) && after.some((l) => l.includes('press=3')));
    assert.ok(!after.some((l) => l.includes('press=1')), 'the press already seen is not shown again');
    ok('reopened: the two presses made while closed arrive once each, from the cursor the client kept');

    // A watch the server refuses ends with the server's reason.
    const bad = await plugin.call('watch_event', { server: 'feeds', event: 'npm.release', arguments: { package: 'Not A Package' } });
    const badState = bad.isError ? bad.text : await h.waitFor(() => monitor!.lines.find((l) => /npm\.release\) ended/.test(l)), 15000, 'the refused watch to end');
    assert.match(badState, /-32602|invalid|not a valid/i);
    ok(`a watch with bad arguments is refused: ${badState.slice(0, 120)}`);

    if (process.env.INTEROP_FEEDS !== '0') {
        // A real feed, the launch-day one: comments in whichever Hacker News thread is busiest right now.
        const latest = (await (await fetch('https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=50&attributesToRetrieve=story_id&attributesToHighlight=none')).json()) as { hits: { story_id: number }[] };
        const counts = new Map<number, number>();
        for (const x of latest.hits) counts.set(x.story_id, (counts.get(x.story_id) ?? 0) + 1);
        const story = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        const s = await plugin.call('watch_event', { server: 'feeds', event: 'hn.comment', arguments: { story }, note: 'interop' });
        assert.equal(s.isError, false, s.text);
        const at = Date.now();
        const c = await h.waitFor(() => monitor!.lines.find((l) => l.includes('hn.comment')), 6 * 60_000, `a new comment on HN story ${story}`);
        console.log('  woke with:', c.slice(0, 170));
        assert.match(c, /storyId=/);
        ok(`hn.comment: a real new comment on story ${story} woke the session after ${Math.round((Date.now() - at) / 1000)} s`);
        const id = /id=(\d+)/.exec(c)?.[1];
        const t = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read_event_text' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_event_text', arguments: { event: 'hn.comment', id }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
        const tj = (await t.json()) as { result: { content: { text: string }[] } };
        assert.match(tj.result.content[0]!.text, /^Third-party text from Hacker News/);
        ok('read_event_text returns that comment\'s text, labelled as third-party text');
    }
    console.log('INTEROP OK');
} catch (e) {
    failed = true;
    console.error(`✗ ${(e as Error).message}`);
    if (monitor) console.error('monitor lines:', JSON.stringify(monitor.lines).slice(0, 1500));
    if (plugin) console.error('watches:', (await plugin.call('list_watches').catch(() => ({ text: '?' }))).text.slice(0, 1500));
} finally {
    monitor?.stop();
    await plugin?.stop().catch(() => {});
}
process.exit(failed ? 1 : 0);
