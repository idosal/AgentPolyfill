import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { sessionDir } from '../../core/src/store.ts';
import { askTyped, confirmFromPrompt } from '../src/muse-confirm.ts';

import { WAKE_HEADER as CODEX_WAKE_HEADER } from '../../codex/src/threads.ts';
import { FIXTURE, Helper, sleep, temp, waitFor } from '../../codex/test/harness.ts';
import { museWatchQuestion } from '../src/muse.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'plugin/dist/inbox.mjs');

const HOOK = join(ROOT, 'plugin/dist/user-prompt-submit.mjs');
const FAKE_MUSE = join(ROOT, 'test', 'fake-muse.mjs');


/** Muse's user settings in `home`: its MCP servers, and this plugin's server turned on (approved), unless `serverOn` is false. */
function museSettings(home: string, mcpServers: Record<string, unknown> = {}, o: { serverOn?: boolean } = {}) {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true });
    const caps = o.serverOn === false ? { 'plugin:mcp-event-monitor:mcp_server:mcp-events': { enabled: false } } : { 'plugin:mcp-event-monitor:mcp_server:mcp-events': { enabled: true }, 'plugin:mcp-event-monitor:hook:user-prompt-submit': { enabled: true } };
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
    writeFileSync(join(data, 'muse-servers.json'), JSON.stringify(['tickets']));
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
                MUSE_PLUGIN_ID: 'mcp-event-monitor',
                MUSE_PLUGIN_DATA_DIR: data,
                MCP_EVENTS_DEV: '1',
                MCP_EVENTS_MUSE_BIN: FAKE_MUSE,
                FAKE_MUSE_LOG: join(dir, 'fake-muse.jsonl'),
                ...extra
            };
        },
        /** The person sends a message of their own: the hook runs, as Muse runs it. */
        say(prompt: string) {
            return hook({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }, { HOME: dir, MUSE_PLUGIN_DATA_DIR: data, MUSE_PLUGIN_ID: 'mcp-event-monitor' });
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
    const h = new Helper(env, HELPER);
    await h.initialize();
    return h;
}

const WATCH = { server: 'tickets', event: 'ticket.created', note: 'tell me' };

/** A watch as it goes in Muse: asked, the person types the phrase, asked again; then until it is active. */
async function watchActive(h: Helper, w: World, args: Record<string, unknown> = WATCH): Promise<string> {
    const asked = await call(h, 'watch_event', args);
    const phrase = /exactly: (watch \S+ \S+ \d{4})$/m.exec(asked.text)?.[1];
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

describe('the helper in Muse', () => {
    test("a watch starts only after the person types its phrase; its new event reaches the model with the person's next message, once", async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        try {
            const tools = ((await h.request('tools/list')).result as { tools: { name: string; description: string; annotations: { readOnlyHint?: boolean } }[] }).tools;
            assert.ok(tools.some(t => t.name === 'watch_event'));
            assert.ok(tools.every((t) => !t.description.includes('Codex')), 'named for Muse');
            assert.equal(tools.find((t) => t.name === 'watch_event')!.annotations.readOnlyHint, false, 'not read-only: Muse does not wave it through');
            assert.match((await call(h, 'list_event_types')).text, /"server": "tickets"/);
            const asked = await call(h, 'watch_event', WATCH);
            assert.equal(asked.isError, true);
            assert.match(asked.text, /^The watch is not started yet\. Muse gives this plugin no way to ask the person/);
            assert.match(asked.text, /Muse wants to watch "ticket\.created" on the MCP server "tickets"\.\nWhen it fires: "tell me"/);
            const phrase = /exactly: (watch tickets ticket\.created \d{4})$/m.exec(asked.text)?.[1];
            assert.ok(phrase, `the phrase names the server and the event type: ${asked.text}`);
            const watchesFile = join(w.data, 'threads', w.session, 'watches.json');
            assert.ok(!existsSync(watchesFile) || !readFileSync(watchesFile, 'utf8').includes('ticket.created'), 'nothing watched yet');
            // The model calling again without the person's yes starts nothing.
            assert.match((await call(h, 'watch_event', WATCH)).text, /not started yet/);
            assert.equal(w.say(`sure, ${phrase}`).out, '', 'only the exact phrase');
            assert.equal(w.say(phrase.replace(' tickets ticket.created', '')).out, '', 'the code alone is not the phrase');
            assert.equal(w.say(phrase.replace('tickets', 'other')).out, '', 'nor is the code with another name');
            const out = JSON.parse(w.say(phrase).out);
            assert.equal(out.systemMessage, 'mcp-events: you approved: mcp-events: start a watch?');
            const r = await call(h, 'watch_event', WATCH);
            assert.equal(r.isError, false, r.text);
            // The Codex form's "shown by" gate is Codex's: in Muse nothing says to wait for Codex's own app.
            assert.doesNotMatch(r.text, /Codex's own app/);
            assert.doesNotMatch((await call(h, 'list_watches')).text, /Codex's own app/);
            const watch = /\b(w-[0-9a-f]+)\b/.exec(r.text)![1]!;
            assert.ok(readFileSync(watchesFile, 'utf8').includes(watch), 'kept under the session Muse named');
            await waitFor(async () => (JSON.parse((await call(h, 'list_watches')).text.split('\n\n')[0]!) as { status: string }[]).every((x) => x.status === 'active'), 15000, 'active');
            assert.match((await call(h, 'watch_event', WATCH)).text, /not started yet/, 'a second watch needs its own yes');
            w.emit('ticket.created', { id: 'T-1', title: 'printer on fire', priority: 'high' });
            await waitFor(() => w.stored('T-1'), 15000, 'the event in the store');
            await sleep(600);
            assert.equal(w.turns().length, 0, 'the helper must never start a turn');
            const context = (JSON.parse(w.say('anything new?').out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
            assert.match(context, /^\[mcp-events\] \(Sent by the mcp-events plugin, not typed by the user\.\)\n\[mcp-events\] tickets · ticket\.created: 1 new event/);
            assert.ok(context.includes(watch), context);
            assert.ok(!context.includes('printer on fire'), 'nothing the server wrote, by default');
            assert.equal(w.say('and now?').out, '', 'handed over once');
            assert.match((await call(h, 'recent_events')).text, /T-1/);
            assert.equal(hook({ session_id: randomUUID(), prompt: 'new?' }, w.env()).out, '');
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
            const phrase = /exactly: (unwatch tickets ticket\.created \d{4})$/m.exec(asked.text)![1]!;
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

    test('a watch the question cannot show whole is refused before anyone is asked; so is an unknown server or event type', async () => {
        const w = museWorld();
        const h = await startMuse(w.env());
        try {
            await call(h, 'list_event_types');
            assert.match((await call(h, 'watch_event', { ...WATCH, note: 'x'.repeat(600) })).text, /^The watch is not started: its note is longer than the 500 characters/);
            const unknown = await call(h, 'watch_event', { server: 'tickets', event: 'no.such.event' });
            assert.equal(unknown.isError, true);
            assert.match(unknown.text, /^The watch is not started: server "tickets" has no event type by that name\. It has: ticket\.created/);
            assert.doesNotMatch(unknown.text, /exactly: watch/);
            const nowhere = await call(h, 'watch_event', { server: 'nowhere', event: 'ticket.created' });
            assert.match(nowhere.text, /^The watch is not started: no MCP server by that name offers events\. Known: tickets/);
            assert.match(museWatchQuestion({ ...WATCH, maxAgeMs: 60000 }), /When it resumes after a break, it asks for events at most 60000 ms old\./, 'maxAgeMs is in the question');
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


test('a typed watch confirmation is scoped, expires and can be consumed only once', () => {
    const w = museWorld();
    try {
        const ask = (when: number, question = 'Watch red tickets?', endpoint = 'original') =>
            askTyped(w.data, w.session, 'watch', question, when, ['tickets','created'], endpoint);
        const first = ask(100);
        assert.ok('pending' in first);
        assert.equal(confirmFromPrompt(w.data, randomUUID(), first.pending, 101), undefined);
        assert.equal(confirmFromPrompt(w.data, w.session, first.pending, 102)?.verb, 'watch');
        const replacement = ask(103, undefined, 'changed');
        assert.ok('pending' in replacement);
        assert.equal(confirmFromPrompt(w.data, w.session, first.pending, 103), undefined);
        assert.equal(confirmFromPrompt(w.data, w.session, replacement.pending, 103)?.verb, 'watch');
        assert.deepEqual(ask(103, undefined, 'changed'), { approved: true });
        const next = ask(104);
        assert.ok('pending' in next);
        assert.equal(confirmFromPrompt(w.data, w.session, next.pending, 104 + 16 * 60000), undefined);
        const changed = ask(110, 'Watch blue tickets?');
        assert.ok('pending' in changed);
        assert.equal(confirmFromPrompt(w.data, w.session, next.pending, 111), undefined);
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
