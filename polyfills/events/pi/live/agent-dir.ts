// The Pi agent folder a live run uses: a throwaway one made for live runs, never
// your own. A live run needs a folder you signed in to, so it can't make the
// folder for you and sign in. Instead:
//
//   node live/run.ts --new-agent-dir <path>       makes an empty folder, marked as one for live runs
//   PI_CODING_AGENT_DIR=<path> pi                 then /login in that Pi, and quit it
//   PI_LIVE_AGENT_DIR=<path> … node live/run.ts   the run itself
//
// A run refuses a folder without the mark, and Pi's own folder (~/.pi/agent)
// whatever it holds. It never reads the folder's credentials: Pi does, to call
// the model. It writes mcp.json only where there is none, or where the one there
// is the one a live run left (its SHA-256 is in the mark), and prints only the
// names and addresses of the servers in it, never header or env values.
// When you're done: `PI_CODING_AGENT_DIR=<path> pi auth logout <provider>`, then
// delete the folder.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MARK = '.agentpolyfill-live-run.json';
type Mark = { purpose: string; mcpJsonSha256?: string };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const realOrSelf = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));

/** Pi's own agent folder, the one a person signs in to: never used by a live run. */
const personal = () => realOrSelf(join(homedir(), '.pi', 'agent'));

/** Makes a new, empty agent folder marked for live runs, and says how to sign in to it. */
export function newAgentDir(path: string): never {
    const dir = resolve(path);
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and isn't empty: give a new folder`);
    if (realOrSelf(dir) === personal()) throw new Error(`${dir} is Pi's own agent folder: give another`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, MARK), JSON.stringify({ purpose: 'A throwaway Pi agent folder for AgentPolyfill live runs.' } satisfies Mark, null, 2) + '\n', { mode: 0o600 });
    console.log(`Made ${dir}. Sign in to it, then quit that Pi:\n\n  PI_CODING_AGENT_DIR=${dir} pi\n  /login\n\nThen run with PI_LIVE_AGENT_DIR=${dir}. When you're done: PI_CODING_AGENT_DIR=${dir} pi auth logout <provider>, and delete the folder.`);
    process.exit(0);
}

/** The folder in PI_LIVE_AGENT_DIR, if it is a marked throwaway one; else the run stops. */
export function liveAgentDir(path: string | undefined): string {
    if (process.argv[2] === '--new-agent-dir') newAgentDir(process.argv[3] ?? '');
    if (!path) throw new Error('set PI_LIVE_AGENT_DIR to a folder made with --new-agent-dir (see live/agent-dir.ts)');
    const dir = realOrSelf(path);
    if (dir === personal()) throw new Error(`${dir} is Pi's own agent folder; a live run uses a throwaway one (--new-agent-dir)`);
    if (!existsSync(join(dir, MARK))) throw new Error(`${dir} isn't marked as a folder for live runs; make one with --new-agent-dir`);
    return dir;
}

const mark = (dir: string): Mark => JSON.parse(readFileSync(join(dir, MARK), 'utf8')) as Mark;
const saveMark = (dir: string, m: Mark) => writeFileSync(join(dir, MARK), JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });

/** Writes the run's mcp.json, unless the folder holds one a live run didn't leave. */
export function writeMcpJson(dir: string, config: unknown): void {
    const file = join(dir, 'mcp.json');
    const m = mark(dir);
    if (existsSync(file) && sha256(readFileSync(file, 'utf8')) !== m.mcpJsonSha256) throw new Error(`${file} wasn't left by a live run, so it isn't overwritten`);
    const text = JSON.stringify(config, null, 2);
    writeFileSync(file, text, { mode: 0o600 });
    saveMark(dir, { ...m, mcpJsonSha256: sha256(text) });
}

/**
 * The servers in the run's mcp.json after the run (it may have added one), by name and address
 * only, and that file kept as the one this run left.
 */
export function mcpServersAfter(dir: string): string {
    const file = join(dir, 'mcp.json');
    if (!existsSync(file)) return '(no mcp.json)';
    const text = readFileSync(file, 'utf8');
    saveMark(dir, { ...mark(dir), mcpJsonSha256: sha256(text) });
    let servers: Record<string, { url?: unknown; command?: unknown }> = {};
    try {
        servers = (JSON.parse(text) as { mcpServers?: typeof servers }).mcpServers ?? {};
    } catch {
        return '(mcp.json is not JSON)';
    }
    // An address without what could be a credential in it: no user, password or query.
    const where = (u: string) => (URL.canParse(u) ? `${new URL(u).origin}${new URL(u).pathname}` : '(not a URL)');
    const lines = Object.entries(servers).map(([name, s]) => `${name}: ${typeof s.url === 'string' ? where(s.url) : typeof s.command === 'string' ? 'a local command' : '(no url or command)'}`);
    return lines.length ? lines.join('\n') : '(no servers)';
}
