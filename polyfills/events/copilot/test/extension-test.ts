// What is particular to Copilot: what the extension registers, standing down, the wake through
// session.send, which messages count as the person's, and which servers it may reach.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Extension, FIXTURE, newSession, sleep, startExtension, untilActive, waitFor, world } from './harness.ts';
import { INSTRUCTIONS } from '../src/words.ts';

describe('joining the session', () => {
    test('six tools: the four that only read skip the permission prompt, watch_event and unwatch_event do not; the session gets its instructions at start', async () => {
        const w = world();
        const e = await startExtension(w);
        try {
            const j = await e.joined;
            assert.deepEqual(j.tools.map((t) => t.name), ['list_event_types', 'watch_event', 'unwatch_event', 'list_watches', 'get_event', 'recent_events']);
            assert.deepEqual(j.tools.filter((t) => t.skipPermission).map((t) => t.name), ['list_event_types', 'list_watches', 'get_event', 'recent_events']);
            assert.deepEqual(j.hooks, ['onSessionStart']);
            // The tools array and hooks by name: the forms older Copilot releases know too (newer SDKs migrate them).
            assert.equal((j as { toolsForm?: string }).toolsForm, 'array');
            assert.deepEqual(await e.hook('onSessionStart', { source: 'new' }), { additionalContext: INSTRUCTIONS });
            // Nothing is connected until a tool is called: a session that never watches starts no server twice.
            await sleep(500);
            assert.deepEqual(w.fixtureMethods(), []);
        } finally {
            await e.stop();
        }
    });

    test('MCP_EVENTS_OFF=1 stands down: it joins with no tools and no hooks, and connects to nothing', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_OFF: '1' });
        try {
            const j = await e.joined;
            assert.deepEqual(j.tools, []);
            assert.deepEqual(j.hooks, []);
            await sleep(500);
            assert.deepEqual(w.fixtureMethods(), []);
        } finally {
            await e.stop();
        }
    });

    test('a join Copilot refuses (a discarded pre-warmed session) is logged in the extension\'s own words, and the process ends cleanly', async () => {
        const w = world();
        // The stand-in refuses a join without SESSION_ID, as the SDK does.
        const e = new Extension(w.env('', { SESSION_ID: '' }), w.cwd);
        assert.equal(await e.exited, 0);
        assert.match(w.log(), /did not let this extension join the session \(the request failed\); nothing to do/);
        assert.doesNotMatch(w.log(), /unexpected/);
    });

    test('SIGTERM, as Copilot stops an extension, ends the process and closes the subscription', async () => {
        const w = world();
        const e = await startExtension(w);
        await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
        await untilActive(e);
        const code = await e.stop('SIGTERM');
        assert.equal(code, 0);
        assert.match(w.log(), /stopped/);
    });
});

describe('robustness', () => {
    test('nothing reaches standard output, Copilot\'s channel: console output goes to the log, and arguments that are not an object are read as none', async () => {
        const w = world();
        const e = await startExtension(w);
        try {
            // The harness fails the run on any stdout line that is not the stand-in's JSON.
            for (const args of [null, 'a string', [1, 2], 7] as unknown[]) {
                const r = await e.call('list_watches', args as never);
                assert.equal(r.isError, false, JSON.stringify(args));
                assert.equal(r.text, '[]');
            }
            const r = await e.call('get_event', { id: 42 } as never);
            assert.equal(r.isError, true);
        } finally {
            await e.stop();
        }
    });
});

describe('asking before a watch (ask by default)', () => {
    test("each watch is put to the user in the extension's own dialog, after Copilot's tool prompt: it names the server, event type, filters and note, says its events start turns, and offers \"Don't watch it\" first", async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            const tools = (await e.joined).tools;
            // Copilot's own prompt still comes first: watch_event doesn't skip it.
            assert.equal(tools.find((t) => t.name === 'watch_event')!.skipPermission, false);
            const r = await e.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: { priority: 'high' }, note: 'tell me the title' });
            assert.equal(r.isError, false, r.text);
            assert.equal(e.asked.length, 1);
            const q = e.asked[0]!;
            assert.equal(q.kind, 'select');
            assert.deepEqual(q.options, ["Don't watch it", 'Watch it']);
            assert.match(q.message, /^mcp-events: start a watch\? Copilot wants to watch "ticket\.created" on the MCP server "tickets" with the filters \{"priority":"high"\}\. When it fires: "tell me the title"\. Its events will start turns in this session by themselves, while you are away too/);
            await untilActive(e);
            // Copilot shows the turns its wakes start, so Codex's rule (wait for a call from Codex's own
            // app) doesn't hold them, and nothing in Codex's words reaches this session.
            const watches = await e.call('list_watches');
            assert.doesNotMatch(r.text + watches.text, /Codex|codex queue/);
            // Reading needs no question.
            await e.call('list_event_types');
            assert.equal(e.asked.length, 1);
        } finally {
            await e.stop();
        }
    });

    test('declined, closed, or where Copilot can\'t ask anyone (copilot -p): nothing is watched, and the server is sent nothing', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { FAKE_UI: 'no' });
        try {
            const no = await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            assert.equal(no.isError, true);
            assert.match(no.text, /The user did not confirm the watch, so nothing is watched/);
            e.uiMode('cancel');
            const closed = await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            assert.match(closed.text, /The user did not confirm the watch/);
            e.uiMode('none');
            const nobody = await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            assert.equal(nobody.isError, true);
            assert.match(nobody.text, /A watch needs the user to confirm it, and Copilot can't ask anyone here/);
            // Nothing was subscribed or streamed on the server.
            assert.ok(!w.fixtureMethods().some((m) => /^events\/(subscribe|stream|poll)$/.test(m)), w.fixtureMethods().join(', '));
            assert.match(w.log(), /declined by the user/);
        } finally {
            await e.stop();
        }
    });

    test('MCP_EVENTS_ASK_BY_DEFAULT=0 leaves it to Copilot\'s permission rules: no question of its own', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_ASK_BY_DEFAULT: '0', FAKE_UI: 'no' });
        try {
            const r = await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            assert.equal(r.isError, false, r.text);
            assert.equal(e.asked.length, 0);
        } finally {
            await e.stop();
        }
    });

    test('a watch the question could not show in full, or whose filters hold a configured secret, is refused before anyone is asked; hidden characters are shown written out', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { FAKE_UI: 'no' });
        try {
            const long = await e.call('watch_event', { server: 'tickets', event: 'ticket.created', note: 'x'.repeat(501) });
            assert.match(long.text, /its note is longer than the 500 characters the question shows/);
            const wide = await e.call('watch_event', { server: 'tickets', event: 'ticket.created', arguments: { q: 'y'.repeat(1001) } });
            assert.match(wide.text, /its filters are longer than the 1000 characters/);
            assert.equal(e.asked.length, 0);
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created', note: 'title\u202eevil\u{e0041}' });
            assert.equal(e.asked.length, 1);
            assert.match(e.asked[0]!.message, /title\\u\{202e\}evil\\u\{e0041\}/);
            assert.doesNotMatch(e.asked[0]!.message, /[\u202e]|[\u{e0000}-\u{e0fff}]/u);
        } finally {
            await e.stop();
        }
    });
});

describe('waking', () => {
    test('past the hour\'s wakes the session is told once and paused; only the person writing lifts it, not another automation turn', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => e.sent.length === 1, 20000, 'the first wake');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => e.sent.length === 2, 20000, 'the notice');
            assert.match(e.sent[1]!.options.prompt, /Waking starts again when the user next sends a message/);
            w.emit('ticket.created', { title: 'three' });
            await sleep(1500);
            assert.equal(e.sent.length, 2, 'paused: not woken again');
            // This extension's own wake, or another automation, is not the person.
            e.message('[mcp-events] …', 'automation-mcp-events');
            e.message('from a skill', 'skill-pdf');
            await sleep(1000);
            assert.equal(e.sent.length, 2, 'still paused');
            // The person writes: waking starts again, with what waited.
            e.message('what happened?');
            await waitFor(() => e.sent.length === 3, 20000, 'the wake after the person wrote');
            assert.match(e.sent[2]!.options.prompt, /2 new events/);
        } finally {
            await e.stop();
        }
    });

    test('when Copilot refuses the message, the events stay, list_watches says why, and the wake is tried again until it goes through, once', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_WAKE_GAP_S: '0', FAKE_SEND_MODE: 'error' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => e.sent.length === 1, 20000, 'the first try');
            await waitFor(async () => /Waking this session failed the last time it was tried \(Copilot refused the message/.test((await e.call('list_watches')).text), 10000, 'list_watches to say so');
            e.sendMode('ok');
            await waitFor(() => e.sent.length >= 2, 20000, 'the retry');
            await sleep(6000);
            const delivered = e.sent.filter((s) => /\[event e1;/.test(s.options.prompt));
            assert.equal(delivered.length, 2, 'tried twice: refused, then taken');
            assert.equal(e.sent.length, 2, 'and not again after it was taken');
        } finally {
            await e.stop();
        }
    });

    test('a send Copilot never answers counts as handed over: not sent twice', async () => {
        const w = world();
        const e = await startExtension(w, newSession(), { MCP_EVENTS_WAKE_GAP_S: '0', FAKE_SEND_MODE: 'hang', MCP_EVENTS_SEND_TIMEOUT_MS: '1500' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => e.sent.length === 1, 20000, 'the send');
            await sleep(4000);
            assert.equal(e.sent.length, 1);
            assert.match(w.log(), /did not answer within 2 s; it may have queued the message, so it counts as handed over/);
            // list_watches says the wake may not have reached the session, in Copilot's terms.
            const watches = (await e.call('list_watches')).text;
            assert.match(watches, /The last wake's session\.send did not answer \(Copilot did not answer within 2 s\), so it may not have woken this session/);
            assert.doesNotMatch(watches, /codex/i);
        } finally {
            await e.stop();
        }
    });

    test('the same session open in a second process lists the watches without running them, and takes them over when the first goes', async () => {
        const w = world();
        const session = newSession();
        const a = await startExtension(w, session, { MCP_EVENTS_WAKE_GAP_S: '0' });
        let b: Extension | undefined;
        try {
            await a.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(a);
            b = await startExtension(w, session, { MCP_EVENTS_WAKE_GAP_S: '0' });
            assert.match((await b.call("list_watches")).text, /"status": "elsewhere"/);
            await a.stop();
            await waitFor(async () => /"status": "active"/.test((await b!.call('list_watches')).text), 20000, 'the second to take over');
            w.emit('ticket.created', { title: 'after the hand-over' });
            await waitFor(() => b!.sent.length === 1, 20000, 'a wake from the second');
        } finally {
            await a.stop();
            await b?.stop();
        }
    });
});

describe('two processes for one session (main\'s takeover and wake-cap fix)', () => {
    test('one that takes the watches over carries on from the wake count and pause the first saved, not from what it read when it opened', async () => {
        const w = world();
        const session = newSession();
        const env = { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1' };
        const a = await startExtension(w, session, env);
        let b: Extension | undefined;
        try {
            await a.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(a);
            // The second opens now, while nothing has woken the session: what it reads is out of date by the takeover.
            b = await startExtension(w, session, env);
            assert.match((await b.call('list_watches')).text, /"status": "elsewhere"/);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => a.sent.length === 1, 20000, 'the first wake');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => a.sent.length === 2, 20000, 'the notice');
            await a.stop();
            await waitFor(async () => /"status": "active"/.test((await b!.call('list_watches')).text), 20000, 'the second to take over');
            w.emit('ticket.created', { title: 'three' });
            await sleep(2500);
            assert.equal(b.sent.length, 0, 'past the hour\'s wakes and paused, as the first left it');
            // The person writes, in the one that now runs the watches: waking starts again, with what waited.
            b.message('what happened?');
            await waitFor(() => b!.sent.length === 1, 20000, 'the wake after the person wrote');
            assert.match(b.sent[0]!.options.prompt, /2 new events/);
        } finally {
            await a.stop();
            await b?.stop();
        }
    });

    test('the person writing in the process that does not run the watches leaves the pause to the one that does', async () => {
        const w = world();
        const session = newSession();
        const env = { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_WAKES_PER_HOUR: '1' };
        const a = await startExtension(w, session, env);
        let b: Extension | undefined;
        try {
            await a.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(a);
            b = await startExtension(w, session, env);
            w.emit('ticket.created', { title: 'one' });
            await waitFor(() => a.sent.length === 1, 20000, 'the first wake');
            w.emit('ticket.created', { title: 'two' });
            await waitFor(() => a.sent.length === 2, 20000, 'the notice');
            b.message('hello from the other window');
            await waitFor(() => /the user wrote in a window that doesn't run this session's watches/.test(w.log()), 10000, 'the second to log it');
            w.emit('ticket.created', { title: 'three' });
            await sleep(2500);
            assert.equal(a.sent.length, 2, 'still paused: the second did not undo the count');
            assert.equal(b.sent.length, 0);
            a.message('what happened?');
            await waitFor(() => a.sent.length === 3, 20000, 'the wake after the person wrote where the watches run');
        } finally {
            await a.stop();
            await b?.stop();
        }
    });
});

describe('which servers', () => {
    test('a server Copilot stops using mid-session is let go: its watch stops listening and waits, saved, and new events from it wake nothing', async () => {
        const w = world();
        const list = join(w.dir, 'configured.json');
        writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: true, source: 'user' }]));
        const e = await startExtension(w, newSession(), { FAKE_COPILOT_CONFIGURED_FILE: list, MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
            // `/mcp disable tickets`: Copilot lists it as off, and says a server's state changed.
            writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: false, source: 'user' }]));
            e.event('session.mcp_server_status_changed', { serverName: 'tickets', status: 'disabled' });
            await waitFor(async () => /"status": "error"/.test((await e.call('list_watches')).text), 15000, 'the watch to stop');
            const watches = (await e.call('list_watches')).text;
            assert.match(watches, /its server is not available in this session/);
            assert.match(watches, /ticket\.created/, 'kept, not removed');
            w.emit('ticket.created', { title: 'after the server was switched off' });
            await sleep(2500);
            assert.equal(e.sent.length, 0, 'no wake from a server Copilot no longer uses');
            assert.match(w.log(), /Copilot no longer uses it in this session/);
        } finally {
            await e.stop();
        }
    });

    test('a webhook watch on a server Copilot stops using has its subscription ended on the server, and its watch kept', async () => {
        const w = world({ FIXTURE_ALLOW_HTTP: '1' });
        const list = join(w.dir, 'configured.json');
        writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: true, source: 'user' }]));
        const net = await import('node:net');
        const port = await new Promise<number>((done) => {
            const srv = net.createServer().listen(0, '127.0.0.1', () => {
                const p = (srv.address() as { port: number }).port;
                srv.close(() => done(p));
            });
        });
        const e = await startExtension(w, newSession(), { FAKE_COPILOT_CONFIGURED_FILE: list, MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_EVENTS_RECEIVER_PORT: String(port) });
        try {
            assert.match((await e.call('watch_event', { server: 'tickets', event: 'deploy.finished' })).text, /by webhook/);
            await waitFor(() => w.fixtureMethods().includes('events/subscribe'), 10000, 'the subscription');
            writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: false, source: 'user' }]));
            e.event('session.mcp_server_status_changed', { serverName: 'tickets', status: 'disabled' });
            await waitFor(() => w.fixtureMethods().includes('events/unsubscribe'), 15000, 'the subscription to be ended');
            assert.match((await e.call('list_watches')).text, /deploy\.finished/);
        } finally {
            await e.stop();
        }
    });

    test('a server switched off while a resumed session is still connecting is checked afresh: its saved watch does not start', async () => {
        const w = world();
        const list = join(w.dir, 'configured.json');
        writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: true, source: 'user' }]));
        const session = newSession();
        let e = await startExtension(w, session, { FAKE_COPILOT_CONFIGURED_FILE: list, MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
        } finally {
            await e.stop();
        }
        const slow = join(w.dir, 'slow-fixture.mjs');
        writeFileSync(slow, `setTimeout(() => import(${JSON.stringify(pathToFileURL(FIXTURE).href)}), 1500);\n`);
        const cfg = JSON.parse(readFileSync(join(w.copilotHome, 'mcp-config.json'), 'utf8'));
        cfg.mcpServers.tickets.args = ['--no-warnings', slow];
        writeFileSync(join(w.copilotHome, 'mcp-config.json'), JSON.stringify(cfg));
        const before = w.fixtureMethods().filter((m) => m === 'events/stream').length;
        e = await startExtension(w, session, { FAKE_COPILOT_CONFIGURED_FILE: list, MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            // Switched off while discovery is still waiting for the slow server.
            await sleep(300);
            writeFileSync(list, JSON.stringify([{ name: 'tickets', enabled: false, source: 'user' }]));
            e.event('session.mcp_server_status_changed', { serverName: 'tickets', status: 'disabled' });
            await sleep(4000);
            assert.equal(w.fixtureMethods().filter((m) => m === 'events/stream').length, before, 'no new subscription');
            w.emit('ticket.created', { title: 'after the switch-off' });
            await sleep(1500);
            assert.equal(e.sent.length, 0);
        } finally {
            await e.stop();
        }
    });

    test('a tool called on a resumed session while its servers are still being looked at does not strand its saved watches', async () => {
        const w = world();
        // The server takes a moment to start, as a real one may: the resumed session's discovery is
        // still running when its first tool call comes in.
        const slow = join(w.dir, 'slow-fixture.mjs');
        writeFileSync(slow, `setTimeout(() => import(${JSON.stringify(pathToFileURL(FIXTURE).href)}), 1500);\n`);
        const cfg = JSON.parse(readFileSync(join(w.copilotHome, 'mcp-config.json'), 'utf8'));
        cfg.mcpServers.tickets.args = ['--no-warnings', slow];
        writeFileSync(join(w.copilotHome, 'mcp-config.json'), JSON.stringify(cfg));
        const session = newSession();
        let e = await startExtension(w, session, { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            await e.call('watch_event', { server: 'tickets', event: 'ticket.created' });
            await untilActive(e);
        } finally {
            await e.stop();
        }
        e = await startExtension(w, session, { MCP_EVENTS_WAKE_GAP_S: '0' });
        try {
            // Straight away, before discovery is through.
            const first = await e.call('list_watches');
            assert.match(first.text, /ticket\.created/);
            await untilActive(e);
            w.emit('ticket.created', { title: 'after the resume' });
            await waitFor(() => e.sent.length === 1, 20000, 'a wake');
        } finally {
            await e.stop();
        }
    });

    test('only servers Copilot lists as enabled are used; the others are listed as unavailable with the reason', async () => {
        const w = world({}, { extra: { secretive: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${NOT_GIVEN_TO_EXTENSIONS}' } } } });
        const configured = [
            { name: 'tickets', enabled: true, source: 'user' },
            { name: 'secretive', enabled: true, source: 'user' },
            { name: 'off', enabled: false, source: 'user' },
            { name: 'from-plugin', enabled: true, source: 'plugin', sourcePlugin: 'someone/thing' },
            { name: 'one-run', enabled: true, source: 'user' },
            { name: 'github-mcp-server', enabled: true, source: 'builtin' }
        ];
        const e = await startExtension(w, newSession(), { FAKE_COPILOT_CONFIGURED: JSON.stringify(configured) });
        try {
            const r = JSON.parse((await e.call('list_event_types')).text.replace(/^[^{]*/, '')) as { servers: { server: string }[]; unavailable: { name: string; why: string }[] };
            assert.deepEqual(r.servers.map((s) => s.server), ['tickets']);
            const why = Object.fromEntries(r.unavailable.map((u) => [u.name, u.why]));
            assert.match(why.secretive!, /NOT_GIVEN_TO_EXTENSIONS/);
            assert.match(why['from-plugin']!, /plugin someone\/thing/);
            assert.match(why['one-run']!, /--additional-mcp-config/);
            assert.equal(why.off, undefined, 'a server switched off is simply not there');
            assert.equal(why['github-mcp-server'], undefined);
        } finally {
            await e.stop();
        }
    });

    test('a server that answers 401 is listed as needing a sign-in this extension cannot do', async () => {
        const w = world();
        const http = await import('node:http');
        const srv = http.createServer((_q, s) => {
            s.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
            s.end();
        });
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
        const port = (srv.address() as { port: number }).port;
        writeFileSync(join(w.copilotHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { locked: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));
        const e = await startExtension(w, newSession(), { FAKE_COPILOT_CONFIGURED: JSON.stringify([{ name: 'locked', enabled: true, source: 'user' }]) });
        try {
            const r = await e.call('list_event_types');
            assert.match(r.text, /"name": "locked"/);
            assert.match(r.text, /sign-in this extension cannot do/);
        } finally {
            await e.stop();
            srv.close();
        }
    });
});
