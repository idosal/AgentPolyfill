// The parts of the OpenCode form that need no OpenCode.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Listed } from '../../core/src/skills.ts';
import { skillIds } from '../src/app.ts';
import { stateDir } from '../src/plugin.ts';
import { stubContent, stubDescription } from '../src/words.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const listed = (label: string, name: string, uri: string) => ({ label, entry: { uri, frontmatter: { name, description: 'd' }, resources: [] }, fetchedAt: 0, ttlMs: 0 }) as unknown as Listed;

test('OpenCode lists a served skill as mcp-skills:<server>:<name>; two of one name are told apart', () => {
    const a = listed('docs', 'guide', 'skill://a/guide/SKILL.md');
    const b = listed('docs', 'guide', 'skill://b/guide/SKILL.md');
    const ids = skillIds([a, b]);
    assert.equal(ids.get(a), 'mcp-skills:docs:guide');
    assert.match(ids.get(b)!, /^mcp-skills:docs:guide-[0-9a-f]{6}$/);
});

test("the listed description is marked with its server first, and holds no markup of the server's", () => {
    const d = stubDescription('docs', 'Use <b>me</b>\nnow `x`');
    assert.match(d, /^\[MCP server "docs", not a local skill\] /);
    assert.doesNotMatch(d, /[<>`\n]/);
});

test("the stub OpenCode's skill tool returns says how to load the skill, and that it is not its text", () => {
    const s = stubContent('docs', 'skill://guide/SKILL.md', 'guide');
    assert.match(s, /mcp_skills_load_skill/);
    assert.match(s, /not its text/);
});

test("state lives under OpenCode's data folder, or MCP_SKILLS_STATE", () => {
    assert.equal(stateDir({ XDG_DATA_HOME: '/d' }), join('/d', 'opencode', 'mcp-skills'));
    assert.equal(stateDir({ MCP_SKILLS_STATE: '/s' }), '/s');
});

test('plugin/server.js is what the sources build', () => {
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('the bundle loads on its own and exports a V2 plugin', async () => {
    const mod = (await import(pathToFileURL(join(ROOT, 'plugin', 'server.js')).href)) as { default: { id: string; setup: unknown } };
    assert.equal(mod.default.id, 'mcp-skills');
    assert.equal(typeof mod.default.setup, 'function');
});
