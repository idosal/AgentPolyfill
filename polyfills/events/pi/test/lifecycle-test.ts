// What happens around a watch, in a real Pi: the session is closed and
// resumed (the watch resumes from its cursor, and what arrived meanwhile is
// handed over); the hourly wake cap (a notice that starts no turn, then waking
// again once the user writes); and print mode, where nobody can confirm a watch.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BRAIN, Pi, PI_BIN, sleep, temp, waitFor } from './pi-rpc.ts';
import { EXTENSION, RULES, world } from './world.ts';

const running: Pi[] = [];
after(async () => {
    for (const p of running) await p.stop();
});
const yes = (r: { method: string }) => (r.method === 'confirm' ? true : undefined);
const wakes = (pi: Pi) => pi.messages('custom').filter((m) => m.customType === 'mcp-events').map((m) => String(m.content));
const runs = (pi: Pi) => pi.records.filter((r) => r.type === 'agent_start').length;

test('a resumed session resumes its watch, and what arrived while Pi was closed is handed over', { timeout: 120_000 }, async () => {
    const w = world();
    const sessions = join(temp('mcp-events-sessions-'), 's');
    const id = 'resume-test-1';
    // Pi resumes a session in its own working directory, and a local server's identity includes it.
    const cwd = temp('mcp-events-project-');
    const first = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, cwd, sessionDir: sessions, args: ['--session-id', id], answer: yes });
    await first.ready();
    await first.prompt('watch tickets ticket.created');
    assert.ok(first.toolResults('watch_event').some((t) => !t.isError));
    await first.stop();

    // Pi is closed. An event arrives at the server.
    w.emit('ticket.created', { id: 'T-9', title: 'Arrived while away' });
    await sleep(500);

    const second = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, cwd, sessionDir: sessions, args: ['--session-id', id], answer: () => undefined });
    running.push(second);
    await second.ready();
    const wake = await waitFor(() => wakes(second)[0], 30000, 'the wake in the resumed session');
    assert.match(wake, /tickets · ticket\.created: 1 new event/);
    await waitFor(() => second.toolResults('get_event').length > 0, 30000, 'get_event');
    assert.match(second.toolResults('get_event')[0]!.text, /Arrived while away/);
    assert.equal(second.ui.length, 0, 'nothing is asked again: the watch was confirmed in this session before');
});

test('the hourly cap: past it the session is told once, without a turn, and waking starts again when the user writes', { timeout: 120_000 }, async () => {
    const w = world();
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: w.agentDir, answer: yes, env: { MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_BATCH_MS: '200' } });
    running.push(pi);
    await pi.ready();
    await pi.prompt('watch tickets ticket.created');

    w.emit('ticket.created', { id: 'T-1' });
    await waitFor(() => wakes(pi).length === 1, 20000, 'the first wake');
    await waitFor(() => pi.toolResults('get_event').length === 1, 20000, 'the first woken turn');
    await waitFor(() => pi.records.at(-1)?.type === 'agent_settled' || pi.records.some((r, i) => i > 0 && r.type === 'agent_settled'), 20000, 'settled');
    await sleep(1000);
    const before = runs(pi);

    // The second event is past the cap: a notice, and no turn.
    w.emit('ticket.created', { id: 'T-2' });
    await waitFor(() => wakes(pi).length === 2, 20000, 'the notice');
    assert.match(wakes(pi)[1]!, /has stopped waking it\. 1 event is waiting/);
    await sleep(3000);
    assert.equal(runs(pi), before, 'the notice started no turn');

    // The user writes: waking starts again, and what waited is handed over.
    await pi.prompt('hello');
    await waitFor(() => wakes(pi).length === 3, 20000, 'the wake after the user wrote');
    assert.match(wakes(pi)[2]!, /tickets · ticket\.created: 1 new event/);
});

test('print mode: nobody can confirm a watch, so none is started', { timeout: 60_000 }, async () => {
    const w = world();
    const child = spawn(process.execPath, [PI_BIN, '--offline', '--mode', 'json', '--no-session', '--provider', 'scripted', '--model', 'm1', '-e', BRAIN, '-e', EXTENSION, '-p', 'watch tickets ticket.created'], {
        env: { ...process.env, HOME: join(w.dir, 'home'), PI_CODING_AGENT_DIR: w.agentDir, PI_TEST_RULES: JSON.stringify(RULES) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    await new Promise((r) => child.on('exit', r));
    assert.match(out, /A watch needs the user to confirm it, and Pi has no one to ask in this mode/);
    assert.ok(!w.methods().some((m) => m === 'events/stream' || m === 'events/poll' || m === 'events/subscribe'), 'nothing was subscribed');
});
