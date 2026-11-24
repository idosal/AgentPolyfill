// Waking a Codex session: `codex queue --thread <id> --message … --resume`.
//
// `codex queue` puts the message in the thread's queue. A thread that is loaded and
// idle (open in the TUI, which keeps it in the app-server daemon) starts a turn with
// it at once; a busy one when its turn ends. `--resume` loads a thread the daemon
// has unloaded, so the message runs there; with no daemon, the message waits in the
// queue until the session is next resumed. The command is run with no
// configuration overrides: with any, Codex would queue through a server of its own
// instead of the daemon.

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import spawn from 'cross-spawn';

export type QueueResult = { ok: true; resumed: boolean } | { ok: false; why: string; permanent?: true };
export type Wake = (thread: string, text: string) => Promise<QueueResult>;

/** A Codex session id: a UUID, as Codex makes them. Nothing else is passed to `codex queue`. */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const executable = (p: string) => {
    try {
        if (!statSync(p).isFile()) return false;
        if (process.platform !== 'win32') accessSync(p, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/**
 * The `codex` to run: MCP_EVENTS_CODEX_BIN if set, else the first on PATH, else where Codex's
 * installers put it.
 */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.MCP_EVENTS_CODEX_BIN) return isAbsolute(env.MCP_EVENTS_CODEX_BIN) && executable(env.MCP_EVENTS_CODEX_BIN) ? env.MCP_EVENTS_CODEX_BIN : undefined;
    const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        for (const n of names) if (executable(join(dir, n))) return join(dir, n);
    }
    const home = env.HOME || homedir();
    const known =
        process.platform === 'win32'
            ? [join(env.APPDATA ?? '', 'npm', 'codex.cmd')]
            : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(home, '.local', 'bin', 'codex'), join(home, '.npm-global', 'bin', 'codex'), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'];
    return known.find(executable);
}

const MAX_OUTPUT = 64 * 1024;

/**
 * The app server `codex queue` should use, when Codex runs against one of its own (`codex --remote
 * <addr>`): MCP_EVENTS_CODEX_REMOTE, in the forms `--remote` takes. Unset: the local daemon.
 */
export function remoteOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const v = env.MCP_EVENTS_CODEX_REMOTE?.trim();
    return v && /^(wss?:\/\/[^\s]+|unix:\/\/[^\s]*)$/.test(v) ? v : undefined;
}

/** Runs `codex queue` once. */
export function queueMessage(bin: string, thread: string, text: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 60000): Promise<QueueResult> {
    if (!THREAD_ID.test(thread)) return Promise.resolve({ ok: false, why: 'not a Codex session id', permanent: true });
    const remote = remoteOf(env);
    // The plugin's own settings are not Codex's business.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.startsWith('MCP_EVENTS_'))) as NodeJS.ProcessEnv;
    return new Promise((done) => {
        let out = '';
        let err = '';
        let settled = false;
        const finish = (r: QueueResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            done(r);
        };
        // `--message=…` keeps the text one argument whatever it starts with; no shell is involved
        // (cross-spawn only quotes for cmd.exe on Windows, where a .cmd shim needs it).
        const args = ['queue', ...(remote ? [`--remote=${remote}`] : []), '--thread', thread, `--message=${text}`, '--resume'];
        const child = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ ok: false, why: `codex queue did not finish within ${timeoutMs / 1000} s` });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-MAX_OUTPUT)));
        child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-MAX_OUTPUT)));
        child.on('error', (e) => finish({ ok: false, why: `codex could not be run (${(e as NodeJS.ErrnoException).code ?? 'error'})`, permanent: true }));
        child.on('close', (code) => {
            if (code === 0 && /Queued message/i.test(out)) return finish({ ok: true, resumed: !/could not resume/i.test(err) });
            if (/unrecognized subcommand|unexpected argument/i.test(err)) return finish({ ok: false, why: 'this Codex has no `codex queue --resume` (Codex 0.170 or newer has it)', permanent: true });
            if (/no (active )?session found|thread\b[^\n]*\bnot found/i.test(err)) return finish({ ok: false, why: 'Codex does not know this session any more', permanent: true });
            // Codex's own words are not repeated: only that it refused, and how.
            finish({ ok: false, why: `codex queue failed (exit ${code ?? 'signal'})` });
        });
    });
}
