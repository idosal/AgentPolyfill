// Interop run: the plugin and the relay against the demo "deploys" server, whose MCP
// Events support is Mastra's (webhook delivery, endpoint verification and signing are
// all Mastra's code). The relay runs in the local Workers runtime.
//
//   node --no-warnings test/interop/deploys.ts
//   DEPLOYS_RELAY=public node --no-warnings test/interop/deploys.ts     through the deployed public relay
//                                                                        (MCP_EVENTS_RELAY=public) instead of a local one
//
// It prints one line per check and exits non-zero on the first failure.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { startRelay } from '../../mod/relay/test/harness.ts';
import { ROOT, sleep, startMonitor, startPlugin, waitFor, world } from '../harness.ts';

const ACCESS = 'interop-access-key-012345';
const TOKEN = 'interop-deploys-token';
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as { port: number }).port;
            s.close(() => resolve(p));
        });
    });
const ok = (s: string) => console.log(`✓ ${s}`);

const usePublic = process.env.DEPLOYS_RELAY === 'public';
const relay = usePublic ? undefined : await startRelay({ ACCESS_KEY: ACCESS });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
let serverErr = '';
const server = spawn(process.execPath, ['--no-warnings', join(ROOT, 'demo', 'server.ts')], {
    env: { ...process.env, PORT: String(port), DEPLOYS_TOKEN: TOKEN, DEPLOYS_DELIVERY: process.env.DEPLOYS_DELIVERY ?? 'webhook', ...(usePublic ? {} : { DEPLOYS_ALLOW_LOCAL: '1' }) },
    stdio: ['ignore', 'ignore', 'pipe']
});
server.stderr.on('data', (d) => (serverErr += d));
const deploy = (service: string, fail: boolean) => fetch(`${origin}/api/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, fail }) });

const w = world();
const config = join(w.dir, 'deploys.json');
writeFileSync(config, JSON.stringify({ mcpServers: { deploys: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
const env = relay ? { MCP_EVENTS_CONFIG: config, MCP_EVENTS_RELAY_URL: relay.origin, MCP_EVENTS_RELAY_ACCESS_KEY: ACCESS } : { MCP_EVENTS_CONFIG: config, MCP_EVENTS_RELAY: 'public' };
let plugin: Awaited<ReturnType<typeof startPlugin>> | undefined;
let monitor: ReturnType<typeof startMonitor> | undefined;
let failed = false;
try {
    await waitFor(() => serverErr.includes('MCP at'), 15000, 'the deploys server to start');
    plugin = await startPlugin(w, 'sess-a', env);
    monitor = startMonitor(w, 'sess-a');
    const mode = process.env.DEPLOYS_DELIVERY ?? 'webhook';
    assert.match(plugin.instructions(), /- deploys \/ deploy\.finished \(/, plugin.instructions());
    ok(`the Mastra server's event type is listed: ${/- deploys \/ deploy\.finished \([^)]*\)/.exec(plugin.instructions())?.[0]}`);

    const r = await plugin.call('watch_event', { server: 'deploys', event: 'deploy.finished', arguments: { status: 'failed' }, note: 'Find out why it failed.' });
    assert.equal(r.isError, false, r.text);
    ok(`watch_event → ${/by [^.]+?(?=, from now on)/.exec(r.text)?.[0] ?? r.text.slice(0, 120)}`);
    if (mode === 'webhook') assert.match(r.text, usePublic ? /through the public relay run by/ : /through your relay/);
    await waitFor(async () => JSON.parse((await plugin!.call('list_watches')).text)[0]?.status === 'active' || undefined, 15000, 'the watch to become active (Mastra verified the address)').catch(async (e) => {
        throw new Error(`${e.message}: ${(await plugin!.call('list_watches')).text}`);
    });
    ok('the watch is active: Mastra accepted the subscription' + (mode === 'webhook' ? ' after its verification handshake reached the plugin through the relay' : ''));

    await deploy('web', false); // succeeds: the watch asked for failures only
    await deploy('api', true);
    const line = await waitFor(() => monitor!.lines.find((l) => l.includes('deploy.finished')), 20000, 'the failed deploy to reach the monitor');
    assert.match(line, /service=api/);
    assert.match(line, /status=failed/);
    ok(`an idle session is woken: ${line.slice(0, 150)}`);
    await sleep(1500);
    assert.equal(monitor.lines.filter((l) => l.includes('service=web')).length, 0, "Mastra's match() kept the successful deploy out");
    ok("Mastra's match() filter applied: the successful web deploy did not arrive");

    // Claude Code closes; the server keeps running and keeps delivering.
    monitor.stop();
    await plugin.stop();
    plugin = undefined;
    await sleep(500);
    await deploy('worker', true);
    await sleep(2600);
    await deploy('web', true);
    await sleep(3500);
    plugin = await startPlugin(w, 'sess-b', env);
    monitor = startMonitor(w, 'sess-b');
    await waitFor(() => monitor!.lines.filter((l) => l.includes('deploy.finished')).length >= 2 || undefined, 20000, 'the two deploys that failed while closed').catch((e) => {
        throw new Error(`${e.message}; monitor has: ${JSON.stringify(monitor!.lines)}`);
    });
    await sleep(1500);
    const held = monitor.lines.filter((l) => l.includes('deploy.finished'));
    assert.equal(held.filter((l) => l.includes('service=worker')).length, 1);
    assert.equal(held.filter((l) => l.includes('service=web')).length, 1);
    assert.equal(held.filter((l) => l.includes('service=api')).length, 0, 'the one already seen is not shown again');
    ok(`reopened: the two deploys that failed while Claude Code was closed arrive once each (${mode === 'webhook' ? 'held by the relay' : 'replayed by the server'})`);
    console.log('INTEROP OK');
} catch (e) {
    failed = true;
    console.error(`✗ ${(e as Error).message}`);
    if (serverErr) console.error(`--- deploys server stderr ---\n${serverErr.slice(-1500)}`);
} finally {
    monitor?.stop();
    await plugin?.stop().catch(() => {});
    server.kill();
    await relay?.stop();
}
process.exit(failed ? 1 : 0);
