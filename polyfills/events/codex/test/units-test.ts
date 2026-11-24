// The Codex-specific parts on their own: the MCP server front, what a call's `_meta` says,
// and running `codex queue`.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isThePersons, threadOf } from '../src/meta.ts';
import { codexNotFound, findCodex, queueMessage, remoteOf } from '../src/waker.ts';
import { TOOLS } from '../src/words.ts';
import { eventIdsIn, FAKE_CODEX, newThread, startHelper, temp, world } from './harness.ts';

describe('the tests read event ids exactly', () => {
    test('an id in a watch id ("w-9ee342" holds "e3") is not an event; only "[event eN, watch" counts', () => {
        const text = '[mcp-events] tickets · ticket.created: title=one [event e1, watch w-9ee342; get_event e1 returns the record].\n[mcp-events] tickets · ticket.created: title=two [event e2, watch w-9ee342; get_event e2 returns the record].';
        assert.deepEqual(eventIdsIn(text), ['e1', 'e2']);
        assert.match(text, /e3/, 'the bare pattern the restart test used would have matched');
    });
});

describe("what Codex says in a call's _meta", () => {
    test('the session is _meta.threadId, else the turn metadata thread_id; anything that is not a Codex session id is no session', () => {
        const t = newThread();
        assert.equal(threadOf({ threadId: t }), t);
        assert.equal(threadOf({ 'x-codex-turn-metadata': { thread_id: t.toUpperCase() } }), t, 'case does not make another session');
        assert.equal(threadOf({ threadId: '../x' }), undefined);
        assert.equal(threadOf({}), undefined);
    });

    test('CX1: only a turn Codex says the person started is theirs (typed, codex exec, voice); anything else, or nothing said, is not', () => {
        const turn = (turn_trigger: unknown) => ({ 'x-codex-turn-metadata': { turn_trigger } });
        // What Codex 0.172 sends: "user" from the TUI, "exec" from codex exec, "realtime" for voice.
        for (const t of ['user', 'exec', 'realtime', 'voice']) assert.equal(isThePersons(turn(t)), true, t);
        for (const t of ['queue', 'goal', 'daemon_recovery', 'automation_cron_scheduled', 'guardian_review', 'memory_consolidation', 'hook', 'composer', 'subagent', 'USER', '']) assert.equal(isThePersons(turn(t)), false, JSON.stringify(t));
        assert.equal(isThePersons({}), false, 'no turn metadata (a Codex before 0.172): not the person');
        assert.equal(isThePersons({ 'x-codex-turn-metadata': {} }), false, 'no turn_trigger: not the person');
        assert.equal(isThePersons({ 'x-codex-turn-metadata': { turn_trigger: 7 } }), false);
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

    test('"no rollout found" (a ChatGPT desktop-app chat) is a session codex queue can never reach', async () => {
        const w = world();
        writeFileSync(w.mode, 'norollout');
        const r = await queueMessage(FAKE_CODEX, newThread(), 'm', w.env());
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.unreachable, true);
        assert.match(!r.ok ? r.why : '', /isn't a local Codex session/);
    });

    test('nothing that is not a session id reaches the command line', async () => {
        const r = await queueMessage(FAKE_CODEX, '--remote=ws://evil', 'm');
        assert.equal(r.ok, false);
    });

    test('MCP_EVENTS_CODEX_BIN must be a full path to a program; MCP_EVENTS_CODEX_REMOTE must be an address codex takes', () => {
        assert.deepEqual(findCodex({ MCP_EVENTS_CODEX_BIN: FAKE_CODEX }, 'darwin'), { command: FAKE_CODEX, args: [] });
        assert.equal(findCodex({ MCP_EVENTS_CODEX_BIN: 'codex' }, 'darwin'), undefined);
        const dir = temp();
        writeFileSync(join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
        assert.deepEqual(findCodex({ PATH: dir, HOME: dir }, 'linux'), { command: join(dir, 'codex'), args: [] });
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'ws://127.0.0.1:4500' }), 'ws://127.0.0.1:4500');
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'unix://' }), 'unix://');
        assert.equal(remoteOf({ MCP_EVENTS_CODEX_REMOTE: 'http://x --thread y' }), undefined);
    });
});

describe('CX2: codex on Windows is never run through cmd.exe', () => {
    /** A folder laid out as npm installs Codex globally on Windows: a .cmd shim beside node_modules. */
    function npmGlobal(withExe = false) {
        const dir = temp('mcp-events-codex-win-');
        writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
        writeFileSync(join(dir, 'codex.bat'), '@ECHO off\r\n');
        mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
        if (withExe) writeFileSync(join(dir, 'codex.exe'), '');
        return dir;
    }

    test('a codex.exe on PATH is run as it is', () => {
        const dir = npmGlobal(true);
        assert.deepEqual(findCodex({ PATH: dir }, 'win32'), { command: join(dir, 'codex.exe'), args: [] });
    });

    test("npm's codex.cmd is not run: Node runs the package's own codex.js, with no shell between", () => {
        const dir = npmGlobal();
        const found = findCodex({ PATH: dir }, 'win32')!;
        assert.equal(found.command, process.execPath);
        assert.deepEqual(found.args, [join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);
        assert.ok(![found.command, ...found.args].some((p) => /\.(cmd|bat)$/i.test(p)));
    });

    test('a .cmd or .bat named in MCP_EVENTS_CODEX_BIN, or a shim with no codex.js beside it, is refused, and the wake says why', async () => {
        const dir = npmGlobal();
        assert.equal(findCodex({ MCP_EVENTS_CODEX_BIN: join(dir, 'codex.cmd') }, 'win32'), undefined);
        assert.equal(findCodex({ MCP_EVENTS_CODEX_BIN: join(dir, 'codex.bat') }, 'win32'), undefined);
        const bare = temp('mcp-events-codex-win-');
        writeFileSync(join(bare, 'codex.cmd'), '@ECHO off\r\n');
        assert.equal(findCodex({ PATH: bare, APPDATA: bare }, 'win32'), undefined);
        assert.match(codexNotFound('win32'), /codex\.exe.*never run through cmd\.exe/);
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
