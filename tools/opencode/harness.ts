// A throwaway OpenCode for the OpenCode forms' tests. Each world is a temporary
// folder with its own HOME and XDG folders (so OpenCode's configuration, data,
// sign-ins and service are all its own, never the user's), a project folder
// whose opencode.json loads the plugins under test, a scripted model
// (fake-llm.mjs) on loopback, and `opencode serve` on loopback, driven over
// its HTTP API.
//
// OpenCode comes from OPENCODE_BIN, or from `npm ci` in this folder, which
// installs the pinned @opencode/cli.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = fileURLToPath(new URL('.', import.meta.url));
export const REPO = join(KIT, '..', '..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openCodeBin(): string {
    if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
    const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode.exe';
    const p = join(KIT, 'node_modules', '@opencode', 'cli', 'bin', exe);
    if (!existsSync(p)) throw new Error(`no OpenCode: run npm ci in ${KIT}, or set OPENCODE_BIN`);
    return p;
}

export async function waitFor<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, timeoutMs = 20000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (e) {
            last = e;
        }
        await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ''}`);
}

export const freePort = () =>
    new Promise<number>((done, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as { port: number }).port;
            s.close(() => done(port));
        });
    });

function startProcess(cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd: string; log: string; ready: RegExp }): Promise<ChildProcess> {
    return new Promise((done, fail) => {
        const child = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => fail(new Error(`${cmd} did not start in time:\n${out.slice(-3000)}`)), 60000);
        const take = (d: Buffer) => {
            const s = d.toString('utf8');
            out += s;
            try {
                writeFileSync(o.log, s, { flag: 'a' });
            } catch {
                // the world is going away
            }
            if (o.ready.test(out)) {
                clearTimeout(timer);
                done(child);
            }
        };
        child.stdout!.on('data', take);
        child.stderr!.on('data', take);
        child.on('exit', (code) => {
            clearTimeout(timer);
            fail(new Error(`${cmd} exited (${code}) before it was ready:\n${out.slice(-3000)}`));
        });
    });
}

export type McpConfig = { type: 'local'; command: string[]; environment?: Record<string, string>; cwd?: string; disabled?: boolean } | { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false; disabled?: boolean };
export type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' };

export type WorldOptions = {
    /** Plugin folders, by absolute path. */
    plugins: string[];
    mcp?: Record<string, McpConfig>;
    permissions?: Rule[];
    /** More environment for OpenCode (and so for the plugins). */
    env?: Record<string, string>;
};

export type Message = { id: string; type: string; text?: string; [k: string]: unknown };

export class World {
    readonly dir: string;
    readonly home: string;
    readonly project: string;
    readonly logs: string;
    readonly llmLog: string;
    readonly password = `test-${randomBytes(12).toString('hex')}`;
    env: NodeJS.ProcessEnv = {};
    url = '';
    #procs: ChildProcess[] = [];
    #o: WorldOptions;
    #llmPort = 0;

    constructor(o: WorldOptions) {
        this.#o = o;
        this.dir = mkdtempSync(join(tmpdir(), 'agentpolyfill-opencode-'));
        this.home = join(this.dir, 'home');
        this.project = join(this.dir, 'project');
        this.logs = join(this.dir, 'logs');
        this.llmLog = join(this.logs, 'llm.jsonl');
        for (const d of [this.home, this.project, this.logs]) mkdirSync(d, { recursive: true });
    }

    /** The project's opencode.json: the scripted model, the plugins, the MCP servers and the rules. */
    writeConfig(): void {
        const config = {
            $schema: 'https://opencode.ai/config.json',
            providers: {
                scripted: {
                    name: 'Scripted',
                    package: '@opencode/ai/providers/openai-compatible',
                    settings: { baseURL: `http://127.0.0.1:${this.#llmPort}/v1`, apiKey: 'not-a-key' },
                    models: { scripted: { name: 'Scripted' } }
                }
            },
            model: 'scripted/scripted',
            plugins: this.#o.plugins,
            ...(this.#o.mcp ? { mcp: this.#o.mcp } : {}),
            ...(this.#o.permissions ? { permissions: this.#o.permissions } : {})
        };
        writeFileSync(join(this.project, 'opencode.json'), JSON.stringify(config, null, 2));
    }

    async start(): Promise<this> {
        const h = this.home;
        this.env = {
            PATH: process.env.PATH,
            HOME: h,
            USERPROFILE: h,
            XDG_CONFIG_HOME: join(h, '.config'),
            XDG_DATA_HOME: join(h, '.local', 'share'),
            XDG_CACHE_HOME: join(h, '.cache'),
            XDG_STATE_HOME: join(h, '.local', 'state'),
            TMPDIR: join(this.dir, 'tmp'),
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1',
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_SERVER_PASSWORD: this.password,
            ...this.#o.env
        };
        mkdirSync(this.env.TMPDIR!, { recursive: true });
        this.#llmPort = await freePort();
        this.#procs.push(await startProcess(process.execPath, [join(KIT, 'fake-llm.mjs'), String(this.#llmPort), this.llmLog], { env: { PATH: process.env.PATH }, cwd: this.dir, log: join(this.logs, 'llm.out'), ready: /fake-llm \d+/ }));
        this.writeConfig();
        const port = await freePort();
        this.url = `http://127.0.0.1:${port}`;
        this.#procs.push(await startProcess(openCodeBin(), ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], { env: this.env, cwd: this.project, log: join(this.logs, 'opencode.log'), ready: /server listening/ }));
        return this;
    }

    async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        const r = await fetch(this.url + path, {
            method,
            headers: { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 500)}`);
        return (text ? JSON.parse(text) : undefined) as T;
    }

    async createSession(): Promise<string> {
        const r = await this.api<{ data?: { id: string }; id?: string }>('POST', '/api/session', { location: { directory: this.project } });
        return (r.data?.id ?? r.id)!;
    }

    async prompt(sessionID: string, text: string): Promise<void> {
        await this.api('POST', `/api/session/${sessionID}/prompt`, { text });
    }

    async messages(sessionID: string): Promise<Message[]> {
        const r = await this.api<{ data: Message[] }>('GET', `/api/session/${sessionID}/message?limit=200&order=asc`);
        return r.data;
    }

    async session(sessionID: string): Promise<{ time: { busy?: number; idle?: number } }> {
        const r = await this.api<{ data: { time: { busy?: number; idle?: number } } }>('GET', `/api/session/${sessionID}`);
        return r.data;
    }

    /** Waits until the session has run since `since` and is idle again. */
    async idle(sessionID: string, since = 0, timeoutMs = 30000): Promise<void> {
        await waitFor(async () => {
            const s = await this.session(sessionID);
            const { busy = 0, idle = 0 } = s.time;
            return busy > since && idle >= busy;
        }, timeoutMs, `session ${sessionID} to go idle`);
    }

    async permissions(sessionID: string): Promise<{ id: string; action: string; resources: string[]; metadata?: Record<string, unknown> }[]> {
        const r = await this.api<{ data: { id: string; action: string; resources: string[] }[] }>('GET', `/api/session/${sessionID}/permission`);
        return r.data;
    }

    async reply(sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
        await this.api('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, { decision });
    }

    /** What OpenCode sent the scripted model, request by request. */
    llmRequests(): { messages: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] }[] {
        if (!existsSync(this.llmLog)) return [];
        return readFileSync(this.llmLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l).body)
            .filter((b) => b && Array.isArray(b.messages));
    }

    /** The texts of the messages the model saw last, with their roles. */
    lastSeen(): string[] {
        const r = this.llmRequests().at(-1);
        return (r?.messages ?? []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
    }

    log(): string {
        try {
            return readFileSync(join(this.logs, 'opencode.log'), 'utf8');
        } catch {
            return '';
        }
    }

    /** Stops OpenCode and starts it again on the same folders (a restart). */
    async restart(): Promise<void> {
        const oc = this.#procs.pop();
        if (oc) await stopProcess(oc);
        const port = await freePort();
        this.url = `http://127.0.0.1:${port}`;
        this.#procs.push(await startProcess(openCodeBin(), ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], { env: this.env, cwd: this.project, log: join(this.logs, 'opencode.log'), ready: /server listening/ }));
    }

    async stop(o: { keep?: boolean } = {}): Promise<void> {
        for (const p of this.#procs.reverse()) await stopProcess(p);
        this.#procs = [];
        if (!o.keep && !process.env.KEEP_WORLD) rmSync(this.dir, { recursive: true, force: true });
    }
}

function stopProcess(p: ChildProcess): Promise<void> {
    return new Promise((done) => {
        if (p.exitCode !== null || p.signalCode !== null) return done();
        const t = setTimeout(() => {
            p.kill('SIGKILL');
            done();
        }, 8000);
        p.once('exit', () => {
            clearTimeout(t);
            done();
        });
        p.kill('SIGTERM');
    });
}

/** A text from a message, whatever its shape. */
export function textOf(m: Message): string {
    if (typeof m.text === 'string') return m.text;
    const payload = m.payload as { text?: string } | undefined;
    if (typeof payload?.text === 'string') return payload.text;
    return JSON.stringify(m);
}
