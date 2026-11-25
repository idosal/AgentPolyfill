// The helper in Muse Code (--host=muse): Muse's settings as the server list, the session from
// MUSE_SESSION_ID, the plugin's settings file, delivery through the inbox and the bundled
// UserPromptSubmit hook, and waking through `muse attach` (a stand-in), against the fixture
// events server.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FIXTURE, HELPER, Helper, PLUGIN, ROOT, sleep, temp, waitFor } from './harness.ts';
import { sessionDir } from '../../core/src/store.ts';
import { applyPluginSettings, attachTurn, inboxDir, parseEventsServer, parseMuseServer, putInbox, readMuseServers, spokeAt, takeInbox } from '../src/muse.ts';

const HOOK = join(PLUGIN, 'muse', 'hooks', 'user-prompt-submit.mjs');
const FAKE_MUSE = join(ROOT, 'test', 'fake-muse.mjs');
chmodSync(FAKE_MUSE, 0o755);

/** Runs the bundled hook as Muse does: the input on standard input, with no newline at the end. */
function hook(input: Record<string, unknown>, env: Record<string, string>): { out: string; status: number | null } {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 10000 });
    return { out: r.stdout, status: r.status };
}

/** A Muse world: a settings.json naming the fixture server, the plugin's data folder (with its settings file), and a session. */
function museWorld(settings: Record<string, string> = {}) {
    const dir = temp('mcp-events-muse-');
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const data = join(dir, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ MCP_EVENTS_BATCH_MS: '200', ...settings }));
    const config = join(dir, 'settings.json');
    writeFileSync(
        config,
        JSON.stringify({ mcpServers: { tickets: { type: 'stdio', command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: upstream, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300' } } } })
    );
    const session = randomUUID();
    let n = 0;
    return {
        dir,
        data,
        session,
        fakeMuseLog: join(dir, 'fake-muse.jsonl'),
        emit(name: string, payload: Record<string, unknown>) {
            writeFileSync(upstream, JSON.stringify({ eventId: `evt_${++n}_${Date.now()}`, name, timestamp: new Date().toISOString(), data: payload }) + '\n', { flag: 'a' });
        },
        /** What Muse passes a plugin's server (a cleared environment), and the config file under test. */
        env(extra: Record<string, string> = {}): Record<string, string> {
            return {
                PATH: process.env.PATH ?? '',
                HOME: dir,
                TMPDIR: process.env.TMPDIR ?? '/tmp',
                MUSE_SESSION_ID: session,
                MUSE_PLUGIN_ID: 'mcp-events',
                MUSE_PLUGIN_DATA_DIR: data,
                MCP_EVENTS_CONFIG: config,
                MCP_EVENTS_DEV: '1',
                FAKE_MUSE_LOG: join(dir, 'fake-muse.jsonl'),
                ...extra
            };
        }
    };
}

/** A tools/call as Muse makes one: its `_meta` carries a call id and no session. */
async function call(h: Helper, name: string, args: Record<string, unknown> = {}) {
    const r = await h.request('tools/call', { name, arguments: args, _meta: { callId: `call_${randomUUID()}`, idempotencyKey: 'tool:x', traceparent: '00-0-0-01' } });
    const result = r.result as { content: { text: string }[]; isError: boolean };
    return { text: result.content.map((c) => c.text).join(''), isError: result.isError };
}

async function startMuse(env: Record<string, string>): Promise<Helper> {
    const h = new Helper(env, HELPER, ['--host=muse']);
    await h.initialize();
    return h;
}

async function watchActive(h: Helper): Promise<string> {
    const w = await call(h, 'watch_event', { server: 'tickets', event: 'ticket.created', note: 'tell me' });
    assert.equal(w.isError, false, w.text);
    const id = /\b(w-[0-9a-f]+)\b/.exec(w.text)?.[1];
    assert.ok(id, w.text);
    await waitFor(
        async () => {
            const list = JSON.parse((await call(h, 'list_watches')).text.split('\n\n')[0]!) as { status: string }[];
            return list.length > 0 && list.every((x) => x.status === 'active');
        },
        15000,
        'the watch to be active'
    );
    return id;
}

describe('Muse settings', () => {
    const env = { HOME: '/nowhere' };
    test('stdio and HTTP entries are read as Muse writes them', () => {
        assert.deepEqual(parseMuseServer({ type: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } }, env, '/cfg'), { command: 'node', args: ['s.js'], env: { A: '1' }, cwd: undefined });
        assert.deepEqual(parseMuseServer({ type: 'streamable-http', url: 'https://x.example/mcp', headers: { 'X-Team': 'a' } }, env, '/cfg'), { url: 'https://x.example/mcp', headers: { 'X-Team': 'a' } });
        assert.deepEqual(parseMuseServer({ type: 'http', url: 'https://x.example/mcp' }, env, '/cfg'), { url: 'https://x.example/mcp', headers: undefined });
    });

    test('a value from the environment is filled only when the helper has it, and otherwise the server is left out, with the reason', () => {
        const bearer = { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${TOK}' } };
        assert.match((parseMuseServer(bearer, env, '/cfg') as { skip: string }).skip, /\$TOK, and Muse passes no environment variables to a plugin's server/);
        assert.deepEqual(parseMuseServer(bearer, { TOK: 't' }, '/cfg'), { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t' } });
        assert.match((parseMuseServer({ type: 'stdio', command: 'node', env: { K: '${KEY}' } }, env, '/cfg') as { skip: string }).skip, /\$KEY/);
        // Only the whole value, or after "Bearer ": Muse reads no reference inside other text.
        assert.match((parseMuseServer({ type: 'http', url: 'https://x.example/${PATH_PART}' }, env, '/cfg') as { skip: string }).skip, /takes a value from/);
    });

    test('switched off, signing in through Muse, and other transports are left out; this plugin itself is never connected to', () => {
        assert.deepEqual(parseMuseServer({ type: 'http', url: 'https://x.example/mcp', enabled: false }, env, '/cfg'), { skip: 'it is switched off in Muse' });
        assert.match((parseMuseServer({ type: 'http', url: 'https://x.example/mcp', oauth: { clientId: 'c' } }, env, '/cfg') as { skip: string }).skip, /signs in through Muse/);
        assert.match((parseMuseServer({ type: 'sse', url: 'https://x.example/sse' }, env, '/cfg') as { skip: string }).skip, /not supported/);
        assert.equal(parseEventsServer({ type: 'stdio', command: 'node', args: ['/x/mcp-events/0.1.7/dist/helper.js', '--host=muse'] }, env, '/cfg'), undefined);
    });

    test('the settings file is mcpServers in ~/.config/muse/settings.json, narrowed by MCP_EVENTS_SERVERS', () => {
        const dir = temp('mcp-events-muse-config-');
        try {
            mkdirSync(join(dir, '.config', 'muse'), { recursive: true });
            writeFileSync(join(dir, '.config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, mcpServers: { a: { type: 'http', url: 'https://a.example/mcp' }, b: { type: 'http', url: 'https://b.example/mcp' } } }));
            assert.deepEqual(Object.keys(readMuseServers({ HOME: dir }).servers), ['a', 'b']);
            const only = readMuseServers({ HOME: dir, MCP_EVENTS_SERVERS: 'b' });
            assert.deepEqual([Object.keys(only.servers), only.skipped], [['b'], { a: "excluded by this plugin's settings" }]);
            writeFileSync(join(dir, '.config', 'muse', 'settings.json'), '{not json');
            assert.match(readMuseServers({ HOME: dir }).skipped['(all servers)']!, /could not be read/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the plugin's settings file sets MCP_EVENTS_* only, never over the environment, and never moves the state", () => {
        const dir = temp('mcp-events-muse-settings-');
        try {
            writeFileSync(join(dir, 'settings.json'), JSON.stringify({ MCP_EVENTS_OFF: '1', MCP_EVENTS_SKIP: 'x', MCP_EVENTS_STATE: '/elsewhere', PATH: '/evil', MCP_EVENTS_BATCH_MS: 5 }));
            const e: NodeJS.ProcessEnv = { MCP_EVENTS_SKIP: 'mine' };
            assert.deepEqual(applyPluginSettings(e, dir).applied, ['MCP_EVENTS_OFF']);
            assert.deepEqual(e, { MCP_EVENTS_SKIP: 'mine', MCP_EVENTS_OFF: '1' });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the inbox and the UserPromptSubmit hook', () => {
    test('batches come out oldest first, once, and a long inbox is cut with a pointer to recent_events', async () => {
        const base = temp('mcp-events-muse-inbox-');
        const s = randomUUID();
        try {
            assert.equal(takeInbox(base, s), undefined);
            putInbox(base, s, 'first');
            await sleep(5);
            putInbox(base, s, 'second');
            assert.equal(takeInbox(base, s), 'first\n\nsecond');
            assert.equal(takeInbox(base, s), undefined);
            putInbox(base, s, 'x'.repeat(50));
            assert.match(takeInbox(base, s, 10)!, /^x{10}\n… \(more new events than fit here: call recent_events\)$/);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test("the hook hands the inbox to the model as additionalContext, stamps the person's message, and prints nothing when there is nothing", () => {
        const data = temp('mcp-events-muse-hook-');
        const s = randomUUID();
        const env = { MUSE_PLUGIN_DATA_DIR: data, HOME: data };
        try {
            assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'hello' }, env), { out: '', status: 0 });
            assert.ok(spokeAt(data, s) > 0, 'stamped');
            putInbox(data, s, '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)\nnew events');
            const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'anything new?' }, env);
            assert.equal(r.status, 0);
            assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)\nnew events' } });
            assert.equal(readdirSync(inboxDir(data, s)).length, 0, 'taken once');
            // Another session's inbox is not this one's.
            putInbox(data, s, 'mine');
            assert.equal(hook({ session_id: randomUUID(), prompt: 'hi' }, env).out, '');
            // Bad input ends quietly and never stops the message.
            const bad = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
            assert.deepEqual([bad.status, bad.stdout], [0, '']);
        } finally {
            rmSync(data, { recursive: true, force: true });
        }
    });

    test('a turn the plugin started through muse attach is not the person speaking', async () => {
        const data = temp('mcp-events-muse-hook-');
        const s = randomUUID();
        try {
            hook({ session_id: s, prompt: '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)' }, { MUSE_PLUGIN_DATA_DIR: data });
            assert.equal(spokeAt(data, s), 0);
            writeFileSync(join(data, 'settings.json'), JSON.stringify({ MCP_EVENTS_OFF: '1' }));
            putInbox(data, s, 'waiting');
            assert.equal(hook({ session_id: s, prompt: 'hi' }, { MUSE_PLUGIN_DATA_DIR: data }).out, '', 'off in the settings file: the hook does nothing');
        } finally {
            rmSync(data, { recursive: true, force: true });
        }
    });
});

describe('the helper in Muse', () => {
    test('a watch belongs to the session Muse names; a new event is stored and reaches the model with the next message, once', async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        const stored = (what: string) => {
            try {
                return readFileSync(join(sessionDir(w.data, w.session), 'events.jsonl'), 'utf8').includes(what);
            } catch {
                return false;
            }
        };
        try {
            const tools = ((await h.request('tools/list')).result as { tools: { name: string; description: string }[] }).tools;
            assert.equal(tools.length, 6);
            assert.ok(tools.every((t) => !t.description.includes('Codex')), 'named for Muse');
            const types = await call(h, 'list_event_types');
            assert.match(types.text, /"server": "tickets"/, types.text);
            const watch = await watchActive(h);
            assert.ok(existsSync(join(w.data, 'threads', w.session, 'watches.json')), 'kept under the session Muse named');
            w.emit('ticket.created', { id: 'T-1', title: 'printer on fire', priority: 'high' });
            await waitFor(() => stored('T-1'), 15000, 'the event in the store');
            await sleep(600);
            assert.ok(!existsSync(inboxDir(w.data, w.session)), 'the helper hands nothing over itself');
            const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: w.session, prompt: 'anything new?' }, { MUSE_PLUGIN_DATA_DIR: w.data });
            const context = (JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
            assert.match(context, /^\[mcp-events\] \(Sent by the mcp-events plugin, not typed by the user\.\)\n\[mcp-events\] tickets · ticket\.created: 1 new event/);
            assert.ok(context.includes(watch), context);
            assert.ok(!context.includes('printer on fire'), 'nothing the server wrote, by default');
            assert.equal(hook({ session_id: w.session, prompt: 'and now?' }, { MUSE_PLUGIN_DATA_DIR: w.data }).out, '', 'handed over once');
            assert.match((await call(h, 'recent_events')).text, /T-1/);
            // A `muse exec` run: its helper ends right after the event is stored, before any hand-over could happen.
            w.emit('ticket.created', { id: 'T-9', priority: 'high' });
            await waitFor(() => stored('T-9'), 15000, 'the second event in the store');
            await h.stop();
            const next = hook({ session_id: w.session, prompt: 'the next run' }, { MUSE_PLUGIN_DATA_DIR: w.data });
            assert.match(JSON.parse(next.out).hookSpecificOutput.additionalContext, /1 new event \[event e2;/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('with MCP_EVENTS_MUSE_WAKE=attach in the settings file, a batch starts a turn through muse attach, queued if the session is busy', async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach', MCP_EVENTS_MUSE_BIN: FAKE_MUSE });
        const h = await startMuse(w.env());
        try {
            await watchActive(h);
            w.emit('ticket.created', { id: 'T-2', priority: 'high' });
            const sent = await waitFor(
                () => {
                    if (!existsSync(w.fakeMuseLog)) return false;
                    const lines = readFileSync(w.fakeMuseLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args?: string[]; leaked?: string[]; in?: { method: string; params: Record<string, unknown> } });
                    return lines.some((l) => l.in?.method === 'turn/start') && lines;
                },
                15000,
                'a turn/start'
            );
            assert.deepEqual(sent[0]!.args, ['attach', '--stdio', w.session]);
            assert.deepEqual(sent[0]!.leaked, [], "the plugin's settings are not muse's business");
            assert.deepEqual(sent.filter((l) => l.in).map((l) => l.in!.method), ['initialize', 'initialized', 'session/resume', 'turn/start']);
            assert.match(String((sent.find((l) => l.in?.method === 'initialize')!.in!.params.clientInfo as { name: string }).name), /^[a-z0-9_]+$/, 'MSP refuses any other client name');
            const turn = sent.find((l) => l.in?.method === 'turn/start')!.in!.params as { sessionId: string; ifBusy: string; input: { type: string; text: string }[] };
            assert.equal(turn.sessionId, w.session);
            assert.equal(turn.ifBusy, 'queue');
            assert.match(turn.input[0]!.text, /^\[mcp-events\] \(Sent by the mcp-events plugin, not typed by the user\.\)/);
            await sleep(500);
            assert.ok(!existsSync(inboxDir(w.data, w.session)) || readdirSync(inboxDir(w.data, w.session)).length === 0, 'not also in the inbox');
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('when the session cannot be attached to (Muse launched without its gates), the batch waits in the inbox', async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach', MCP_EVENTS_MUSE_BIN: FAKE_MUSE });
        const h = await startMuse(w.env({ FAKE_MUSE_MODE: 'refuse' }));
        try {
            await watchActive(h);
            w.emit('ticket.created', { id: 'T-3', priority: 'high' });
            await waitFor(() => existsSync(inboxDir(w.data, w.session)) && readdirSync(inboxDir(w.data, w.session)).length > 0, 15000, 'a batch in the inbox');
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('MCP_EVENTS_OFF=1 in the settings file serves no tools', async () => {
        const w = museWorld({ MCP_EVENTS_OFF: '1' });
        const h = await startMuse(w.env());
        try {
            assert.deepEqual(((await h.request('tools/list')).result as { tools: unknown[] }).tools, []);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('without MUSE_SESSION_ID a call says so instead of guessing a session', async () => {
        const w = museWorld();
        const env = w.env();
        delete env.MUSE_SESSION_ID;
        const h = await startMuse(env);
        try {
            const r = await call(h, 'list_watches');
            assert.equal(r.isError, true);
            assert.match(r.text, /MUSE_SESSION_ID/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });
});

describe('attachTurn', () => {
    test('refuses anything but a session id, and reports a session that cannot be attached to', async () => {
        assert.deepEqual(await attachTurn(FAKE_MUSE, 'not-a-session', 'x'), { ok: false, why: 'not a Muse session id', permanent: true });
        const r = await attachTurn(FAKE_MUSE, randomUUID(), 'x', { env: { ...process.env, FAKE_MUSE_MODE: 'refuse' } });
        assert.equal(r.ok, false);
        assert.match((r as { why: string }).why, /can't be attached to/);
    });
});
