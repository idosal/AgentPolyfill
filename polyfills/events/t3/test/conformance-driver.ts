// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`), for the
// T3 Code form. It mirrors ../../pi/test/conformance-driver.ts and ../../codex/test/conformance-driver.ts.
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
//              this form names it (configureHost(T3_CODE)): the same EventsConnection and
//              WatchManager the watcher runs, over a temporary state folder laid out as the watcher
//              lays out a thread.
//   --t3       end to end: the server as Codex starts it for a T3 Code thread (src/server.ts, with
//              T3CODE_THREAD_ID set), a Codex home whose config.toml names the suite's server, and
//              the watcher it starts; the driver calls list_event_types, then watch_event for each
//              type listed, waits, and ends the server and the watcher. No agent and no sign-in.
//
// `node test/conformance-driver.ts --suite [--t3]` runs the suite's four Events client scenarios
// from a checkout named in MCP_CONFORMANCE_SUITE_DIR (result files in MCP_CONFORMANCE_OUTPUT_DIR, if
// set). That checkout is code this repository does not hold: read it before you run it.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { configureHost } from '../../core/src/host.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { folderOf } from '../src/threads.ts';
import { T3_CODE } from '../src/words.ts';
import { Server, SERVER, FAKE_T3 } from './harness.ts';

const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const viaT3 = process.argv.includes('--t3');

function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"${viaT3 ? ' --t3' : ''}`;
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    let failed = 0;
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    say(`${viaT3 ? 'T3 Code server and watcher (end to end)' : 'core client'}: ${failed ? `${failed} of 4 scenarios did not pass` : 'all 4 scenarios passed'}`);
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
    say('usage: conformance-driver.ts [--t3] <server url> (the conformance suite appends it)');
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

// A short folder, so the watcher's socket fits in the state folder.
const dir = mkdtempSync(join(process.platform === 'win32' ? process.env.TEMP ?? '.' : '/tmp', 'me3c-'));
// Webhook: the stand-in is plain http on this machine, asks for no credentials and never delivers.
// The client subscribes by webhook only on an authenticated connection and only to an https address,
// so for this scenario alone its testing switch is on, and the "public" address is its own receiver.
const webhookEnv = async (): Promise<Record<string, string>> => {
    if (scenario !== 'events-client-webhook') return {};
    const port = await freePort();
    return { MCP_EVENTS_DEV: '1', MCP_EVENTS_RECEIVER_PORT: String(port), MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}` };
};

async function inProcess(): Promise<number> {
    configureHost(T3_CODE);
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_EVENTS_')));
    env.HOME = dir;
    env.MCP_EVENTS_RELAY_FILE = join(dir, 'no-relay.json');
    Object.assign(env, await webhookEnv());
    const conn = new EventsConnection('conformance', { url }, { preStandard: preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD)('conformance') });
    conn.log = say;
    const thread = `mcp:${randomUUID()}`;
    const base = join(dir, 'state');
    const spool = new Spool(base, thread);
    // As the watcher's ThreadSession sets a thread up: the watches in threads/<thread>/.
    const project = new ProjectState(base, `t3 thread ${thread}`, { dir: join(base, 'threads', folderOf(thread)) });
    const manager = new WatchManager({ connections: new Map([[conn.name, conn]]), project, spool, session: thread, log: say, env });
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

async function throughT3(): Promise<number> {
    const codexHome = join(dir, 'codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.conformance]\nurl = ${JSON.stringify(url)}\n`);
    const state = join(dir, 'state');
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        CODEX_HOME: codexHome,
        T3CODE_THREAD_ID: `mcp:${randomUUID()}`,
        MCP_EVENTS_STATE: state,
        MCP_EVENTS_RELAY_FILE: join(dir, 'no-relay.json'),
        // Nothing is woken here; a wake goes to the stand-in, which only records it.
        MCP_EVENTS_T3_BIN: FAKE_T3,
        FAKE_T3_LOG: join(dir, 'sent.jsonl'),
        ...(await webhookEnv())
    };
    const s = new Server(env, SERVER);
    let code = 0;
    try {
        await s.initialize();
        const listed = await s.call('list_event_types');
        const types: string[] = [];
        try {
            const json = JSON.parse(listed.text.slice(listed.text.indexOf('\n') + 1)) as { servers: { server: string; declares?: string; eventTypes: { name: string; delivery: string[] }[] }[]; unavailable: unknown[] };
            say(`${scenario || 'no scenario named'}: list_event_types: ${JSON.stringify(json.servers.map((x) => ({ server: x.server, declares: x.declares, types: x.eventTypes.map((t) => `${t.name} [${t.delivery.join(',')}]`) })))}${json.unavailable.length ? `; unavailable ${JSON.stringify(json.unavailable)}` : ''}`);
            for (const x of json.servers) if (x.server === 'conformance') types.push(...x.eventTypes.map((t) => t.name));
        } catch {
            say(`list_event_types: ${listed.text.slice(0, 300)}`);
        }
        for (const t of types) {
            const r = await s.call('watch_event', { server: 'conformance', event: t, note: 'conformance run' });
            say(`watch_event ${JSON.stringify(t)}: ${r.isError ? 'ERROR ' : ''}${r.text.split('. New events')[0]}`);
        }
        await sleep(durationMs);
    } catch (e) {
        say(`failed: ${e instanceof Error ? e.message : String(e)}`);
        code = 1;
    } finally {
        // The agent's session ends, and then the watcher is stopped (as `server.js --stop` does).
        await s.stop().catch(() => undefined);
        spawnSync(process.execPath, ['--no-warnings', SERVER, '--stop'], { env, stdio: 'ignore' });
        await sleep(500);
        try {
            const log = readFileSync(join(state, 'mcp-events.log'), 'utf8');
            for (const l of log.split('\n').filter(Boolean)) say(`log: ${l.replace(/^\S+ /, '')}`);
        } catch {
            // no log
        }
    }
    return code;
}

let code = 1;
try {
    code = viaT3 ? await throughT3() : await inProcess();
} finally {
    rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
