// The plugin as Codex installs and runs it: a copy of mod/ in Codex's plugin cache, which Codex
// replaces with a fresh copy whenever the marketplace is updated, started with each session even
// on an app-server daemon that already holds the plugin's tool list.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { VERSION } from '../src/version.ts';
import { Fixture, scenarioOf, skill, temp } from './harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(ROOT, '..', '..', '..');
type Json = Record<string, unknown>;
const running: ChildProcess[] = [];
after(() => running.forEach((c) => c.kill()));

/** Every SKILL.md under a folder, as paths relative to it. */
const skillFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((p) => p.endsWith('SKILL.md')) : []);
/** The served stubs in the skill roots Codex reads for this home: the user's and the plugin's. */
const servedStubs = (home: string, codexHome: string): string[] =>
    [join(home, '.agents', 'skills'), join(codexHome, 'skills'), join(codexHome, 'plugins', 'cache')].flatMap((root) => skillFiles(root).map((p) => join(root, p))).filter((p) => readFileSync(p, 'utf8').includes('not a local skill'));

async function until(check: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** A throwaway HOME and CODEX_HOME whose config holds one hand-written skills server. */
function homes() {
    const s = skill('release-notes', { 'a.md': 'A\n' });
    const f = new Fixture(scenarioOf([s]));
    const base = temp();
    const home = join(base, 'home');
    const codexHome = join(base, 'codex-home');
    mkdirSync(join(home, '.agents', 'skills', 'my-own'), { recursive: true });
    writeFileSync(join(home, '.agents', 'skills', 'my-own', 'SKILL.md'), '---\nname: my-own\ndescription: The user\'s own skill.\n---\n\nMine.\n');
    mkdirSync(codexHome, { recursive: true });
    const cfg = f.config;
    writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.docs]\ncommand = ${JSON.stringify(cfg.command)}\nargs = ${JSON.stringify(cfg.args)}\nenv = { FIXTURE_SCENARIO = ${JSON.stringify(cfg.env!.FIXTURE_SCENARIO)}, FIXTURE_LOG = ${JSON.stringify(cfg.env!.FIXTURE_LOG)} }\n`);
    return { home, codexHome, f };
}

describe('installed by Codex', () => {
    test('the stubs survive the plugin folder being copied afresh, as a marketplace update does', async () => {
        const { home, codexHome } = homes();
        const installed = join(codexHome, 'plugins', 'cache', 'agent-polyfill', 'mcp-skills', VERSION);
        const install = () => {
            rmSync(installed, { recursive: true, force: true });
            cpSync(join(ROOT, 'mod'), installed, { recursive: true });
        };
        install();
        // Started as Codex starts it: from the installed folder, with a small environment, no overrides.
        const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) };
        const helper = spawn(process.execPath, ['./dist/helper.js'], { cwd: installed, env, stdio: ['pipe', 'pipe', 'ignore'] });
        running.push(helper);
        helper.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } } })}\n`);
        await until(() => servedStubs(home, codexHome).length === 1);
        helper.kill();
        install();
        const left = servedStubs(home, codexHome);
        assert.equal(left.length, 1, 'the served skill is still in a skill root Codex reads');
        assert.ok(left[0]!.startsWith(join(home, '.agents', 'skills', 'mcp-skills-served')), left[0]);
        assert.match(readFileSync(left[0]!, 'utf8'), /^name: "mcp-skills:docs:release-notes"$/m, 'listed under the same name as before');
        assert.equal(readFileSync(join(home, '.agents', 'skills', 'my-own', 'SKILL.md'), 'utf8'), '---\nname: my-own\ndescription: The user\'s own skill.\n---\n\nMine.\n', 'the user\'s own skills are untouched');
        assert.deepEqual(readdirSync(join(home, '.agents', 'skills')).sort(), ['mcp-skills-served', 'my-own']);
    });

    test('Codex is told not to keep the plugin\'s tool list, so it starts the plugin\'s server with every session', async () => {
        // Codex 0.172 puts off starting a stdio server whose tool list it has kept from an earlier
        // session (on a daemon) until one of its tools is called, unless the server is required
        // (can_defer_stdio_startup in codex-rs/config/src/mcp_types.rs) or it declares that its tool
        // list is not to be kept (codex/tool-catalog-cache, codex-rs/codex-mcp/src/rmcp_client.rs).
        // The stubs are written when the server starts. Required would block every Codex session
        // while the server can't start (no Node), so it is not.
        const server = (JSON.parse(readFileSync(join(ROOT, 'mod', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, Json> }).mcpServers['mcp-skills']!;
        assert.notEqual(server.required, true, 'a required server that cannot start stops every Codex session');
        const { home } = homes();
        const installed = join(temp(), 'mcp-skills');
        cpSync(join(ROOT, 'mod'), installed, { recursive: true });
        const helper = spawn(process.execPath, ['./dist/helper.js'], { cwd: installed, env: { PATH: process.env.PATH ?? '', HOME: home, MCP_SKILLS_STATE: join(home, 'state'), MCP_SKILLS_STUBS: join(home, 'stubs'), ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
        running.push(helper);
        let out = '';
        helper.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        helper.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } } })}\n`);
        await until(() => out.includes('\n'));
        helper.kill();
        const reply = JSON.parse(out.slice(0, out.indexOf('\n'))) as { result: { capabilities: { experimental?: Record<string, Json> } } };
        assert.deepEqual(reply.result.capabilities.experimental?.['codex/tool-catalog-cache'], { cacheable: false });
    });

    const codex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0 ? 'codex' : undefined;
    test('in Codex itself: one app-server, several sessions, a reinstall between them', { skip: codex ? false : 'codex is not installed here', timeout: 180_000 }, async () => {
        const { home, codexHome } = homes();
        const project = join(temp(), 'project');
        mkdirSync(project, { recursive: true });
        const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
        const run = (...args: string[]) => execFileSync(codex!, args, { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
        run('plugin', 'marketplace', 'add', REPO);
        run('plugin', 'add', 'mcp-skills@agent-polyfill');
        const starts = () => (existsSync(join(codexHome, 'mcp-skills', 'mcp-skills.log')) ? readFileSync(join(codexHome, 'mcp-skills', 'mcp-skills.log'), 'utf8').split('\n').filter((l) => l.includes('server(s) to look at')).length : 0);
        // An app-server holds its sessions' MCP servers, as the daemon does; no turn, so no model is called.
        const server = spawn(codex!, ['app-server'], { env, cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
        running.push(server);
        let buf = '';
        let id = 0;
        const answers = new Map<number, (m: Json) => void>();
        server.stdout!.on('data', (d: Buffer) => {
            buf += d.toString();
            let at: number;
            while ((at = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, at)) as Json;
                buf = buf.slice(at + 1);
                if (typeof m.id === 'number' && m.method === undefined) answers.get(m.id)?.(m);
            }
        });
        const request = (method: string, params: Json) => new Promise<Json>((done) => {
            const n = ++id;
            answers.set(n, done);
            server.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
        });
        await request('initialize', { clientInfo: { name: 'mcp-skills-test', version: '0' }, capabilities: { experimentalApi: true } });
        server.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        const session = async (n: number) => {
            const r = await request('thread/start', { cwd: project, sandbox: 'read-only', approvalPolicy: 'never' });
            assert.equal(r.error, undefined, JSON.stringify(r.error));
            await until(() => starts() >= n);
        };
        await session(1);
        await until(() => servedStubs(home, codexHome).length === 1);
        await session(2);
        await session(3);
        assert.equal(starts(), 3, 'the plugin\'s server started with each session');
        // A marketplace update: Codex replaces the plugin's folder with a fresh copy.
        run('plugin', 'remove', 'mcp-skills@agent-polyfill');
        run('plugin', 'add', 'mcp-skills@agent-polyfill');
        assert.equal(servedStubs(home, codexHome).length, 1, 'the stub is still there after the plugin folder was replaced');
        server.kill();
    });
});
