// Runs the helper the way Codex does: an MCP server over stdio, each tools/call carrying the session's
// id and the turn's trigger in `_meta`, with Codex's side of elicitation answered by a script. The
// server it reaches is test/fixture-tasks-server.mjs, written by hand from the specification. The
// `codex` it would run to wake a session is test/fake-codex.mjs, which records what it was told.
// Nothing here can find a real Codex or gh: PATH holds only Node's own folder, and HOME is a temp folder.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HELPER = join(ROOT, 'src', 'helper.ts');
export const FIXTURE = join(ROOT, 'test', 'fixture-tasks-server.mjs');
export const FAKE_CODEX = join(ROOT, 'test', 'fake-codex.mjs');
type Json = Record<string, unknown>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const made: string[] = [];
export const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'mcp-tasks-codex-'));
    made.push(d);
    return d;
};
process.on('exit', () => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

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

export function world(o: { fixtureEnv?: Record<string, string>; extraServerToml?: string } = {}) {
    const dir = temp();
    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome);
    const fixtureLog = join(dir, 'fixture.jsonl');
    const queueLog = join(dir, 'queue.jsonl');
    chmodSync(FAKE_CODEX, 0o755);
    const env = { FIXTURE_LOG: fixtureLog, FIXTURE_TASK_MS: '400', FIXTURE_POLL_MS: '200', ...(o.fixtureEnv ?? {}) };
    writeFileSync(join(codexHome, 'config.toml'), ['[mcp_servers.jobs]', `command = ${toml(process.execPath)}`, `args = [${toml(FIXTURE)}]`, o.extraServerToml ?? '', '', '[mcp_servers.jobs.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`), ''].join('\n'));
    return {
        dir,
        codexHome,
        state: join(dir, 'state'),
        fixtureLog,
        queueLog,
        requests: (): Json[] => (existsSync(fixtureLog) ? readFileSync(fixtureLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json) : []),
        wakes: (): { args: string[] }[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }) : []),
        helperLog: () => (existsSync(join(dir, 'state', 'mcp-tasks.log')) ? readFileSync(join(dir, 'state', 'mcp-tasks.log'), 'utf8') : '')
    };
}
export type World = ReturnType<typeof world>;

/** What the scripted person does with a form: return the result Codex would send back. */
export type Responder = (params: Json) => Json | Promise<Json>;

export class FakeCodex {
    readonly child: ChildProcess;
    #next = 1;
    #waiting = new Map<number, (m: Json) => void>();
    readonly asked: Json[] = [];
    respond: Responder = () => ({ action: 'decline' });

    constructor(w: World, o: { env?: Record<string, string> } = {}) {
        this.child = spawn(process.execPath, ['--no-warnings', HELPER], {
            env: { PATH: dirname(process.execPath), HOME: w.dir, CODEX_HOME: w.codexHome, MCP_TASKS_STATE: w.state, MCP_TASKS_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_LOG: w.queueLog, MCP_TASKS_MIN_POLL_MS: '100', ...(o.env ?? {}) },
            stdio: ['pipe', 'pipe', 'inherit']
        });
        createInterface({ input: this.child.stdout! }).on('line', (line) => void this.#on(JSON.parse(line) as Json));
    }

    async #on(m: Json): Promise<void> {
        if (m.method === 'elicitation/create') {
            this.asked.push(m.params as Json);
            const result = await this.respond(m.params as Json);
            this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
            return;
        }
        if (typeof m.id === 'number') {
            this.#waiting.get(m.id)?.(m);
            this.#waiting.delete(m.id);
        }
    }

    request(method: string, params: Json = {}): Promise<Json> {
        const id = this.#next++;
        return new Promise((done) => {
            this.#waiting.set(id, done);
            this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    async initialize(capabilities: Json = { elicitation: {} }): Promise<Json> {
        return (await this.request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } })).result as Json;
    }

    /** A tool call as Codex makes it, from a session, in a turn the person started (`user`) unless said otherwise. */
    async call(name: string, args: Json, thread: string, o: { trigger?: string | null; meta?: Json } = {}): Promise<{ text: string; content: Json[]; isError: boolean }> {
        const turn = o.trigger === null ? {} : { thread_id: thread, turn_trigger: o.trigger ?? 'user' };
        const r = (await this.request('tools/call', { name, arguments: args, _meta: { threadId: thread, 'x-codex-turn-metadata': turn, ...(o.meta ?? {}) } })).result as { content: Json[]; isError?: boolean };
        return { text: String(r.content[0]?.text ?? ''), content: r.content.slice(1), isError: r.isError === true };
    }

    async close(): Promise<void> {
        this.child.stdin!.end();
        await new Promise((r) => this.child.once('exit', r));
    }
}

export const newThread = () => randomUUID();
/** Codex's answer when the person picks a choice in a form. */
export const choose = (decision: string) => () => ({ action: 'accept', content: { decision } });
export const idOf = (text: string) => /\b(t-[0-9a-f]{6})\b/.exec(text)?.[1];
