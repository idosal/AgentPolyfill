// Runs the helper the way the Hermes plugin does (tools/hermes/shared/_helper.py): over its
// stdin and stdout, `initialize` with the servers, then `call`s naming a Hermes session; the
// helper's `wake` requests are recorded and answered as the test says (taken, refused, or
// never answered). The MCP server is the Claude Code form's fixture events server (written by
// hand from SEP-3415, sharing no code with the client).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HELPER = join(ROOT, 'src', 'helper.ts');
export const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A Hermes session key, in the shapes Hermes uses: a stored session id, or a messaging chat's routing key. */
export const newSession = (kind: 'local' | 'chat' = 'local') => (kind === 'local' ? `20261125_${randomUUID().slice(0, 6)}_${randomUUID().slice(0, 6)}` : `agent:main:telegram:dm:${Math.floor(Math.random() * 1e9)}`);

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

type Json = Record<string, unknown>;
export type WakeMode = 'ok' | 'refuse' | 'silent';

/** Every folder the tests make, removed when the run ends. */
const temps: string[] = [];
process.on('exit', () => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

export function world(fixtureEnv: Record<string, string> = {}, o: { serverName?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-events-hermes-'));
    temps.push(dir);
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    const name = o.serverName ?? 'tickets';
    let n = 0;
    return {
        dir,
        upstream,
        fixtureLog,
        state: join(dir, 'state'),
        servers: { [name]: { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv } } } as Json,
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
        }
    };
}
export type World = ReturnType<typeof world>;

/** The helper, as the plugin sees it. */
export class Helper {
    readonly child: ChildProcess;
    readonly exited: Promise<number | null>;
    /** Every wake the helper asked for, in order, and how it was answered. */
    readonly wakes: { session: string; text: string; answered: WakeMode }[] = [];
    wakeMode: WakeMode = 'ok';
    stderr = '';
    #id = 0;
    #waiting = new Map<number, (m: Json) => void>();

    constructor(env: Record<string, string>) {
        this.child = spawn(process.execPath, ['--no-warnings', HELPER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr!.on('data', (d) => (this.stderr += d));
        this.exited = new Promise((r) => this.child.on('close', (code) => r(code)));
        createInterface({ input: this.child.stdout! }).on('line', (line) => {
            let m: Json;
            try {
                m = JSON.parse(line) as Json;
            } catch {
                return;
            }
            if (m.method === 'wake') {
                const p = m.params as { session: string; text: string };
                const mode = this.wakeMode;
                this.wakes.push({ session: p.session, text: p.text, answered: mode });
                if (mode === 'silent') return;
                this.#send({ id: m.id, result: mode === 'ok' ? { ok: true } : { ok: false, why: 'Hermes did not take the message (test)' } });
                return;
            }
            if (typeof m.id === 'number') this.#waiting.get(m.id)?.(m);
        });
    }

    #send(m: Json): void {
        this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    }

    request(method: string, params: Json = {}, timeoutMs = 30000): Promise<Json> {
        const id = ++this.#id;
        return new Promise((done, fail) => {
            const t = setTimeout(() => fail(new Error(`${method}: no answer`)), timeoutMs);
            this.#waiting.set(id, (m) => {
                clearTimeout(t);
                this.#waiting.delete(id);
                if (m.error) fail(new Error(String((m.error as Json).message)));
                else done((m.result ?? {}) as Json);
            });
            this.#send({ id, method, params });
        });
    }

    async call(name: string, args: Json, session: string): Promise<{ text: string; isError: boolean }> {
        const r = await this.request('call', { name, arguments: args, session });
        return { text: String(r.text ?? ''), isError: r.isError === true };
    }

    async stop(): Promise<number | null> {
        this.child.stdin!.end();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 10000);
        const code = await this.exited;
        clearTimeout(timer);
        return code;
    }
}

export async function startHelper(w: World, extra: Record<string, string | undefined> = {}, o: { skipped?: Record<string, string>; servers?: Json } = {}): Promise<Helper> {
    const env = Object.fromEntries(
        Object.entries({ PATH: process.env.PATH, HOME: w.dir, TMPDIR: process.env.TMPDIR, MCP_EVENTS_BATCH_MS: '200', MCP_EVENTS_DEV: '1', ...extra }).filter((e): e is [string, string] => e[1] !== undefined)
    );
    const h = new Helper(env);
    await h.request('initialize', { state: w.state, servers: o.servers ?? w.servers, skipped: o.skipped ?? {} });
    return h;
}

/** The event ids recent_events lists, in order (`[event e12, watch …]`). */
export function eventIdsIn(recentEventsText: string): string[] {
    return [...recentEventsText.matchAll(/\[event (e\d+), watch /g)].map((m) => m[1]!);
}

export async function untilActive(h: Helper, session: string, timeoutMs = 15000): Promise<void> {
    await waitFor(
        async () => {
            const list = JSON.parse((await h.call('list_watches', {}, session)).text.split('\n\n')[0]!) as { status: string }[];
            return list.length > 0 && list.every((w) => w.status === 'active');
        },
        timeoutMs,
        'the watch to be active'
    );
}
