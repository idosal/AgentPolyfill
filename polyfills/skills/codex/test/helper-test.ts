// The bundled plugin server (mod/dist/helper.js) as Codex runs it: started over
// stdio from the plugin's folder, spoken to as Codex speaks (initialize on
// 2025-06-18 with elicitation, tools/list, tools/call with the thread in _meta),
// and asked its questions as Codex asks them. Also: the bundle is what src/ builds.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { VERSION } from '../src/version.ts';
import { Fixture, scenarioOf, skill, temp } from './harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'mod', 'dist', 'helper.js');
const RUNTIME = process.env.HELPER_RUNTIME || process.execPath;
type Json = Record<string, unknown>;
const running: ChildProcess[] = [];
after(() => running.forEach((c) => c.kill()));

/** A stand-in for Codex: starts the bundle, sends requests, and answers its questions with `answer`. */
function codex(env: Record<string, string>, answer: (params: Json) => Json | undefined = () => ({ action: 'decline' })) {
    const child = spawn(RUNTIME, [BUNDLE], { cwd: join(ROOT, 'mod'), env: { PATH: process.env.PATH ?? '', HOME: env.HOME ?? temp(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    let buf = '';
    let id = 0;
    const pending = new Map<number, (m: Json) => void>();
    const asked: Json[] = [];
    child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        let at: number;
        while ((at = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, at)) as Json;
            buf = buf.slice(at + 1);
            if (m.method === 'elicitation/create') {
                asked.push(m.params as Json);
                const result = answer(m.params as Json);
                child.stdin!.write(`${JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'no' } } : { jsonrpc: '2.0', id: m.id, result })}\n`);
            } else if (typeof m.id === 'number') pending.get(m.id)?.(m);
        }
    });
    const request = (method: string, params: Json = {}): Promise<Json> =>
        new Promise((done) => {
            const n = ++id;
            pending.set(n, done);
            child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
        });
    const call = async (name: string, args: Json) => {
        const m = await request('tools/call', { name, arguments: args, _meta: { threadId: 'thread-1', callId: 'c1' } });
        const r = m.result as { content: { text: string }[]; isError?: boolean };
        return { text: r.content[0]!.text, isError: r.isError === true };
    };
    return { child, request, call, asked, init: (caps: Json = { elicitation: { form: {}, url: {} } }) => request('initialize', { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'codex-mcp-client', version: '0.170.0' } }) };
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 50));
    }
}

function setup(skills: ReturnType<typeof skill>[]) {
    const f = new Fixture(scenarioOf(skills));
    const home = temp();
    const cfg = f.config;
    writeFileSync(join(home, 'config.toml'), `[mcp_servers.docs]\ncommand = ${JSON.stringify(cfg.command)}\nargs = ${JSON.stringify(cfg.args)}\nenv = { FIXTURE_SCENARIO = ${JSON.stringify(cfg.env!.FIXTURE_SCENARIO)}, FIXTURE_LOG = ${JSON.stringify(cfg.env!.FIXTURE_LOG)} }\n`);
    const stubs = join(temp(), 'served');
    return { f, env: { MCP_SKILLS_CODEX_HOME: home, MCP_SKILLS_STATE: join(home, 'mcp-skills'), MCP_SKILLS_STUBS: stubs }, stubs, home };
}
const stubFiles = (root: string) => (existsSync(root) ? readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith('SKILL.md')) : []);

describe('the bundled plugin server', () => {
    test('mod/dist/helper.js is what src/ builds', () => {
        const out = temp();
        execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'ignore' });
        assert.equal(readFileSync(join(out, 'helper.js'), 'utf8'), readFileSync(BUNDLE, 'utf8'), 'run npm run build and commit mod/dist');
    });

    test('the plugin folder holds its manifest, its MCP server entry and its skill, and imports nothing from outside it', () => {
        const manifest = JSON.parse(readFileSync(join(ROOT, 'mod', '.codex-plugin', 'plugin.json'), 'utf8')) as Json;
        assert.equal(manifest.name, 'mcp-skills');
        assert.equal(manifest.version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
        assert.deepEqual([manifest.skills, manifest.mcpServers], ['./skills/', './.mcp.json']);
        const mcp = JSON.parse(readFileSync(join(ROOT, 'mod', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, Json> };
        assert.deepEqual(mcp.mcpServers['mcp-skills']!.args, ['./dist/helper.js']);
        assert.doesNotMatch(readFileSync(BUNDLE, 'utf8'), /from\s*["']\.\.\/|require\(["']\.\.\//);
    });

    test('as Codex speaks to it: initialize, tools, stubs, a question before a load, none after', async () => {
        const s = skill('git-workflow', { 'a.md': 'A\n' });
        const { f, env, stubs } = setup([s]);
        const c = codex(env, (p) => ({ action: 'accept', content: { decision: (p.requestedSchema as { properties: { decision: { enum: string[] } } }).properties.decision.enum.at(-1) } }));
        const init = (await c.init()).result as Json;
        assert.equal(init.protocolVersion, '2025-06-18');
        assert.deepEqual(init.serverInfo, { name: 'mcp-skills', title: 'MCP Skills (polyfill)', version: VERSION });
        assert.match(String(init.instructions), /mcp-skills:<server>:<name>/);
        const tools = ((await c.request('tools/list')).result as { tools: { name: string; annotations: Json }[] }).tools;
        assert.deepEqual(tools.map((t) => t.name), ['list_skills', 'load_skill', 'read_skill_file', 'list_skill_directory']);
        assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
        await until(() => stubFiles(stubs).length === 1);
        const loaded = await c.call('load_skill', { server: 'docs', uri: s.uri });
        assert.ok(!loaded.isError, loaded.text);
        assert.match(loaded.text, /<mcp-skill id="[0-9a-f]+" server="docs"/);
        assert.equal(c.asked.length, 1);
        const q = c.asked[0]!;
        assert.equal(q.mode, undefined, 'a 2025-06-18 elicitation carries no mode');
        assert.deepEqual((q.requestedSchema as Json).required, ['decision']);
        assert.deepEqual((q.requestedSchema as { properties: { decision: Json } }).properties.decision.enum, ['no', 'show', 'load']);
        assert.match(String(q.message), /Load the skill "git-workflow" from the MCP server "docs"\?/);
        assert.match((await c.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.md' })).text, /\nA\n/);
        assert.match((await c.call('load_skill', { server: 'docs', uri: s.uri })).text, /approved earlier/);
        assert.equal(c.asked.length, 1, 'not asked again');
        const hello = (f.requests('skills/list')[0]!.params._meta as Json)['io.modelcontextprotocol/clientInfo'] as Json;
        assert.deepEqual([hello.name, hello.version], ['mcp-skills-codex', VERSION]);
        assert.equal((await c.request('server/discover')).error !== undefined, true);
        c.child.kill();
    });

    test('a decline, an answer without a choice, an error, and a client that cannot ask: each is a no', async () => {
        const s = skill('git-workflow');
        for (const answer of [() => ({ action: 'decline' }), () => ({ action: 'accept', content: {} }), () => ({ action: 'accept', content: { decision: 'yes please' } }), () => undefined]) {
            const { f, env } = setup([s]);
            const c = codex(env, answer);
            await c.init();
            const r = await c.call('load_skill', { server: 'docs', uri: s.uri });
            assert.ok(r.isError, r.text);
            assert.match(r.text, /not loaded/);
            assert.equal(f.requests('resources/read').length, 0);
            c.child.kill();
        }
        const { env } = setup([s]);
        const mute = codex(env);
        await mute.init({});
        assert.match((await mute.call('load_skill', { server: 'docs', uri: s.uri })).text, /could not be asked \(Codex did not offer to put questions/);
        assert.equal(mute.asked.length, 0);
        mute.child.kill();
    });

    test('it stands down for a client that declares the Skills extension itself: the stubs go, and the tools do nothing', async () => {
        const s = skill('git-workflow');
        const { env, stubs } = setup([s]);
        mkdirSync(stubs, { recursive: true });
        const first = codex(env);
        await first.init();
        await until(() => stubFiles(stubs).length === 1);
        first.child.kill();
        const native = codex(env);
        await native.init({ elicitation: { form: {} }, extensions: { 'io.modelcontextprotocol/skills': {} } });
        await until(() => stubFiles(stubs).length === 0);
        assert.match((await native.call('list_skills', {})).text, /Codex serves MCP skills itself/);
        native.child.kill();
    });
});
