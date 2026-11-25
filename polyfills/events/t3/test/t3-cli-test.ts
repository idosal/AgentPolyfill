// The wake against the real `t3` command, in a throwaway T3 Code home: what T3 Code
// answers when no server is running, and for a thread it doesn't know. It needs no agent
// and no sign-in. It runs when T3_CLI names T3 Code's `dist/bin.mjs` (CI installs the
// release the polyfill was tested with); otherwise it is skipped.
//
// No agent CLI of this machine's is ever found or run. When T3 Code starts, it checks the
// agent CLIs it finds on PATH (claude, codex, opencode and the others) by running them, and
// a throwaway HOME doesn't keep an agent from reaching what it keeps elsewhere (the macOS
// Keychain). So T3 Code gets a PATH of a folder of this test's own, holding only `node`,
// then /usr/bin and /bin. (Node's own folder is not on it: npm installs global commands,
// agent CLIs among them, beside `node`.) Afterwards the file fails if T3 Code reports any
// agent CLI installed, or if anything was written to the throwaway HOME. (On Linux, in CI, a
// ~/.local appeared with no agent CLI found, so the XDG folders are set to folders of the
// test's own outside HOME: an empty HOME still means nothing else wrote there.)
//
// The `t3` package is a launcher: on first use it downloads that version's T3 Code into
// T3CODE_HOME. That happens once, before the tests, and a failed download fails the file
// as what it is.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findT3, sendMessage } from '../src/waker.ts';
import { cleanup, temp, waitFor } from './harness.ts';

const cli = process.env.T3_CLI;
const skip = cli ? false : 'set T3_CLI to the t3 package\'s dist/bin.mjs to run this';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const home = temp();
const bin = join(home, 'bin');
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));
const xdg = join(home, 'xdg');
const env = {
    PATH: [bin, '/usr/bin', '/bin'].join(':'),
    HOME: join(home, 'home'),
    XDG_CONFIG_HOME: join(xdg, 'config'),
    XDG_DATA_HOME: join(xdg, 'data'),
    XDG_STATE_HOME: join(xdg, 'state'),
    XDG_CACHE_HOME: join(xdg, 'cache'),
    T3CODE_HOME: join(home, 't3'),
    T3CODE_TELEMETRY_ENABLED: 'false',
    T3CODE_NO_BROWSER: '1',
    MCP_EVENTS_T3_BIN: cli
};
mkdirSync(env.HOME, { recursive: true });

/** T3 Code's own record of each provider it checked, in T3CODE_HOME/caches. */
const providers = () => {
    const dir = join(env.T3CODE_HOME, 'caches');
    // Only whether it is installed: a record's other fields can name an account, and CI logs are public.
    const found: { file: string; installed: unknown }[] = [];
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        if (!f.endsWith('.json')) continue;
        try {
            const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { installed?: unknown };
            if (j && typeof j === 'object' && 'installed' in j) found.push({ file: f, installed: j.installed });
        } catch {
            // being written, or not a provider's record
        }
    }
    return found;
};

let server: ChildProcess | undefined;
/** Ends T3 Code and everything it started (its process group), and waits until none of it is left. */
async function stopServer() {
    if (!server?.pid) return;
    const group = -server.pid;
    const alive = () => {
        try {
            process.kill(group, 0);
            return true;
        } catch {
            return false;
        }
    };
    const signal = (s: NodeJS.Signals) => {
        try {
            process.kill(group, s);
        } catch {
            // already gone
        }
    };
    signal('SIGTERM');
    const end = Date.now() + 10000;
    while (alive() && Date.now() < end) await sleep(100);
    signal('SIGKILL');
    const killed = Date.now() + 10000;
    while (alive() && Date.now() < killed) await sleep(100);
    if (alive()) throw new Error(`T3 Code's processes (group ${server.pid}) were still there 10 s after SIGKILL`);
    server = undefined;
}

before(
    () => {
        if (!cli) return;
        const r = spawnSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8', timeout: 540000, killSignal: 'SIGKILL' });
        if (r.status !== 0) {
            const said = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-3).join(' / ');
            throw new Error(`could not get T3 Code itself: the t3 package downloads it from T3 Code's GitHub release on first use, and that failed (${r.error ? r.error.message : `exit ${r.status ?? r.signal}`}: ${said}). This is not a failure of the polyfill.`);
        }
    },
    { timeout: 600000 }
);

after(async () => {
    try {
        if (cli) {
            // T3 Code checks its providers when it starts; let it finish before judging what it found.
            if (server) await waitFor(() => providers().length >= 2, 30000, 'T3 Code to record which agent CLIs it found').catch(() => undefined);
            await stopServer();
            const seen = providers().filter((p) => p.installed !== false);
            assert.deepEqual(seen, [], `T3 Code found an agent CLI on the test's PATH: ${JSON.stringify(seen)}`);
            assert.deepEqual(readdirSync(env.HOME, { recursive: true }), [], 'something wrote to the throwaway HOME (an agent CLI ran?)');
        }
    } finally {
        try {
            await stopServer();
        } finally {
            cleanup();
        }
    }
});

test('with no T3 Code server running, the wake is "tried again later"', { skip }, async () => {
    const t3 = findT3(env)!;
    assert.ok(t3, 'T3_CLI is found');
    const r = await sendMessage(t3, 'mcp:00000000-0000-4000-8000-000000000000', 'hello', env);
    assert.ok(!r.ok && !r.unreachable && !r.maybe, JSON.stringify(r));
    assert.match(!r.ok ? r.why : '', /T3 Code is not running/);
});

test('with T3 Code running, a thread it does not know is "not tried again"', { skip, timeout: 120000 }, async () => {
    const t3 = findT3(env)!;
    // Its own process group, so that the end of the file can end all of it.
    server = spawn(process.execPath, [cli!, 'serve', '--port', '37999', '--host', '127.0.0.1'], { env, stdio: 'ignore', detached: true });
    let r = await sendMessage(t3, 'mcp:00000000-0000-4000-8000-000000000000', 'hello', env);
    await waitFor(
        async () => {
            r = await sendMessage(t3, 'mcp:00000000-0000-4000-8000-000000000000', 'hello', env);
            return !r.ok && r.unreachable === true;
        },
        90000,
        'T3 Code to answer that the thread is unknown'
    );
    assert.match(!r.ok ? r.why : '', /does not know this thread/);
});
