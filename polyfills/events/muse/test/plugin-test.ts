// The Muse form lives in the Codex plugin folder (Muse reads this repository's Codex marketplace),
// with its own manifest (.muse-plugin/plugin.json) and its own bundles under plugin/muse/. These
// tests check that those bundles are current, that a copy of the folder runs the Muse bundle with
// no node_modules and nothing outside it, and that the Muse manifest says what Muse reads. The
// Codex bundle beside them is the Codex form's alone (../codex/test/plugin-test.ts).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { Helper, PLUGIN, temp } from '../../codex/test/harness.ts';
import { VERSION } from '../src/version.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MUSE = join(PLUGIN, 'muse');

describe("the Muse form's files in the plugin folder", () => {
    test('the committed Muse bundles are byte-identical to a fresh build', () => {
        const dir = temp('mcp-events-muse-build-');
        try {
            const r = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(readdirSync(join(MUSE, 'dist')), ['helper.js']);
            assert.deepEqual(readdirSync(join(MUSE, 'hooks')), ['user-prompt-submit.mjs']);
            assert.ok(readFileSync(join(dir, 'helper.js')).equals(readFileSync(join(MUSE, 'dist', 'helper.js'))), 'plugin/muse/dist/helper.js is stale: run npm run build in polyfills/events/muse');
            assert.ok(readFileSync(join(dir, 'user-prompt-submit.mjs')).equals(readFileSync(join(MUSE, 'hooks', 'user-prompt-submit.mjs'))), 'plugin/muse/hooks/user-prompt-submit.mjs is stale: run npm run build in polyfills/events/muse');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the Muse manifest names the same plugin, its own version, and its own bundles', () => {
        const muse = JSON.parse(readFileSync(join(PLUGIN, '.muse-plugin', 'plugin.json'), 'utf8')) as {
            schemaVersion: number;
            name: string;
            version: string;
            compat: Record<string, string>;
            capabilities: { skills: { path: string }[]; hooks: { id: string; event: string; command: string[] }[]; mcpServers: { id: string; transport: string; command: string[] }[] };
        };
        assert.equal(muse.schemaVersion, 1);
        assert.equal(muse.name, 'mcp-events');
        assert.equal(muse.version, VERSION);
        assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, VERSION);
        assert.deepEqual(muse.compat, { source: 'native', manifestDir: '.muse-plugin' });
        // Muse resolves these paths against the plugin folder.
        assert.deepEqual(muse.capabilities.mcpServers, [{ id: 'mcp-events', transport: 'stdio', command: ['node', 'muse/dist/helper.js'] }]);
        assert.deepEqual(muse.capabilities.hooks.map((h) => [h.event, h.command]), [['UserPromptSubmit', ['node', 'muse/hooks/user-prompt-submit.mjs']]]);
        for (const s of muse.capabilities.skills) {
            assert.ok(existsSync(join(PLUGIN, s.path)), s.path);
            // Codex lists every SKILL.md under skills/: the Muse skill stays out of it.
            assert.ok(!s.path.startsWith('skills/'), s.path);
        }
    });

    test('a copied plugin, with no node_modules and nothing outside it, runs the Muse bundle as Muse starts it', async () => {
        const dir = temp('mcp-events-muse-install-');
        const installed = join(dir, 'plugins cache', 'mcp-events'); // a space in the path, as a cache may have
        mkdirSync(installed, { recursive: true });
        cpSync(PLUGIN, installed, { recursive: true, filter: (p) => !['node_modules', '.DS_Store'].includes(basename(p)) });
        const guard = join(dir, 'isolated.mjs');
        // Node may rescue a broken bundle with a dependency from a folder above the copy: stop that.
        writeFileSync(
            guard,
            `import { registerHooks, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (!isBuiltin(result.url) && (!result.url.startsWith('file:') || !fileURLToPath(result.url).startsWith(${JSON.stringify(realpathSync(installed) + sep)}))) {
        throw new Error('Dependency outside the copied plugin: ' + result.url);
    }
    return result;
} });
`
        );
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        // Muse's cleared environment, with no muse to ask: no server is reached, and the tools are served.
        const env = { HOME: home, PATH: process.env.PATH ?? '', MUSE_SESSION_ID: randomUUID(), MUSE_PLUGIN_DATA_DIR: join(dir, 'data'), MCP_EVENTS_MUSE_BIN: join(dir, 'no-muse'), NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
        const h = new Helper(env, join(installed, 'muse', 'dist', 'helper.js'));
        try {
            await h.initialize();
            const tools = ((await h.request('tools/list')).result as { tools: { name: string; description: string }[] }).tools;
            assert.equal(tools.length, 6, h.stderr);
            assert.ok(tools.every((t) => !t.description.includes('Codex')), 'named for Muse');
            const r = await h.call('list_event_types', {}, randomUUID()); // Muse sends no thread: the session is MUSE_SESSION_ID
            assert.equal(r.isError, false, h.stderr);
        } finally {
            await h.stop();
            assert.equal(h.stderr.includes('Dependency outside'), false, h.stderr);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
