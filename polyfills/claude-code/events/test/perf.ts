// Measurements of the helper process, against the fixture events server.
//
//   node --no-warnings test/perf.ts                 with the Node that runs this script, from source
//   PERF_RUNTIME="bun" node --no-warnings test/perf.ts          the bundle (mod/dist/helper.js) under another runtime
//   PERF_RUNTIME="/path/to/node --no-warnings" node ... test/perf.ts
//
// It prints one line per figure. CPU time and memory are read from `ps` (macOS and Linux);
// `ps` counts CPU time in steps of 10 ms.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE, ROOT, sleep, startHelper, startMonitor, startPlugin, waitFor, world } from './harness.ts';

const runtime = process.env.PERF_RUNTIME?.split(' ').filter(Boolean);
const command = runtime ? [...runtime, join(ROOT, 'mod', 'dist', 'helper.js')] : undefined;
const label = runtime ? runtime[0]! : `node ${process.version} (source)`;
const say = (what: string, value: string) => console.log(`${what.padEnd(58)} ${value}`);

/** Resident memory (MiB) and CPU time used so far (ms) of a process. */
function ps(pid: number): { rssMiB: number; cpuMs: number } {
    const [rss, time] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    // time is [[dd-]hh:]mm:ss[.cc]
    const parts = time!.replace('-', ':').split(':').map(Number);
    const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
    return { rssMiB: Number(rss) / 1024, cpuMs: seconds * 1000 };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`# mcp-events helper, ${label}, ${process.platform} ${process.arch}`);

// 1. Start-up: to "ready" (the tools can be called), and to the catalog with one server.
{
    const ready: number[] = [];
    const catalog: number[] = [];
    for (let i = 0; i < 9; i++) {
        const w = world();
        const t0 = performance.now();
        const h = await startHelper(w, 'sess-a', {}, { command });
        const done = await waitFor(() => h.messages.find((m) => m.t === 'catalog'), 20000, 'catalog');
        // Timed by when each message arrived, not by when this script next looked.
        ready.push((h.messages.find((m) => m.t === 'ready')!.at as number) - t0);
        catalog.push((done.at as number) - t0);
        await h.post('/stop');
        await h.exited;
    }
    say('start → ready (median of 9)', `${median(ready).toFixed(0)} ms`);
    say('start → catalog, 1 stdio server (median of 9)', `${median(catalog).toFixed(0)} ms`);
    if (process.env.PERF_ONLY === 'start') process.exit(0);
}

// 2. No server offers events: how long the helper lives, and that it leaves nothing running.
{
    const w = world();
    writeFileSync(w.config, JSON.stringify({ mcpServers: {} }));
    const t0 = performance.now();
    const h = await startHelper(w, 'sess-a', { MCP_EVENTS_STANDBY_MS: '20000' }, { command });
    await waitFor(() => h.messages.find((m) => m.t === 'catalog'), 20000, 'catalog');
    const at = ps(h.child.pid!);
    say('nothing to watch: memory while it waits to stand by', `${at.rssMiB.toFixed(0)} MiB`);
    await h.exited;
    say('nothing to watch: exits by itself after', `${((performance.now() - t0) / 1000).toFixed(1)} s (then 0 processes)`);
}

// 3. Idle with watches: memory and CPU over 30 s, with 8 watches (4 push, 4 poll at 5 s).
{
    const w = world({ FIXTURE_POLL_MS: '5000', FIXTURE_HEARTBEAT_MS: '15000' });
    const plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_MIN_POLL_MS: '1000' }, { command });
    startMonitor(w);
    // Four push watches, then four poll watches on a second server that offers poll only.
    for (let i = 0; i < 4; i++) await plugin.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: { priority: ['high', 'low', 'medium', 'urgent'][i] } });
    await sleep(3000);
    const a = ps(plugin.helper.child.pid!);
    await sleep(30000);
    const b = ps(plugin.helper.child.pid!);
    say('idle, 4 push watches: memory', `${b.rssMiB.toFixed(0)} MiB`);
    say('idle, 4 push watches: CPU over 30 s', `${(b.cpuMs - a.cpuMs).toFixed(0)} ms (${(((b.cpuMs - a.cpuMs) / 30000) * 100).toFixed(2)} % of one core)`);
    await plugin.stop();

    const wp = world({ FIXTURE_TICKET_DELIVERY: 'poll', FIXTURE_POLL_MS: '5000' });
    const poller = await startPlugin(wp, 'sess-a', {}, { command });
    startMonitor(wp);
    for (let i = 0; i < 4; i++) await poller.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: { priority: ['high', 'low', 'medium', 'urgent'][i] } });
    await sleep(3000);
    const c = ps(poller.helper.child.pid!);
    await sleep(30000);
    const d = ps(poller.helper.child.pid!);
    say('idle, 4 poll watches (every 5 s): memory', `${d.rssMiB.toFixed(0)} MiB`);
    say('idle, 4 poll watches (every 5 s): CPU over 30 s', `${(d.cpuMs - c.cpuMs).toFixed(0)} ms (${(((d.cpuMs - c.cpuMs) / 30000) * 100).toFixed(2)} % of one core)`);
    await poller.stop();
}

// 4. Cost per event: 1,000 events through one push watch, written to disk (fsync) and handed over.
{
    const w = world();
    const plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_BATCH_MS: '50' }, { command });
    const monitor = startMonitor(w);
    await plugin.call('watch_event', { server: 'tickets', event: 'ticket.created' });
    await waitFor(() => w.fixtureMethods().includes('events/stream'), 8000, 'events/stream');
    await sleep(500);
    const N = 1000;
    const before = ps(plugin.helper.child.pid!);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) w.emit('ticket.created', { ticketId: `T-${i}`, title: 'load', priority: 'high' });
    await waitFor(async () => (JSON.parse((await plugin.call('list_watches')).text) as { events: number }[])[0]?.events === N, 120000, 'all events taken');
    const wall = performance.now() - t0;
    await waitFor(() => monitor.lines.length > 0, 10000, 'the hand-over');
    await sleep(1500);
    const after = ps(plugin.helper.child.pid!);
    say(`${N} events, one push watch: emitted → all on disk`, `${wall.toFixed(0)} ms (${(wall / N).toFixed(2)} ms/event, ${Math.round((N / wall) * 1000)} events/s; each one is fsynced)`);
    say(`${N} events: helper CPU per event`, `${((after.cpuMs - before.cpuMs) / N).toFixed(2)} ms`);
    say(`${N} events: memory afterwards`, `${after.rssMiB.toFixed(0)} MiB`);
    say(`${N} events: lines handed to Claude Code (bursts are folded)`, `${monitor.lines.length}`);
    await plugin.stop();

    // One event, end to end: from the server having it to the helper saying it waits.
    const w1 = world();
    const one = await startPlugin(w1, 'sess-a', { MCP_EVENTS_BATCH_MS: '0' }, { command });
    await one.call('watch_event', { server: 'tickets', event: 'ticket.created' });
    await waitFor(() => w1.fixtureMethods().includes('events/stream'), 8000, 'events/stream');
    await sleep(500);
    const lat: number[] = [];
    for (let i = 0; i < 10; i++) {
        const seen = one.helper.messages.filter((m) => m.t === 'pending').length;
        const t = performance.now();
        w1.emit('ticket.created', { ticketId: `L-${i}`, title: 'one', priority: 'high' });
        await waitFor(() => one.helper.messages.filter((m) => m.t === 'pending').length > seen, 8000, 'pending');
        lat.push((one.helper.messages.findLast((m) => m.t === 'pending')!.at as number) - t);
        await one.helper.deliverNow();
        await sleep(200);
    }
    say('one event: server has it → helper says it waits (median of 10)', `${median(lat).toFixed(0)} ms (the fixture looks for new events every 150 ms; the helper then waits its batching window, 1 s by default, before it says so; 0 here)`);
    await one.stop();
}

// 5. Many servers: 20 configured, 10 of which offer events.
{
    const w = world();
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) servers[`events-${i}`] = { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: join(w.dir, `up-${i}.jsonl`) } };
    // Ten more that are MCP servers without the extension.
    for (let i = 0; i < 10; i++) servers[`plain-${i}`] = { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: join(w.dir, `plain-${i}.jsonl`), FIXTURE_CAPS: 'none' } };
    writeFileSync(w.config, JSON.stringify({ mcpServers: servers }));
    const t0 = performance.now();
    const plugin = await startPlugin(w, 'sess-a', {}, { command });
    const took = performance.now() - t0;
    const listed = JSON.parse((await plugin.call('list_event_types')).text.split('\n').slice(1).join('\n')) as { servers: unknown[] };
    say('20 stdio servers (10 with events): start → catalog', `${took.toFixed(0)} ms, ${listed.servers.length} kept connected`);
    say('20 stdio servers: helper memory', `${ps(plugin.helper.child.pid!).rssMiB.toFixed(0)} MiB`);
    await plugin.stop();
}
process.exit(0);
