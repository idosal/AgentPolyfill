// The helper's side of its contract with the hooks module: the local endpoint,
// Claude Code's verdict on each server, standing by when there is nothing to
// do, and the tools as the hooks module registers them.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PLUGIN, TOOLS } from '../mod/hooks/tools.ts';
import { MOD, ROOT, startHelper, startPlugin, waitFor, world } from './harness.ts';

/** A world whose server is in Claude Code's own (user scope) config, not in a servers file of the user's. */
function claudeCodeWorld() {
    const w = world();
    const servers = JSON.parse(readFileSync(w.config, 'utf8')) as { mcpServers: Record<string, unknown> };
    writeFileSync(join(w.dir, '.claude.json'), JSON.stringify({ mcpServers: servers.mcpServers }));
    return w;
}
const fromClaudeCode = { MCP_EVENTS_CONFIG: undefined, MCP_EVENTS_SOURCES: 'user' };

describe('the local endpoint', () => {
    test('answers only the holder of the token it said on stdout, and only on the loopback address', async () => {
        const w = world();
        const plugin = await startPlugin(w);
        try {
            const { where } = plugin.helper;
            assert.match(where.url, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.ok(where.token.length >= 40);
            for (const token of ['', 'wrong', where.token.slice(0, -1), where.token + 'x']) {
                assert.equal((await plugin.helper.post('/tool', { name: 'list_watches', input: {} }, token)).status, 401);
            }
            const none = await fetch(`${where.url}/tool`, { method: 'POST', body: '{}' });
            assert.equal(none.status, 401);
            assert.equal((await fetch(`${where.url}/tool`, { headers: { authorization: `Bearer ${where.token}` } })).status, 404, 'POST only');
            assert.equal((await plugin.helper.post('/nothing-here')).status, 404);
            assert.equal((await plugin.helper.post('/tool', { name: 'list_watches', input: {} })).status, 200);
        } finally {
            await plugin.stop();
        }
    });

    test('a tool that is not one of the six, or arguments of the wrong kind, get an error in the mod\'s own words', async () => {
        const w = world();
        const plugin = await startPlugin(w);
        try {
            assert.deepEqual(await plugin.call('constructor'), { text: 'mcp-events has no tool by that name.', isError: true });
            assert.deepEqual(await plugin.call('watch_event', { server: 'tickets' }), { text: '"event" is required', isError: true });
            assert.deepEqual(await plugin.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: 'high' }), { text: '"arguments" must be an object', isError: true });
            assert.deepEqual(await plugin.call('recent_events', { limit: 1000 }), { text: '"limit" must be a whole number from 1 to 100', isError: true });
        } finally {
            await plugin.stop();
        }
    });
});

describe("Claude Code's verdict on a server", () => {
    test('a server Claude Code uses is connected to; the helper asks before it connects', async () => {
        const w = claudeCodeWorld();
        const plugin = await startPlugin(w, 'sess-a', fromClaudeCode);
        try {
            assert.deepEqual(plugin.helper.messages.find((m) => m.t === 'servers')?.names, ['tickets']);
            assert.match(plugin.instructions(), /- tickets \/ ticket\.created/);
        } finally {
            await plugin.stop();
        }
    });

    for (const [reason, said] of [
        ['disabled', /it is switched off in Claude Code/],
        ['unapproved', /it is not approved in Claude Code yet/],
        ['policy', /your organisation's MCP policy does not allow it/],
        ['unlisted', /Claude Code does not list a server by that name/],
        ['auth', /Claude Code says it needs a sign-in/]
    ] as const) {
        test(`a server Claude Code refuses (${reason}) is never started or sent anything, and the reason is given`, async () => {
            const w = claudeCodeWorld();
            const plugin = await startPlugin(w, 'sess-a', fromClaudeCode, { verdict: () => ({ ok: false, reason }) });
            try {
                assert.match(plugin.instructions(), /None of the configured MCP servers offers events\./);
                assert.match((await plugin.call('list_event_types')).text, said);
                assert.deepEqual(w.fixtureMethods(), [], 'the server was never started');
                const r = await plugin.call('watch_event', { server: 'tickets', event: 'ticket.created' });
                assert.equal(r.isError, true);
            } finally {
                await plugin.stop();
            }
        });
    }

    test("a servers file of the user's own (MCP_EVENTS_CONFIG) is not Claude Code's list, so nothing is asked", async () => {
        const w = world();
        const plugin = await startPlugin(w, 'sess-a', {}, { verdict: () => ({ ok: false, reason: 'unlisted' }) });
        try {
            assert.equal(plugin.helper.messages.some((m) => m.t === 'servers'), false);
            assert.match(plugin.instructions(), /- tickets \/ ticket\.created/);
        } finally {
            await plugin.stop();
        }
    });
});

describe('nothing to do', () => {
    test('with no server that offers events and nothing watched, the helper says so and exits; with a watch it stays', async () => {
        const empty = world();
        writeFileSync(empty.config, JSON.stringify({ mcpServers: {} }));
        const idle = await startHelper(empty, 'sess-a', { MCP_EVENTS_STANDBY_MS: '400' });
        assert.equal(await idle.exited, 0);
        assert.deepEqual(
            idle.messages.map((m) => m.t),
            ['ready', 'catalog', 'standby']
        );

        const w = world();
        const plugin = await startPlugin(w, 'sess-a', { MCP_EVENTS_STANDBY_MS: '400' });
        try {
            await new Promise((r) => setTimeout(r, 1500));
            assert.equal(plugin.helper.child.exitCode, null, 'a server offers events: it stays');
            assert.equal(plugin.helper.messages.some((m) => m.t === 'standby'), false);
        } finally {
            await plugin.stop();
        }
    });

    test('a server found without events is not started again at the next session, until a day passes, a tool is called, or a watch names it', async () => {
        const w = world({ FIXTURE_CAPS: 'none' });
        const starts = () => w.fixtureMethods().length;
        let plugin = await startPlugin(w);
        const first = starts();
        assert.ok(first > 0, 'looked at once');
        assert.match(plugin.instructions(), /None of the configured MCP servers offers events\./);
        await plugin.stop();

        plugin = await startPlugin(w, 'sess-b');
        assert.equal(starts(), first, 'not started a second time');
        await plugin.stop();

        // Claude called a tool: the hooks module starts the helper with MCP_EVENTS_PROBE=fresh.
        plugin = await startPlugin(w, 'sess-c', { MCP_EVENTS_PROBE: 'fresh' });
        assert.ok(starts() > first, 'looked at again when asked');
        await plugin.stop();
    });

    test('a helper whose Claude Code has gone stops by itself', async () => {
        const w = world();
        // CLAUDE_PID names a process that does not exist (the harness passes no CLAUDE_* variables of its own).
        const h = await startHelper(w, 'sess-a', { CLAUDE_PID: '2147483646' });
        assert.equal(await Promise.race([h.exited, new Promise((r) => setTimeout(() => r('still running'), 15000))]), 0);
    });
});

describe('the tools as Claude Code is told of them', () => {
    test('the hooks module registers exactly the tools the helper serves, with the arguments it reads', async () => {
        const w = world();
        const plugin = await startPlugin(w);
        try {
            for (const spec of TOOLS) {
                assert.match(spec.name, /^[a-z_]{3,64}$/);
                assert.equal((spec.inputSchema as { type: string }).type, 'object');
                const r = await plugin.call(spec.name, {});
                assert.notEqual(r.text, 'mcp-events has no tool by that name.', spec.name);
            }
            assert.equal(TOOLS.length, 6);
        } finally {
            await plugin.stop();
        }
        const tools = readFileSync(join(ROOT, 'src', 'tools.ts'), 'utf8');
        for (const spec of TOOLS) {
            for (const arg of Object.keys((spec.inputSchema as { properties: object }).properties)) assert.match(tools, new RegExp(`p\\.${arg}\\b`), `${spec.name} reads ${arg}`);
        }
        assert.equal(PLUGIN, JSON.parse(readFileSync(join(MOD, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'tool names are mcp__<plugin name>__<tool>');
    });
});
