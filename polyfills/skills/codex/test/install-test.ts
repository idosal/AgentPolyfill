// The plugin as Codex installs and runs it: a copy of mod/ in Codex's plugin cache, which Codex
// replaces with a fresh copy whenever the marketplace is updated. The stubs go where that copy
// doesn't reach, ~/.agents/skills/mcp-skills-served, when the plugin's server starts: on a running
// app-server daemon, that is at the plugin's first tool call.

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

    test('at the plugin\'s first tool call, list_skills, the stubs are in ~/.agents/skills/mcp-skills-served', async () => {
        // On an app-server daemon that kept the plugin's tool list from an earlier session, Codex
        // starts the plugin's server only at its first tool call (can_defer_stdio_startup in
        // codex-rs/config/src/mcp_types.rs). Asking Codex to list the served skills is that call.
        const { home, codexHome } = homes();
        const installed = join(codexHome, 'plugins', 'cache', 'agent-polyfill', 'mcp-skills', VERSION);
        cpSync(join(ROOT, 'mod'), installed, { recursive: true });
        const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) };
        const helper = spawn(process.execPath, ['./dist/helper.js'], { cwd: installed, env, stdio: ['pipe', 'pipe', 'ignore'] });
        running.push(helper);
        let buf = '';
        const answers = new Map<number, (m: Json) => void>();
        helper.stdout!.on('data', (d: Buffer) => {
            buf += d.toString();
            let at: number;
            while ((at = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, at)) as Json;
                buf = buf.slice(at + 1);
                if (typeof m.id === 'number' && m.method === undefined) answers.get(m.id)?.(m);
            }
        });
        const request = (id: number, method: string, params: Json) => new Promise<Json>((done) => {
            answers.set(id, done);
            helper.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        // As Codex makes it when the model calls the tool: the connection, then the call at once.
        await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } });
        helper.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const answer = (await request(2, 'tools/call', { name: 'list_skills', arguments: {} })) as { result: { content: { text: string }[] } };
        // Checked when the answer comes, not after: Codex's next turn lists what is on disk then.
        const stubs = skillFiles(join(home, '.agents', 'skills', 'mcp-skills-served'));
        helper.kill();
        assert.match(answer.result.content[0]!.text, /release-notes/);
        assert.equal(stubs.length, 1, 'the served skill has its stub in ~/.agents/skills/mcp-skills-served');
        assert.match(readFileSync(join(home, '.agents', 'skills', 'mcp-skills-served', stubs[0]!), 'utf8'), /^name: "mcp-skills:docs:release-notes"$/m);
        assert.deepEqual(skillFiles(installed).filter((f) => f.includes('served')), [], 'nothing is written into the plugin\'s folder');
    });

    const codex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0 ? 'codex' : undefined;
    test('in Codex itself: the installed plugin\'s stubs stay through a reinstall, and a new session lists them', { skip: codex ? false : 'codex is not installed here', timeout: 180_000 }, async () => {
        const { home, codexHome } = homes();
        const project = join(temp(), 'project');
        mkdirSync(project, { recursive: true });
        const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
        const run = (...args: string[]) => execFileSync(codex!, args, { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
        run('plugin', 'marketplace', 'add', REPO);
        run('plugin', 'add', 'mcp-skills@agent-polyfill');
        // An app-server holds its sessions' MCP servers, as the daemon does; no turn, so no model is
        // called. Its first session starts the plugin's server, whose tool list it hasn't kept yet.
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
        const session = async () => {
            const r = await request('thread/start', { cwd: project, sandbox: 'read-only', approvalPolicy: 'never' });
            assert.equal(r.error, undefined, JSON.stringify(r.error));
        };
        await session();
        await until(() => servedStubs(home, codexHome).length === 1);
        // A marketplace update: Codex replaces the plugin's folder with a fresh copy.
        run('plugin', 'remove', 'mcp-skills@agent-polyfill');
        run('plugin', 'add', 'mcp-skills@agent-polyfill');
        assert.equal(servedStubs(home, codexHome).length, 1, 'the stub is still there after the plugin folder was replaced');
        await session();
        const listed = await request('skills/list', { cwds: [project], forceReload: true });
        assert.match(JSON.stringify(listed.result), /mcp-skills:docs:release-notes/, 'Codex lists the served skill in the new session');
        server.kill();
    });
});
