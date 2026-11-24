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
