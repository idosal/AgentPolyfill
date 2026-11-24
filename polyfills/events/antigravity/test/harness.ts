import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Helper, sleep, waitFor, eventIdsIn } from '../../codex/test/harness.ts';
import { tempHome, preToolUse, runHook, matches, antigravityServer } from '../../../server-cards/antigravity/test/harness.ts';

export { sleep, waitFor, eventIdsIn, tempHome, preToolUse, runHook, matches, antigravityServer };
export const temp = tempHome;
export const newThread = randomUUID;
// Tests are bundled in test/.build, as in the other Antigravity forms.
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER = join(ROOT, 'plugin/dist/server.mjs');
export const FIXTURE = join(ROOT, '../claude-code/test/fixture-events-server.ts');

export function config(home: string, servers: Record<string, unknown>) {
    const file = join(home, '.gemini/config/mcp_config.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    return file;
}
export function fakeAgentapi(home: string) {
    const bin = join(home, 'bin'); mkdirSync(bin, { recursive: true });
    const log = join(home, 'agentapi.jsonl');
    writeFileSync(join(bin, 'agentapi'), `#!${process.execPath}\n` +
        `import {appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';\n` +
        `const args=process.argv.slice(2); let injected={};\n` +
        `if(process.env.TEST_INJECT==='1'){ const r=spawnSync(process.execPath,[process.env.TEST_SERVER,'--hook','pre-invocation'],{input:JSON.stringify({conversationId:args[1]}),encoding:'utf8',env:process.env}); injected=JSON.parse(r.stdout); }\n` +
        `appendFileSync(process.env.TEST_AGENTAPI_LOG,JSON.stringify({args,injected,leaked:Object.keys(process.env).filter(k=>k.startsWith('MCP_EVENTS_'))})+'\\n');\n` +
        `if(process.env.TEST_AGENTAPI_HANG==='1')setInterval(()=>{},1000); else process.exit(Number(process.env.TEST_AGENTAPI_EXIT||0));\n`, { mode: 0o755 });
    return { bin, log, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home, TEST_AGENTAPI_LOG: log, TEST_SERVER: SERVER },
        calls: (): { args: string[]; injected: any; leaked: string[] }[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] };
}
export function invocation(home: string, input: unknown, extra: Record<string, string> = {}, raw = false, server = SERVER) {
    const r = spawnSync(process.execPath, [server, '--hook', 'pre-invocation'], {
        input: raw ? String(input) : JSON.stringify(input), encoding: 'utf8', timeout: 30000,
        env: { HOME: home, PATH: process.env.PATH ?? '', ...extra }
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}
export function world(fixtureEnv: Record<string, string> = {}) {
    const dir = tempHome();
    const upstream = join(dir, 'upstream.jsonl'); writeFileSync(upstream, '');
    const fixtureLog = join(dir, 'fixture.jsonl');
    config(dir, { tickets: { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { HOME: dir, FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv } } });
    const fake = fakeAgentapi(dir);
    let n = 0;
    return {
        dir, fixtureLog, upstream, state: join(dir, '.gemini/agentpolyfill/mcp-events'), fake,
        emit(name: string, data: Record<string, unknown>, eventId = `evt_${++n}_${Date.now()}`) {
            appendFileSync(upstream, JSON.stringify({ eventId, name, timestamp: new Date().toISOString(), data }) + '\n'); return eventId;
        },
        queued: () => fake.calls().map(r => ({ ...r, thread: r.args[1], message: r.args[2]!, summary: r.injected.injectSteps?.[0]?.systemMessage.systemMessage ?? '' })),
        fixtureMethods: () => existsSync(fixtureLog) ? readFileSync(fixtureLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.dir === 'in' && r.m.method).map(r => r.m.method as string) : [],
        env: (extra: Record<string, string | undefined> = {}): Record<string, string> => Object.fromEntries(Object.entries({ ...fake.env, MCP_EVENTS_BATCH_MS: '200', MCP_EVENTS_DEV: '1', TEST_INJECT: '1', ...extra }).filter((e): e is [string, string] => typeof e[1] === 'string'))
    };
}
export type World = ReturnType<typeof world>;
export class Adapter extends Helper {
    sidecar?: ChildProcess;
    constructor(readonly env: Record<string, string>, readonly entry = SERVER) { super(env, entry); }
    override async initialize() {
        return this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'antigravity-test', version: '1.5.16' } });
    }
    override async call(name: string, args: Record<string, unknown>, id: string) {
        const h = runHook(this.entry, this.env.HOME!, preToolUse(`mcp_mcp-events_events_${name}`, args, id), this.env);
        assert.equal(h.status, 0); assert.equal(h.out.decision, 'allow', JSON.stringify(h.out));
        return this.rawCall(name, { ...args, ...h.out.overwrite });
    }
    async rawCall(name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {}) {
        const r = await this.request('tools/call', { name, arguments: args, _meta: meta });
        const result = r.result as { content: { text: string }[]; isError: boolean };
        return { text: result.content.map(c => c.text).join(''), isError: result.isError };
    }
    override async stop() {
        if (this.sidecar && this.sidecar.exitCode === null && this.sidecar.signalCode === null) {
            const end = new Promise(r => this.sidecar!.once('close', r)); this.sidecar.kill(); await end;
        }
        return super.stop();
    }
}
export async function startHelper(w: World, extra: Record<string, string | undefined> = {}, wake = true) {
    const h = new Adapter(w.env(extra)); await h.initialize();
    if (wake) h.sidecar = spawn(process.execPath, [SERVER, '--sidecar'], { env: w.env(extra), stdio: 'ignore' });
    after(async () => { if (h.child.exitCode === null && h.child.signalCode === null) await h.stop(); });
    return h;
}
export async function untilActive(h: Adapter, thread: string) {
    await waitFor(async () => {
        const ws = JSON.parse((await h.call('list_watches', {}, thread)).text.split('\n\n')[0]);
        return ws.length && ws.every((w: { status: string }) => w.status === 'active');
    }, 15000, 'active watches');
}
/** Lets the shared client-rule suite exercise its two lifecycle cases through this adapter. */
export async function startPlugin(w: World) {
    const h = await startHelper(w, {}, false), id = newThread();
    await h.call('list_event_types', {}, id);
    return { call: (name: string, args: Record<string, unknown> = {}) => h.call(name, args, id), stop: () => h.stop() };
}
