// The helper in Muse Code (--host=muse): Muse's settings as the server list, the stubs flat in
// Muse's own skill folder, and the person's yes typed as a message of their own (load <code>),
// read by the bundled UserPromptSubmit hook. Against the fixture server of the Claude Code form.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeAll, Fixture, scenarioOf, skill, temp } from './harness.ts';
import { confirmFromPrompt, flatStubDir, museAsk, museWords, readMuseSkillsConfig, syncFlatStubs } from '../src/muse.ts';
import type { Listed } from '../../core/src/skills.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(ROOT, 'mod', 'muse', 'hooks', 'user-prompt-submit.mjs');
after(closeAll);

const listed = (label: string, uri: string, name = 'git-workflow'): Listed => ({ label, entry: { uri, frontmatter: { name, description: `${name} skill` }, resources: [] } }) as unknown as Listed;

function hook(input: Record<string, unknown>, env: Record<string, string>): string {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

describe('the Muse plugin folder', () => {
    test('the bundled hook is what src/ builds, and the Muse manifest names the same plugin and files that are in the folder', () => {
        const out = temp();
        execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'ignore' });
        assert.equal(readFileSync(join(out, 'user-prompt-submit.mjs'), 'utf8'), readFileSync(HOOK, 'utf8'), 'run npm run build and commit mod/muse/hooks');
        const muse = JSON.parse(readFileSync(join(ROOT, 'mod', '.muse-plugin', 'plugin.json'), 'utf8'));
        assert.equal(muse.name, 'mcp-skills');
        assert.equal(muse.version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
        assert.deepEqual(muse.compat, { source: 'native', manifestDir: '.muse-plugin' });
        assert.deepEqual(muse.capabilities.mcpServers, [{ id: 'mcp-skills', transport: 'stdio', command: ['node', 'dist/helper.js', '--host=muse'] }]);
        assert.deepEqual(muse.capabilities.hooks.map((h: { event: string; command: string[] }) => [h.event, h.command]), [['UserPromptSubmit', ['node', 'muse/hooks/user-prompt-submit.mjs']]]);
        for (const s of muse.capabilities.skills) {
            assert.ok(existsSync(join(ROOT, 'mod', s.path)), s.path);
            assert.ok(!s.path.startsWith('skills/'), 'Codex lists every SKILL.md under skills/');
        }
    });
});

describe('stubs in Muse', () => {
    test('one folder each, directly in Muse\'s skill folder; stale ones go, a configured server not reached keeps its own, nothing else is touched', () => {
        const root = join(temp(), 'skills');
        mkdirSync(join(root, 'my-own-skill'), { recursive: true });
        writeFileSync(join(root, 'my-own-skill', 'SKILL.md'), 'mine');
        const a = listed('github', 'skill://git-workflow/SKILL.md');
        const b = listed('github', 'skill://release/SKILL.md', 'release');
        const c = listed('docs', 'skill://search/SKILL.md', 'search');
        assert.deepEqual(syncFlatStubs(root, { listed: new Map([['github', [a, b]], ['docs', [c]]]), keep: new Set() }), { written: 3, removed: 0, omitted: 0 });
        const stub = readFileSync(join(flatStubDir(root, 'github', 'skill://git-workflow/SKILL.md'), 'SKILL.md'), 'utf8');
        assert.match(stub, /^---\nname: "mcp-skills:github:git-workflow"\n/);
        assert.match(stub, /"uri": "skill:\/\/git-workflow\/SKILL.md"/);
        // A link someone put where a stub folder goes is removed, never followed.
        symlinkSync('/tmp', join(root, 'mcp-skills-served--evil-123456--0123456789abcdef'));
        // github lists one skill now; docs is not reachable but still configured (keep).
        assert.deepEqual(syncFlatStubs(root, { listed: new Map([['github', [a]]]), keep: new Set(['docs']) }), { written: 0, removed: 2, omitted: 0 });
        assert.deepEqual(readdirSync(root).sort(), [flatStubDir(root, 'docs', c.entry.uri), flatStubDir(root, 'github', a.entry.uri)].map((d) => d.slice(root.length + 1)).concat('my-own-skill').sort());
        assert.equal(readFileSync(join(root, 'my-own-skill', 'SKILL.md'), 'utf8'), 'mine');
    });
});

describe("the person's yes, typed", () => {
    test('a question waits for exactly "load <code>" in a message of the person\'s own, in the same session, once', async () => {
        const dir = temp();
        const s = randomUUID();
        const ask = museAsk(dir, s);
        const first = await ask('Load the skill "x" from the MCP server "srv"?\nURI: skill://x/SKILL.md', ['no', 'show', 'load']);
        assert.ok('pending' in first);
        const code = /exactly: load (\d{4})\b/.exec((first as { pending: string }).pending)![1]!;
        assert.match((first as { pending: string }).pending, /Show them this question as it is:\n\nLoad the skill "x"/);
        // Asked again before the person answered: the same code.
        assert.match(((await ask('Load the skill "x" from the MCP server "srv"?\nURI: skill://x/SKILL.md', ['no', 'show', 'load'])) as { pending: string }).pending, new RegExp(`load ${code}\\b`));
        assert.equal(confirmFromPrompt(dir, s, `please load ${code}`), undefined, 'the whole message, nothing else');
        assert.equal(confirmFromPrompt(dir, randomUUID(), `load ${code}`), undefined, 'another session');
        assert.equal(confirmFromPrompt(dir, s, ` Load ${code} `), 'Load the skill "x" from the MCP server "srv"?');
        assert.deepEqual(await ask('Load the skill "y" from the MCP server "srv"?', ['no', 'show', 'load']).then((a) => 'pending' in a), true, 'a different question is not approved');
    });

    test('the yes is for that question only, and runs out', async () => {
        const dir = temp();
        const s = randomUUID();
        let t = 1_000_000;
        const ask = museAsk(dir, s, () => t);
        const code = /load (\d{4})/.exec(((await ask('Q1', ['load'])) as { pending: string }).pending)![1]!;
        assert.ok(confirmFromPrompt(dir, s, `load ${code}`, t));
        assert.deepEqual(await ask('Q1', ['load']), { decision: 'load' });
        assert.ok('pending' in (await ask('Q1', ['load'])), 'once');
        const again = /load (\d{4})/.exec(((await ask('Q1', ['load'])) as { pending: string }).pending)![1]!;
        t += 16 * 60 * 1000;
        assert.equal(confirmFromPrompt(dir, s, `load ${again}`, t), undefined, 'a question waits 15 minutes');
        assert.deepEqual(await museAsk(dir, undefined)('Q', ['load']).then((a) => 'unavailable' in a), true);
    });

    test('the bundled hook approves only the waiting question, tells the model, and prints nothing otherwise', async () => {
        const dir = temp();
        const s = randomUUID();
        const env = { MUSE_PLUGIN_DATA_DIR: dir, HOME: dir };
        assert.equal(hook({ session_id: s, prompt: 'load 1234' }, env), '');
        const code = /load (\d{4})/.exec(((await museAsk(dir, s)('Load the skill "x"?', ['load'])) as { pending: string }).pending)![1]!;
        const out = JSON.parse(hook({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: `load ${code}` }, env));
        assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
        assert.match(out.hookSpecificOutput.additionalContext, /they approve "Load the skill "x"\?"\. Call load_skill again/);
        assert.equal(out.systemMessage, 'mcp-skills: you approved: Load the skill "x"?');
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ off: true }));
        assert.equal(hook({ session_id: s, prompt: `load ${code}` }, env), '', 'off in its settings');
        assert.equal(spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' }).status, 0);
    });
});

describe('Muse words and settings', () => {
    test('what the plugin says names Muse and its commands', () => {
        assert.equal(museWords('approved in an interactive Codex session; codex mcp login x; http_headers in config.toml'), "approved in an interactive Muse session; muse mcp login x; headers in Muse's settings.json");
    });

    test("the servers are Muse's settings, narrowed by the plugin's settings", () => {
        const home = temp();
        mkdirSync(join(home, '.config', 'muse'), { recursive: true });
        writeFileSync(join(home, '.config', 'muse', 'settings.json'), JSON.stringify({ mcpServers: { hf: { type: 'http', url: 'https://huggingface.co/mcp' }, other: { type: 'http', url: 'https://o.example/mcp' } } }));
        const r = readMuseSkillsConfig({ HOME: home }, { skip: ['other'] });
        assert.deepEqual(Object.keys(r.table.servers), ['hf']);
        assert.equal(r.file, join(home, '.config', 'muse', 'settings.json'));
    });
});

describe('the helper in Muse', () => {
    test('a served skill gets a stub in Muse\'s skill folder; loading it waits for the person\'s typed yes, then loads, and later loads without asking', async () => {
        const s = skill('git-workflow', { 'refs/guide.md': '# Guide' });
        const f = new Fixture(scenarioOf([s]));
        const home = temp();
        mkdirSync(join(home, '.config', 'muse'), { recursive: true });
        writeFileSync(join(home, '.config', 'muse', 'settings.json'), JSON.stringify({ mcpServers: { github: { type: 'stdio', ...f.config } } }));
        const data = join(home, 'data');
        const session = randomUUID();
        const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', MUSE_SESSION_ID: session, MUSE_PLUGIN_ID: 'mcp-skills', MUSE_PLUGIN_DATA_DIR: data };
        const child: ChildProcess = spawn(process.execPath, ['--no-warnings', join(ROOT, 'src', 'helper.ts'), '--host=muse'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr!.on('data', (d) => (stderr += d));
        const waiting = new Map<number, (m: { result?: { content: { text: string }[]; isError?: boolean; tools?: { description: string }[] } }) => void>();
        createInterface({ input: child.stdout! }).on('line', (l) => {
            const m = JSON.parse(l);
            waiting.get(m.id)?.(m);
        });
        let id = 0;
        const request = (method: string, params: Record<string, unknown>) =>
            new Promise<{ result?: { content: { text: string }[]; isError?: boolean; tools?: { description: string }[] } }>((r) => {
                waiting.set(++id, r);
                child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        const call = async (name: string, args: Record<string, unknown>) => {
            const r = await request('tools/call', { name, arguments: args, _meta: { callId: 'call_1', idempotencyKey: 'tool:call_1' } });
            return { text: r.result!.content.map((c) => c.text).join(''), isError: r.result!.isError === true };
        };
        try {
            // Muse's client: no capabilities at all, so no form.
            await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tbh', version: '0.1.0' } });
            const tools = (await request('tools/list', {})).result!.tools!;
            assert.ok(tools.every((t) => !t.description.includes('Codex')), 'named for Muse');
            const root = join(home, '.config', 'muse', 'skills');
            const deadline = Date.now() + 15000;
            while (!(existsSync(root) && readdirSync(root).some((d) => d.startsWith('mcp-skills-served--github-'))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
            const stubDir = readdirSync(root).find((d) => d.startsWith('mcp-skills-served--github-'))!;
            assert.ok(existsSync(join(root, stubDir, 'SKILL.md')), stderr);
            const first = await call('load_skill', { server: 'github', uri: s.uri });
            assert.equal(first.isError, true);
            assert.match(first.text, /^The skill is not loaded yet\. Muse gives this plugin no way to ask the person/);
            assert.match(first.text, /Load the skill "git-workflow" from the MCP server "github"\?/);
            assert.match(first.text, /through Muse's usual approvals/);
            const code = /exactly: load (\d{4})/.exec(first.text)![1]!;
            assert.equal(f.requests('resources/read').length, 0, 'nothing of the skill was read');
            assert.match(hook({ session_id: session, prompt: `load ${code}` }, { MUSE_PLUGIN_DATA_DIR: data }), /approve/);
            const loaded = await call('load_skill', { server: 'github', uri: s.uri });
            assert.equal(loaded.isError, false, loaded.text);
            assert.match(loaded.text, /git-workflow/);
            const later = await call('load_skill', { server: 'github', uri: s.uri });
            assert.equal(later.isError, false, 'approved before, unchanged: no question');
        } finally {
            child.stdin!.end();
            child.kill();
        }
    });
});
