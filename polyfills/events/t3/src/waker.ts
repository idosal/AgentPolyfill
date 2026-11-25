// Waking a T3 Code thread: `t3 thread send <thread> -`, the message on standard input.
//
// That is T3 Code's own command for messaging a thread from the machine that runs it
// (docs/user/outside-agents.md, "Scripts on the host"). It needs no sign-in there,
// and it never interrupts: an idle thread starts a turn with the message, a busy one
// gets it as its next turn. The turn runs in the thread's own permission mode, and
// T3 Code starts the thread's agent session again if it had closed it.
//
// The command is run with no shell anywhere, and the message never goes on the
// command line: it is read from standard input (`-`). On Windows only a real
// program is run (`t3.exe`, or Node with the package's own `dist/bin.mjs`), never a
// .cmd or .bat shim, which would go through cmd.exe.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * `maybe`: it may have sent the message all the same (it timed out), so it counts as handed over.
 * `unreachable`: no later try can reach this thread (T3 Code says there is no such thread).
 */
export type SendResult = { ok: true } | { ok: false; why: string; unreachable?: true; maybe?: true };
export type Wake = (thread: string, text: string) => Promise<SendResult>;
export type T3Command = { command: string; args: string[] };

/**
 * A T3 Code thread id as T3 Code makes them (a UUID, or `mcp:<uuid>` for a thread an outside
 * agent or `t3 thread start` made). Nothing else is passed to `t3 thread send`, and nothing that
 * could be read as a flag.
 */
export const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

const executable = (p: string, platform: NodeJS.Platform) => {
    try {
        if (!statSync(p).isFile()) return false;
        if (platform !== 'win32') accessSync(p, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

export function t3NotFound(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
        ? 'no t3.exe was found to run `t3 thread send` with (a t3.cmd is never run through cmd.exe). Set MCP_EVENTS_T3_BIN to the full path of t3.exe, or of the t3 package\'s dist/bin.mjs'
        : 'no `t3` command was found to run `t3 thread send` with. Install it (T3 Code\'s "Install" docs: curl -fsSL https://t3.codes/install.sh | sh), or set MCP_EVENTS_T3_BIN to its full path';
}

/**
 * The `t3` to run: MCP_EVENTS_T3_BIN if set, else the first on PATH, else where T3 Code's installer
 * puts it (~/.local/bin, T3 Code's apps/server/src/cli/install.ts).
 */
export function findT3(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): T3Command | undefined {
    const bin = env.MCP_EVENTS_T3_BIN?.trim();
    if (bin) {
        if (!isAbsolute(bin)) return undefined;
        // The package's own entry point, run by this Node: what `npx t3` runs.
        if (/\.m?js$/i.test(bin)) return statSync(bin, { throwIfNoEntry: false })?.isFile() ? { command: process.execPath, args: [bin] } : undefined;
        if (/\.(cmd|bat)$/i.test(bin)) return undefined;
        return executable(bin, platform) ? { command: bin, args: [] } : undefined;
    }
    const name = platform === 'win32' ? 't3.exe' : 't3';
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (executable(join(dir, name), platform)) return { command: join(dir, name), args: [] };
    if (platform === 'win32') return undefined;
    const home = env.HOME || homedir();
    const installed = join(home, '.local', 'bin', 't3');
    return executable(installed, platform) ? { command: installed, args: [] } : undefined;
}

const MAX_OUTPUT = 64 * 1024;

/** Runs `t3 thread send` once. */
export function sendMessage(t3: T3Command, thread: string, text: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 60000): Promise<SendResult> {
    if (!THREAD_ID.test(thread)) return Promise.resolve({ ok: false, why: 'not a T3 Code thread id', unreachable: true });
    if (/\.(cmd|bat)$/i.test(t3.command)) return Promise.resolve({ ok: false, why: 'a .cmd or .bat is never run (it would go through cmd.exe)', unreachable: true });
    // This polyfill's own settings are not T3 Code's business.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.startsWith('MCP_EVENTS_'))) as NodeJS.ProcessEnv;
    return new Promise((done) => {
        let out = '';
        let err = '';
        let settled = false;
        const finish = (r: SendResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            done(r);
        };
        const args = [...t3.args, 'thread', 'send', '--json', thread, '-'];
        const child = spawn(t3.command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ ok: false, why: `t3 thread send did not finish within ${timeoutMs / 1000} s`, maybe: true });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-MAX_OUTPUT)));
        child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-MAX_OUTPUT)));
        child.on('error', (e) => finish({ ok: false, why: `t3 could not be run (${(e as NodeJS.ErrnoException).code ?? 'error'})` }));
        child.stdin?.on('error', () => {
            // it ended before reading: its exit says why
        });
        child.stdin?.end(text);
        child.on('close', (code) => {
            const said = `${out}\n${err}`;
            if (code === 0) return finish({ ok: true });
            // T3 Code's own words are not repeated: only what they mean for waking.
            if (/No running T3 Code server/i.test(said)) return finish({ ok: false, why: 'T3 Code is not running (no running T3 Code server uses its data folder); tried again later' });
            if (/Could not reach the T3 Code server/i.test(said)) return finish({ ok: false, why: 'the T3 Code server did not answer; tried again later' });
            if (/thread[^\n]*(not found|does not exist|unknown)|no (such )?thread/i.test(said)) return finish({ ok: false, why: 'T3 Code does not know this thread any more', unreachable: true });
            finish({ ok: false, why: `t3 thread send failed (exit ${code ?? 'signal'})` });
        });
    });
}
