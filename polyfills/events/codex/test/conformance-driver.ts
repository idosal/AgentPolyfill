// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`), for the
// Codex form. It mirrors ../../claude-code/test/conformance-driver.ts.
//
// The suite plays the events server. It appends its address as the last argument and sets
//   MCP_CONFORMANCE_SCENARIO          which scenario is running
//   MCP_CONFORMANCE_CONTEXT           JSON; `durationMs` is how long to keep the subscriptions up
//   MCP_CONFORMANCE_PROTOCOL_VERSION  the revision the stand-in server speaks
//
// Two ways to be the client, both doing only what the scenarios ask (connect, list the event types
// if the server declared Events, watch every one in the mode the client itself picks, wait, stop):
//
//   (default)  the shared client (polyfills/events/core) in this process, named to the server as
//              this plugin names it (configureHost(CODEX)): the same EventsConnection and
//              WatchManager the helper runs, over a temporary state folder.
//   --helper   end to end: the bundled helper (plugin/dist/helper.js) started as Codex starts it,
//              an MCP server over stdio, with a throwaway CODEX_HOME whose config.toml names the
//              suite's server, and a stand-in `codex` (test/fake-codex.mjs) for `codex queue`. The
//              driver calls list_event_types and watch_event as Codex would, each call carrying a
//              session id in `_meta`, waits, and closes the helper's stdin as Codex does.
//
// `node test/conformance-driver.ts --suite [--helper]` runs the suite's four Events client scenarios
// from a checkout named in MCP_CONFORMANCE_SUITE_DIR (result files in MCP_CONFORMANCE_OUTPUT_DIR, if
// set). That checkout is code this repository does not hold: read it before you run it.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { configureHost } from '../../core/src/host.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { CODEX } from '../src/words.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'plugin', 'dist', 'helper.js');
const FAKE_CODEX = join(ROOT, 'test', 'fake-codex.mjs');
const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const viaHelper = process.argv.includes('--helper');

function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"${viaHelper ? ' --helper' : ''}`;
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    let failed = 0;
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    say(`${viaHelper ? 'helper (end to end)' : 'core client'}: ${failed ? `${failed} of 4 scenarios did not pass` : 'all 4 scenarios passed'}`);
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
    say('usage: conformance-driver.ts [--helper] <server url> (the conformance suite appends it)');
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

const dir = mkdtempSync(join(tmpdir(), 'mcp-events-codex-conformance-'));
// Webhook: the stand-in is plain http on this machine, asks for no credentials and never delivers.
// The client subscribes by webhook only on an authenticated connection and only to an https address,
// so for this scenario alone its testing switch is on, and the "public" address is its own receiver.
const webhookEnv = async (): Promise<Record<string, string>> => {
    if (scenario !== 'events-client-webhook') return {};
    const port = await freePort();
    return { MCP_EVENTS_DEV: '1', MCP_EVENTS_RECEIVER_PORT: String(port), MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}` };
};

async function inProcess(): Promise<number> {
    configureHost(CODEX);
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_EVENTS_')));
    env.HOME = dir;
    env.CODEX_HOME = join(dir, 'codex-home');
    env.MCP_EVENTS_RELAY_FILE = join(dir, 'no-relay.json');
    Object.assign(env, await webhookEnv());
    const conn = new EventsConnection('conformance', { url }, { preStandard: preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD)('conformance') });
    conn.log = say;
    const session = randomUUID();
    const base = join(dir, 'state');
    const spool = new Spool(base, session);
    // As the Codex form's ThreadSession sets a session up: the watches in threads/<id>/.
    const project = new ProjectState(base, `codex thread ${session}`, { dir: join(base, 'threads', session) });
    const manager = new WatchManager({ connections: new Map([[conn.name, conn]]), project, spool, session, log: say, env });
    let code = 0;
    try {
        await conn.connect(15000);
        say(`${scenario || 'no scenario named'}: connected on revision ${conn.revision}; Events ${conn.declaration ? 'declared' : 'not declared'}`);
        const types = await conn.list();
        manager.start();
        for (const t of types) {
            try {
                const w = await manager.add({ server: conn.name, event: t.name });
                say(`watching ${JSON.stringify(t.name)} by ${w.mode} (the server lists ${t.delivery.join(', ')})`);
            } catch (e) {
                say(`could not watch ${JSON.stringify(t.name)}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        await sleep(durationMs);
        for (const w of manager.watches) say(`at the end: ${JSON.stringify(w.event)} ${w.mode} ${w.status}, cursor ${JSON.stringify(w.cursor)}, ${w.events} event(s)${w.error ? `, ${w.error}` : ''}`);
    } catch (e) {
        say(`failed: ${e instanceof Error ? e.message : String(e)}`);
        code = 1;
    } finally {
        await manager.stop().catch(() => undefined);
        await conn.close().catch(() => undefined);
    }
    return code;
}

async function throughHelper(): Promise<number> {
    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.conformance]\nurl = ${JSON.stringify(url)}\n`);
    const queueLog = join(dir, 'queue.jsonl');
    // Only what Codex passes a plugin's server, and the settings under test.
    const env: Record<string, string> = Object.fromEntries(
        Object.entries({ PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR, CODEX_HOME: codexHome, MCP_EVENTS_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_LOG: queueLog, MCP_EVENTS_RELAY_FILE: join(dir, 'no-relay.json'), ...(await webhookEnv()) }).filter((e): e is [string, string] => typeof e[1] === 'string')
    );
    const child = spawn(process.execPath, [HELPER], { cwd: join(ROOT, 'plugin'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    const waiting = new Map<number, (m: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
        try {
            const m = JSON.parse(line) as Record<string, unknown>;
            if (typeof m.id === 'number') waiting.get(m.id)?.(m);
        } catch {
            // not a message
        }
    });
    let id = 0;
    const request = (method: string, params: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((done, fail) => {
            const n = ++id;
            const t = setTimeout(() => fail(new Error(`${method}: no answer`)), 25000);
            waiting.set(n, (m) => {
                clearTimeout(t);
                waiting.delete(n);
                done(m);
            });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
        });
    const thread = randomUUID();
    const call = async (name: string, args: Record<string, unknown>) => {
        const r = await request('tools/call', { name, arguments: args, _meta: { threadId: thread, 'x-codex-turn-metadata': { session_id: thread, thread_id: thread, turn_id: randomUUID(), turn_trigger: 'user', thread_source: 'user' } } });
        const res = r.result as { content: { text: string }[]; isError?: boolean } | undefined;
        if (!res) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
        return { text: res.content.map((c) => c.text).join(''), isError: res.isError === true };
    };
    let code = 0;
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const listed = await call('list_event_types', {});
        const json = JSON.parse(listed.text.slice(listed.text.indexOf('\n') + 1)) as { servers: { server: string; declares?: string; eventTypes: { name: string; delivery: string[] }[] }[]; unavailable: unknown[] };
        say(`${scenario || 'no scenario named'}: list_event_types: ${JSON.stringify(json.servers.map((s) => ({ server: s.server, declares: s.declares, types: s.eventTypes.map((t) => `${t.name} [${t.delivery.join(',')}]`) })))}${json.unavailable.length ? `; unavailable ${JSON.stringify(json.unavailable)}` : ''}`);
        for (const s of json.servers) {
            for (const t of s.eventTypes) {
                const r = await call('watch_event', { server: s.server, event: t.name, note: 'conformance run' });
                say(`watch_event ${JSON.stringify(t.name)}: ${r.isError ? 'ERROR ' : ''}${r.text.split('. New events')[0]}`);
            }
        }
        await sleep(durationMs);
        say(`list_watches at the end: ${(await call('list_watches', {})).text.split('\n\n')[0]}`);
    } catch (e) {
        say(`failed: ${e instanceof Error ? e.message : String(e)}`);
        code = 1;
    } finally {
        // As Codex closes a session: stdin ends, and the helper stops by itself.
        child.stdin.end();
        const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
        const exit = await exited;
        clearTimeout(kill);
        if (exit !== 0) say(`helper exited with ${exit}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`);
        try {
            const log = readFileSync(join(codexHome, 'mcp-events', 'mcp-events.log'), 'utf8');
            for (const l of log.split('\n').filter(Boolean)) say(`helper log: ${l.replace(/^\S+ \[\d+\] /, '')}`);
        } catch {
            // no log
        }
    }
    return code;
}

let code = 1;
try {
    code = viaHelper ? await throughHelper() : await inProcess();
} finally {
    rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
