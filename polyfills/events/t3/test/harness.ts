// Runs the server the way Codex in a T3 Code thread does (an MCP server over stdio, with
// T3CODE_THREAD_ID in its environment), against the fixture events server of the Claude
// Code form (written by hand from SEP-3415, sharing no code with the client), with a
// stand-in `t3` that records what `t3 thread send` would have delivered.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SERVER = join(ROOT, 'src', 'server.ts');
export const BUNDLE = join(ROOT, 'plugin', 'dist', 'server.js');
export const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');
export const FAKE_T3 = join(ROOT, 'test', 'fake-t3.mjs');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every folder a test made, removed by cleanup() when its file's tests end. */
const made: string[] = [];
/** A folder in the temporary directory (TMPDIR). Where its path is too long for a socket, the watcher puts the socket in a private folder of its own there. */
export const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'me3-'));
    made.push(dir);
    return dir;
};
export function cleanup(): void {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
/** A thread id as T3 Code makes one for a thread started by `t3 thread start`. */
export const newThread = () => `mcp:${randomUUID()}`;

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

const toml = (v: string) => JSON.stringify(v);

export type Sent = { thread: string; message: string; args: string[]; leaked: string[]; pid: number };

/** A test world: a Codex home whose config.toml names the fixture server, a state folder, and the stand-in t3. */
export function world(fixtureEnv: Record<string, string> = {}, extraToml = '') {
    const dir = temp();
    const codexHome = join(dir, 'codex');
    mkdirSync(codexHome);
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    const sendLog = join(dir, 'sent.jsonl');
    const mode = join(dir, 't3-mode');
    writeFileSync(mode, 'ok');
    chmodSync(FAKE_T3, 0o755);
    const env = { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv };
    writeFileSync(
        join(codexHome, 'config.toml'),
        [`[mcp_servers.tickets]`, `command = ${toml(process.execPath)}`, `args = ["--no-warnings", ${toml(FIXTURE)}]`, '', `[mcp_servers.tickets.env]`, ...Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`), '', extraToml].join('\n')
    );
    let n = 0;
    return {
        dir,
        codexHome,
        state: join(dir, 'state'),
        mode,
        emit(eventName: string, data: Record<string, unknown>, eventId = `evt_${++n}_${Date.now()}`) {
            appendFileSync(upstream, JSON.stringify({ eventId, name: eventName, timestamp: new Date().toISOString(), data }) + '\n');
            return eventId;
        },
        /** What `t3 thread send` was asked to deliver, in order. */
        sent(): Sent[] {
            if (!existsSync(sendLog)) return [];
            return readFileSync(sendLog, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { args: string[]; stdin: string; leaked: string[]; pid: number })
                .map((r) => ({ args: r.args, leaked: r.leaked, pid: r.pid, thread: r.args[r.args.length - 2]!, message: r.stdin }));
        },
        fixtureMethods(): string[] {
            if (!existsSync(fixtureLog)) return [];
            return readFileSync(fixtureLog, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { dir: string; m: { method?: string } })
                .filter((r) => r.dir === 'in' && r.m.method)
                .map((r) => r.m.method!);
        },
        /** The environment Codex gives a server it starts for a T3 Code thread, plus the settings under test. */
        env(thread: string | undefined, extra: Record<string, string | undefined> = {}): Record<string, string> {
            return Object.fromEntries(
                Object.entries({
                    PATH: process.env.PATH,
                    HOME: dir,
                    TMPDIR: process.env.TMPDIR,
                    CODEX_HOME: codexHome,
                    T3CODE_THREAD_ID: thread,
                    MCP_EVENTS_STATE: join(dir, 'state'),
                    MCP_EVENTS_T3_BIN: FAKE_T3,
                    FAKE_T3_LOG: sendLog,
                    FAKE_T3_MODE: mode,
                    MCP_EVENTS_BATCH_MS: '200',
                    // No gap between two wakes of one watch, unless a test sets one.
                    MCP_EVENTS_WAKE_GAP_S: '0',
                    MCP_EVENTS_DEV: '1',
                    ...extra
                }).filter((e): e is [string, string] => e[1] !== undefined)
            );
        }
    };
}
export type World = ReturnType<typeof world>;

type Json = Record<string, unknown>;

/** The server, as Codex sees it: an MCP server on the other end of a pipe. */
export class Server {
    readonly child: ChildProcess;
    readonly exited: Promise<number | null>;
    stderr = '';
    #id = 0;
    #waiting = new Map<number, (m: Json) => void>();

    constructor(env: Record<string, string>, entry = SERVER, args: string[] = []) {
        this.child = spawn(process.execPath, [...(entry.endsWith('.ts') ? ['--no-warnings'] : []), entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr!.on('data', (d) => (this.stderr += d));
        this.exited = new Promise((r) => this.child.on('close', (code) => r(code)));
        createInterface({ input: this.child.stdout! }).on('line', (line) => {
            try {
                const m = JSON.parse(line) as Json;
                if (typeof m.id === 'number') this.#waiting.get(m.id)?.(m);
            } catch {
                // not ours
            }
        });
    }

    request(method: string, params: Json = {}, timeoutMs = 30000): Promise<Json> {
        const id = ++this.#id;
        return new Promise((done, fail) => {
            const t = setTimeout(() => fail(new Error(`${method}: no answer`)), timeoutMs);
            this.#waiting.set(id, (m) => {
                clearTimeout(t);
                this.#waiting.delete(id);
                done(m);
            });
            this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    async initialize(): Promise<Json> {
        const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } });
        this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        return r;
    }

    async tools(): Promise<string[]> {
        const r = await this.request('tools/list');
        return ((r.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
    }

    async call(name: string, args: Json = {}): Promise<{ text: string; isError: boolean }> {
        const r = await this.request('tools/call', { name, arguments: args, _meta: { threadId: randomUUID() } }, 60000);
        const result = r.result as { content: { text: string }[]; isError: boolean };
        return { text: result.content.map((c) => c.text).join(''), isError: result.isError };
    }

    async stop(): Promise<number | null> {
        this.child.stdin!.end();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 10000);
        const code = await this.exited;
        clearTimeout(timer);
        return code;
    }
}

/** Every server started, so a failed test leaves none running. */
export const started: Server[] = [];

export async function startServer(w: World, thread: string | undefined, extra: Record<string, string | undefined> = {}, entry = SERVER): Promise<Server> {
    const s = new Server(w.env(thread, extra), entry);
    started.push(s);
    await s.initialize();
    return s;
}

/** Runs `server --stop` in the world, ending its watcher. */
export function stopWatcher(w: World, entry = SERVER): Promise<string> {
    return new Promise((done) => {
        const c = spawn(process.execPath, [...(entry.endsWith('.ts') ? ['--no-warnings'] : []), entry, '--stop'], { env: w.env(undefined), stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        c.stdout!.on('data', (d) => (out += d));
        c.on('close', () => done(out));
    });
}

/** The watcher's pid, from its answer at the socket, or undefined. */
export function watcherLog(w: World): string {
    const p = join(w.state, 'mcp-events.log');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Until every watch of the thread is active (the server confirmed the subscription). */
export async function untilActive(s: Server, timeoutMs = 15000): Promise<void> {
    await waitFor(
        async () => {
            const list = JSON.parse((await s.call('list_watches')).text.split('\n\n')[0]!) as { status: string }[];
            return list.length > 0 && list.every((x) => x.status === 'active');
        },
        timeoutMs,
        'the watch to be active'
    );
}
