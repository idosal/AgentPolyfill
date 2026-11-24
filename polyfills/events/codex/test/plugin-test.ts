// The plugin is installed by copying plugin/ and nothing else (Codex copies the folder its
// marketplace entry names into its plugin cache). These tests check that the committed bundle
// is current, that a copy with no node_modules and nothing outside it runs as Codex starts it,
// and that the manifests say what Codex reads.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { Helper, newThread, PLUGIN, ROOT, temp, world } from './harness.ts';
import { VERSION } from '../src/version.ts';

const REPO = join(ROOT, '..', '..', '..');

describe('the plugin folder', () => {
    test('the committed bundle is byte-identical to a fresh build', () => {
        const dir = temp('mcp-events-codex-build-');
        try {
            const r = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(readdirSync(join(PLUGIN, 'dist')), ['helper.js']);
            assert.ok(readFileSync(join(dir, 'helper.js')).equals(readFileSync(join(PLUGIN, 'dist', 'helper.js'))), 'plugin/dist/helper.js is stale: run npm run build');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the manifests agree with each other and with what Codex reads', () => {
        const manifest = JSON.parse(readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.name, 'mcp-events');
        assert.equal(manifest.version, VERSION);
        assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, VERSION);
        assert.equal(manifest.mcpServers, './.mcp.json');
        assert.equal(manifest.skills, './skills/');
        assert.ok(existsSync(join(PLUGIN, 'skills', 'mcp-events', 'SKILL.md')));
        const mcp = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; cwd: string; env_vars: string[] }> };
        const server = mcp.mcpServers['mcp-events']!;
        assert.deepEqual([server.command, server.args, server.cwd], ['node', ['./dist/helper.js'], '.']);
        // Every setting the helper reads reaches it: Codex passes a plugin's server only the variables it names.
        const helper = readdirSync(join(ROOT, 'src'))
            .map((f) => readFileSync(join(ROOT, 'src', f), 'utf8'))
            .concat(readdirSync(join(ROOT, '..', 'core', 'src')).map((f) => readFileSync(join(ROOT, '..', 'core', 'src', f), 'utf8')))
            .join('\n');
        const read = new Set([...helper.matchAll(/env\.(MCP_EVENTS_[A-Z_]+)/g)].map((m) => m[1]!));
        // For tests on this machine only: plain http and stand-ins (DEV), and a short relay backoff.
        for (const v of ['MCP_EVENTS_DEV', 'MCP_EVENTS_PUBLIC_RELAY_URL', 'MCP_EVENTS_RELAY_BACKOFF_MS']) read.delete(v);
        assert.deepEqual([...read].filter((v) => !server.env_vars.includes(v)).sort(), [], 'settings the plugin does not forward');
        assert.ok(server.env_vars.includes('CODEX_HOME'));
        // Listed in the Codex marketplace of this repository, by the folder that is installed.
        const market = JSON.parse(readFileSync(join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { name: string; plugins: { name: string; source: { source: string; path: string } }[] };
        assert.equal(market.name, 'agent-polyfill');
        assert.deepEqual(market.plugins.find((p) => p.name === 'mcp-events')?.source, { source: 'local', path: './polyfills/events/codex/plugin' });
    });

    test('a copied plugin, with no node_modules and nothing outside it, starts and serves its tools as Codex starts it', async () => {
        const dir = temp('mcp-events-codex-install-');
        const installed = join(dir, 'plugins cache', 'mcp-events', '0.1.0'); // a space in the path, as a cache may have
        mkdirSync(installed, { recursive: true });
        cpSync(PLUGIN, installed, { recursive: true, filter: (p) => !['node_modules', '.DS_Store'].includes(basename(p)) });
        assert.deepEqual(readdirSync(installed).sort(), ['.codex-plugin', '.mcp.json', 'THIRD_PARTY_LICENSES.txt', 'dist', 'skills']);
        assert.equal(existsSync(join(installed, 'package.json')), false);
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
        const w = world();
        // What .mcp.json says: `node ./dist/helper.js`, in the plugin's folder.
        const h = new Helper({ ...w.env(), NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` }, join(installed, 'dist', 'helper.js'));
        try {
            await h.initialize();
            const r = await h.call('list_event_types', {}, newThread());
            assert.equal(r.isError, false, h.stderr);
            assert.match(r.text, /"server": "tickets"/);
        } finally {
            await h.stop();
            assert.equal(h.stderr.includes('Dependency outside'), false, h.stderr);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the third-party notices name every package the bundle holds', () => {
        const r = spawnSync(process.execPath, [join(REPO, 'tools', 'bundle-notices.mjs'), ROOT, '--plugin', 'plugin', '--check'], { encoding: 'utf8', timeout: 30000 });
        assert.equal(r.status, 0, r.stderr);
    });
});
