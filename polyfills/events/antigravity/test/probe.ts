// A local external-server/conformance driver through the committed bundle and real hooks.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { config, invocation, newThread, sleep, startHelper, untilActive, waitFor, world } from './harness.ts';

const value = (flag: string) => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const url = new URL(process.argv.at(-1)!);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('The probe accepts only an HTTP server on 127.0.0.1.');
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const w = world();
const headers = value('--headers') ? JSON.parse(value('--headers')!) : {};
config(w.dir, { external: { serverUrl: url.href, headers } });
const env: Record<string, string> = { MCP_EVENTS_PRE_STANDARD: 'off', MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_DEV: '0' };
if (scenario === 'events-client-webhook' || process.argv.includes('--webhook')) {
    const port = await new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    Object.assign(env, { MCP_EVENTS_DEV: '1', MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_EVENTS_RECEIVER_PORT: String(port) });
}
const h = await startHelper(w, env), id = newThread();
const watches: string[] = [];
try {
    const listed = await h.call('list_event_types', {}, id); assert.equal(listed.isError, false, listed.text);
    const catalog = JSON.parse(listed.text.slice(listed.text.indexOf('{')));
    console.log(listed.text);
    if (scenario === 'events-client-no-extension') assert.equal(catalog.servers.length, 0);
    for (const server of catalog.servers) for (const type of server.eventTypes) {
        if (value('--event') && type.name !== value('--event')) continue;
        const r = await h.call('watch_event', { server: server.server, event: type.name, arguments: JSON.parse(value('--arguments') ?? '{}'), note: 'Local interop probe' }, id);
        assert.equal(r.isError, false, r.text); watches.push(/as (w-[0-9a-f]{6})/.exec(r.text)![1]!);
        console.log(r.text);
    }
    if (!scenario && !watches.length) throw new Error('No matching event type to watch.');
    if (watches.length) await untilActive(h, id);
    if (process.argv.includes('--expect-event')) {
        console.log('Waiting for the other server to emit an event (60 seconds).');
        await waitFor(() => w.queued().some(q => /new event/.test(q.summary)), 60000, 'external event, agentapi wake and PreInvocation injection');
        console.log(w.queued().map(q => q.summary).join('\n'));
        assert.match((await h.call('get_event', { id: 'e1' }, id)).text, /data from that server/);
    } else {
        const context = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}');
        await sleep(typeof context.durationMs === 'number' && context.durationMs > 0 ? Math.min(context.durationMs, 60000) : 5000);
    }
    console.log((await h.call('list_watches', {}, id)).text);
    console.log(JSON.stringify(invocation(w.dir, { conversationId: id })));
    for (const watch of watches) await h.call('unwatch_event', { watch }, id);
} finally { await h.stop(); rmSync(w.dir, { recursive: true, force: true }); }
