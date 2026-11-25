// The helper in Muse Code (--host=muse): Muse's settings as the server list, the session from
// MUSE_SESSION_ID, the plugin's settings file, a watch that waits for the person's typed yes, the
// enterprise-policy and turned-off checks, delivery through the bundled UserPromptSubmit hook,
// and waking through `muse attach` (a stand-in muse) with the shared takeover and wake cap.
// Against the fixture events server.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { sessionDir } from '../../core/src/store.ts';
import { askTyped, confirmFromPrompt } from '../src/muse-confirm.ts';
import { applyPluginSettings, attachTurn, inboxDir, museManaged, museWatchQuestion, parseEventsServer, parseMuseServer, putInbox, readMuseServers, serverEnabled, spokeAt, takeInbox } from '../src/muse.ts';
import { FIXTURE, HELPER, Helper, PLUGIN, ROOT, sleep, temp, waitFor } from './harness.ts';

const HOOK = join(PLUGIN, 'muse', 'hooks', 'user-prompt-submit.mjs');
const FAKE_MUSE = join(ROOT, 'test', 'fake-muse.mjs');
chmodSync(FAKE_MUSE, 0o755);

/** Muse's user settings in `home`: its MCP servers, and this plugin's server turned on (approved), unless `serverOn` is false. */
function museSettings(home: string, mcpServers: Record<string, unknown> = {}, o: { serverOn?: boolean } = {}) {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true });
    const caps = o.serverOn === false ? { 'plugin:mcp-events:mcp_server:mcp-events': { enabled: false } } : { 'plugin:mcp-events:mcp_server:mcp-events': { enabled: true }, 'plugin:mcp-events:hook:user-prompt-submit': { enabled: true } };
    writeFileSync(join(home, '.config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, runtime_capabilities: caps, mcpServers }));
}

/** Runs the bundled hook as Muse does: the input on standard input, with no newline at the end. */
function hook(input: Record<string, unknown>, env: Record<string, string>): { out: string; status: number | null } {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 10000 });
    return { out: r.stdout, status: r.status };
}

/** A Muse world: Muse's settings naming the fixture server, the plugin's data folder (with its settings file), a session, a stand-in muse. */
function museWorld(settings: Record<string, string> = {}) {
    const dir = temp('mcp-events-muse-');
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const data = join(dir, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ MCP_EVENTS_BATCH_MS: '200', ...settings }));
    museSettings(dir, { tickets: { type: 'stdio', command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: upstream, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300' } } });
    const session = randomUUID();
    let n = 0;
    const w = {
        dir,
        data,
        session,
        fakeMuseLog: join(dir, 'fake-muse.jsonl'),
        emit(name: string, payload: Record<string, unknown>) {
            writeFileSync(upstream, JSON.stringify({ eventId: `evt_${++n}_${Date.now()}`, name, timestamp: new Date().toISOString(), data: payload }) + '\n', { flag: 'a' });
        },
        /** What Muse passes a plugin's server (a cleared environment), and the stand-in muse. */
        env(extra: Record<string, string> = {}): Record<string, string> {
            return {
                PATH: process.env.PATH ?? '',
                HOME: dir,
                TMPDIR: process.env.TMPDIR ?? '/tmp',
                MUSE_SESSION_ID: session,
                MUSE_PLUGIN_ID: 'mcp-events',
                MUSE_PLUGIN_DATA_DIR: data,
                MCP_EVENTS_DEV: '1',
                MCP_EVENTS_MUSE_BIN: FAKE_MUSE,
                FAKE_MUSE_LOG: join(dir, 'fake-muse.jsonl'),
                ...extra
            };
        },
        /** The person sends a message of their own: the hook runs, as Muse runs it. */
        say(prompt: string) {
            return hook({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }, { HOME: dir, MUSE_PLUGIN_DATA_DIR: data, MUSE_PLUGIN_ID: 'mcp-events' });
        },
        stored(what: string) {
            try {
                return readFileSync(join(sessionDir(data, session), 'events.jsonl'), 'utf8').includes(what);
            } catch {
                return false;
            }
        },
        turns(): { text: string }[] {
            if (!existsSync(w.fakeMuseLog)) return [];
            return readFileSync(w.fakeMuseLog, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { in?: { method: string; params: { input: { text: string }[] } } })
                .filter((l) => l.in?.method === 'turn/start')
                .map((l) => ({ text: l.in!.params.input[0]!.text }));
        }
    };
    return w;
}
type World = ReturnType<typeof museWorld>;

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

const WATCH = { server: 'tickets', event: 'ticket.created', note: 'tell me' };

/** A watch as it goes in Muse: asked, the person types the phrase, asked again; then until it is active. */
async function watchActive(h: Helper, w: World, args: Record<string, unknown> = WATCH): Promise<string> {
    const asked = await call(h, 'watch_event', args);
    const phrase = /exactly: (watch \d{4})/.exec(asked.text)?.[1];
    assert.ok(phrase, asked.text);
    assert.match((JSON.parse(w.say(phrase).out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, /they approve "mcp-events: start a watch\?"/);
    const r = await call(h, 'watch_event', args);
    assert.equal(r.isError, false, r.text);
    const id = /\b(w-[0-9a-f]+)\b/.exec(r.text)?.[1];
    assert.ok(id, r.text);
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
        assert.match((parseMuseServer({ type: 'http', url: 'https://x.example/${PATH_PART}' }, env, '/cfg') as { skip: string }).skip, /takes a value from/);
    });

    test('switched off, signing in through Muse, and other transports are left out; this plugin itself is never connected to', () => {
        assert.deepEqual(parseMuseServer({ type: 'http', url: 'https://x.example/mcp', enabled: false }, env, '/cfg'), { skip: 'it is switched off in Muse' });
        assert.match((parseMuseServer({ type: 'http', url: 'https://x.example/mcp', oauth: { clientId: 'c' } }, env, '/cfg') as { skip: string }).skip, /signs in through Muse/);
        assert.match((parseMuseServer({ type: 'sse', url: 'https://x.example/sse' }, env, '/cfg') as { skip: string }).skip, /not supported/);
        assert.equal(parseEventsServer({ type: 'stdio', command: 'node', args: ['/x/mcp-events/0.1.7/dist/helper.js', '--host=muse'] }, env, '/cfg'), undefined);
    });

    test("the settings file is mcpServers in Muse's user settings (never a project's), narrowed by MCP_EVENTS_SERVERS", () => {
        const dir = temp('mcp-events-muse-config-');
        try {
            museSettings(dir, { a: { type: 'http', url: 'https://a.example/mcp' }, b: { type: 'http', url: 'https://b.example/mcp' } });
            // A project's .mcp.json beside it is never read.
            writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'touch', args: ['/tmp/pwned'] } } }));
            assert.deepEqual(Object.keys(readMuseServers({ HOME: dir }).servers), ['a', 'b']);
            const only = readMuseServers({ HOME: dir, MCP_EVENTS_SERVERS: 'b' });
            assert.deepEqual([Object.keys(only.servers), only.skipped], [['b'], { a: "excluded by this plugin's settings" }]);
            writeFileSync(join(dir, '.config', 'muse', 'settings.json'), '{not json');
            assert.match(readMuseServers({ HOME: dir }).skipped['(all servers)']!, /could not be read/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('where an organisation manages Muse, or it cannot be told, no server is reached', () => {
        assert.equal(museManaged(FAKE_MUSE, { ...process.env }), undefined);
        assert.match(museManaged(FAKE_MUSE, { ...process.env, FAKE_MUSE_POLICY: 'present' })!, /your organisation manages Muse \(policy plane from system_file\)/);
        assert.match(museManaged(undefined)!, /muse command was not found/);
        const dir = temp('mcp-events-muse-config-');
        try {
            museSettings(dir, { a: { type: 'http', url: 'https://a.example/mcp' } });
            const r = readMuseServers({ HOME: dir }, () => {}, 'your organisation manages Muse');
            assert.deepEqual([r.servers, r.skipped], [{}, { '(all servers)': 'your organisation manages Muse' }]);
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

describe("the person's yes, typed", () => {
    test('the watch question shows every name and value whole, with hidden characters written out', () => {
        const q = museWatchQuestion({ server: 'tickets', event: 'ticket.created', arguments: { team: 'a‮b' }, note: 'ping me​' });
        assert.match(q, /^mcp-events: start a watch\?\nMuse wants to watch "ticket\.created" on the MCP server "tickets" with the filters \{"team":"a\\u\{202e\}b"\}\.\nWhen it fires: "ping me\\u\{200b\}"\n\nIts events will come with the messages you send/);
        assert.match(museWatchQuestion(WATCH, { gapMs: 60000, perHour: 30 }), /start turns in this session by themselves, while you are away too \(at most once every 60 s per watch, 30 times an hour\)/);
    });

    test('a question waits for exactly its phrase, in a message of the person, in the same session, once', () => {
        const dir = temp('mcp-events-muse-confirm-');
        const s = randomUUID();
        try {
            const first = askTyped(dir, s, 'watch', 'Q1');
            assert.ok('pending' in first);
            const phrase = (first as { pending: string }).pending;
            assert.match(phrase, /^watch \d{4}$/);
            assert.equal((askTyped(dir, s, 'watch', 'Q1') as { pending: string }).pending, phrase, 'the same code while it waits');
            assert.equal(confirmFromPrompt(dir, s, `ok ${phrase}`), undefined, 'the whole message, nothing else');
            assert.equal(confirmFromPrompt(dir, randomUUID(), phrase), undefined, 'another session');
            assert.deepEqual(confirmFromPrompt(dir, s, ` ${phrase.toUpperCase()} `), { verb: 'watch', summary: 'Q1' });
            assert.ok('pending' in askTyped(dir, s, 'watch', 'Q2'), 'a different question is not approved');
            assert.ok('pending' in askTyped(dir, s, 'watch', 'Q1'), 'and the waiting one was replaced by it');
            const q3 = (askTyped(dir, s, 'watch', 'Q3') as { pending: string }).pending;
            assert.ok(confirmFromPrompt(dir, s, q3));
            assert.deepEqual(askTyped(dir, s, 'watch', 'Q3'), { approved: true });
            assert.ok('pending' in askTyped(dir, s, 'watch', 'Q3'), 'once');
            const later = (askTyped(dir, s, 'watch', 'Q4', 1_000) as { pending: string }).pending;
            assert.equal(confirmFromPrompt(dir, s, later, 1_000 + 16 * 60_000), undefined, 'a question waits 15 minutes');
            assert.ok('unavailable' in askTyped(dir, undefined, 'watch', 'Q'));
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
        museSettings(data);
        const env = { MUSE_PLUGIN_DATA_DIR: data, HOME: data };
        try {
            assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'hello' }, env), { out: '', status: 0 });
            assert.ok(spokeAt(data, s) > 0, 'stamped');
            putInbox(data, s, '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)\nnew events');
            const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'anything new?' }, env);
            assert.equal(r.status, 0);
            assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)\nnew events' } });
            assert.equal(readdirSync(inboxDir(data, s)).length, 0, 'taken once');
            putInbox(data, s, 'mine');
            assert.equal(hook({ session_id: randomUUID(), prompt: 'hi' }, env).out, '', "another session's inbox is not this one's");
            const bad = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
            assert.deepEqual([bad.status, bad.stdout], [0, ''], 'bad input ends quietly and never stops the message');
        } finally {
            rmSync(data, { recursive: true, force: true });
        }
    });

    test("with the plugin's MCP server turned off in Muse (rejected, or never approved), the hook does nothing", () => {
        const data = temp('mcp-events-muse-hook-');
        const s = randomUUID();
        try {
            putInbox(data, s, 'waiting');
            assert.equal(hook({ session_id: s, prompt: 'hi' }, { MUSE_PLUGIN_DATA_DIR: data, HOME: data }).out, '', 'no Muse settings: never approved');
            museSettings(data, {}, { serverOn: false });
            assert.equal(serverEnabled({ HOME: data }, 'mcp-events'), false);
            assert.equal(hook({ session_id: s, prompt: 'hi' }, { MUSE_PLUGIN_DATA_DIR: data, HOME: data }).out, '', 'rejected');
            assert.equal(spokeAt(data, s), 0, 'nothing written either');
            museSettings(data);
            assert.match(hook({ session_id: s, prompt: 'hi' }, { MUSE_PLUGIN_DATA_DIR: data, HOME: data }).out, /waiting/, 'on again');
        } finally {
            rmSync(data, { recursive: true, force: true });
        }
    });

    test('a turn the plugin started through muse attach is not the person speaking; MCP_EVENTS_OFF in the settings file stops the hook', () => {
        const data = temp('mcp-events-muse-hook-');
        const s = randomUUID();
        museSettings(data);
        try {
            hook({ session_id: s, prompt: '[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)' }, { MUSE_PLUGIN_DATA_DIR: data, HOME: data });
            assert.equal(spokeAt(data, s), 0);
            writeFileSync(join(data, 'settings.json'), JSON.stringify({ MCP_EVENTS_OFF: '1' }));
            putInbox(data, s, 'waiting');
            assert.equal(hook({ session_id: s, prompt: 'hi' }, { MUSE_PLUGIN_DATA_DIR: data, HOME: data }).out, '');
        } finally {
            rmSync(data, { recursive: true, force: true });
        }
    });
});

describe('the helper in Muse', () => {
    test("a watch starts only after the person types its phrase; its new event reaches the model with the person's next message, once", async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        try {
            const tools = ((await h.request('tools/list')).result as { tools: { name: string; description: string; annotations: { readOnlyHint?: boolean } }[] }).tools;
            assert.equal(tools.length, 6);
            assert.ok(tools.every((t) => !t.description.includes('Codex')), 'named for Muse');
            assert.equal(tools.find((t) => t.name === 'watch_event')!.annotations.readOnlyHint, false, 'not read-only: Muse does not wave it through');
            assert.match((await call(h, 'list_event_types')).text, /"server": "tickets"/);
            const asked = await call(h, 'watch_event', WATCH);
            assert.equal(asked.isError, true);
            assert.match(asked.text, /^The watch is not started yet\. Muse gives this plugin no way to ask the person/);
            assert.match(asked.text, /Muse wants to watch "ticket\.created" on the MCP server "tickets"\.\nWhen it fires: "tell me"/);
            const phrase = /exactly: (watch \d{4})/.exec(asked.text)![1]!;
            const watchesFile = join(w.data, 'threads', w.session, 'watches.json');
            assert.ok(!existsSync(watchesFile) || !readFileSync(watchesFile, 'utf8').includes('ticket.created'), 'nothing watched yet');
            // The model calling again without the person's yes starts nothing.
            assert.match((await call(h, 'watch_event', WATCH)).text, /not started yet/);
            assert.equal(w.say(`sure, ${phrase}`).out, '', 'only the exact phrase');
            const out = JSON.parse(w.say(phrase).out);
            assert.equal(out.systemMessage, 'mcp-events: you approved: mcp-events: start a watch?');
            const r = await call(h, 'watch_event', WATCH);
            assert.equal(r.isError, false, r.text);
            const watch = /\b(w-[0-9a-f]+)\b/.exec(r.text)![1]!;
            assert.ok(readFileSync(watchesFile, 'utf8').includes(watch), 'kept under the session Muse named');
            await waitFor(async () => (JSON.parse((await call(h, 'list_watches')).text.split('\n\n')[0]!) as { status: string }[]).every((x) => x.status === 'active'), 15000, 'active');
            assert.match((await call(h, 'watch_event', WATCH)).text, /not started yet/, 'a second watch needs its own yes');
            w.emit('ticket.created', { id: 'T-1', title: 'printer on fire', priority: 'high' });
            await waitFor(() => w.stored('T-1'), 15000, 'the event in the store');
            await sleep(600);
            assert.ok(!existsSync(inboxDir(w.data, w.session)), 'the helper hands nothing over itself');
            const context = (JSON.parse(w.say('anything new?').out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
            assert.match(context, /^\[mcp-events\] \(Sent by the mcp-events plugin, not typed by the user\.\)\n\[mcp-events\] tickets · ticket\.created: 1 new event/);
            assert.ok(context.includes(watch), context);
            assert.ok(!context.includes('printer on fire'), 'nothing the server wrote, by default');
            assert.equal(w.say('and now?').out, '', 'handed over once');
            assert.match((await call(h, 'recent_events')).text, /T-1/);
            // A `muse exec` run: its helper ends right after the event is stored, before any hand-over could happen.
            w.emit('ticket.created', { id: 'T-9', priority: 'high' });
            await waitFor(() => w.stored('T-9'), 15000, 'the second event in the store');
            await h.stop();
            assert.match(JSON.parse(w.say('the next run').out).hookSpecificOutput.additionalContext, /1 new event \[event e2;/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('stopping a watch waits for its own typed yes too; an unknown watch is refused with nobody asked', async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        try {
            const watch = await watchActive(h, w);
            const asked = await call(h, 'unwatch_event', { watch });
            assert.equal(asked.isError, true);
            assert.match(asked.text, /^The watch is not stopped yet\./);
            assert.match(asked.text, new RegExp(`Muse wants to stop the watch "${watch}" of "ticket\\.created" on the MCP server "tickets"\\.\\nIts note: "tell me"`));
            const phrase = /exactly: (unwatch \d{4})/.exec(asked.text)![1]!;
            assert.match((await call(h, 'list_watches')).text, new RegExp(watch), 'still running');
            assert.match((JSON.parse(w.say(phrase).out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, /Call unwatch_event again/);
            const r = await call(h, 'unwatch_event', { watch });
            assert.equal(r.isError, false, r.text);
            assert.doesNotMatch((await call(h, 'list_watches')).text, new RegExp(`"id": "${watch}"`));
            const unknown = await call(h, 'unwatch_event', { watch: 'w-000000' });
            assert.doesNotMatch(unknown.text, /exactly: unwatch/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('a watch the question cannot show whole is refused before anyone is asked; an unknown event type is refused by the call itself', async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        try {
            await call(h, 'list_event_types');
            assert.match((await call(h, 'watch_event', { ...WATCH, note: 'x'.repeat(600) })).text, /^The watch is not started: its note is longer than the 500 characters/);
            const unknown = await call(h, 'watch_event', { server: 'tickets', event: 'no.such.event' });
            assert.equal(unknown.isError, true);
            assert.doesNotMatch(unknown.text, /exactly: watch/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('where an organisation manages Muse, the helper reaches no server, and says why', async () => {
        const w = museWorld();
        const h = await startMuse(w.env({ FAKE_MUSE_POLICY: 'present' }));
        try {
            const r = await call(h, 'list_event_types');
            assert.match(r.text, /your organisation manages Muse \(policy plane from system_file\)/);
            assert.doesNotMatch(r.text, /"server": "tickets"/);
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('with MCP_EVENTS_MUSE_WAKE=attach in the settings file, a batch starts a turn through muse attach, queued if the session is busy', async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach' });
        const h = await startMuse(w.env());
        try {
            await watchActive(h, w);
            w.emit('ticket.created', { id: 'T-2', priority: 'high' });
            await waitFor(() => w.turns().length > 0, 15000, 'a turn/start');
            const lines = readFileSync(w.fakeMuseLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args?: string[]; leaked?: string[]; in?: { method: string; params: Record<string, unknown> } });
            const attach = lines.find((l) => l.args?.[0] === 'attach')!;
            assert.deepEqual(attach.args, ['attach', '--stdio', w.session]);
            assert.deepEqual(attach.leaked, [], "the plugin's settings are not muse's business");
            assert.deepEqual(lines.filter((l) => l.in).map((l) => l.in!.method), ['initialize', 'initialized', 'session/resume', 'turn/start']);
            assert.match(String((lines.find((l) => l.in?.method === 'initialize')!.in!.params.clientInfo as { name: string }).name), /^[a-z0-9_]+$/, 'MSP refuses any other client name');
            const turn = lines.find((l) => l.in?.method === 'turn/start')!.in!.params as { sessionId: string; ifBusy: string; input: { type: string; text: string }[] };
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

    test("waking is capped as in Codex: past the hour's wakes the session is told once, and woken again only after a message of the person's", async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach', MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_WAKE_GAP_S: '0' });
        const h = await startMuse(w.env());
        try {
            await watchActive(h, w);
            w.emit('ticket.created', { id: 'A' });
            await waitFor(() => w.turns().length === 1, 15000, 'the first wake');
            w.emit('ticket.created', { id: 'B' });
            await waitFor(() => w.turns().length === 2, 15000, 'the notice');
            assert.match(w.turns()[1]!.text, /woken by events 1 times in the last hour, so the mcp-events plugin has stopped waking it/);
            w.emit('ticket.created', { id: 'C' });
            await sleep(2500);
            assert.equal(w.turns().length, 2, 'paused: no third turn');
            // The person writes (the hook stamps it); the helper sees it within its five-second tick.
            w.say('I am back');
            await waitFor(() => w.turns().length === 3, 20000, 'waking again after the person wrote');
        } finally {
            await h.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('a second process for the same session leaves the watches to the first, and takes them over, with the wake count, when it goes', async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach', MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_WAKE_GAP_S: '0' });
        const first = await startMuse(w.env());
        let second: Helper | undefined;
        try {
            await watchActive(first, w);
            w.emit('ticket.created', { id: 'A' });
            await waitFor(() => w.turns().length === 1, 15000, 'the first wake');
            second = await startMuse(w.env());
            await sleep(1500);
            assert.match((await call(second, 'list_watches')).text, /ticket\.created/);
            await first.stop();
            // The second takes over within its five-second tick; the hour's one wake is spent already.
            await sleep(6500);
            w.emit('ticket.created', { id: 'B' });
            await waitFor(() => w.turns().length === 2, 20000, 'a turn from the second process');
            assert.match(w.turns()[1]!.text, /has stopped waking it/, 'it inherited the wake count: the notice, not a second wake');
        } finally {
            await first.stop();
            await second?.stop();
            rmSync(w.dir, { recursive: true, force: true });
        }
    });

    test('when the session cannot be attached to (Muse launched without its gates), the batch waits in the inbox for the next message', async () => {
        const w = museWorld({ MCP_EVENTS_MUSE_WAKE: 'attach' });
        const h = await startMuse(w.env({ FAKE_MUSE_MODE: 'refuse' }));
        try {
            await watchActive(h, w);
            w.emit('ticket.created', { id: 'T-3', priority: 'high' });
            await waitFor(() => existsSync(inboxDir(w.data, w.session)) && readdirSync(inboxDir(w.data, w.session)).length > 0, 15000, 'a batch in the inbox');
            assert.match(w.say('hi').out, /1 new event/);
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
