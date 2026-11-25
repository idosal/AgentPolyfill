// The wake against the real `t3` command, in a throwaway T3 Code home: what T3 Code
// answers when no server is running, and for a thread it doesn't know. It needs no agent
// and no sign-in. It runs when T3_CLI names T3 Code's `dist/bin.mjs` (CI installs the
// release the polyfill was tested with); otherwise it is skipped.

import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findT3, sendMessage } from '../src/waker.ts';
import { cleanup, temp, waitFor } from './harness.ts';

const cli = process.env.T3_CLI;
const skip = cli ? false : 'set T3_CLI to the t3 package\'s dist/bin.mjs to run this';

const home = temp();
const env = { PATH: process.env.PATH, HOME: join(home, 'home'), T3CODE_HOME: join(home, 't3'), T3CODE_TELEMETRY_ENABLED: 'false', T3CODE_NO_BROWSER: '1', MCP_EVENTS_T3_BIN: cli };
mkdirSync(env.HOME, { recursive: true });
let server: ChildProcess | undefined;
after(async () => {
    server?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    cleanup();
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
    server = spawn(process.execPath, [cli!, 'serve', '--port', '37999', '--host', '127.0.0.1'], { env, stdio: 'ignore' });
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
