// The helper process as an installed copy runs it: the bundle in mod/dist/, started
// with nothing but its environment, spoken to as the hooks module speaks to it.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Fixture, scenarioOf, skill } from './harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'mod', 'dist', 'helper.js');
// What the bundle runs on: this Node, or (HELPER_RUNTIME=/path/to/bun) another runtime, as the mod starts it there.
const RUNTIME = process.env.HELPER_RUNTIME ? [process.env.HELPER_RUNTIME] : [process.execPath, '--no-warnings'];
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));

type Message = Record<string, unknown>;
async function startHelper(env: Record<string, string>): Promise<{ messages: Message[]; post: (route: string, body?: unknown, token?: string) => Promise<{ status: number; json: Message }>; next: (t: string) => Promise<Message>; child: ChildProcess }> {
    const state = mkdtempSync(join(tmpdir(), 'mcp-skills-helper-'));
    const child = spawn(RUNTIME[0]!, [...RUNTIME.slice(1), BUNDLE], { env: { PATH: process.env.PATH ?? '', HOME: state, MCP_SKILLS_STATE: state, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    const messages: Message[] = [];
    const waiters: (() => void)[] = [];
    let buffer = '';
    child.stdout!.on('data', (d: Buffer) => {
        buffer += String(d);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            messages.push(JSON.parse(buffer.slice(0, end)) as Message);
            buffer = buffer.slice(end + 1);
        }
        waiters.splice(0).forEach((w) => w());
    });
    const next = async (t: string): Promise<Message> => {
        for (const end = Date.now() + 15_000; Date.now() < end; ) {
            const found = messages.find((m) => m.t === t);
            if (found) return found;
            await new Promise<void>((r) => {
                waiters.push(r);
                setTimeout(r, 200);
            });
        }
        throw new Error(`the helper never said ${t}`);
    };
    const ready = await next('ready');
    const post = async (route: string, body: unknown = {}, token = String(ready.token)) => {
        const r = await fetch(`${String(ready.url)}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        return { status: r.status, json: (await r.json()) as Message };
    };
    return { messages, post, next, child };
}

describe('the bundled helper', () => {
    test('mod/dist/helper.js is what src/ builds', () => {
        const out = mkdtempSync(join(tmpdir(), 'mcp-skills-bundle-'));
        const built = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), out], { encoding: 'utf8' });
        assert.equal(built.status, 0, built.stderr);
        assert.ok(readFileSync(join(out, 'helper.js')).equals(readFileSync(BUNDLE)), 'mod/dist/helper.js is stale: run `npm run build`');
    });

    test('with a servers file of the user\'s own: lists, loads and reads, answering only to its token', async () => {
        const s = skill('git-workflow', { 'references/commits.md': 'Use the imperative mood.\n' });
        const f = new Fixture(scenarioOf([s]));
        const cfgDir = mkdtempSync(join(tmpdir(), 'mcp-skills-cfg-'));
        const project = mkdtempSync(join(tmpdir(), 'mcp-skills-proj-'));
        const config = join(cfgDir, 'servers.json');
        writeFileSync(config, JSON.stringify({ mcpServers: { docs: f.config } }));
        const h = await startHelper({ MCP_SKILLS_CONFIG: config, CLAUDE_PROJECT_DIR: project });
        const catalog = await h.next('catalog');
        assert.equal(catalog.skills, 1);
        assert.match(String(catalog.text), /- git-workflow \(MCP server "docs", uri skill:\/\/git-workflow\/SKILL\.md\)/);
        assert.equal(h.messages.some((m) => m.t === 'servers'), false, 'a servers file of the user\'s own is not Claude Code\'s list: Claude Code is not asked about it');

        assert.equal((await h.post('/tool', { name: 'list_skills' }, 'wrong-token')).status, 401);
        assert.equal((await fetch(`${String((await h.next('ready')).url)}/tool`)).status, 401);
        const loaded = await h.post('/tool', { name: 'load_skill', input: { server: 'docs', uri: s.uri } });
        assert.equal(loaded.status, 200);
        assert.match(String(loaded.json.text), /^Loaded the skill "git-workflow" from the MCP server "docs"/);
        const acting = loaded.json.acting as Record<string, string>;
        assert.deepEqual({ server: acting.server, uri: acting.uri, name: acting.name, root: acting.root }, { server: 'docs', uri: s.uri, name: 'git-workflow', root: s.root });
        assert.match(acting.hash!, /^sha256:[0-9a-f]{64}$/);
        // What the person is asked about is the same content, by the same measure, with no file fetched.
        const facts = (await h.post('/entry', { server: 'docs', uri: s.uri })).json;
        assert.equal(facts.hash, acting.hash);
        assert.equal(facts.fingerprint, acting.fingerprint);
        const file = await h.post('/tool', { name: 'read_skill_file', input: { server: 'docs', skill: s.uri, path: 'references/commits.md' } });
        assert.match(String(file.json.text), /Use the imperative mood\./);
        assert.match(String((await h.post('/status')).json.text), /git-workflow .*\[loaded in this session\]/);
        // The conversation is cleared: nothing of the skill is readable until it is loaded again.
        await h.post('/release');
        const after = await h.post('/tool', { name: 'read_skill_file', input: { server: 'docs', skill: s.uri, path: 'references/commits.md' } });
        assert.equal(after.json.isError, true);
        await h.post('/stop');
        await new Promise((r) => h.child.once('exit', r));
    });

    test('a server found not to serve skills is remembered, and not connected to again at the next start; /refresh looks again', async () => {
        const [serves, plain] = [new Fixture(scenarioOf([skill('kept-skill')])), new Fixture({ caps: 'none' })];
        const cfgDir = mkdtempSync(join(tmpdir(), 'mcp-skills-cfg-'));
        const state = mkdtempSync(join(tmpdir(), 'mcp-skills-state-'));
        const config = join(cfgDir, 'servers.json');
        writeFileSync(config, JSON.stringify({ mcpServers: { serves: serves.config, plain: plain.config } }));
        const env = { MCP_SKILLS_CONFIG: config, CLAUDE_PROJECT_DIR: mkdtempSync(join(tmpdir(), 'mcp-skills-proj-')), MCP_SKILLS_STATE: state };
        const first = await startHelper(env);
        assert.equal((await first.next('ready')).expects, 2, 'neither server has been looked at: the session waits a moment for both');
        await first.next('catalog');
        assert.ok(plain.requests().length > 0, 'the first session looks at every server');
        await first.post('/stop');
        await new Promise((r) => first.child.once('exit', r));
        const looked = plain.requests().length;

        const second = await startHelper(env);
        assert.equal((await second.next('ready')).expects, 1, 'one server is known to serve skills: the session waits a moment for it');
        assert.match(String((await second.next('catalog')).text), /kept-skill/);
        assert.equal(plain.requests().length, looked, 'the server that serves no skills was not connected to again');
        assert.match(String((await second.post('/status')).json.text), /Not looked at this time[^\n]*"plain"/);
        // The server gains skills; the user asks for another look.
        plain.change((sc) => Object.assign(sc, scenarioOf([skill('new-skill')]), { caps: 'skills' }));
        await second.post('/refresh');
        assert.match(String((await second.post('/status')).json.text), /new-skill/);
        await second.post('/stop');
    });

    test('a server that hangs does not hold back the others: their skills are sent as each is done, and the listing is marked complete once every server has been looked at', async () => {
        const f = new Fixture(scenarioOf([skill('quick-skill')]));
        const cfgDir = mkdtempSync(join(tmpdir(), 'mcp-skills-cfg-'));
        const config = join(cfgDir, 'servers.json');
        // A local server that starts and never answers.
        writeFileSync(config, JSON.stringify({ mcpServers: { quick: f.config, hung: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e9)'] } } }));
        const started = Date.now();
        const h = await startHelper({ MCP_SKILLS_CONFIG: config, CLAUDE_PROJECT_DIR: mkdtempSync(join(tmpdir(), 'mcp-skills-proj-')), MCP_SKILLS_CONNECT_TIMEOUT_MS: '4000' });
        const first = await h.next('catalog');
        assert.ok(Date.now() - started < 3000, `the first listing took ${Date.now() - started} ms`);
        assert.equal(first.complete, false);
        assert.match(String(first.text), /quick-skill/);
        for (const end = Date.now() + 10_000; !h.messages.some((m) => m.t === 'catalog' && m.complete === true) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
        const complete = h.messages.find((m) => m.t === 'catalog' && m.complete === true);
        assert.ok(complete, 'the listing is said to be complete once the hung server has timed out');
        assert.match(String(complete.text), /quick-skill/);
        assert.match(String((await h.post('/status')).json.text), /Not used: "hung"/);
        await h.post('/stop');
    });

    test('with Claude Code\'s own config: connects only to servers Claude Code says it uses', async () => {
        const [used, refused] = [new Fixture(scenarioOf([skill('used-skill')])), new Fixture(scenarioOf([skill('refused-skill')]))];
        const home = mkdtempSync(join(tmpdir(), 'mcp-skills-home-'));
        const project = join(home, 'proj');
        writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { used: used.config, refused: refused.config }, projects: { [project]: { hasTrustDialogAccepted: true } } }));
        const h = await startHelper({ HOME: home, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: '' });
        const asked = await h.next('servers');
        assert.deepEqual((asked.names as string[]).sort(), ['refused', 'used']);
        assert.equal(used.requests().length + refused.requests().length, 0, 'nothing is connected to before Claude Code has answered');
        await h.post('/verdict', { name: 'used', ok: true });
        await h.post('/verdict', { name: 'refused', ok: false, reason: 'disabled' });
        const catalog = await h.next('catalog');
        assert.match(String(catalog.text), /used-skill/);
        assert.doesNotMatch(String(catalog.text), /refused-skill/);
        assert.equal(refused.requests().length, 0, 'a server Claude Code has switched off is never connected to');
        assert.match(String((await h.post('/status')).json.text), /Not used: "refused": it is switched off in Claude Code\./);
        await h.post('/stop');
    });
});
