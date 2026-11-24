// The mod is installed by copying this folder, without node_modules. These
// tests check that the committed bundle is current, and that a copy with no
// dependencies runs the helper the hooks module starts.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { MOD, ROOT, temp, waitFor } from './harness.ts';

const names = ['helper.js'];

test('committed bundles are byte-identical to a fresh build', () => {
    const dir = temp('mcp-events-build-');
    try {
        const result = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(readdirSync(join(MOD, 'dist')).sort(), names, 'mod/dist/ holds just the helper bundle, without a sourcemap');
        assert.deepEqual(readdirSync(dir).sort(), names);
        for (const name of names) {
            assert.ok(readFileSync(join(dir, name)).equals(readFileSync(join(MOD, 'dist', name))), `${name} is stale: run npm run build`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a copied mod without node_modules runs the helper its hooks module starts', { timeout: 30000 }, async () => {
    const dir = temp('mcp-events-install-');
    const installed = join(dir, 'cached plugin'); // a space in the path, as an install folder may have
    mkdirSync(installed);
    // What is installed is the mod/ folder, as the marketplace file says, and nothing else.
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: { name: string; source: string }[] };
    assert.deepEqual(marketplace.plugins.map((p) => [p.name, p.source]), [['mcp-events', './mod']]);
    // Left out: what a development checkout gathers and git ignores (Claude Code writes the last two when it loads the mod from this folder).
    const skip = new Set(['node_modules', '.test-state', '.wrangler', 'types', 'tsconfig.json']);
    cpSync(MOD, installed, { recursive: true, filter: (p) => !skip.has(basename(p)) });
    // No package.json at its top: Claude Code installs dependencies for a plugin that has one.
    assert.equal(existsSync(join(installed, 'package.json')), false);
    assert.equal(existsSync(join(installed, 'node_modules')), false);
    assert.deepEqual(readdirSync(installed).sort(), ['.claude-plugin', 'dist', 'hooks', 'relay', 'skills']);
    const state = join(dir, 'state');
    const guard = join(dir, 'isolated.mjs');
    // The copy may sit under a folder that has node_modules. Stop Node from rescuing a
    // broken bundle with a dependency from outside the copy, for ESM and CommonJS alike.
    writeFileSync(
        guard,
        `import { registerHooks, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (!isBuiltin(result.url) && (!result.url.startsWith('file:') || !fileURLToPath(result.url).startsWith(${JSON.stringify(realpathSync(installed) + sep)}))) {
        throw new Error('Dependency outside copied plugin: ' + result.url);
    }
    return result;
} });
`
    );
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MCP_EVENTS_|NODE_OPTIONS|NODE_PATH)/.test(k))),
        HOME: dir,
        CLAUDE_PLUGIN_ROOT: installed,
        CLAUDE_PLUGIN_DATA: state,
        CLAUDE_PROJECT_DIR: installed,
        CLAUDE_CODE_SESSION_ID: 'copied',
        MCP_EVENTS_BATCH_MS: '10',
        MCP_EVENTS_STANDBY_MS: '0'
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
        const manifest = JSON.parse(readFileSync(join(installed, '.claude-plugin/plugin.json'), 'utf8'));
        assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
        assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, manifest.version);
        assert.match(readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8'), new RegExp(`VERSION = '${manifest.version.replace(/\./g, '\\.')}'`), 'src/version.ts matches plugin.json');
        // A mod, whole: a hooks module and the helper it starts. No MCP server of its own, no monitor.
        assert.equal(manifest.mcpServers, undefined);
        assert.equal(manifest.experimental, undefined);
        const hooks = JSON.parse(readFileSync(join(installed, 'hooks', 'hooks.json'), 'utf8')) as { modules: string[] };
        assert.deepEqual(hooks.modules, ['./register.ts']);
        const module = readFileSync(join(installed, 'hooks', 'register.ts'), 'utf8');
        assert.match(module, /\$\{\$\.plugin\.root\}\/dist\/helper\.js/, 'the hooks module starts the bundled helper');

        // What the hooks module runs: `node --no-warnings <root>/dist/helper.js`.
        child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, '--no-warnings', join(installed, 'dist', 'helper.js')], { cwd: installed, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (b) => (stdout += b));
        child.stderr!.on('data', (b) => (stderr += b));
        const closed = once(child, 'close');
        const messages = () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; url?: string; token?: string; version?: string });
        const ready = await waitFor(
            () => {
                assert.equal(child!.exitCode, null, stderr);
                return messages().find((m) => m.t === 'ready');
            },
            8000,
            'the helper to say where it listens'
        );
        assert.equal(ready.version, manifest.version);
        const post = async (route: string, body: unknown = {}) => {
            const r = await fetch(`${ready.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(r.status, 200);
            return (await r.json()) as Record<string, unknown>;
        };
        await waitFor(() => messages().find((m) => m.t === 'catalog'), 8000, 'the catalog');
        assert.match(String((await post('/tool', { name: 'list_event_types', input: {} })).text), /"servers": \[\]/);
        const spool = join(state, 'sessions', 'copied', 'events.jsonl');
        appendFileSync(spool, JSON.stringify({ id: 'e1', kind: 'notice', receivedAt: '', text: 'Copied mod ready' }) + '\n');
        assert.deepEqual((await post('/take')).lines, ['[mcp-events] Copied mod ready']);
        await post('/stop');
        assert.deepEqual(await closed, [0, null], stderr);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    }
});
