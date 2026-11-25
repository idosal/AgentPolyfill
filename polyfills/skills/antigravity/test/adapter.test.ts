import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { Store } from '../../codex/src/store.ts';
import { checkEntry, LIMITS, type Listed } from '../../core/src/skills.ts';
import { answerHook, digestOf, gateMatcher, issueTicket, redeemTicket, stateDir, TICKET_TTL_MS } from '../../../server-cards/antigravity/src/gate.ts';
import { handlers, MATCHER } from '../src/approval.ts';
import { configPath, readConfig } from '../src/config.ts';
import { MAX_STUBS, SHAPE, stubName, stubPath, stubRootOf, syncStubs } from '../src/stubs.ts';
import { antigravityServer, closeAll, digest, Fixture, localWeb, matches, preToolUse, runHook, scenarioOf, skill, skillMd, sizeOf, startApp, tempHome, TOOL, writeConfig } from './harness.ts';

after(closeAll);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(ROOT, 'plugin/dist/server.mjs');
const call = async (s: ReturnType<typeof antigravityServer>, name: string, args: Record<string, unknown>) => (await s.request('tools/call', { name, arguments: args })).result;
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');
const listed = (label = 'docs', name = 'git-workflow'): Listed => {
    const c = checkEntry(skill(name).entry); assert.ok('entry' in c);
    return { label, entry: c.entry, fetchedAt: Date.now(), ttlMs: 0 };
};

test('A-1 personal JSON: commands, URLs, headers, disabled, OAuth, settings and exact labels', () => {
    const home = tempHome(), env = { HOME: home }, store = new Store(stateDir('mcp-skills', env));
    const entries = {
        docs: { command: 'node', args: ['server.js'], env: { A: 'literal' }, cwd: '/somewhere' },
        url: { serverUrl: 'http://127.0.0.1/mcp', headers: { Authorization: 'Bearer given' } },
        alternate: { url: 'http://127.0.0.1/mcp' }, disabled: { command: 'must-not-run', disabled: true },
        oauth: { url: 'http://127.0.0.1/mcp', oauth: {} }, provider: { url: 'http://127.0.0.1/mcp', authProviderType: 'google', headers: { X: 'x' } },
        broken: { command: 'x', args: [1] }, 'bad/name': { command: 'x' }
    };
    writeConfig(home, entries);
    const original = readFileSync(configPath(env));
    const result = readConfig(env, store);
    assert.deepEqual(Object.keys(result.servers), ['docs', 'url', 'alternate']);
    assert.deepEqual(result.servers.docs, entries.docs);
    assert.deepEqual(result.servers.url, { url: entries.url.serverUrl, headers: entries.url.headers });
    assert.match(result.skipped.disabled!, /disabled/);
    assert.match(result.skipped.oauth!, /Antigravity's own sign-in/);
    assert.match(result.skipped.provider!, /sign-in/);
    writeFileSync(join(store.dir, 'settings.json'), JSON.stringify({ servers: ['docs', 'alternate'], skip: ['alternate'] }));
    assert.deepEqual(Object.keys(readConfig(env, store).servers), ['docs']);
    assert.ok(original.equals(readFileSync(configPath(env))), 'never rewrites user configuration');
});

test('A-2 malformed config fails closed; workspace, plugin config and token files are never inspected', () => {
    const home = tempHome(), env = { HOME: home, PLUGIN_ROOT: join(home, 'plugin') }, store = new Store(join(home, 'state'));
    for (const folder of ['.agents', 'plugin', '.gemini/antigravity']) mkdirSync(join(home, folder), { recursive: true });
    writeFileSync(join(home, '.agents/mcp_config.json'), '{"mcpServers":{"workspace":{"command":"must-not-run"}}}');
    writeFileSync(join(home, 'plugin/mcp_config.json'), '{"mcpServers":{"bundled":{"command":"must-not-run"}}}');
    // A directory at the token-file path would fail a file read; it must remain untouched.
    mkdirSync(join(home, '.gemini/antigravity/mcp_oauth_tokens.json'));
    assert.deepEqual(Object.keys(readConfig(env, store).servers), []);
    mkdirSync(join(configPath(env), '..'), { recursive: true });
    for (const bad of ['{', '[]', '{"mcpServers":[]}']) {
        writeFileSync(configPath(env), bad);
        assert.deepEqual(Object.keys(readConfig(env, store).servers), []);
        assert.ok(readConfig(env, store).skipped['(all servers)']);
    }
});

test('A-3 a URL that requires sign-in is skipped with a reason, without OAuth', async () => {
    const web = await localWeb({ '/mcp': { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: 'sign in' } } });
    try {
        const st = await startApp({ remote: { config: { url: `${web.origin}/mcp` } } as never });
        assert.match((await st.call('list_skills', {})).text, /Antigravity's own sign-in/);
        assert.equal(st.app.conns.size, 0);
    } finally { await web.close(); }
});

test('A-4 URL plain headers work on the shared wire', async () => {
    const entry = skill('remote'); let headerSeen = false;
    const caps = { resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } };
    const web = await localWeb({ '/mcp': (req, body) => {
        if (req.method !== 'POST') return { status: 405, body: '' };
        headerSeen ||= req.headers.authorization === 'Bearer explicit';
        const m = JSON.parse(body);
        if (m.id === undefined) return { status: 202, body: '' };
        let result: unknown;
        if (m.method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: caps };
        else if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: caps, serverInfo: { name: 'remote', version: '1' } };
        else if (m.method === 'skills/list') result = { skills: [entry.entry] };
        else if (m.method === 'skills/get') result = { skill: entry.entry };
        else if (m.method === 'resources/read') result = { contents: [{ uri: entry.uri, mimeType: 'text/markdown', text: entry.files[entry.uri]!.text }] };
        else result = {};
        return { body: { jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...(result as object) } } };
    } });
    try {
        const st = await startApp({ remote: { config: { url: `${web.origin}/mcp`, headers: { Authorization: 'Bearer explicit' } } } as never }, { answers: ['load'] });
        const loaded = await st.call('load_skill', { server: 'remote', uri: entry.uri });
        assert.equal(loaded.isError, undefined, loaded.text + '\n' + st.app.status());
        assert.ok(headerSeen);
    } finally { await web.close(); }
});

test('S-1 stubs are one level deep, exact shape, frontmatter name equals folder; only metadata is copied', () => {
    const root = stubRootOf(tempHome()), l = listed('Docs');
    syncStubs(root, [l]);
    const name = readdirSync(root)[0]!;
    assert.ok(SHAPE.test(name)); assert.ok(name.length <= 64);
    assert.equal(name, stubName('Docs', l.entry.uri));
    const body = readFileSync(join(root, name, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`name: "${name}"`));
    assert.match(body, /not a local skill/); assert.doesNotMatch(body, /Body of/);
    assert.notEqual(stubName('Docs', l.entry.uri), stubName('docs', l.entry.uri));
});

test('S-2 cleanup, changes, and stand-down touch only exact-shape folders', () => {
    const root = stubRootOf(tempHome()); mkdirSync(root, { recursive: true });
    for (const n of ['mine', 'mcp-skills-served', 'mcp-skills-served--docs-bad--0000000000000000']) {
        mkdirSync(join(root, n)); writeFileSync(join(root, n, 'SKILL.md'), 'keep');
    }
    writeFileSync(join(root, 'loose.txt'), 'keep');
    const l = listed(); syncStubs(root, [l]);
    const path = stubPath(root, l.label, l.entry.uri);
    l.entry.frontmatter.description = 'Changed listing'; syncStubs(root, [l]);
    assert.match(readFileSync(path, 'utf8'), /Changed listing/);
    assert.equal(syncStubs(root, [l]).written, 0);
    syncStubs(root, []);
    assert.ok(!existsSync(path));
    assert.deepEqual(readdirSync(root).sort(), ['loose.txt', 'mcp-skills-served', 'mcp-skills-served--docs-bad--0000000000000000', 'mine'].sort());
    assert.equal(readFileSync(join(root, 'mine/SKILL.md'), 'utf8'), 'keep');
});

test('S-3 stub folder/file symlinks never write or remove their target; shared root symlink is refused', () => {
    const home = tempHome(), root = join(home, 'skills'), outside = join(home, 'outside');
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside, 'SKILL.md'), 'private');
    const l = listed(), dir = join(root, stubName(l.label, l.entry.uri));
    symlinkSync(outside, dir); syncStubs(root, [l]);
    assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), 'private');
    syncStubs(root, []); mkdirSync(dir); symlinkSync(join(outside, 'SKILL.md'), join(dir, 'SKILL.md')); syncStubs(root, [l]);
    assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), 'private');
    const link = join(home, 'root-link'); symlinkSync(outside, link);
    assert.throws(() => syncStubs(link, []), /not a real directory/);
});

test('S-4 cap includes retained stubs; omitted skills remain listable/loadable', () => {
    const root = stubRootOf(tempHome());
    syncStubs(root, Array.from({ length: 80 }, (_, i) => listed('old', `s${i}`)));
    const result = syncStubs(root, Array.from({ length: 50 }, (_, i) => listed('new', `s${i}`)), new Set(['old']));
    assert.equal(readdirSync(root).length, MAX_STUBS); assert.equal(result.omitted, 30);
    syncStubs(root, []); assert.equal(readdirSync(root).length, 0);
});

test('H-1 matcher takes only this plugin and MCP key by eager name, and read_resource (X8); never call_mcp_tool; list_skills has no hook', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'plugin/hooks.json'), 'utf8'));
    const entry = hooks['mcp-skills-approval'].PreToolUse[0];
    // The three gated tools are eager (plugin/mcp_config.json), so Antigravity names them mcp_<server>_<tool>; the
    // matcher takes those and read_resource (rule X8), never call_mcp_tool.
    assert.equal(entry.matcher, gateMatcher('mcp-skills_skills', ['load_skill', 'read_skill_file', 'list_skill_directory'], ['read_resource'])); assert.equal(entry.hooks[0].command, 'node ./dist/server.mjs --hook');
    for (const n of ['read_resource', TOOL, 'mcp_mcp-skills_skills_read_skill_file', 'mcp_mcp-skills_skills_list_skill_directory']) assert.ok(matches(entry.matcher, n), n);
    assert.deepEqual(hooks['mcp-skills-approval'].Stop, [{ type: 'command', command: 'node ./dist/server.mjs --hook stop', timeout: 10 }]);
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'plugin/mcp_config.json'), 'utf8')).mcpServers.skills.tools, { load_skill: { eager: true }, read_skill_file: { eager: true }, list_skill_directory: { eager: true } });
    for (const n of ['call_mcp_tool', 'list_resources', 'load_skill', 'mcp_other_load_skill', 'mcp_other_mcp-skills_skills_load_skill', 'mcp_mcp-skills-other_skills_load_skill', 'mcp_mcp-skills_other_load_skill', 'mcp_mcp-skills_skills_list_skills', `${TOOL}_other`]) assert.ok(!matches(entry.matcher, n), n);
    // The handler's own check takes the eager name the gate gives every call of this server.
    assert.ok(new RegExp(`^(?:${MATCHER})$`).test(TOOL));
});

test('G-1 tickets are one-use, tool/digest bound and expire; private state honors the override', () => {
    const home = tempHome(), dir = stateDir('mcp-skills', { HOME: home, AGENTPOLYFILL_STATE_DIR: join(home, 'custom') });
    assert.equal(dir, join(home, 'custom/mcp-skills')); assert.equal(statSync(dir).mode & 0o777, 0o700);
    const t = () => issueTicket(dir, { tool: 'load_skill', digest: 'd', conversationId: 'c' });
    const one = t(); assert.deepEqual(redeemTicket(dir, one, 'load_skill', 'd'), { ok: true, conversationId: 'c' });
    assert.equal(redeemTicket(dir, one, 'load_skill', 'd').ok, false);
    assert.equal(redeemTicket(dir, t(), 'load_skill', 'other').ok, false);
    assert.equal(redeemTicket(dir, t(), 'read_skill_file', 'd').ok, false);
    const expired = issueTicket(dir, { tool: 'load_skill', digest: 'd', conversationId: 'c' }, Date.now() - TICKET_TTL_MS - 1);
    assert.equal(redeemTicket(dir, expired, 'load_skill', 'd').ok, false);
    assert.equal(redeemTicket(dir, '../../x', 'load_skill', 'd').ok, false);
});

test('E-1 installed hook and server: ask, overwrite, verified content, saved approval, unchanged pass, changed ask', async () => {
    const home = tempHome(), s1 = skill('git-workflow', { 'a.md': 'A\n' }), f = new Fixture(scenarioOf([s1]));
    writeConfig(home, { docs: f.config });
    const s = antigravityServer(SERVER, home); await s.ready;
    await call(s, 'list_skills', {});
    const args = { server: 'docs', uri: s1.uri };
    const h = runHook(SERVER, home, preToolUse(TOOL, args));
    assert.equal(h.status, 0, h.stderr); assert.equal(h.out.decision, 'force_ask');
    assert.match(h.out.reason, /new skill approval/); assert.match(h.out.reason, /git-workflow/); assert.match(h.out.reason.split('\n')[1], /^This is a new skill approval: you have not approved this version before · URI skill:/);
    assert.deepEqual(f.requests('resources/read'), []);
    const loaded = await call(s, 'load_skill', { ...args, ...h.out.overwrite });
    assert.equal(loaded.isError, false, text(loaded)); assert.match(text(loaded), /Body of git-workflow/);
    const dir = stateDir('mcp-skills', { HOME: home });
    assert.equal(statSync(join(dir, 'approvals.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'mcp-skills.log')).mode & 0o777, 0o600);
    assert.equal(runHook(SERVER, home, preToolUse(TOOL, args)).out.decision, 'allow');
    f.change(sc => { (sc.listed![0]!.resources as any[])[1].digest = digest('B\n'); sc.files![`${s1.root}/a.md`] = { text: 'B\n' }; });
    const changed = runHook(SERVER, home, preToolUse(TOOL, args));
    assert.equal(changed.out.decision, 'force_ask'); assert.match(changed.out.reason, /has changed.*since you last approved/);
    assert.equal((await call(s, 'load_skill', { ...args, ...changed.out.overwrite })).isError, false);
    assert.ok(existsSync(stubPath(stubRootOf(home), 'docs', s1.uri)));
    assert.deepEqual(s.asked, [], 'no elicitation');
});

test('E-2 no ticket, wrong ticket, replay, missing hook: no text and no unapproved resources/read', async () => {
    const home = tempHome(), sk = skill('git-workflow'), f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
    const s = antigravityServer(SERVER, home); await s.ready;
    const args = { server: 'docs', uri: sk.uri };
    for (const extra of [{}, { agentpolyfill_ticket: 'f'.repeat(32) }]) {
        const r = await call(s, 'load_skill', { ...args, ...extra });
        assert.equal(r.isError, true); assert.doesNotMatch(text(r), /Body of/);
    }
    assert.deepEqual(f.requests('resources/read'), []);
    const h = runHook(SERVER, home, preToolUse(TOOL, args));
    assert.equal((await call(s, 'load_skill', { ...args, ...h.out.overwrite })).isError, false);
    const replay = await call(s, 'load_skill', { ...args, ...h.out.overwrite });
    assert.equal(replay.isError, true); assert.doesNotMatch(text(replay), /Body of/);
});

test('E-3 hook shared metadata survives its process; another server instance redeems and rechecks it', async () => {
    const home = tempHome(), sk = skill('git-workflow'), f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
    // The hook runs before any plugin MCP process exists.
    const h = runHook(SERVER, home, preToolUse(TOOL, { server: 'docs', uri: sk.uri }));
    assert.equal(h.out.decision, 'force_ask');
    const s = antigravityServer(SERVER, home); await s.ready;
    assert.equal((await call(s, 'load_skill', { server: 'docs', uri: sk.uri, ...h.out.overwrite })).isError, false);
});

test('E-4 metadata changes after the question: refuse before fetching any skill text', async () => {
    const home = tempHome(), sk = skill('git-workflow'), f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
    const s = antigravityServer(SERVER, home); await s.ready;
    const args = { server: 'docs', uri: sk.uri }, h = runHook(SERVER, home, preToolUse(TOOL, args));
    const body = skillMd('git-workflow').replace('Body', 'Swap');
    f.change(sc => { (sc.listed![0]!.resources as any[])[0] = { uri: sk.uri, digest: digest(body), size: sizeOf(body) }; sc.files![sk.uri] = { text: body }; });
    const r = await call(s, 'load_skill', { ...args, ...h.out.overwrite });
    assert.equal(r.isError, true); assert.match(text(r), /changed/); assert.doesNotMatch(text(r), /Swap/);
    assert.deepEqual(f.requests('resources/read'), []);
});

test('E-5 reads raise no question but need this conversation to have loaded the approved skill', async () => {
    const sk = skill('git-workflow', { 'a.md': 'A\n' });
    const st = await startApp({ docs: new Fixture(scenarioOf([sk])) }, { answers: ['load'] });
    const args = { server: 'docs', skill: sk.uri, path: 'a.md' };
    const h = await answerHook(preToolUse('mcp_mcp-skills_skills_read_skill_file', args, 'one'), handlers(st.env, st.store), st.store.dir);
    assert.equal(h.decision, 'allow');
    assert.equal((await st.app.call('read_skill_file', { ...args, ...h.overwrite as object })).isError, true);
    assert.equal((await st.call('load_skill', { server: 'docs', uri: sk.uri }, { thread: 'one' })).isError, undefined);
    assert.equal((await st.call('read_skill_file', args, { thread: 'one' })).isError, undefined);
    assert.equal((await st.call('read_skill_file', args, { thread: 'two' })).isError, true);
    assert.equal(st.questions.length, 1);
});

test('E-6 malformed hook input gets allow and nothing else, with exit zero (whose call it is can\'t be told; an own call without a ticket is refused by the server); invalid or over-limit skill gets deny, not ask', async () => {
    const home = tempHome(), bad = spawnSync(process.execPath, [SERVER, '--hook'], { input: '{', encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH } });
    assert.equal(bad.status, 0); assert.deepEqual(JSON.parse(bad.stdout), { decision: 'allow' });
    const sk = skill('big'); (sk.entry.resources as any[])[0].size = LIMITS.bytes + 1;
    const f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
    const h = runHook(SERVER, home, preToolUse(TOOL, { server: 'docs', uri: sk.uri }));
    assert.equal(h.out.decision, 'deny'); assert.match(h.out.reason, /bytes/);
    assert.deepEqual(f.requests('resources/read'), []);
    assert.equal(runHook(SERVER, home, preToolUse(TOOL, { server: 'docs', uri: 'skill://big/a.md' })).out.decision, 'deny');
});

test('E-7 stand-down env and settings: no connections, no tools, owned stubs removed, later calls refused', async () => {
    for (const mode of ['env', 'settings']) {
        const home = tempHome(), sk = skill('git-workflow'), f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
        const dir = stateDir('mcp-skills', { HOME: home });
        syncStubs(stubRootOf(home), [listed()]);
        if (mode === 'settings') writeFileSync(join(dir, 'settings.json'), '{"off":true}');
        const s = antigravityServer(SERVER, home, mode === 'env' ? { MCP_SKILLS_DISABLED: '1' } : {}); await s.ready;
        assert.deepEqual((await s.request('tools/list', {})).result.tools, []);
        assert.equal(readdirSync(stubRootOf(home)).length, 0); assert.deepEqual(f.requests(), []);
    }
    const st = await startApp({ docs: new Fixture(scenarioOf([skill('git-workflow')])) });
    writeFileSync(join(st.store.dir, 'settings.json'), '{"off":true}');
    assert.equal((await st.call('list_skills', {})).isError, true);
    assert.equal(readdirSync(st.stubRoot).length, 0);
});

test('B-1 committed bundle is byte-identical to a fresh build and dist holds only it', () => {
    const out = tempHome(); const r = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', out], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(readdirSync(join(ROOT, 'plugin/dist')), ['server.mjs']);
    assert.ok(readFileSync(join(out, 'server.mjs')).equals(readFileSync(SERVER)), 'rebuild committed bundle');
});

test('B-2 manifest schema fields and plugin-only copy: starts, lists tools, hook loads and verifies content', async () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin/plugin.json'), 'utf8'));
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    const allowed = ['$schema', 'name', 'displayName', 'description', 'version', 'disabled', 'logo', 'suggestedPrompts', 'skills', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
    assert.deepEqual(Object.keys(manifest).filter(k => !allowed.includes(k)), []); assert.ok(manifest.suggestedPrompts.length <= 3);
    const { tools: _eager, ...entry } = JSON.parse(readFileSync(join(ROOT, 'plugin/mcp_config.json'), 'utf8')).mcpServers.skills;
    assert.deepEqual(entry, { command: 'node', args: ['${PLUGIN_ROOT}/dist/server.mjs'] });
    const home = tempHome(), installed = join(home, 'installed'); cpSync(join(ROOT, 'plugin'), installed, { recursive: true });
    const sk = skill('git-workflow'), f = new Fixture(scenarioOf([sk])); writeConfig(home, { docs: f.config });
    const serverFile = join(installed, 'dist/server.mjs'), s = antigravityServer(serverFile, home); await s.ready;
    assert.deepEqual((await s.request('tools/list', {})).result.tools.map((t: any) => t.name), ['list_skills', 'load_skill', 'read_skill_file', 'list_skill_directory']);
    const h = runHook(serverFile, home, preToolUse(TOOL, { server: 'docs', uri: sk.uri })); assert.equal(h.out.decision, 'force_ask');
    const r = await call(s, 'load_skill', { server: 'docs', uri: sk.uri, ...h.out.overwrite });
    assert.equal(r.isError, false, text(r)); assert.match(text(r), /Body of git-workflow/);
});
