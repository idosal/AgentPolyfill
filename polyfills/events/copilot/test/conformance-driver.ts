// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`), for the
// Copilot form. It mirrors ../../codex/test/conformance-driver.ts --helper: end to end, the bundled
// extension (plugin/extensions/mcp-events/extension.mjs) started as Copilot starts it, with a
// throwaway COPILOT_HOME whose mcp-config.json names the suite's server and the stand-in session of
// test/harness.ts. The driver calls list_event_types and watch_event as the model would, waits, and
// ends the extension with SIGTERM as Copilot does.
//
// The suite plays the events server. It appends its address as the last argument and sets
//   MCP_CONFORMANCE_SCENARIO          which scenario is running
//   MCP_CONFORMANCE_CONTEXT           JSON; `durationMs` is how long to keep the subscriptions up
//
// `node test/conformance-driver.ts --suite` runs the suite's four Events client scenarios from a
// checkout named in MCP_CONFORMANCE_SUITE_DIR (result files in MCP_CONFORMANCE_OUTPUT_DIR, if set).
// That checkout is code this repository does not hold: read it before you run it.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSession, sleep, startExtension, world } from './harness.ts';

const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);

function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"`;
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    let failed = 0;
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    say(`extension (end to end): ${failed ? `${failed} of 4 scenarios did not pass` : 'all 4 scenarios passed'}`);
    return failed ? 1 : 0;
}
if (process.argv[2] === '--suite') process.exit(suite());

const url = process.argv.at(-1) ?? '';
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
let durationMs = 5000;
try {
    const d = (JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}') as { durationMs?: unknown }).durationMs;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) durationMs = d;
} catch {
    // no context: the default stands
}
if (!/^https?:\/\//.test(url)) {
    say('usage: conformance-driver.ts <server url> (the conformance suite appends it)');
    process.exit(2);
}

const freePort = () =>
    new Promise<number>((done, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as { port: number };
            s.close(() => done(port));
        });
    });

const w = world();
writeFileSync(join(w.copilotHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { conformance: { type: 'http', url } } }));
// Webhook: the stand-in is plain http on this machine, asks for no credentials and never delivers.
// The client subscribes by webhook only on an authenticated connection and only to an https address,
// so for this scenario alone its testing switch is on, and the "public" address is its own receiver.
const extra: Record<string, string> = { FAKE_COPILOT_CONFIGURED: JSON.stringify([{ name: 'conformance', enabled: true, source: 'user' }]), MCP_EVENTS_RELAY_FILE: join(w.dir, 'no-relay.json'), MCP_EVENTS_DEV: '' };
if (scenario === 'events-client-webhook') {
    const port = await freePort();
    Object.assign(extra, { MCP_EVENTS_DEV: '1', MCP_EVENTS_RECEIVER_PORT: String(port), MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}` });
}
let code = 0;
const e = await startExtension(w, newSession(), extra);
try {
    const listed = await e.call('list_event_types');
    const json = JSON.parse(listed.text.slice(listed.text.indexOf('\n') + 1)) as { servers: { server: string; declares?: string; eventTypes: { name: string; delivery: string[] }[] }[]; unavailable: unknown[] };
    say(`${scenario || 'no scenario named'}: list_event_types: ${JSON.stringify(json.servers.map((s) => ({ server: s.server, declares: s.declares, types: s.eventTypes.map((t) => `${t.name} [${t.delivery.join(',')}]`) })))}${json.unavailable.length ? `; unavailable ${JSON.stringify(json.unavailable)}` : ''}`);
    for (const s of json.servers) {
        for (const t of s.eventTypes) {
            const r = await e.call('watch_event', { server: s.server, event: t.name, note: 'conformance run' });
            say(`watch_event ${JSON.stringify(t.name)}: ${r.isError ? 'ERROR ' : ''}${r.text.split('. New events')[0]}`);
        }
    }
    await sleep(durationMs);
    say(`list_watches at the end: ${(await e.call('list_watches')).text.split('\n\n')[0]}`);
} catch (err) {
    say(`failed: ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
} finally {
    const exit = await e.stop();
    if (exit !== 0) say(`extension exited with ${exit}${e.stderr ? `: ${e.stderr.slice(0, 500)}` : ''}`);
    try {
        for (const l of readFileSync(join(w.state, 'mcp-events.log'), 'utf8').split('\n').filter(Boolean)) say(`extension log: ${l.replace(/^\S+ \[\d+\] /, '')}`);
    } catch {
        // no log
    }
    rmSync(w.dir, { recursive: true, force: true });
}
process.exit(code);
