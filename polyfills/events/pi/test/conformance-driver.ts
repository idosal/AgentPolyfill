// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`), for the
// Pi form. It mirrors ../../codex/test/conformance-driver.ts.
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
//              this extension names it (configureHost(PI)): the same EventsConnection and
//              WatchManager the extension runs, over a temporary state folder laid out as a Pi
//              session lays it out.
//   --pi       end to end: a real Pi 1.6.0 in RPC mode with the bundled extension
//              (extension/dist/index.js), its own agent folder whose mcp.json names the suite's
//              server, and the scripted model of brain.ts. The driver has the model call
//              list_event_types, then watch_event for each type listed, answers the extension's
//              question with yes, waits, and stops Pi as a person closing it would.
//
// `node test/conformance-driver.ts --suite [--pi]` runs the suite's four Events client scenarios
// from a checkout named in MCP_CONFORMANCE_SUITE_DIR (result files in MCP_CONFORMANCE_OUTPUT_DIR, if
// set). That checkout is code this repository does not hold: read it before you run it.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { configureHost } from '../../core/src/host.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { PI } from '../src/words.ts';
import { Pi } from './pi-rpc.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = join(ROOT, 'extension', 'dist', 'index.js');
const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const viaPi = process.argv.includes('--pi');

function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"${viaPi ? ' --pi' : ''}`;
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    let failed = 0;
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    say(`${viaPi ? 'Pi (end to end)' : 'core client'}: ${failed ? `${failed} of 4 scenarios did not pass` : 'all 4 scenarios passed'}`);
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
    say('usage: conformance-driver.ts [--pi] <server url> (the conformance suite appends it)');
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

const dir = mkdtempSync(join(tmpdir(), 'mcp-events-pi-conformance-'));
// Webhook: the stand-in is plain http on this machine, asks for no credentials and never delivers.
// The client subscribes by webhook only on an authenticated connection and only to an https address,
// so for this scenario alone its testing switch is on, and the "public" address is its own receiver.
const webhookEnv = async (): Promise<Record<string, string>> => {
    if (scenario !== 'events-client-webhook') return {};
    const port = await freePort();
    return { MCP_EVENTS_DEV: '1', MCP_EVENTS_RECEIVER_PORT: String(port), MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}` };
};

async function inProcess(): Promise<number> {
    configureHost(PI);
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_EVENTS_')));
    env.HOME = dir;
    env.PI_CODING_AGENT_DIR = join(dir, 'agent');
    env.MCP_EVENTS_RELAY_FILE = join(dir, 'no-relay.json');
    Object.assign(env, await webhookEnv());
    const conn = new EventsConnection('conformance', { url }, { preStandard: preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD)('conformance') });
    conn.log = say;
    const session = randomUUID();
    const base = join(dir, 'state');
    const spool = new Spool(base, session);
    // As the Pi form's PiSession sets a session up: the watches in watches/<id>/.
    const project = new ProjectState(base, `pi session ${session}`, { dir: join(base, 'watches', session) });
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

async function throughPi(): Promise<number> {
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { conformance: { url } } }, null, 2));
    const env: Record<string, string> = { HOME: join(dir, 'home'), MCP_EVENTS_RELAY_FILE: join(dir, 'no-relay.json'), MCP_EVENTS_STATE: join(dir, 'state'), ...(await webhookEnv()) };
    mkdirSync(env.HOME!, { recursive: true });
    // Only what a person would ask for: list the event types, then watch each, one prompt at a time.
    const rules = [
        { when: '^list$', call: { name: 'list_event_types', args: {} } },
        { when: '^watch (\\S+)$', call: { name: 'watch_event', args: { server: 'conformance', event: '$1', note: 'conformance run' } } }
    ];
    const pi = new Pi({ extensions: [EXTENSION], rules, agentDir, cwd: dir, env, answer: (r) => (r.method === 'confirm' ? true : undefined) });
    let code = 0;
    try {
        await pi.ready(60000);
        await pi.prompt('list', 30000);
        const listed = pi.toolResults('list_event_types').at(-1);
        if (!listed) throw new Error('list_event_types was not called');
        const types: string[] = [];
        try {
            const json = JSON.parse(listed.text.slice(listed.text.indexOf('\n') + 1)) as { servers: { server: string; declares?: string; eventTypes: { name: string; delivery: string[] }[] }[]; unavailable: unknown[] };
            say(`${scenario || 'no scenario named'}: list_event_types: ${JSON.stringify(json.servers.map((s) => ({ server: s.server, declares: s.declares, types: s.eventTypes.map((t) => `${t.name} [${t.delivery.join(',')}]`) })))}${json.unavailable.length ? `; unavailable ${JSON.stringify(json.unavailable)}` : ''}`);
            for (const s of json.servers) if (s.server === 'conformance') types.push(...s.eventTypes.map((t) => t.name));
        } catch {
            say(`list_event_types: ${listed.text.slice(0, 300)}`);
        }
        for (const t of types) {
            await pi.prompt(`watch ${t}`, 30000);
            const r = pi.toolResults('watch_event').at(-1);
            say(`watch_event ${JSON.stringify(t)}: ${r?.isError ? 'ERROR ' : ''}${(r?.text ?? 'not called').split('. New events')[0]}`);
        }
        const asked = pi.ui.filter((u) => u.method === 'confirm').length;
        say(`the extension asked ${asked} time(s) before watching`);
        await sleep(durationMs);
    } catch (e) {
        say(`failed: ${e instanceof Error ? e.message : String(e)}`);
        code = 1;
    } finally {
        // As a person closes Pi: the session shuts down, and the extension stops its watches.
        await pi.stop().catch(() => undefined);
        try {
            const log = readFileSync(join(dir, 'state', 'mcp-events.log'), 'utf8');
            for (const l of log.split('\n').filter(Boolean)) say(`extension log: ${l.replace(/^\S+ \[\d+\] /, '')}`);
        } catch {
            // no log
        }
    }
    return code;
}

let code = 1;
try {
    code = viaPi ? await throughPi() : await inProcess();
} finally {
    rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
