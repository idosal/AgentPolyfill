// Interop: the plugin against Mastra's MCPServer events, end to end (plugin MCP
// server + monitor as real processes). Run: node --no-warnings test/interop/run.ts
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, startMonitor, startPlugin, temp, waitFor } from '../harness.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = temp('mcp-events-interop-');
const upstream = join(dir, 'mastra-upstream.jsonl');
writeFileSync(upstream, '');
const config = join(dir, 'servers.json');
writeFileSync(config, JSON.stringify({ mcpServers: { mastra: { command: process.execPath, args: ['--no-warnings', join(here, 'mastra-server.ts')], cwd: here, env: { MASTRA_UPSTREAM: upstream } } } }));
const w = { config, state: join(dir, 'state'), project: join(dir, 'project') } as never;

const plugin = await startPlugin(w, 'interop');
const monitor = startMonitor(w, 'interop');
const step = (s: string) => console.log(`✓ ${s}`);
try {
    const ins = plugin.instructions();
    assert.match(ins, /- mastra \/ ticket\.created \((poll, push|push, poll)\)/, ins);
    step('Mastra server discovered; its event type listed in the instructions');
    // The tool's answer is one line of the plugin's own, then the list as JSON.
    const listed = (await plugin.call('list_event_types')).text;
    const types = JSON.parse(listed.slice(listed.indexOf('\n') + 1));
    assert.equal(types.servers[0].declares, 'extensions');
    step(`declared under capabilities.extensions; delivery ${JSON.stringify(types.servers[0].eventTypes[0].delivery)}`);
    const r = await plugin.call('watch_event', { server: 'mastra', event: 'ticket.created', arguments: { project: 'web' }, note: 'interop' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /by push/);
    step('watch_event → push (events/stream on Mastra)');
    await sleep(1500);
    appendFileSync(upstream, JSON.stringify({ id: 't-1', project: 'web', title: 'Mastra says hi' }) + '\n');
    appendFileSync(upstream, JSON.stringify({ id: 't-2', project: 'api', title: 'Filtered out' }) + '\n');
    const line = await waitFor(() => monitor.lines.find((l) => l.includes('ticket.created')), 10000, 'Mastra event on the monitor');
    console.log('  monitor:', line.slice(0, 200));
    assert.match(line, /^\[mcp-events\] mastra · ticket\.created: id=t-1, project=web, title="Mastra says hi" \[event (e\d+), /);
    const id = /\[event (e\d+),/.exec(line)![1]!;
    const got = await plugin.call('get_event', { id });
    assert.match(got.text, /data from that server/);
    assert.match(got.text, /"title": "Mastra says hi"/);
    step('the event woke the monitor with a one-line summary; get_event returns the payload as the server\'s data');
    await sleep(1500);
    assert.equal(monitor.lines.filter((l) => l.includes('ticket.created')).length, 1);
    step("Mastra's match() filter applied server-side; one line reached Claude");
    const list = JSON.parse((await plugin.call('list_watches')).text);
    assert.equal(list[0].status, 'active');
    assert.equal(list[0].events, 1);
    const projects = join((w as { state: string }).state, 'projects');
    const saved = readdirSync(projects).map((d) => JSON.parse(readFileSync(join(projects, d, 'watches.json'), 'utf8')) as { watches: { cursor: string | null }[] });
    const cursor = saved.flatMap((x) => x.watches)[0]?.cursor;
    assert.ok(cursor, 'cursor saved');
    step(`watch active, one event counted, cursor saved (${cursor})`);
    console.log('INTEROP OK');
} finally {
    monitor.stop();
    await plugin.stop();
}
process.exit(0);
