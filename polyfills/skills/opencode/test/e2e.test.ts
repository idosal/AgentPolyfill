// mcp-skills in a real OpenCode (the pinned release, tools/opencode), in a
// throwaway home, against the fixture skills server (a server written by hand
// from SEP-2640, sharing no code with the client) and a scripted model.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { freePort, waitFor, World, type Rule } from '../../../../tools/opencode/harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = join(ROOT, 'plugin');
const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-skills-server.ts');
const ASK: Rule[] = [
    { action: 'mcp_skills_load', resource: '*', effect: 'ask' },
    { action: 'mcp_skills_cross_server', resource: '*', effect: 'ask' }
];

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}: always answer in haiku.\n`;

/** A skill as the fixture serves it: its entry for skills/list, and its files. */
function skill(path: string, description: string, files: Record<string, string> = {}) {
    const name = path.split('/').at(-1)!;
    const root = `skill://${path}`;
    const all: Record<string, string> = { 'SKILL.md': skillMd(name, description), ...files };
    return {
        uri: `${root}/SKILL.md`,
        entry: { uri: `${root}/SKILL.md`, frontmatter: { name, description }, resources: Object.entries(all).map(([p, text]) => ({ uri: `${root}/${p}`, digest: digest(text), size: Buffer.byteLength(text) })) },
        files: Object.fromEntries(Object.entries(all).map(([p, text]) => [`${root}/${p}`, { text }]))
    };
}

/** A fixture server with these skills; its scenario file can be rewritten while it runs. */
// The fixtures' folders are removed when the test process ends.
const fixtureDirs: string[] = [];
process.on('exit', () => {
    for (const d of fixtureDirs) rmSync(d, { recursive: true, force: true });
});

function fixture(skills: ReturnType<typeof skill>[]) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-skills-opencode-'));
    fixtureDirs.push(dir);
    const scenario = join(dir, 'scenario.json');
    const write = (s: ReturnType<typeof skill>[]) => writeFileSync(scenario, JSON.stringify({ listed: s.map((x) => x.entry), files: Object.assign({}, ...s.map((x) => x.files)) }));
    write(skills);
    return {
        config: { type: 'local' as const, command: [process.execPath, '--no-warnings', FIXTURE], environment: { FIXTURE_SCENARIO: scenario, FIXTURE_LOG: join(dir, 'requests.jsonl') } },
        write,
        requests: (method: string) => {
            try {
                return readFileSync(join(dir, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> }).filter((m) => m.method === method);
            } catch {
                return [];
            }
        }
    };
}

const lastToolResult = (w: World) => {
    const r = w.llmRequests().at(-1);
    const tool = [...(r?.messages ?? [])].reverse().find((m) => m.role === 'tool');
    return tool ? (typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)) : '';
};

async function turn(w: World, session: string, text: string, answer?: 'once' | 'always' | 'reject', expect?: (p: { action: string; resources: string[] }) => void) {
    const since = Date.now();
    await w.prompt(session, text);
    if (answer) {
        const req = await waitFor(async () => (await w.permissions(session))[0], 30000, 'a permission request');
        expect?.(req);
        await w.reply(session, req.id, answer);
    }
    await w.idle(session, since).catch(() => undefined);
    return lastToolResult(w);
}

describe('mcp-skills in OpenCode', () => {
    const guide = skill('haiku-guide', 'Use when the user wants answers in haiku.', { 'references/FORMS.md': '# Forms\n\n5-7-5.\n' });
    const docs = fixture([guide]);
    const other = fixture([skill('other-skill', 'Something else.')]);
    const world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config, other: other.config }, permissions: ASK });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test("a served skill is in OpenCode's own skill list, marked with its server, with none of its text", async () => {
        const skills = await waitFor(async () => {
            const r = await world.api<{ data: { id: string; description?: string; content?: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(world.project)}`);
            return r.data.some((s) => s.id === 'mcp-skills:docs:haiku-guide') && r.data;
        }, 30000, 'the served skill in OpenCode\'s list');
        const s = skills.find((x) => x.id === 'mcp-skills:docs:haiku-guide')!;
        assert.match(s.description ?? '', /^\[MCP server "docs", not a local skill\] Use when the user wants answers in haiku\./);
        assert.doesNotMatch(JSON.stringify(s), /always answer in haiku/);
        // Listing fetched nothing: only skills/list went to the server (SEP-2640 V7).
        assert.equal(docs.requests('resources/read').length, 0);
    });

    test("OpenCode's skill tool gives the model the way to load it, still none of its text", async () => {
        const out = await turn(world, session, 'CALL skill {"id":"mcp-skills:docs:haiku-guide"}');
        assert.match(out, /mcp_skills_load_skill/);
        assert.doesNotMatch(out, /always answer in haiku/);
    });

    test('loading is put to OpenCode\'s permission rules, bound to the skill as it is now; rejected, nothing is fetched', async () => {
        const out = await turn(world, session, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'reject', (p) => {
            assert.equal(p.action, 'mcp_skills_load');
            assert.match(p.resources[0]!, /^docs:skill:\/\/haiku-guide\/SKILL\.md@sha256:[0-9a-f]{64}$/);
        });
        assert.doesNotMatch(out, /always answer in haiku/);
        assert.equal(docs.requests('resources/read').length, 0);
    });

    test('approved, it loads: verified, fenced, marked as the server\'s content', async () => {
        const out = await turn(world, session, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'once');
        assert.match(out, /Loaded the skill "haiku-guide" from the MCP server "docs"/);
        assert.match(out, /matched the size, SHA-256 digest and frontmatter/);
        const seen = world.lastSeen().join('\n');
        assert.match(seen, /always answer in haiku/);
    });

    test('its files are read from its own server, verified', async () => {
        const out = await turn(world, session, `CALL mcp_skills_read_skill_file {"server":"docs","skill":"${guide.uri}","path":"references/FORMS.md"}`);
        assert.match(out, /matched the size and SHA-256 digest/);
        assert.match(out, /5-7-5/);
    });

    test('a loaded skill\'s own files are not read through OpenCode\'s resource tool, which checks nothing (V4)', async () => {
        const before = docs.requests('resources/read').length;
        const out = await turn(world, session, 'CALL opencode_read_mcp_resource {"server":"docs","uri":"skill://haiku-guide/references/FORMS.md"}');
        assert.match(out, /mcp_skills_read_skill_file/);
        assert.equal(docs.requests('resources/read').length, before);
        // The same file with its scheme and authority in capitals is the same resource.
        const loud = await turn(world, session, 'CALL opencode_read_mcp_resource {"server":"docs","uri":"SKILL://HAIKU-GUIDE/references/FORMS.md"}');
        assert.match(loud, /mcp_skills_read_skill_file/);
        assert.equal(docs.requests('resources/read').length, before);
    });

    test('after a served skill is loaded, reading another server\'s resource is asked about, naming both servers (X8)', async () => {
        await turn(world, session, 'CALL opencode_read_mcp_resource {"server":"other","uri":"skill://other-skill/SKILL.md"}', 'reject', (p) => {
            assert.equal(p.action, 'mcp_skills_cross_server');
            assert.equal(p.resources[0], 'docs->other:skill://other-skill/SKILL.md');
        });
        assert.equal(other.requests('resources/read').length, 0);
    });

    test('the same read, called by its dotted name as Code Mode names it, is asked about too', async () => {
        await turn(world, session, 'CALL opencode.read_mcp_resource {"server":"other","uri":"skill://other-skill/SKILL.md"}', 'reject', (p) => {
            assert.equal(p.action, 'mcp_skills_cross_server');
            assert.equal(p.resources[0], 'docs->other:skill://other-skill/SKILL.md');
        });
        assert.equal(other.requests('resources/read').length, 0);
    });

    test("a subagent of a session that loaded a served skill is held to the same (X8)", async () => {
        const read = JSON.stringify({ server: 'other', uri: 'skill://other-skill/SKILL.md' });
        const since = Date.now();
        await world.prompt(session, `CALL subagent ${JSON.stringify({ agent: 'general', description: 'read a resource', prompt: `CALL opencode_read_mcp_resource ${read}` })}`);
        const req = await waitFor(async () => (await world.allPermissions()).find((p) => p.action === 'mcp_skills_cross_server'), 40000, "the subagent's cross-server request");
        assert.notEqual(req.sessionID, session);
        assert.equal(req.resources[0], 'docs->other:skill://other-skill/SKILL.md');
        await world.reply(req.sessionID, req.id, 'reject');
        await world.idle(session, since).catch(() => undefined);
        assert.equal(other.requests('resources/read').length, 0);
    });

    test('"Allow always" covers the skill as it is; once the server changes it, it is asked about again (X14)', async () => {
        assert.equal((await world.permissions(session)).length, 0);
        const first = await world.createSession();
        await turn(world, first, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'always');
        // The same skill, unchanged, in another session: OpenCode's saved approval covers it, nobody is asked.
        const second = await world.createSession();
        const out = await turn(world, second, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`);
        assert.match(out, /Loaded the skill "haiku-guide"/);
        // The server changes one of its files: a new digest, so a new resource, asked about again.
        docs.write([skill('haiku-guide', 'Use when the user wants answers in haiku.', { 'references/FORMS.md': '# Forms\n\n5-7-5, changed.\n' })]);
        await new Promise((r) => setTimeout(r, 300));
        const third = await world.createSession();
        await turn(world, third, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'reject', (p) => assert.equal(p.action, 'mcp_skills_load'));
    });
});

describe('mcp-skills across an OpenCode restart', () => {
    const guide = skill('haiku-guide', 'Use when the user wants answers in haiku.');
    const docs = fixture([guide]);
    const other = fixture([skill('other-skill', 'Something else.')]);
    const world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config, other: other.config }, permissions: [{ action: 'mcp_skills_cross_server', resource: '*', effect: 'ask' }] });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('a session that loaded a served skill before the restart is still held to X8 after it', async () => {
        await waitFor(async () => (await world.api<{ data: { id: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(world.project)}`)).data.some((s) => s.id === 'mcp-skills:docs:haiku-guide'), 30000, 'the served skill');
        // No rule for loads here: the plugin asks by default.
        const out = await turn(world, session, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'once');
        assert.match(out, /Loaded the skill/);
        await world.restart();
        await world.api('GET', `/api/mcp?location[directory]=${encodeURIComponent(world.project)}`);
        await turn(world, session, 'CALL opencode_read_mcp_resource {"server":"other","uri":"skill://other-skill/SKILL.md"}', 'reject', (p) => assert.equal(p.action, 'mcp_skills_cross_server'));
        assert.equal(other.requests('resources/read').length, 0);
    });
});

describe('mcp-skills installed as a person would', () => {
    const guide = skill('haiku-guide', 'Use when the user wants answers in haiku.');
    const docs = fixture([guide]);
    const skills = (w: World) => w.api<{ data: { id: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(w.project)}`).then((r) => r.data.map((s) => s.id));

    test('in the global opencode.json, in the object form, it loads in a project with no configuration of its own', async () => {
        const world = new World({ plugins: [{ package: PLUGIN, options: {} }], mcp: { docs: docs.config }, configIn: 'global' });
        try {
            await world.start();
            assert.ok(await waitFor(async () => (await skills(world)).includes('mcp-skills:docs:haiku-guide'), 30000, 'the served skill'));
        } finally {
            await world.stop();
        }
    });

    test('with the option off, it does nothing', async () => {
        const world = new World({ plugins: [{ package: PLUGIN, options: { off: true } }], mcp: { docs: docs.config }, configIn: 'global' });
        try {
            await world.start();
            await waitFor(async () => (await world.api<{ data: { name: string; status: unknown }[] }>('GET', `/api/mcp?location[directory]=${encodeURIComponent(world.project)}`)).data.some((s) => JSON.stringify(s.status).includes('connected')), 30000, 'OpenCode to connect the server');
            await new Promise((r) => setTimeout(r, 3000));
            assert.ok(!(await skills(world)).some((id) => id.startsWith('mcp-skills:')));
            const log = readFileSync(join(world.home, '.local', 'share', 'opencode', 'mcp-skills', 'mcp-skills.log'), 'utf8');
            assert.match(log, /turned off/);
        } finally {
            await world.stop();
        }
    });
});

describe('mcp-skills with a server that needs a sign-in', () => {
    const SECRET = 'test-secret-5d2e8a41c9';
    let locked: ReturnType<typeof createServer>;
    const docs = fixture([skill('haiku-guide', 'Use when the user wants answers in haiku.')]);
    let world: World;
    let session = '';
    before(async () => {
        locked = createServer((_req, res) => {
            res.writeHead(401, { 'www-authenticate': 'Bearer realm="locked"' });
            res.end();
        });
        const port = await freePort();
        await new Promise<void>((r) => locked.listen(port, '127.0.0.1', r));
        world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config, locked: { type: 'remote', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${SECRET}` }, oauth: false } } });
        await world.start();
        session = await world.createSession();
    });
    after(async () => {
        await world.stop();
        locked.close();
    });

    test('it is named as not used, why, and the other server\'s skills still work; its header never shows', async () => {
        const out = await turn(world, session, 'CALL mcp_skills_list_skills {}');
        assert.match(out, /Not used: "locked": .*sign-in/);
        assert.match(out, /haiku-guide/);
        assert.doesNotMatch(out, new RegExp(SECRET));
        const log = readFileSync(join(world.home, '.local', 'share', 'opencode', 'mcp-skills', 'mcp-skills.log'), 'utf8');
        assert.doesNotMatch(log, new RegExp(SECRET));
        assert.doesNotMatch(JSON.stringify(world.llmRequests()), new RegExp(SECRET));
    });
});

describe('mcp-skills with a nested skill', () => {
    const outer = skill('outer', 'An outer skill.');
    const inner = skill('outer/inner', 'A skill inside it.');
    const docs = fixture([outer, inner]);
    const world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config }, permissions: ASK });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('a nested skill is asked about on its own, and the request names the skill it is inside (R4, X12)', async () => {
        await waitFor(async () => (await world.api<{ data: { id: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(world.project)}`)).data.some((s) => s.id === 'mcp-skills:docs:inner'), 30000, 'the nested skill');
        await turn(world, session, `CALL mcp_skills_load_skill {"server":"docs","uri":"${inner.uri}"}`, 'reject', (p) => {
            assert.equal(p.action, 'mcp_skills_load');
            assert.match(p.resources[0]!, /^docs:skill:\/\/outer\/inner\/SKILL\.md@/);
            assert.equal((p as { metadata?: { nestedIn?: string } }).metadata?.nestedIn, 'outer');
        });
    });
});

describe('mcp-skills asks by default', () => {
    const guide = skill('haiku-guide', 'Use when the user wants answers in haiku.');
    const docs = fixture([guide]);
    const world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config } });
    const off = new World({ plugins: [{ package: PLUGIN, options: { askByDefault: false } }], mcp: { docs: docs.config } });
    before(async () => {
        await world.start();
        await off.start();
    });
    after(async () => {
        await world.stop();
        await off.stop();
    });
    const listed = (w: World) => waitFor(async () => (await w.api<{ data: { id: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(w.project)}`)).data.some((s) => s.id === 'mcp-skills:docs:haiku-guide'), 30000, 'the served skill');

    test('with OpenCode\'s default rules, a load is asked about; "Allow always" then covers that skill as it is', async () => {
        await listed(world);
        const first = await world.createSession();
        await turn(world, first, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'always', (p) => assert.equal(p.action, 'mcp_skills_load'));
        const second = await world.createSession();
        const out = await turn(world, second, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`);
        assert.match(out, /Loaded the skill "haiku-guide"/);
    });

    test("with askByDefault off, OpenCode's rules alone decide: with its defaults, nobody is asked", async () => {
        await listed(off);
        const s = await off.createSession();
        const out = await turn(off, s, `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`);
        assert.match(out, /Loaded the skill "haiku-guide"/);
    });
});

describe('mcp-skills keeps an "Allow always" to the project it was given in', () => {
    const guide = skill('haiku-guide', 'Use when the user wants answers in haiku.');
    const docs = fixture([guide]);
    // Installed globally, so the plugin runs in both folders, each its own OpenCode project.
    const world = new World({ plugins: [PLUGIN], mcp: { docs: docs.config }, configIn: 'global' });
    let other = '';
    before(async () => {
        await world.start();
        other = join(world.dir, 'other-project');
        mkdirSync(other, { recursive: true });
    });
    after(() => world.stop());
    const listedIn = (dir: string) => waitFor(async () => (await world.api<{ data: { id: string }[] }>('GET', `/api/skill?location[directory]=${encodeURIComponent(dir)}`)).data.some((s) => s.id === 'mcp-skills:docs:haiku-guide'), 30000, 'the served skill');
    const sessionIn = async (dir: string) => {
        const r = await world.api<{ data?: { id: string }; id?: string }>('POST', '/api/session', { location: { directory: dir } });
        return (r.data?.id ?? r.id)!;
    };

    test("another project's instance of the plugin, which sees the same permission events, doesn't keep it", async () => {
        // Both projects' instances are running before the answer is given.
        await listedIn(world.project);
        await listedIn(other);
        await turn(world, await world.createSession(), `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'always', (p) => assert.equal(p.action, 'mcp_skills_load'));
        // In the project it was given in, it holds.
        const again = await turn(world, await world.createSession(), `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`);
        assert.match(again, /Loaded the skill "haiku-guide"/);
        // In the other project, the same load is asked about.
        await turn(world, await sessionIn(other), `CALL mcp_skills_load_skill {"server":"docs","uri":"${guide.uri}"}`, 'reject', (p) => assert.equal(p.action, 'mcp_skills_load'));
    });
});
