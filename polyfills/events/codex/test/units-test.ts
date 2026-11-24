// The Codex-specific parts on their own: the MCP server front, what a call's `_meta` says,
// and running `codex queue`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isThePersons, threadOf } from '../src/meta.ts';
import { findCodex, queueMessage, remoteOf } from '../src/waker.ts';
import { TOOLS } from '../src/words.ts';
import { FAKE_CODEX, newThread, startHelper, temp, world } from './harness.ts';

describe("what Codex says in a call's _meta", () => {
    test('the session is _meta.threadId, else the turn metadata thread_id; anything that is not a Codex session id is no session', () => {
        const t = newThread();
        assert.equal(threadOf({ threadId: t }), t);
        assert.equal(threadOf({ 'x-codex-turn-metadata': { thread_id: t.toUpperCase() } }), t, 'case does not make another session');
        assert.equal(threadOf({ threadId: '../x' }), undefined);
        assert.equal(threadOf({}), undefined);
    });

    test("a turn the person started is theirs; one the queue, a goal or an automation started is not", () => {
        const turn = (turn_trigger: unknown) => ({ 'x-codex-turn-metadata': { turn_trigger } });
        for (const t of ['user', 'composer', 'exec', 'realtime']) assert.equal(isThePersons(turn(t)), true, t);
        for (const t of ['queue', 'goal', 'daemon_recovery', 'automation_cron_scheduled', 'automation_heartbeat_scheduled', 'guardian_review', 'memory_consolidation']) assert.equal(isThePersons(turn(t)), false, t);
        assert.equal(isThePersons({}), true, 'an older Codex with no turn metadata');
    });
});

describe('codex queue', () => {
    test('it is run with the session, the message as one argument, and --resume; the plugin\'s own settings are not passed on', async () => {
        const w = world();
        const thread = newThread();
        const r = await queueMessage(FAKE_CODEX, thread, '-starts with a dash\nand has two lines', { ...w.env(), MCP_EVENTS_SECRET_SETTING: 'x' });
        assert.deepEqual(r, { ok: true, resumed: true });
        const q = w.queued()[0]!;
        assert.deepEqual(q.args, ['queue', '--thread', thread, '--message=-starts with a dash\nand has two lines', '--resume']);
        assert.deepEqual(q.leaked, []);
    });

    test('queued but not resumed (no daemon) is still taken; a Codex without queue, or a failure, is not', async () => {
        const w = world();
        writeFileSync(w.mode, 'noresume');
        assert.deepEqual(await queueMessage(FAKE_CODEX, newThread(), 'm', w.env()), { ok: true, resumed: false });
        writeFileSync(w.mode, 'old');
        assert.deepEqual(await queueMessage(FAKE_CODEX, newThread(), 'm', w.env()), { ok: false, why: 'this Codex has no `codex queue --resume` (Codex 0.170 or newer has it)', permanent: true });
        writeFileSync(w.mode, 'fail');
        assert.deepEqual(await queueMessage(FAKE_CODEX, newThread(), 'm', w.env()), { ok: false, why: 'codex queue failed (exit 1)' });
    });

    test('nothing that is not a session id reaches the command line', async () => {
        const r = await queueMessage(FAKE_CODEX, '--remote=ws://evil', 'm');
        assert.equal(r.ok, false);
    });

    test('MCP_EVENTS_CODEX_BIN must be a full path to a program; MCP_EVENTS_CODEX_REMOTE must be an address codex takes', () => {
        assert.equal(findCodex({ MCP_EVENTS_CODEX_BIN: FAKE_CODEX }), FAKE_CODEX);
        assert.equal(findCodex({ MCP_EVENTS_CODEX_BIN: 'codex' }), undefined);
        const dir = temp();
        assert.equal(findCodex({ PATH: dir, HOME: dir }) === undefined || findCodex({ PATH: dir, HOME: dir })!.endsWith('codex'), true);
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'ws://127.0.0.1:4500' }), 'ws://127.0.0.1:4500');
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'unix://' }), 'unix://');
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'http://x --thread y' }), undefined);
    });
});

describe('the MCP server Codex starts', () => {
    test('the handshake answers the revision Codex asks for, and tools/list gives the six tools, the reading ones marked read-only', async () => {
        const w = world();
        const h = await startHelper(w);
        try {
            const init = (await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.172.0' } })).result as { protocolVersion: string; serverInfo: { name: string; version: string }; instructions: string; capabilities: Record<string, unknown> };
            assert.equal(init.protocolVersion, '2025-06-18');
            assert.equal(init.serverInfo.name, 'mcp-events');
            assert.deepEqual(Object.keys(init.capabilities), ['tools']);
            assert.match(init.instructions, /sent by the mcp-events plugin, not typed by the user/);
            const unknown = (await h.request('initialize', { protocolVersion: '2099-01-01' })).result as { protocolVersion: string };
            assert.equal(unknown.protocolVersion, '2025-06-18', 'a revision it does not speak gets one it does');
            const tools = ((await h.request('tools/list')).result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
            assert.deepEqual(tools.map((t) => t.name), ['list_event_types', 'watch_event', 'unwatch_event', 'list_watches', 'get_event', 'recent_events']);
            assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name), ['list_event_types', 'list_watches', 'get_event', 'recent_events']);
            assert.equal(((await h.request('resources/list')) as { error: { code: number } }).error.code, -32601);
            assert.equal(((await h.request('ping')) as { result: unknown }).result !== undefined, true);
        } finally {
            await h.stop();
        }
    });

    test('a line that is not JSON gets a parse error, and the server carries on', async () => {
        const w = world();
        const h = await startHelper(w);
        try {
            h.send('{not json');
            assert.equal(((await h.request('ping')) as { result: unknown }).result !== undefined, true);
        } finally {
            await h.stop();
        }
    });

    test('when Codex closes its standard input (the session ended), the helper ends', async () => {
        const w = world();
        const h = await startHelper(w);
        assert.equal(await h.stop(), 0);
        assert.match(readFileSync(join(w.state, 'mcp-events.log'), 'utf8'), /stopped/);
    });

    test('MCP_EVENTS_OFF=1: installed, and serving nothing', async () => {
        const w = world();
        const h = await startHelper(w, { MCP_EVENTS_OFF: '1' });
        try {
            assert.deepEqual(((await h.request('tools/list')).result as { tools: unknown[] }).tools, []);
            assert.equal(w.fixtureMethods().length, 0, 'no server is contacted');
        } finally {
            await h.stop();
        }
    });

    test('every tool Codex is told of has a handler in the shared client, which reads the arguments its schema names', () => {
        const tools = readFileSync(join(import.meta.dirname, '..', '..', 'core', 'src', 'tools.ts'), 'utf8');
        for (const t of TOOLS) {
            assert.match(tools, new RegExp(`\\b${t.name}\\(`), t.name);
            for (const arg of Object.keys((t.inputSchema as { properties: object }).properties)) assert.match(tools, new RegExp(`p\\.${arg}\\b`), `${t.name} reads ${arg}`);
        }
    });
});
