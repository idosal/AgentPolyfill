// The plugin folder as Codex installs it: the committed bundle is what src/ builds,
// the manifests agree with each other, and the hook is set up as Codex expects.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, any>;

test('mod/dist is what src/ builds (run `npm run build` after a change)', () => {
    const out = mkdtempSync(join(tmpdir(), 'rl-build-'));
    const r = spawnSync(process.execPath, ['build.mjs', out], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['helper.js', 'hook.js']) assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(root, 'mod', 'dist', f), 'utf8'), `mod/dist/${f} is stale`);
});

test('plugin.json, package.json and the version in src agree', () => {
    const plugin = json('mod/.codex-plugin/plugin.json');
    assert.equal(plugin.name, 'mcp-resource-links');
    assert.equal(plugin.version, json('package.json').version);
    assert.match(readFileSync(join(root, 'src', 'version.ts'), 'utf8'), new RegExp(`VERSION = '${plugin.version}'`));
    assert.equal(plugin.mcpServers, './.mcp.json');
    assert.equal(plugin.hooks, './hooks/hooks.json');
});

test("the server runs the bundle, and passes on only the plugin's own settings and where Codex is", () => {
    const server = json('mod/.mcp.json').mcpServers['mcp-resource-links'];
    assert.deepEqual(server.args, ['./dist/helper.js']);
    assert.deepEqual(server.env_vars, ['CODEX_HOME', 'CODEX_CLI_PATH', 'MCP_RESOURCE_LINKS_DISABLED', 'MCP_RESOURCE_LINKS_STATE']);
});

test('the hook is one PostToolUse command for MCP tools, running the bundled hook', () => {
    const hooks = json('mod/hooks/hooks.json').hooks;
    assert.deepEqual(Object.keys(hooks), ['PostToolUse']);
    const [entry] = hooks.PostToolUse;
    assert.equal(entry.matcher, '^mcp__');
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].command, 'node "$PLUGIN_ROOT/dist/hook.js"');
});

// Every `codex plugin add <name>@agent-polyfill` the repository's docs give must name a
// plugin its Codex marketplace lists, or a reader's install fails. Runs and recordings
// (runs/ folders) are left out: they show what was run, not what to run.
test("every documented `codex plugin add <name>@agent-polyfill` names a plugin in the Codex marketplace", () => {
    const repo = join(root, '..', '..', '..');
    const listed = new Set((JSON.parse(readFileSync(join(repo, '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins: { name: string }[] }).plugins.map((p) => p.name));
    const docs = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = join(dir, e.name);
            if (e.isDirectory()) return ['node_modules', 'runs', '.git', 'dist', '.vitepress'].includes(e.name) ? [] : docs(p);
            return /\.(md|mjs)$/.test(e.name) ? [p] : [];
        });
    const files = [join(repo, 'README.md'), ...docs(join(repo, 'site', 'guide')), join(repo, 'site', 'scripts', 'agents.mjs'), ...docs(join(repo, 'polyfills'))];
    const missing: string[] = [];
    let seen = 0;
    for (const f of files) {
        for (const m of readFileSync(f, 'utf8').matchAll(/codex plugin add ([a-z0-9-]+)@agent-polyfill/g)) {
            seen++;
            if (!listed.has(m[1]!)) missing.push(`${f.slice(repo.length + 1)}: ${m[1]}`);
        }
    }
    assert.ok(seen > 0, 'no install lines found: the scan is looking in the wrong place');
    assert.deepEqual(missing, []);
});
