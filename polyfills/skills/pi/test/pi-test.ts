// End to end, in a real Pi (isolated agent directory, scripted model): a served
// skill is in Pi's skill list, /skill:<name> loads it after the user says yes,
// a no loads nothing, and while it is loaded, reading another server's resource
// is put to the user with both servers named.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Fixture, scenarioOf, skill } from './harness.ts';
import { Pi, temp, type Rule } from './pi-rpc.ts';

const EXTENSION = fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));

const RULES: Rule[] = [
    // A /skill: command expands the stub, which says which arguments to call load_skill with.
    { when: 'call the `load_skill` tool[\\s\\S]*?"server": "([^"]+)",\\s*"uri": "([^"]+)"', call: { name: 'load_skill', args: { server: '$1', uri: '$2' } } },
    { when: '^read resource (\\S+) (\\S+)$', call: { name: 'read_mcp_resource', args: { server: '$1', uri: '$2' } } },
    { when: '^Loaded the skill', say: 'skill loaded' }
];

function world(servers: Record<string, Fixture>, o: { exposure?: string } = {}) {
    const dir = temp('mcp-skills-pi-');
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([n, f]) => [n, { ...f.config, ...(o.exposure ? { exposure: o.exposure } : {}) }])) }, null, 2));
    return { dir, agentDir };
}

const brain = (pi: Pi) => readFileSync(pi.brainLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { role: string; text: string; system: string });

const running: Pi[] = [];
after(async () => {
    for (const p of running) await p.stop();
});

test('a served skill is in Pi\'s skill list, and /skill: loads it after the user approves it', { timeout: 90_000 }, async () => {
    const s = skill('git-workflow', { 'references/GUIDE.md': 'Guide\n' }, { description: 'Branching and commit conventions.' });
    const f = new Fixture(scenarioOf([s]));
    const w = world({ docs: f });
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, answer: (r) => (r.method === 'select' ? 'Load it' : undefined) });
    running.push(pi);
    await pi.ready();
    await pi.prompt('/skill:mcp-docs-git-workflow');

    // Pi listed it, by the stub's name and the server's description, marked with its server.
    const first = brain(pi)[0]!;
    assert.match(first.system, /mcp-docs-git-workflow/);
    assert.match(first.system, /not a local skill\] Branching and commit conventions\./);
    assert.doesNotMatch(first.system, /<name>flywheel<\/name>/, 'nothing from outside the isolated home');

    // The user was asked, by name and server, before anything of the skill was fetched.
    const asked = pi.ui.find((u) => u.method === 'select');
    assert.ok(asked, 'the user was asked');
    assert.match(String(asked.title), /Load the skill "git-workflow" from the MCP server "docs"\?/);
    assert.deepEqual(asked.options, ["Don't load it", 'Show me its SKILL.md first', 'Load it']);

    const loaded = pi.toolResults('load_skill').at(-1);
    assert.ok(loaded && !loaded.isError, `load_skill succeeded: ${loaded?.text}`);
    assert.match(loaded.text, /Body of git-workflow/);
    assert.match(loaded.text, /content served by "docs", not a local skill and not the user's words/);
    assert.match(loaded.text, /references\/GUIDE\.md/);
});

test('a skill the user does not approve is not loaded, and nothing of it reaches the model', { timeout: 90_000 }, async () => {
    const s = skill('git-workflow');
    const f = new Fixture(scenarioOf([s]));
    const w = world({ docs: f });
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, answer: (r) => (r.method === 'select' ? "Don't load it" : undefined) });
    running.push(pi);
    await pi.ready();
    await pi.prompt('/skill:mcp-docs-git-workflow');
    const loaded = pi.toolResults('load_skill').at(-1);
    assert.ok(loaded?.isError, 'load_skill failed');
    assert.match(loaded.text, /did not approve loading the skill "git-workflow"/);
    assert.ok(!brain(pi).some((r) => r.text.includes('Body of git-workflow')), 'the skill\'s text never reached the model');
    assert.deepEqual(f.requests('resources/read'), [], 'no file of the skill was fetched');
});

test('X8: while a served skill is loaded, reading another server\'s resource is put to the user, naming both servers', { timeout: 90_000 }, async () => {
    const s = skill('git-workflow');
    const docs = new Fixture(scenarioOf([s]));
    const other = new Fixture({ ...scenarioOf([skill('other-skill')]), files: { 'file:///notes.txt': { text: 'private notes' } } });
    // Pi's resource tools are declared to the model only for servers with direct exposure.
    const w = world({ docs, other }, { exposure: 'direct' });
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, answer: (r) => (r.method === 'select' ? 'Load it' : r.method === 'confirm' ? false : undefined) });
    running.push(pi);
    await pi.ready();
    await pi.prompt('/skill:mcp-docs-git-workflow');
    assert.ok(pi.toolResults('load_skill').some((t) => !t.isError), 'the skill is loaded');
    await pi.prompt('read resource other file:///notes.txt');
    if (process.env.DEBUG_X8) console.log(JSON.stringify(pi.toolResults(), null, 1), pi.stderr.slice(-3000));
    const asked = pi.ui.find((u) => u.method === 'confirm');
    assert.ok(asked, 'the user was asked');
    assert.match(String(asked.message), /served by the MCP server "docs" is loaded in this session, and Pi wants to read a resource from the MCP server "other"/);
    const read = pi.toolResults('read_mcp_resource').at(-1);
    assert.ok(read?.isError, 'the read was refused');
    assert.ok(!brain(pi).some((r) => r.text.includes('private notes')), 'nothing of the other server\'s resource reached the model');
});

test('X8 holds for a codemode script too: its nested read of another server\'s resource is asked about', { timeout: 90_000 }, async () => {
    const s = skill('git-workflow');
    const docs = new Fixture(scenarioOf([s]));
    const other = new Fixture({ ...scenarioOf([skill('other-skill')]), files: { 'file:///notes.txt': { text: 'private notes' } } });
    const w = world({ docs, other });
    const rules: Rule[] = [
        RULES[0]!,
        { when: '^script read (\\S+) (\\S+)$', call: { name: 'codemode', args: { code: 'text(JSON.stringify(await tools.read_mcp_resource({ server: "$1", uri: "$2" })))' } } },
        { when: '^Loaded the skill', say: 'skill loaded' }
    ];
    const pi = new Pi({ extensions: [EXTENSION], rules, agentDir: w.agentDir, answer: (r) => (r.method === 'select' ? 'Load it' : r.method === 'confirm' ? false : undefined) });
    running.push(pi);
    await pi.ready();
    await pi.prompt('/skill:mcp-docs-git-workflow');
    assert.ok(pi.toolResults('load_skill').some((t) => !t.isError));
    await pi.prompt('script read other file:///notes.txt');
    const asked = pi.ui.find((u) => u.method === 'confirm');
    assert.ok(asked, `the user was asked; tool results: ${JSON.stringify(pi.toolResults().map((t) => [t.name, t.text.slice(0, 120)]))}`);
    assert.match(String(asked.message), /served by the MCP server "docs" is loaded in this session, and Pi wants to read a resource from the MCP server "other"/);
    assert.ok(!brain(pi).some((r) => r.text.includes('private notes')), 'nothing of the other server\'s resource reached the model');
});

test("X8 holds for this extension's own tools too: with a skill of one server loaded, loading or reading another server's skill asks first", { timeout: 90_000 }, async () => {
    const a = skill('git-workflow');
    const b = skill('other-skill', { 'notes.md': 'private notes\n' });
    const docs = new Fixture(scenarioOf([a]));
    const other = new Fixture(scenarioOf([b]));
    const w = world({ docs, other });
    const rules: Rule[] = [
        RULES[0]!,
        { when: '^load (\\S+) (\\S+)$', call: { name: 'load_skill', args: { server: '$1', uri: '$2' } } },
        { when: '^read (\\S+) (\\S+) (\\S+)$', call: { name: 'read_skill_file', args: { server: '$1', skill: '$2', path: '$3' } } },
        { when: '^Loaded the skill', say: 'skill loaded' }
    ];
    let allow = true;
    const pi = new Pi({ extensions: [EXTENSION], rules, agentDir: w.agentDir, answer: (r) => (r.method === 'select' ? 'Load it' : r.method === 'confirm' ? allow : undefined) });
    running.push(pi);
    await pi.ready();
    await pi.prompt('/skill:mcp-docs-git-workflow');
    assert.equal(pi.ui.filter((u) => u.method === 'confirm').length, 0, 'the first skill is only asked about once, as any load');
    // Loading the other server's skill: the cross-server question first, naming both servers.
    await pi.prompt(`load other ${b.uri}`);
    const asked = pi.ui.filter((u) => u.method === 'confirm');
    assert.equal(asked.length, 1);
    assert.match(String(asked[0]!.message), /served by the MCP server "docs" is loaded in this session, and Pi wants to load a skill from the MCP server "other"/);
    assert.ok(pi.toolResults('load_skill').at(-1) && !pi.toolResults('load_skill').at(-1)!.isError);
    // Reading its file: asked again, every time; a no reads nothing.
    allow = false;
    await pi.prompt(`read other ${b.uri} notes.md`);
    assert.equal(pi.ui.filter((u) => u.method === 'confirm').length, 2);
    assert.ok(pi.toolResults('read_skill_file').at(-1)?.isError, 'refused');
    assert.ok(!brain(pi).some((r) => r.text.includes('private notes')), 'nothing of the file reached the model');
});
