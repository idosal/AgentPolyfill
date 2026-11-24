// Interop run: a server that refuses callers without credentials, reached over real
// Streamable HTTP with credentials that come only from a `headersHelper` (a command of the
// user's that prints the headers to send). The server is the demo "deploys" server, whose
// MCP Events support is Mastra's; delivery is push (events/stream), so no relay is involved.
//
//   node --no-warnings test/interop/sign-in.ts
//
// It prints one line per check and exits non-zero on the first failure.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ROOT, sleep, startMonitor, startPlugin, waitFor, world } from '../harness.ts';

const TOKEN = 'interop-helper-token';
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as { port: number }).port;
            s.close(() => resolve(p));
        });
    });
const ok = (s: string) => console.log(`✓ ${s}`);

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
let serverErr = '';
const server = spawn(process.execPath, ['--no-warnings', join(ROOT, 'demo', 'server.ts')], { env: { ...process.env, PORT: String(port), DEPLOYS_TOKEN: TOKEN, DEPLOYS_DELIVERY: 'push,poll' }, stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.on('data', (d) => (serverErr += d));
const deploy = (service: string, fail: boolean) => fetch(`${origin}/api/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, fail }) });

// The helper reads the token from a file of the user's and prints the header; it also notes each run.
const w = world();
const tokenFile = join(w.dir, 'token');
const runs = join(w.dir, 'helper-runs');
writeFileSync(tokenFile, TOKEN);
const helper = join(w.dir, 'print-headers.mjs');
writeFileSync(
    helper,
    `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(runs)}, process.env.CLAUDE_CODE_MCP_SERVER_NAME + ' ' + process.env.CLAUDE_CODE_MCP_SERVER_URL + '\\n');
console.log(JSON.stringify({ Authorization: 'Bearer ' + readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim() }));
`
);
const withHelper = join(w.dir, 'with-helper.json');
writeFileSync(withHelper, JSON.stringify({ mcpServers: { deploys: { type: 'http', url: `${origin}/mcp`, headersHelper: `"${process.execPath}" "${helper}"` } } }));
const without = join(w.dir, 'without.json');
writeFileSync(without, JSON.stringify({ mcpServers: { deploys: { type: 'http', url: `${origin}/mcp` } } }));

let plugin: Awaited<ReturnType<typeof startPlugin>> | undefined;
let monitor: ReturnType<typeof startMonitor> | undefined;
let failed = false;
try {
    await waitFor(() => serverErr.includes('MCP at'), 15000, 'the deploys server to start');

    // With no credentials the server refuses, and the mod says what it needs, in its own words.
    plugin = await startPlugin(w, 'sess-none', { MCP_EVENTS_CONFIG: without });
    const listed = (await plugin.call('list_event_types')).text;
    assert.match(listed, /it needs a sign-in this mod cannot do/, listed);
    assert.ok(!plugin.instructions().includes('deploy.finished'));
    ok('with no credentials the server refuses (401), and the mod says it needs a header or a headersHelper');
    await plugin.stop();

    plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_CONFIG: withHelper });
    monitor = startMonitor(w, 'sess-a');
    assert.match(plugin.instructions(), /- deploys \/ deploy\.finished \(/, plugin.instructions());
    assert.ok(existsSync(runs));
    assert.equal(readFileSync(runs, 'utf8').split('\n')[0], `deploys ${origin}/mcp`);
    ok(`the headersHelper ran, told which server it was for, and its header let the mod in: ${/- deploys \/ deploy\.finished \([^)]*\)/.exec(plugin.instructions())?.[0]}`);

    const r = await plugin.call('watch_event', { server: 'deploys', event: 'deploy.finished', arguments: { status: 'failed' }, note: 'Find out why it failed.' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /by push/);
    await waitFor(async () => JSON.parse((await plugin!.call('list_watches')).text)[0]?.status === 'active' || undefined, 15000, 'the watch to become active');
    ok('watch_event → push: events/stream is open over Streamable HTTP, authenticated by the helper\'s header');

    await deploy('web', false);
    await deploy('api', true);
    const line = await waitFor(() => monitor!.lines.find((l) => l.includes('deploy.finished')), 20000, 'the failed deploy');
    assert.match(line, /service=api/);
    ok(`an event arrives: ${line.slice(0, 140)}`);
    await sleep(1000);
    assert.equal(monitor.lines.filter((l) => l.includes('service=web')).length, 0);

    // Nothing the helper printed is written down by the mod.
    const state = readFileSync(join(w.state, 'mcp-events.log'), 'utf8');
    assert.ok(!state.includes(TOKEN), 'the token is not in the log');
    ok('the token the helper printed is in no file of the mod\'s');
    console.log('INTEROP OK');
} catch (e) {
    failed = true;
    console.error(`✗ ${(e as Error).message}`);
    if (serverErr) console.error(`--- deploys server stderr ---\n${serverErr.slice(-1500)}`);
} finally {
    monitor?.stop();
    await plugin?.stop().catch(() => {});
    server.kill();
}
process.exit(failed ? 1 : 0);
