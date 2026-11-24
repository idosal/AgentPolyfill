// Runs the helper the way Codex does (an MCP server over stdio, each tools/call carrying the
// session's id in `_meta`), against the fixture events server of the Claude Code form (a server
// written by hand from SEP-3415, sharing no code with the client), with a stand-in `codex` that
// records what `codex queue` would have been told.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HELPER = join(ROOT, 'src', 'helper.ts');
export const PLUGIN = join(ROOT, 'plugin');
export const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');
export const FAKE_CODEX = join(ROOT, 'test', 'fake-codex.mjs');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const temp = (prefix = 'mcp-events-codex-') => mkdtempSync(join(tmpdir(), prefix));
export const newThread = () => randomUUID();

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

/** A test world: a Codex home whose config.toml names the fixture server, a state folder, and the stand-in codex. */
export function world(fixtureEnv: Record<string, string> = {}, o: { serverName?: string; extraToml?: string } = {}) {
    const dir = temp();
    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome);
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    const queueLog = join(dir, 'queue.jsonl');
    const mode = join(dir, 'codex-mode');
    writeFileSync(mode, 'ok');
    chmodSync(FAKE_CODEX, 0o755);
    const env = { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv };
    const name = o.serverName ?? 'tickets';
    writeFileSync(
        join(codexHome, 'config.toml'),
        [`model = "not-used"`, '', `[mcp_servers.${name}]`, `command = ${toml(process.execPath)}`, `args = ["--no-warnings", ${toml(FIXTURE)}]`, '', `[mcp_servers.${name}.env]`, ...Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`), '', o.extraToml ?? ''].join('\n')
    );
    let n = 0;
    return {
        dir,
        codexHome,
        upstream,
        fixtureLog,
        state: join(dir, 'state'),
        mode,
        emit(eventName: string, data: Record<string, unknown>, eventId = `evt_${++n}_${Date.now()}`) {
            appendFileSync(upstream, JSON.stringify({ eventId, name: eventName, timestamp: new Date().toISOString(), data }) + '\n');
            return eventId;
        },
        /** What `codex queue` was asked to do, in order. */
        queued(): { thread: string; message: string; args: string[]; leaked: string[]; remote?: string; pid: number }[] {
            if (!existsSync(queueLog)) return [];
            return readFileSync(queueLog, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { args: string[]; leaked: string[]; pid: number })
                .map((r) => ({ args: r.args, leaked: r.leaked, pid: r.pid, thread: r.args[r.args.indexOf('--thread') + 1]!, message: (r.args.find((a) => a.startsWith('--message=')) ?? '').slice('--message='.length), remote: r.args.find((a) => a.startsWith('--remote='))?.slice('--remote='.length) }));
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
        env(extra: Record<string, string | undefined> = {}): Record<string, string> {
            return Object.fromEntries(
                Object.entries({
                    // Only what Codex passes a plugin's server, and the settings under test.
                    PATH: process.env.PATH,
                    HOME: dir,
                    TMPDIR: process.env.TMPDIR,
                    CODEX_HOME: codexHome,
                    MCP_EVENTS_STATE: join(dir, 'state'),
                    MCP_EVENTS_CODEX_BIN: FAKE_CODEX,
                    FAKE_CODEX_LOG: queueLog,
                    FAKE_CODEX_MODE: mode,
                    MCP_EVENTS_BATCH_MS: '200',
                    MCP_EVENTS_DEV: '1',
                    ...extra
                }).filter((e): e is [string, string] => e[1] !== undefined)
            );
        }
    };
}
export type World = ReturnType<typeof world>;

type Json = Record<string, unknown>;

/** The helper, as Codex sees it: an MCP server on the other end of a pipe. */
export class Helper {
    readonly child: ChildProcess;
    readonly exited: Promise<number | null>;
    stderr = '';
    #id = 0;
    #waiting = new Map<number, (m: Json) => void>();

    constructor(env: Record<string, string>, entry = HELPER) {
        const args = entry.endsWith('.ts') ? ['--no-warnings', entry] : [entry];
        this.child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

    send(line: string): void {
        this.child.stdin!.write(line + '\n');
    }

    async initialize(): Promise<Json> {
        const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'codex-mcp-client', version: '0.170.0' } });
        this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        return r;
    }

    /** A tools/call as Codex makes it: the session's id in `_meta`, and the turn's metadata. */
    async call(name: string, args: Json, thread: string, trigger = 'composer'): Promise<{ text: string; isError: boolean }> {
        const r = await this.request('tools/call', {
            name,
            arguments: args,
            _meta: { threadId: thread, sessionId: thread, 'x-codex-turn-metadata': { session_id: thread, thread_id: thread, turn_id: randomUUID(), turn_trigger: trigger, thread_source: 'user' } }
        });
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

/**
 * The event ids recent_events lists, in order: each line reads `[event e12, watch w-…; …]`. Matched
 * exactly, never as a bare /e12/: a watch id is random hex and can hold "e12" too.
 */
export function eventIdsIn(recentEventsText: string): string[] {
    return [...recentEventsText.matchAll(/\[event (e\d+), watch /g)].map((m) => m[1]!);
}

/** Until the session's watches are all active: the server has confirmed the subscription, so an event from now on is seen. */
export async function untilActive(h: Helper, thread: string, timeoutMs = 15000): Promise<void> {
    await waitFor(
        async () => {
            const list = JSON.parse((await h.call('list_watches', {}, thread, 'queue')).text.split('\n\n')[0]!) as { status: string }[];
            return list.length > 0 && list.every((w) => w.status === 'active');
        },
        timeoutMs,
        'the watch to be active'
    );
}

export async function startHelper(w: World, extra: Record<string, string | undefined> = {}): Promise<Helper> {
    const h = new Helper(w.env(extra));
    await h.initialize();
    return h;
}
