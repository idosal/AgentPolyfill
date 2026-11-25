#!/usr/bin/env node
// Codex ignores the Muse Code forms' files in its plugin folders.
//
// Muse installs from this repository's Codex marketplace, so each of the four Codex plugin folders
// also holds a Muse manifest (.muse-plugin/plugin.json) and the Muse form's bundles, hooks and
// skill (muse/). This installs the four plugins into a throwaway Codex home, from this repository
// as a local marketplace (no sign-in, no model), and checks with the real `codex` and its
// app server that Codex loads only what each Codex manifest names:
//   - the plugin is installed and enabled, at the Codex manifest's version, and the copy Codex
//     made holds .muse-plugin and muse/ (so Codex had them, and passed them over);
//   - the plugin's skills are the ones in its skills/ folder, and none comes from muse/;
//   - no hook is registered or offered for review;
//   - its MCP server is the one .mcp.json names (./dist/…, not muse/), with the tools the Codex
//     bundle itself serves, and there is no other server.
//
// usage: node tools/muse/codex-ignores-muse.mjs [--codex PATH]   (default: `codex` on PATH)

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = process.argv.indexOf('--codex');
const CODEX = at >= 0 ? process.argv[at + 1] : 'codex';
const FOLDERS = {
    'mcp-events': 'polyfills/events/codex/plugin',
    'mcp-skills': 'polyfills/skills/codex/mod',
    'mcp-server-cards': 'polyfills/server-cards/codex/plugin',
    'ard-discovery': 'polyfills/ard/codex/plugin'
};

const root = mkdtempSync(join(tmpdir(), 'codex-ignores-muse-'));
const home = join(root, 'home');
const ws = join(root, 'ws');
const env = { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' };
const codex = (...args) => execFileSync(CODEX, args, { env, cwd: ws, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });

/** A JSON-RPC client over a child's stdio (newline-delimited). */
function client(cmd, args, o) {
    const child = spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const waiting = new Map();
    createInterface({ input: child.stdout }).on('line', (l) => {
        let m;
        try {
            m = JSON.parse(l);
        } catch {
            return;
        }
        if (m.id !== undefined && waiting.has(m.id)) {
            waiting.get(m.id)(m);
            waiting.delete(m.id);
        }
    });
    let id = 0;
    return {
        request: (method, params) =>
            new Promise((done, fail) => {
                const n = ++id;
                const t = setTimeout(() => fail(new Error(`${method} timed out: ${stderr.slice(-600)}`)), 90000);
                waiting.set(n, (m) => {
                    clearTimeout(t);
                    if (m.error) fail(new Error(`${method}: ${JSON.stringify(m.error)}`));
                    else done(m.result);
                });
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
            }),
        notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
        close: () => child.kill()
    };
}

/** The tools a Codex bundle serves by itself, over stdio. */
async function bundleTools(folder, mcp) {
    const c = client('node', mcp.args, { cwd: folder, env: { ...env, MCP_EVENTS_STATE: join(root, 'state'), MCP_SKILLS_STATE: join(root, 'skills-state') } });
    try {
        await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
        c.notify('notifications/initialized');
        return (await c.request('tools/list', {})).tools.map((t) => t.name).sort();
    } finally {
        c.close();
    }
}

try {
    execFileSync('mkdir', ['-p', env.CODEX_HOME, ws]);
    console.log(codex('--version').trim());
    codex('plugin', 'marketplace', 'add', REPO);
    for (const p of Object.keys(FOLDERS)) codex('plugin', 'add', `${p}@agent-polyfill`);

    const app = client(CODEX, ['app-server'], { cwd: ws, env });
    let installed, skills, hooks, servers;
    try {
        await app.request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0' } });
        app.notify('initialized');
        installed = await app.request('plugin/installed', {});
        skills = (await app.request('skills/list', { cwds: [ws], forceReload: true })).data.flatMap((e) => e.skills ?? []);
        hooks = (await app.request('hooks/list', { cwds: [ws] })).data;
        servers = (await app.request('mcpServerStatus/list', {})).data;
    } finally {
        app.close();
    }

    const market = installed.marketplaces.find((m) => m.name === 'agent-polyfill');
    assert.ok(market, 'the agent-polyfill marketplace is there');
    for (const h of hooks) assert.deepEqual([h.hooks, h.warnings, h.errors], [[], [], []], 'no hook is registered or offered for review');
    assert.deepEqual(servers.map((s) => s.name).sort(), Object.keys(FOLDERS).sort(), 'one MCP server per plugin, and no other');
    assert.ok(!skills.some((s) => /[\\/]muse[\\/]/.test(s.path ?? '')), 'no skill is listed from a muse/ folder');

    for (const [name, rel] of Object.entries(FOLDERS)) {
        const folder = join(REPO, rel);
        const manifest = JSON.parse(readFileSync(join(folder, '.codex-plugin', 'plugin.json'), 'utf8'));
        const p = market.plugins.find((x) => x.name === name);
        assert.ok(p?.installed && p?.enabled, `${name} is installed and enabled`);
        const cached = join(env.CODEX_HOME, 'plugins', 'cache', 'agent-polyfill', name, manifest.version);
        assert.ok(existsSync(join(cached, '.muse-plugin', 'plugin.json')) && existsSync(join(cached, 'muse')), `${name}: Codex's copy holds the Muse files`);
        // Its skills: those in its skills/ folder, by their folder names, and nothing else of the plugin's.
        const own = readdirSync(join(folder, 'skills')).map((d) => `${name}:${d}`).sort();
        const listed = skills.filter((s) => s.name.startsWith(`${name}:`)).map((s) => s.name).sort();
        assert.deepEqual(listed, own, `${name}: only the skills in skills/`);
        // Its server: what .mcp.json names, and the tools the Codex bundle serves.
        const mcp = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8')).mcpServers[name];
        const got = JSON.parse(codex('mcp', 'get', name, '--json'));
        assert.deepEqual(got.transport?.args ?? got.args, mcp.args, `${name}: Codex runs ${mcp.args.join(' ')}`);
        assert.ok(!mcp.args.some((a) => a.includes('muse')), `${name}: not the Muse bundle`);
        const server = servers.find((s) => s.name === name);
        const tools = Object.keys(server.tools ?? {}).sort();
        assert.deepEqual(tools, await bundleTools(folder, mcp), `${name}: the Codex bundle's tools`);
        console.log(`ok ${name} ${manifest.version}: skills ${listed.join(', ')}; server ${mcp.args.join(' ')} with ${tools.length} tools; no hooks; .muse-plugin and muse/ copied and not read`);
    }
    console.log('Codex reads none of the Muse files.');
} finally {
    rmSync(root, { recursive: true, force: true });
}
