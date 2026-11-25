// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`), for the Hermes
// form. It mirrors ../../codex/test/conformance-driver.ts --helper.
//
// The suite plays the events server. It appends its address as the last argument and sets
//   MCP_CONFORMANCE_SCENARIO          which scenario is running
//   MCP_CONFORMANCE_CONTEXT           JSON; `durationMs` is how long to keep the subscriptions up
//
// The client is the bundled helper (plugin/dist/helper.mjs), started as the plugin starts it and
// spoken to over its stdin/stdout as the plugin speaks to it (tools/hermes/shared/_helper.py):
// `initialize` with the suite's server, then list_event_types and watch_event for every event type,
// as the model would, each call naming a Hermes session; every wake is answered "taken". It waits,
// lists the watches, and closes the helper's stdin, as the plugin does when the gateway stops.
//
// `node test/conformance-driver.ts --suite` runs the suite's four Events client scenarios from a
// checkout named in MCP_CONFORMANCE_SUITE_DIR (modelcontextprotocol/conformance#541, which has
// them). That checkout is code this repository does not hold: read it before you run it. The
// webhook scenario is expected not to pass: in Hermes, webhook delivery is Hermes's own
// (`events: true`), and this form never subscribes by webhook.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'plugin', 'dist', 'helper.mjs');
const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCENARIOS = ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook'];

function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"`;
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    const failed: string[] = [];
    // The suite is someone else's code, and it passes its environment on to the client it starts:
    // it gets the system's basics and a throwaway HOME, not this shell's environment or home.
    const home = mkdtempSync(join(tmpdir(), 'events-conformance-home-'));
    const env: NodeJS.ProcessEnv = { HOME: home };
    for (const k of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'TZ']) if (process.env[k]) env[k] = process.env[k];
    try {
        for (const scenario of SCENARIOS) {
            const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit', env });
            if (r.status !== 0) failed.push(scenario);
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
    say(failed.length ? `did not pass: ${failed.join(', ')}` : 'all 4 scenarios passed');
    return failed.filter((s) => s !== 'events-client-webhook').length ? 1 : 0;
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

const dir = mkdtempSync(join(tmpdir(), 'mcp-events-hermes-conformance-'));
const state = join(dir, 'state');
const child = spawn(process.execPath, [HELPER], { env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: process.env.TMPDIR ?? '', MCP_EVENTS_BATCH_MS: '200' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
const waiting = new Map<number, (m: Record<string, unknown>) => void>();
let wakes = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
    let m: Record<string, unknown>;
    try {
        m = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return;
    }
    if (m.method === 'wake') {
        wakes++;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } }) + '\n');
        return;
    }
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
});
let id = 0;
const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((done, fail) => {
        const n = ++id;
        const t = setTimeout(() => fail(new Error(`${method}: no answer`)), 25000);
        waiting.set(n, (m) => {
            clearTimeout(t);
            waiting.delete(n);
            if (m.error) fail(new Error(JSON.stringify(m.error)));
            else done((m.result ?? {}) as Record<string, unknown>);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
const session = `conformance:${scenario}`;
const call = async (name: string, args: Record<string, unknown>) => (await request('call', { name, arguments: args, session })) as { text: string; isError: boolean };

let code = 0;
try {
    await request('initialize', { state, servers: { conformance: { url } }, skipped: {} });
    const listed = await call('list_event_types', {});
    const json = JSON.parse(listed.text.slice(listed.text.indexOf('{'))) as { servers: { server: string; declares?: string; eventTypes: { name: string; delivery: string[] }[] }[] };
    say(`${scenario || 'no scenario named'}: list_event_types: ${JSON.stringify(json.servers.map((s) => ({ server: s.server, declares: s.declares, types: s.eventTypes.map((t) => `${t.name} [${t.delivery.join(',')}]`) })))}`);
    for (const s of json.servers) {
        for (const t of s.eventTypes) {
            const r = await call('watch_event', { server: s.server, event: t.name, note: 'conformance run' });
            say(`watch_event ${JSON.stringify(t.name)}: ${r.isError ? 'ERROR ' : ''}${r.text.split('. New events')[0]}`);
        }
    }
    await sleep(durationMs);
    say(`list_watches at the end: ${(await call('list_watches', {})).text.split('\n\n')[0]}; ${wakes} wake(s) asked of the plugin`);
} catch (e) {
    say(`failed: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
} finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
    const exit = await exited;
    clearTimeout(kill);
    if (exit !== 0) say(`helper exited with ${exit}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`);
    try {
        for (const l of readFileSync(join(state, 'mcp-events.log'), 'utf8').split('\n').filter(Boolean)) say(`helper log: ${l.replace(/^\S+ \[\d+\] /, '')}`);
    } catch {
        // no log
    }
    rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
