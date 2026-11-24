// mcp-events in a real OpenCode (the pinned release, tools/opencode), in a
// throwaway home, against the fixture events server (a server written by hand
// from SEP-3415, sharing no code with the client) and a scripted model.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { textOf, waitFor, World, type Rule } from '../../../../tools/opencode/harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = join(ROOT, 'plugin');
const FIXTURE = join(ROOT, '..', 'claude-code', 'test', 'fixture-events-server.ts');
const ASK: Rule[] = [
    { action: 'mcp_events_watch', resource: '*', effect: 'ask' },
    { action: 'mcp_events_unwatch', resource: '*', effect: 'ask' }
];

function eventsWorld(o: { delivery?: string; permissions?: Rule[] } = {}) {
    const upstream = join(process.env.TMPDIR ?? '/tmp', `upstream-${randomUUID()}.jsonl`);
    writeFileSync(upstream, '');
    const world = new World({
        plugins: [PLUGIN],
        mcp: {
            fixture: {
                type: 'local',
                command: [process.execPath, '--no-warnings', FIXTURE],
                environment: { FIXTURE_UPSTREAM: upstream, FIXTURE_TICKET_DELIVERY: o.delivery ?? 'poll', FIXTURE_POLL_MS: '300' }
            }
        },
        permissions: o.permissions ?? ASK,
        env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_BATCH_MS: '200' }
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
        const out = await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created","note":"tell me"}', 'once');
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

describe('mcp-events leaves push to OpenCode', () => {
    const { world } = eventsWorld({ delivery: 'poll,push' });
    let session = '';
    before(async () => {
        await world.start();
        session = await world.createSession();
    });
    after(() => world.stop());

    test('an event type OpenCode can watch by push is not watched by the plugin', async () => {
        const out = await turn(world, session, 'CALL mcp_events_watch_event {"server":"fixture","event":"ticket.created"}');
        assert.match(out, /OpenCode watches this event type itself/);
        assert.equal((await world.permissions(session)).length, 0);
        const list = await turn(world, session, 'CALL mcp_events_list_event_types {}');
        assert.match(list, /This plugin watches the others/);
    });
});
