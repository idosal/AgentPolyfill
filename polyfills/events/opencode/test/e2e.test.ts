// mcp-events in a real OpenCode (the pinned release, tools/opencode), in a
// throwaway home, against the fixture events server (a server written by hand
// from SEP-3415, sharing no code with the client) and a scripted model.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { freePort, textOf, waitFor, World, type McpConfig, type Rule } from '../../../../tools/opencode/harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The fixture servers' event logs are removed when the test process ends.
const upstreams: string[] = [];
process.on('exit', () => {
    for (const f of upstreams) rmSync(f, { force: true });
});
const PLUGIN = join(ROOT, 'plugin');
const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');
const ASK: Rule[] = [
    { action: 'mcp_events_watch', resource: '*', effect: 'ask' },
    { action: 'mcp_events_unwatch', resource: '*', effect: 'ask' }
];

function eventsWorld(o: { delivery?: string; permissions?: Rule[]; fixtureEnv?: Record<string, string>; env?: Record<string, string>; mcp?: Record<string, McpConfig>; options?: Record<string, unknown> } = {}) {
    const upstream = join(tmpdir(), `upstream-${randomUUID()}.jsonl`);
    writeFileSync(upstream, '');
    upstreams.push(upstream);
    const world = new World({
        plugins: [o.options ? { package: PLUGIN, options: o.options } : PLUGIN],
        mcp: {
            fixture: {
                type: 'local',
                command: [process.execPath, '--no-warnings', FIXTURE],
                environment: { FIXTURE_UPSTREAM: upstream, FIXTURE_TICKET_DELIVERY: o.delivery ?? 'poll', FIXTURE_POLL_MS: '300', ...o.fixtureEnv }
            },
            ...o.mcp
        },
        permissions: o.permissions === undefined && 'permissions' in o ? [] : (o.permissions ?? ASK),
        // Worlds with no rules test something else: they leave the decision to OpenCode's rules alone.
        env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_BATCH_MS: '200', ...(o.permissions?.length === 0 ? { MCP_EVENTS_ASK_BY_DEFAULT: '0' } : {}), ...o.env }
    });
    const emit = (name: string, data: Record<string, unknown>) => {
        const eventId = `evt_${randomUUID().slice(0, 8)}`;
        appendFileSync(upstream, JSON.stringify({ eventId, name, timestamp: new Date().toISOString(), data }) + '\n');
        return eventId;
    };
    return { world, emit };
}

/** The result text of the last tool call the model saw. */
const lastToolResult = (w: World) => {
    const r = w.llmRequests().at(-1);
    const tool = [...(r?.messages ?? [])].reverse().find((m) => m.role === 'tool');
    return tool ? (typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)) : '';
};

/** Sends a prompt and waits for the turn to end; answers each permission request with `answer`. */
async function turn(w: World, session: string, text: string, answer?: 'once' | 'always' | 'reject') {
    const since = Date.now();
    await w.prompt(session, text);
    if (answer) {
        const req = await waitFor(async () => (await w.permissions(session))[0], 30000, 'a permission request');
        await w.reply(session, req.id, answer);
    }
    await w.idle(session, since).catch(() => undefined);
    return lastToolResult(w);
}

describe('mcp-events in OpenCode', () => {
    const { world, emit } = eventsWorld();
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('loads: its six tools reach the model, in their namespace', async () => {
        await turn(world, session, 'hello');
        const tools = (world.llmRequests().at(-1)?.tools ?? []).map((t) => t.function?.name);
        for (const n of ['list_event_types', 'watch_event', 'unwatch_event', 'list_watches', 'get_event', 'recent_events']) assert.ok(tools.includes(`mcp_events_${n}`), `${n} in ${tools.join(', ')}`);
    });

    test('lists the fixture server\'s event types, from OpenCode\'s own MCP configuration', async () => {
        const out = await turn(world, session, 'CALL mcp_events_list_event_types {}');
        assert.match(out, /ticket\.created/);
        assert.match(out, /"server": "fixture"/);
    });

    test('a watch is put to OpenCode\'s permission rules first; rejected, nothing is watched', async () => {
        await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created","note":"tell me"}', 'reject');
        const out = await turn(world, session, 'CALL mcp_events_list_watches {}');
        assert.match(out, /\[\]/);
    });

    test('approved, it watches; an event then wakes the idle session with a synthetic message', async () => {
        const req = (async () => {
            const r = await waitFor(async () => (await world.permissions(session))[0], 30000, 'the watch request');
            return r as unknown as { resources: string[]; save?: string[] };
        })();
        const out = await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created","note":"tell me"}', 'once');
        // A plain name: "Allow always" would save exactly what was asked about.
        assert.deepEqual((await req).save, ['fixture:ticket.created']);
        assert.match(out, /Watching fixture \/ ticket\.created as w-[0-9a-f]{6}, by poll/);
        await world.idle(session);
        const before = (await world.session(session)).time.idle ?? 0;
        await new Promise((r) => setTimeout(r, 800));
        const id = emit('ticket.created', { title: 'Printer on fire', priority: 'high' });
        // The session wakes by itself: a new turn starts after it was idle.
        await world.idle(session, before, 30000);
        const msgs = await world.messages(session);
        const wake = msgs.find((m) => m.type === 'synthetic' && textOf(m).includes('[mcp-events]'));
        assert.ok(wake, `a synthetic [mcp-events] message in ${JSON.stringify(msgs.map((m) => m.type))}`);
        assert.match(textOf(wake!), /not typed by the user/);
        // The wake gives ids, never what the server sent.
        assert.doesNotMatch(textOf(wake!), /Printer on fire/);
        // And the model saw it as input of its own turn.
        assert.ok(world.lastSeen().some((l) => l.includes('[mcp-events]')), 'the model saw the wake');
        // get_event returns the event, as data from the server.
        const ev = /\b(e\d+)\b/.exec(textOf(wake!))?.[1];
        assert.ok(ev, 'an event id in the wake');
        const got = await turn(world, session, `CALL mcp_events_get_event {"id":"${ev}"}`);
        assert.match(got, /Printer on fire/);
        assert.match(got, new RegExp(id));
    });

    test('unwatch is asked about too, and ends the watch', async () => {
        const list = await turn(world, session, 'CALL mcp_events_list_watches {}');
        const w = /"id": "(w-[0-9a-f]{6})"/.exec(list)?.[1];
        assert.ok(w);
        const out = await turn(world, session, `CALL mcp_events_unwatch_event {"watch":"${w}"}`, 'once');
        assert.match(out, /Stopped w-/);
    });
});

describe('mcp-events across an OpenCode restart', () => {
    const { world, emit } = eventsWorld({ permissions: [] });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('a watch resumes from its cursor: an event from while OpenCode was down wakes the session once', async () => {
        const out = await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created","note":"tell me"}');
        assert.match(out, /Watching fixture/);
        await new Promise((r) => setTimeout(r, 1000));
        await world.restart();
        emit('ticket.created', { title: 'While down' });
        // OpenCode loads a location's plugins when a client uses that location (opening the project again does).
        await world.api('GET', `/api/mcp?location[directory]=${encodeURIComponent(world.project)}`);
        await waitFor(async () => (await world.messages(session)).some((m) => m.type === 'synthetic' && textOf(m).includes('[mcp-events]')), 40000, 'the wake after the restart');
        await world.idle(session, 0);
        await new Promise((r) => setTimeout(r, 2000));
        const wakes = (await world.messages(session)).filter((m) => m.type === 'synthetic' && textOf(m).includes('[mcp-events]'));
        assert.equal(wakes.length, 1);
    });
});

describe('mcp-events by webhook, inside OpenCode', () => {
    let port = 0;
    let ew: ReturnType<typeof eventsWorld>;
    let session = '';
    before(async () => {
        port = await freePort();
        // The plugin's own receiver, inside OpenCode's server, at a loopback address the fixture may post to (tests only).
        ew = eventsWorld({ permissions: [], fixtureEnv: { FIXTURE_ALLOW_HTTP: '1' }, env: { MCP_EVENTS_DEV: '1', MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_EVENTS_RECEIVER_PORT: String(port) } });
        await ew.world.start();
        session = await ew.world.createSession();
    });
    after(() => ew.world.stop());

    test('a webhook-only event type is watched by webhook; a signed delivery wakes the session', async () => {
        const out = await turn(ew.world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"deploy.finished","note":"say which service"}');
        assert.match(out, /Watching fixture \/ deploy\.finished as w-[0-9a-f]{6}, by webhook/);
        await ew.world.idle(session);
        const before = (await ew.world.session(session)).time.idle ?? 0;
        await new Promise((r) => setTimeout(r, 800));
        ew.emit('deploy.finished', { service: 'billing', status: 'ok' });
        await ew.world.idle(session, before, 30000);
        const wake = (await ew.world.messages(session)).find((m) => m.type === 'synthetic' && textOf(m).includes('deploy.finished'));
        assert.ok(wake, 'a wake for the delivery');
    });
});

describe('mcp-events with a server that needs a sign-in', () => {
    let locked: ReturnType<typeof createServer>;
    let ew: ReturnType<typeof eventsWorld>;
    let session = '';
    const SECRET = 'test-secret-7f3a9c1e2b';
    before(async () => {
        locked = createServer((_req, res) => {
            res.writeHead(401, { 'www-authenticate': 'Bearer realm="locked"', 'content-type': 'application/json' });
            res.end('{"error":"unauthorized"}');
        });
        const port = await freePort();
        await new Promise<void>((r) => locked.listen(port, '127.0.0.1', r));
        ew = eventsWorld({ permissions: [], mcp: { locked: { type: 'remote', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${SECRET}` }, oauth: false } } });
        await ew.world.start();
        session = await ew.world.createSession();
    });
    after(async () => {
        await ew.world.stop();
        locked.close();
    });

    test('it is named as left alone, why, and the other server still works; its header never shows', async () => {
        const out = await turn(ew.world, session, 'CALL mcp_events_list_event_types {}');
        assert.match(out, /"name": "locked"/);
        assert.match(out, /sign-in/);
        assert.match(out, /ticket\.created/);
        assert.doesNotMatch(out, new RegExp(SECRET));
        const log = readFileSync(`${ew.world.home}/.local/share/opencode/mcp-events/mcp-events.log`, 'utf8');
        assert.doesNotMatch(log, new RegExp(SECRET));
        assert.doesNotMatch(JSON.stringify(ew.world.llmRequests()), new RegExp(SECRET));
    });
});

describe('mcp-events by push, beside OpenCode\'s automations', () => {
    const { world, emit } = eventsWorld({ delivery: 'poll,push', permissions: [] });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('a push event type is watched by push, with OpenCode\'s automations named as the alternative; an event wakes the session', async () => {
        // OpenCode's own client skips this type (it can't check its payload schema), so leaving push to it would leave the type unwatched.
        const out = await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created","note":"tell me"}');
        assert.match(out, /Watching fixture \/ ticket\.created as w-[0-9a-f]{6}, by push/);
        assert.match(out, /automations can also take push events/);
        await world.idle(session);
        const before = (await world.session(session)).time.idle ?? 0;
        await new Promise((r) => setTimeout(r, 800));
        emit('ticket.created', { title: 'By push' });
        await world.idle(session, before, 30000);
        assert.ok((await world.messages(session)).some((m) => m.type === 'synthetic' && textOf(m).includes('[mcp-events]')), 'a wake');
    });
});

describe('mcp-events asks by default', () => {
    // No rule for the plugin's actions: OpenCode's shipped default would allow them.
    const asks = eventsWorld({ permissions: undefined, env: {} });
    let session = '';
    before(async () => {
        await asks.world.start();
        session = await asks.world.createSession();
    });
    after(() => asks.world.stop());

    test('with OpenCode\'s default rules, a watch is asked about; "Allow always" then covers that event type', async () => {
        const out = await turn(asks.world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created"}', 'always');
        assert.match(out, /Watching fixture \/ ticket\.created/);
        const w = /as (w-[0-9a-f]{6})/.exec(out)![1]!;
        await turn(asks.world, session, `CALL mcp_events_unwatch_event {"watch":"${w}"}`, 'once');
        // The same event type again: the person's "Allow always" covers it, nobody is asked.
        const again = await turn(asks.world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created"}');
        assert.match(again, /Watching fixture \/ ticket\.created/);
        // Another event type is not covered by it.
        await asks.world.prompt(session, 'CALL mcp_events_watch_event {"server":"fixture","event":"deploy.finished"}');
        const req = await waitFor(async () => (await asks.world.permissions(session))[0], 30000, 'a request for the other event type');
        assert.equal(req.resources[0], 'fixture:deploy.finished');
        await asks.world.reply(session, req.id, 'reject');
    });
});

describe('mcp-events with askByDefault off', () => {
    const off = eventsWorld({ permissions: undefined, options: { askByDefault: false } });
    let session = '';
    before(async () => {
        await off.world.start();
        session = await off.world.createSession();
    });
    after(() => off.world.stop());

    test("OpenCode's rules alone decide: with its defaults, nobody is asked", async () => {
        const out = await turn(off.world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created"}');
        assert.match(out, /Watching fixture \/ ticket\.created/);
    });
});
