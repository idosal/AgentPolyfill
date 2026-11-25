// Runs the extension the way Copilot does (a child process with SESSION_ID set, joining the
// session through `@github/copilot-sdk/extension`), with a stand-in for that module
// (test/fake-sdk) that the test drives: tool calls, the session's messages, and how Copilot answers
// `session.send`. The MCP server is the fixture events server of the Claude Code form, written by
// hand from SEP-3415 and sharing no code with the client.
//
// By default the committed bundle (plugin/extensions/mcp-events/extension.mjs) runs, so the tests
// check what is installed; MCP_EVENTS_TEST_SOURCE=1 runs src/extension.ts instead.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BUNDLE = join(ROOT, 'plugin', 'extensions', 'mcp-events', 'extension.mjs');
export const SOURCE = join(ROOT, 'src', 'extension.ts');
export const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');
const REGISTER = join(ROOT, 'test', 'fake-sdk', 'register.mjs');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Every folder made here is removed when the test process ends, failed or not.
const made: string[] = [];
process.on('exit', () => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});
export const temp = (prefix = 'mcp-events-copilot-') => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
};
export const newSession = () => randomUUID();

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A test world: a Copilot home whose mcp-config.json names the fixture server, a state folder and a working folder. */
export function world(fixtureEnv: Record<string, string> = {}, o: { serverName?: string; extra?: Record<string, unknown> } = {}) {
    const dir = temp();
    const copilotHome = join(dir, 'copilot-home');
    const cwd = join(dir, 'work');
    mkdirSync(copilotHome);
    mkdirSync(cwd);
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    const env = { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv };
    const name = o.serverName ?? 'tickets';
    writeFileSync(join(copilotHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { [name]: { type: 'local', command: process.execPath, args: ['--no-warnings', FIXTURE], env }, ...(o.extra ?? {}) } }, null, 2));
    let n = 0;
    return {
        dir,
        copilotHome,
        cwd,
        upstream,
        fixtureLog,
        state: join(dir, 'state'),
        emit(eventName: string, data: Record<string, unknown>, eventId = `evt_${++n}_${Date.now()}`) {
            appendFileSync(upstream, JSON.stringify({ eventId, name: eventName, timestamp: new Date().toISOString(), data }) + '\n');
            return eventId;
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
        log(): string {
            try {
                return readFileSync(join(dir, 'state', 'mcp-events.log'), 'utf8');
            } catch {
                return '';
            }
        },
        env(session: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
            return Object.fromEntries(
                Object.entries({
                    PATH: process.env.PATH,
                    HOME: dir,
                    TMPDIR: process.env.TMPDIR,
                    COPILOT_HOME: copilotHome,
                    SESSION_ID: session,
                    MCP_EVENTS_STATE: join(dir, 'state'),
                    MCP_EVENTS_BATCH_MS: '200',
                    MCP_EVENTS_DEV: '1',
                    FAKE_COPILOT_CONFIGURED: JSON.stringify([{ name, enabled: true, source: 'user' }]),
                    ...extra
                }).filter((e): e is [string, string] => e[1] !== undefined)
            );
        }
    };
}
export type World = ReturnType<typeof world>;

type Json = Record<string, unknown>;
export type Sent = { id: number; options: { prompt: string; source?: string; mode?: string } };
export type Asked = { kind: 'select' | 'confirm'; message: string; options?: string[] };

/** The extension, as Copilot runs it, and the session it joined. */
export class Extension {
    readonly child: ChildProcess;
    readonly exited: Promise<number | null>;
    readonly joined: Promise<{ tools: { name: string; skipPermission: boolean; description: string; parameters: Json }[]; hooks: string[] }>;
    readonly sent: Sent[] = [];
    /** The dialogs the extension showed (session.ui), in order. */
    readonly asked: Asked[] = [];
    stderr = '';
    #id = 0;
    #waiting = new Map<number, (m: Json) => void>();

    constructor(env: Record<string, string>, cwd: string, entry = process.env.MCP_EVENTS_TEST_SOURCE === '1' ? SOURCE : BUNDLE) {
        this.child = spawn(process.execPath, ['--no-warnings', '--import', REGISTER, entry], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr!.on('data', (d) => (this.stderr += d));
        this.exited = new Promise((r) => this.child.on('close', (code) => r(code)));
        let joined: (v: never) => void = () => {};
        this.joined = new Promise((r) => (joined = r as never));
        createInterface({ input: this.child.stdout! }).on('line', (line) => {
            let m: Json;
            try {
                m = JSON.parse(line) as Json;
            } catch {
                throw new Error(`the extension wrote to stdout, which is Copilot's channel: ${line.slice(0, 200)}`);
            }
            if (m.t === 'joined') joined(m as never);
            else if (m.t === 'send') this.sent.push(m as unknown as Sent);
            else if (m.t === 'asked') this.asked.push(m as unknown as Asked);
            else if (typeof m.id === 'number') this.#waiting.get(m.id)?.(m);
        });
    }

    #ask(m: Json, timeoutMs = 30000): Promise<Json> {
        const id = ++this.#id;
        return new Promise((done, fail) => {
            const t = setTimeout(() => fail(new Error(`${String(m.t)} ${String(m.name ?? '')}: no answer`)), timeoutMs);
            this.#waiting.set(id, (r) => {
                clearTimeout(t);
                this.#waiting.delete(id);
                done(r);
            });
            this.child.stdin!.write(JSON.stringify({ ...m, id }) + '\n');
        });
    }

    /** The model calls a tool. */
    async call(name: string, args: Json = {}): Promise<{ text: string; isError: boolean }> {
        const r = await this.#ask({ t: 'call', name, args });
        if (typeof r.thrown === 'string') throw new Error(r.thrown);
        const v = r.value as string | { textResultForLlm: string; resultType: string };
        return typeof v === 'string' ? { text: v, isError: false } : { text: v.textResultForLlm, isError: v.resultType !== 'success' };
    }

    async hook(name: string, input: Json = {}): Promise<unknown> {
        return (await this.#ask({ t: 'hook', name, input })).value;
    }

    /** A message reaches the session: the person's (no source) or something else's. */
    message(content: string, source?: string): void {
        this.child.stdin!.write(JSON.stringify({ t: 'event', type: 'user.message', data: { content, ...(source ? { source } : {}) } }) + '\n');
    }

    /** Any other session event, as Copilot emits it. */
    event(type: string, data: Json = {}): void {
        this.child.stdin!.write(JSON.stringify({ t: 'event', type, data }) + '\n');
    }

    sendMode(mode: 'ok' | 'error' | 'hang'): void {
        this.child.stdin!.write(JSON.stringify({ t: 'sendMode', mode }) + '\n');
    }

    /** How the person answers the extension's dialogs from now on: 'none' is a host that can't ask (copilot -p). */
    uiMode(mode: 'yes' | 'no' | 'cancel' | 'none'): void {
        this.child.stdin!.write(JSON.stringify({ t: 'uiMode', mode }) + '\n');
    }

    /** Ends the extension as Copilot does when the session ends: SIGTERM. */
    async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
        if (this.child.exitCode !== null) return this.child.exitCode;
        this.child.kill(signal);
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 10000);
        const code = await this.exited;
        clearTimeout(timer);
        return code;
    }
}

export async function startExtension(w: World, session = newSession(), extra: Record<string, string | undefined> = {}): Promise<Extension> {
    const e = new Extension(w.env(session, extra), w.cwd);
    await Promise.race([e.joined, e.exited.then((c) => Promise.reject(new Error(`the extension exited (${c}) before joining: ${e.stderr}`)))]);
    return e;
}

/** The event ids recent_events lists, in order. */
export function eventIdsIn(recentEventsText: string): string[] {
    return [...recentEventsText.matchAll(/\[event (e\d+), watch /g)].map((m) => m[1]!);
}

/** Until the session's watches are all active: the server has confirmed the subscription. */
export async function untilActive(e: Extension, timeoutMs = 15000): Promise<void> {
    await waitFor(
        async () => {
            const list = JSON.parse((await e.call('list_watches', {})).text.split('\n\n')[0]!) as { status: string }[];
            return list.length > 0 && list.every((w) => w.status === 'active');
        },
        timeoutMs,
        'the watch to be active'
    );
}

export const watchIdOf = (text: string) => /as (w-[0-9a-f]{6})/.exec(text)?.[1];
