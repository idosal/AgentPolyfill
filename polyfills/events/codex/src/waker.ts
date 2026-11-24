// Waking a Codex session: `codex queue --thread <id> --message … --resume`.
//
// `codex queue` puts the message in the thread's queue. A thread that is loaded and
// idle (open in the TUI, which keeps it in the app-server daemon) starts a turn with
// it at once; a busy one when its turn ends. `--resume` loads a thread the daemon
// has unloaded, so the message runs there; with no daemon, the message waits in the
// queue until the session is next resumed. The command is run with no
// configuration overrides: with any, Codex would queue through a server of its own
// instead of the daemon.
//
// It is run with no shell anywhere. On Windows that means a real program: `codex.exe`, or,
// for Codex installed with npm, Node running the package's own `bin/codex.js`. Never npm's
// `codex.cmd` shim, nor any .cmd or .bat: those run through cmd.exe, which parses the
// arguments (a model-written note among them) a second time.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * `unreachable`: `codex queue` can never reach this session (a ChatGPT desktop-app chat, which is not a
 * local Codex session): no later try will either, so the session is not tried again.
 */
export type QueueResult = { ok: true; resumed: boolean } | { ok: false; why: string; permanent?: true; unreachable?: true };

/** Why a session that is not a local Codex session cannot be woken. */
export const NOT_LOCAL = "this chat can't be woken: it isn't a local Codex session (a ChatGPT desktop-app chat, say), which is all codex queue reaches";
export type Wake = (thread: string, text: string) => Promise<QueueResult>;
/** What to run for `codex`: a program, and any arguments that come before Codex's own. */
export type CodexCommand = { command: string; args: string[] };

/** A Codex session id: a UUID, as Codex makes them. Nothing else is passed to `codex queue`. */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const executable = (p: string, platform: NodeJS.Platform) => {
    try {
        if (!statSync(p).isFile()) return false;
        if (platform !== 'win32') accessSync(p, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};
const isFile = (p: string) => {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
};

/** Why nothing can wake a session, when no `codex` was found that may be run. */
export function codexNotFound(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
        ? 'no codex.exe, nor an npm install of Codex (its node_modules\\@openai\\codex\\bin\\codex.js), was found to run `codex queue` with; npm\'s codex.cmd is never run through cmd.exe. Set MCP_EVENTS_CODEX_BIN to the full path of codex.exe'
        : 'no `codex` command was found to run `codex queue` with (set MCP_EVENTS_CODEX_BIN to its full path)';
}

/**
 * The `codex` to run: MCP_EVENTS_CODEX_BIN if set, else the first on PATH, else where Codex's
 * installers put it. On Windows only codex.exe, or Node with npm's codex.js; nothing else.
 */
export function findCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexCommand | undefined {
    if (platform === 'win32') return findOnWindows(env);
    const plain = (p: string): CodexCommand => ({ command: p, args: [] });
    if (env.MCP_EVENTS_CODEX_BIN) return isAbsolute(env.MCP_EVENTS_CODEX_BIN) && executable(env.MCP_EVENTS_CODEX_BIN, platform) ? plain(env.MCP_EVENTS_CODEX_BIN) : undefined;
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (executable(join(dir, 'codex'), platform)) return plain(join(dir, 'codex'));
    const home = env.HOME || homedir();
    const known = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(home, '.local', 'bin', 'codex'), join(home, '.npm-global', 'bin', 'codex'), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'];
    const found = known.find((p) => executable(p, platform));
    return found ? plain(found) : undefined;
}

function findOnWindows(env: NodeJS.ProcessEnv): CodexCommand | undefined {
    // npm puts codex.cmd beside node_modules\@openai\codex: the script it would start, run by Node itself.
    const npmScript = (dir: string) => join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const viaNode = (script: string): CodexCommand => ({ command: process.execPath, args: [script] });
    const bin = env.MCP_EVENTS_CODEX_BIN;
    if (bin) {
        if (!isAbsolute(bin)) return undefined;
        if (/\.exe$/i.test(bin)) return isFile(bin) ? { command: bin, args: [] } : undefined;
        if (/\.js$/i.test(bin)) return isFile(bin) ? viaNode(bin) : undefined;
        return undefined; // a .cmd, a .bat, or anything else that would need cmd.exe
    }
    const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])];
    for (const dir of dirs) {
        if (isFile(join(dir, 'codex.exe'))) return { command: join(dir, 'codex.exe'), args: [] };
        if (isFile(join(dir, 'codex.cmd')) && isFile(npmScript(dir))) return viaNode(npmScript(dir));
    }
    return undefined;
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

/** Runs `codex queue` once. `bin` is what findCodex gave (or, in tests, a program's path). */
export function queueMessage(bin: CodexCommand | string, thread: string, text: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 60000): Promise<QueueResult> {
    if (!THREAD_ID.test(thread)) return Promise.resolve({ ok: false, why: 'not a Codex session id', permanent: true });
    const codex = typeof bin === 'string' ? { command: bin, args: [] } : bin;
    // Never anything cmd.exe would run, whoever asks.
    if (/\.(cmd|bat)$/i.test(codex.command)) return Promise.resolve({ ok: false, why: 'a .cmd or .bat is never run (it would go through cmd.exe)', permanent: true });
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
        // `--message=…` keeps the text one argument whatever it starts with. No shell is involved, on
        // any platform: the program is started directly with its arguments as a list.
        const args = [...codex.args, 'queue', ...(remote ? [`--remote=${remote}`] : []), '--thread', thread, `--message=${text}`, '--resume'];
        const child = spawn(codex.command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
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
            // Codex keeps no local rollout for a ChatGPT desktop-app chat: queueing to it always fails.
            if (/no rollout found/i.test(err)) return finish({ ok: false, why: NOT_LOCAL, permanent: true, unreachable: true });
            if (/no (active )?session found|thread\b[^\n]*\bnot found/i.test(err)) return finish({ ok: false, why: 'Codex does not know this session any more', permanent: true });
            // Codex's own words are not repeated: only that it refused, and how.
            finish({ ok: false, why: `codex queue failed (exit ${code ?? 'signal'})` });
        });
    });
}
