// The entry point the upstream conformance suite starts for a client under test
// (modelcontextprotocol/conformance, `client --command "<this>" --scenario <name>`).
//
// The suite plays the events server. It appends its address as the last argument and sets
//   MCP_CONFORMANCE_SCENARIO          which scenario is running
//   MCP_CONFORMANCE_CONTEXT           JSON; `durationMs` is how long to keep the subscriptions up
//   MCP_CONFORMANCE_PROTOCOL_VERSION  the revision the stand-in server speaks
//
// This does what the scenarios ask of a client and nothing else: connect, list the event types if
// the server declared Events, watch every one in the mode the client itself would pick, wait, stop.
// It is the same `EventsConnection` and `WatchManager` the mod's helper runs, on a state folder
// made for the run and removed after it. Nothing here changes what the client sends.
//
// `npm run conformance` (this file with `--suite`) runs the suite's four Events client scenarios
// against it, from a checkout of the suite named in MCP_CONFORMANCE_SUITE_DIR (and keeps the suite's
// result files in MCP_CONFORMANCE_OUTPUT_DIR, if that is set). That checkout is code this
// repository does not hold: read it before you run it.
//
// See docs/conformance.md ("The upstream conformance suite") for how to run it and what it showed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventsConnection, preStandardPolicy } from '../src/events-client.ts';
import { ProjectState, Spool } from '../src/store.ts';
import { WatchManager } from '../src/watcher.ts';

const say = (s: string) => process.stderr.write(`[driver] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the suite's Events client scenarios against this file, one after another, with the suite's
 * own folder as the working directory. The scenarios are extension scenarios, which the suite
 * leaves out when a spec version is named unless it is told `--force`.
 */
function suite(): number {
    const dir = process.env.MCP_CONFORMANCE_SUITE_DIR ?? '';
    const cli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!dir || !existsSync(join(dir, 'src', 'scenarios', 'client', 'events')) || !existsSync(cli)) {
        say('set MCP_CONFORMANCE_SUITE_DIR to a checkout of modelcontextprotocol/conformance that has the Events client scenarios (src/scenarios/client/events) and its dependencies installed');
        return 2;
    }
    const command = `"${process.execPath}" --no-warnings "${fileURLToPath(import.meta.url)}"`;
    // MCP_CONFORMANCE_OUTPUT_DIR: where the suite keeps each scenario's checks and this client's output.
    const keep = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    let failed = 0;
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [cli, 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...keep], { cwd: dir, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    say(failed ? `${failed} of 4 scenarios did not pass` : 'all 4 scenarios passed');
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

/** A port nothing listens on, for the webhook receiver. */
const freePort = () =>
    new Promise<number>((done, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as { port: number };
            s.close(() => done(port));
        });
    });

const dir = mkdtempSync(join(tmpdir(), 'mcp-events-conformance-'));
// The run's own settings, whatever this machine has: none of the user's MCP_EVENTS_* variables,
// and a home folder of its own, so no relay of theirs (~/.mcp-events/relay.json) is read or used.
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_EVENTS_')));
env.HOME = dir;
env.MCP_EVENTS_RELAY_FILE = join(dir, 'no-relay.json');
if (scenario === 'events-client-webhook') {
    // The stand-in server is plain http on this machine and asks for no credentials, and it never
    // delivers to the callback. The client subscribes by webhook only on an authenticated connection
    // and only to an https address, so for this scenario alone its testing switch is on, and the
    // "public" address is its own local receiver.
    const port = await freePort();
    env.MCP_EVENTS_DEV = '1';
    env.MCP_EVENTS_RECEIVER_PORT = String(port);
    env.MCP_EVENTS_PUBLIC_URL = `http://127.0.0.1:${port}`;
}

// Set up as the helper sets a connection up when the user has configured nothing: the form from
// before the standard is allowed (the suite's stand-in servers do not use it).
const conn = new EventsConnection('conformance', { url }, { preStandard: preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD)('conformance') });
conn.log = say;
const session = 'conformance';
const spool = new Spool(join(dir, 'state'), session);
const manager = new WatchManager({ connections: new Map([[conn.name, conn]]), project: new ProjectState(join(dir, 'state'), join(dir, 'project')), spool, session, log: say, env });

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
    for (const r of spool.all()) if (r.kind === 'notice') say(`notice: ${r.text}`);
} catch (e) {
    say(`failed: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
} finally {
    await manager.stop().catch(() => undefined);
    await conn.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
