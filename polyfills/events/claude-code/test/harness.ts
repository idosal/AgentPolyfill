// Runs the mod's helper process the way the hooks module does (started with the
// session's variables, its messages read from stdout, its tools called over its
// local endpoint), with this harness in Claude Code's place, against the
// fixture events server.

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HELPER = join(ROOT, 'src', 'helper.ts');
/** What an installed copy consists of: the folder the marketplace file names as the plugin's source. */
export const MOD = join(ROOT, 'mod');
export const FIXTURE = join(ROOT, 'test', 'fixture-events-server.ts');

export function temp(prefix = 'mcp-events-test-'): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        // The condition may be asynchronous (a tool call, say): it is its answer that counts.
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A test world: an upstream file, a fixture server config, a project folder and a state dir. */
export function world(fixtureEnv: Record<string, string> = {}) {
    const dir = temp();
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    const config = join(dir, 'servers.json');
    writeFileSync(
        config,
        JSON.stringify({
            mcpServers: {
                tickets: { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv } }
            }
        })
    );
    const project = join(dir, 'project');
    const state = join(dir, 'state');
    let n = 0;
    return {
        dir,
        upstream,
        fixtureLog,
        config,
        project,
        state,
        emit(name: string, data: Record<string, unknown>, eventId = `evt_${++n}_${Date.now()}`, meta?: Record<string, unknown>) {
            appendFileSync(upstream, JSON.stringify({ eventId, name, timestamp: new Date().toISOString(), data, ...(meta ? { _meta: meta } : {}) }) + '\n');
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

function envFor(w: World, session: string, extra: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        Object.entries({
            // Nothing of the developer's own setup leaks in: no Claude Code variables, no plugin
            // settings, and a HOME of the test's own (so no real ~/.claude.json or relay file).
            ...(Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MCP_EVENTS_)/.test(k))) as Record<string, string>),
            HOME: w.dir,
            MCP_EVENTS_CONFIG: w.config,
            MCP_EVENTS_STATE: w.state,
            CLAUDE_CODE_SESSION_ID: session,
            CLAUDE_PROJECT_DIR: w.project,
            // For tests on this machine: webhook addresses over plain http, and webhook subscriptions on a
            // connection with no credentials. A server that follows the extension refuses both.
            MCP_EVENTS_DEV: '1',
            ...extra
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
}

/**
 * Most tests tell events apart by a payload field in the line Claude Code is handed, and send
 * several to one watch in quick succession. So unless a test says otherwise the helper runs with
 * payload fields in the wake message and no gap between a watch's wakes. Neither is the mod's
 * default: test/wake-test.ts covers the defaults (no payload text; a minute; thirty an hour).
 */
export const WAKE_AS_TESTS_READ_IT = { MCP_EVENTS_WAKE_VALUES: '1', MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '0' };
/** The mod's own defaults for waking, for a test of them. */
export const WAKE_DEFAULTS = { MCP_EVENTS_WAKE_VALUES: undefined, MCP_EVENTS_WAKE_GAP_S: undefined, MCP_EVENTS_WAKES_PER_HOUR: undefined };

export type HelperMessage = { t: string; [k: string]: unknown };

/** What a running helper looks like to the hooks module: its messages, and its local endpoint. */
export type Helper = {
    child: ChildProcess;
    messages: HelperMessage[];
    /** Lines Claude Code has been handed (what the hooks module would submit as prompts). */
    lines: string[];
    post(route: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }>;
    exited: Promise<number | null>;
};

const helpers = new Map<string, Helper>();
const key = (w: World, session: string) => `${w.dir}\0${session}`;

/**
 * Starts a helper and plays the hooks module's part: answers its question about each server
 * (`verdict`, Claude Code's own; by default every server is one Claude Code uses), and, while
 * `deliver` is on, takes waiting events and acknowledges them as Claude Code would.
 */
export async function startHelper(
    w: World,
    session = 'sess-a',
    extra: Record<string, string | undefined> = {},
    o: { command?: string[]; verdict?: (name: string) => { ok: boolean; reason?: string } | undefined; deliver?: boolean } = {}
): Promise<Helper & { where: { url: string; token: string }; deliverNow(): Promise<void>; setDeliver(on: boolean): void }> {
    const [cmd, ...args] = o.command ?? [process.execPath, '--no-warnings', HELPER];
    const child = spawn(cmd!, args, { env: envFor(w, session, { MCP_EVENTS_BATCH_MS: '400', MCP_EVENTS_STANDBY_MS: '0', ...WAKE_AS_TESTS_READ_IT, ...extra }), cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    const messages: HelperMessage[] = [];
    const lines: string[] = [];
    let where: { url: string; token: string } | undefined;
    let deliver = o.deliver === true;
    let delivering = false;
    const post = async (route: string, body: unknown = {}, token = where?.token) => {
        const r = await fetch(`${where!.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const deliverNow = async () => {
        if (delivering) return;
        delivering = true;
        try {
            for (;;) {
                const { json } = await post('/take');
                if (typeof json.upto !== 'number') break;
                lines.push(...((json.lines as string[]) ?? []));
                await post('/ack', { upto: json.upto });
            }
        } catch {
            // the helper has gone
        } finally {
            delivering = false;
        }
    };
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let m: HelperMessage;
            try {
                m = JSON.parse(line) as HelperMessage;
            } catch {
                continue;
            }
            // When it arrived, for measurements.
            messages.push({ ...m, at: performance.now() });
            if (m.t === 'ready') where = { url: String(m.url), token: String(m.token) };
            if (m.t === 'servers') for (const name of m.names as string[]) void post('/verdict', { name, ...(o.verdict?.(name) ?? { ok: true }) }).catch(() => {});
            if (m.t === 'pending' && deliver) void deliverNow();
        }
    });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await waitFor(() => where, 15000, 'the helper to say where it listens');
    const h = {
        child,
        messages,
        lines,
        post,
        exited,
        where: where!,
        deliverNow,
        setDeliver(on: boolean) {
            deliver = on;
            if (on) void deliverNow();
        }
    };
    helpers.set(key(w, session), h);
    void exited.then(() => helpers.get(key(w, session)) === h && helpers.delete(key(w, session)));
    return h;
}

/** The helper, with its tools: what Claude has once the mod is loaded. */
export async function startPlugin(w: World, session = 'sess-a', extra: Record<string, string | undefined> = {}, o: Parameters<typeof startHelper>[3] = {}) {
    const h = await startHelper(w, session, extra, o);
    // The catalog is sent once every configured server has been looked at.
    const catalog = await waitFor(() => h.messages.findLast((m) => m.t === 'catalog'), 30000, 'the catalog');
    void catalog;
    return {
        helper: h,
        instructions: () => String(h.messages.findLast((m) => m.t === 'catalog')?.text ?? ''),
        async call(name: string, args: Record<string, unknown> = {}) {
            const { json } = await h.post('/tool', { name, input: args });
            return { text: String(json.text ?? ''), isError: json.isError === true };
        },
        async stop() {
            await h.post('/stop').catch(() => {});
            const t = setTimeout(() => h.child.kill('SIGKILL'), 9000);
            await h.exited;
            clearTimeout(t);
        }
    };
}

/**
 * Claude Code taking this session's events: the lines it is handed. With a helper running for the
 * session it takes from that one; `stop` stops the taking (the helper goes on), and `kill` stops
 * it without acknowledging what was last taken, as a session that died mid-way would.
 */
export function startMonitor(w: World, session = 'sess-a') {
    const h = helpers.get(key(w, session));
    if (!h) throw new Error(`no helper runs for ${session}: start it first`);
    const full = h as Awaited<ReturnType<typeof startHelper>>;
    full.setDeliver(true);
    return { lines: h.lines, stop: () => full.setDeliver(false), kill: () => full.setDeliver(false) };
}
