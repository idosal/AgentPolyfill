import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir, writePrivate } from '../../../server-cards/antigravity/src/gate.ts';
import { deliveredPosition, Spool } from '../../core/src/store.ts';
import { WakeBudget } from '../../core/src/wake.ts';
import { recordSurface, requestWake, requestsDir, surfaceOfSession } from '../src/pending.ts';
import { findAgentapi, HEARTBEAT_MS, sendMessage, WakeSidecar, wakeAvailability } from '../src/sidecar.ts';
import { WAKE_PROMPT } from '../src/words.ts';
import { fakeAgentapi, invocation, newThread, ROOT, SERVER, sleep, startHelper, tempHome, waitFor, world } from './harness.ts';

function rig(extra: Record<string, string> = {}) {
    const home = tempHome(), id = newThread(), base = stateDir('mcp-events', { HOME: home });
    const fake = fakeAgentapi(home), env = { ...fake.env, MCP_EVENTS_BATCH_MS: '0', MCP_EVENTS_WAKE_GAP_S: '0', ...extra };
    const spool = new Spool(base, id), sidecar = new WakeSidecar(base, env);
    // An App conversation, as its hook records it: only those are woken.
    if (extra.SURFACE !== 'none') recordSurface(base, id, 'app');
    const append = () => { spool.append({ kind: 'event', watch: 'w-1', server: 'tickets', event: 'ticket.created', data: { title: 'untrusted' } }); requestWake(base, id, env); };
    return { home, id, base, fake, env, spool, sidecar, append };
}

test('W-1 fake agentapi on PATH receives exactly send-message, UUID and one literal prompt; no shell', async () => {
    const r = rig(), text = '-flag\n$(touch SHOULD_NOT_EXIST); `echo hi` & "quoted"';
    const bin = findAgentapi(r.env)!; assert.ok(bin.endsWith('/agentapi'));
    assert.deepEqual(await sendMessage(bin, r.id, text, r.env), { ok: true });
    // Nothing but what agentapi needs: not the sidecar's MCP_EVENTS_* settings, not an unrelated variable.
    assert.deepEqual(r.fake.calls()[0]!.args, ['send-message', r.id, text]); assert.deepEqual(r.fake.calls()[0]!.leaked, []);
    assert.ok(!existsSync(join(ROOT, 'SHOULD_NOT_EXIST')));
    for (const id of ['--help', '../../elsewhere', 'not-uuid']) assert.equal((await sendMessage(bin, id, text, r.env)).ok, false);
    assert.equal((await sendMessage(join(r.home, 'agentapi.cmd'), r.id, text, r.env)).ok, false);
    assert.equal(r.fake.calls().length, 1);
});
test('W-2 sidecar wakes once per batch and leaves delivery to PreInvocation', async () => {
    const r = rig(); r.append(); r.append();
    try {
        await r.sidecar.tick(); await r.sidecar.tick(); assert.equal(r.fake.calls().length, 1);
        assert.deepEqual(r.fake.calls()[0]!.args, ['send-message', r.id, WAKE_PROMPT]);
        assert.equal(deliveredPosition(r.spool.dir), 0, 'a wake does not claim injection');
        assert.match(invocation(r.home, { conversationId: r.id }).injectSteps[0].systemMessage.systemMessage, /2 new events or notices are waiting for this conversation\. Call recent_events/);
        await r.sidecar.tick(); assert.equal(r.fake.calls().length, 1);
        r.append(); await r.sidecar.tick(); assert.equal(r.fake.calls().length, 2);
    } finally { r.sidecar.close(); }
});
test('W-3 hourly budget survives restarts, sends one pause notice, and never resets on hook/tool calls', async () => {
    const r = rig({ MCP_EVENTS_WAKES_PER_HOUR: '1' }); r.append();
    await r.sidecar.tick(); r.sidecar.close(); assert.equal(r.fake.calls().length, 1);
    invocation(r.home, { conversationId: r.id }); r.append();
    const next = new WakeSidecar(r.base, r.env);
    try {
        await next.tick(); assert.equal(r.fake.calls().length, 2); assert.match(r.fake.calls()[1]!.args[2]!, /stopped waking/);
        invocation(r.home, { conversationId: r.id }); r.append();
        await next.tick(); await next.tick(); assert.equal(r.fake.calls().length, 2);
        const saved = JSON.parse(readFileSync(join(r.spool.dir, 'wakes.json'), 'utf8')); assert.equal(saved.paused, true);
        saved.pausedAt = Date.now() - 3600_001; writePrivate(join(r.spool.dir, 'wakes.json'), JSON.stringify(saved));
        await next.tick(); assert.equal(r.fake.calls().length, 3, 'hour pause expires');
    } finally { next.close(); }
});
test('W-4 per-watch gap and server batch delay are respected', async () => {
    const r = rig({ MCP_EVENTS_WAKE_GAP_S: '60' }); r.append();
    try {
        await r.sidecar.tick(); invocation(r.home, { conversationId: r.id }); r.append();
        await r.sidecar.tick(); assert.equal(r.fake.calls().length, 1);
        const file = join(r.spool.dir, 'wakes.json'), saved = JSON.parse(readFileSync(file, 'utf8')); saved.last['w-1'] -= 60001; writePrivate(file, JSON.stringify(saved));
        await r.sidecar.tick(); assert.equal(r.fake.calls().length, 2);
        invocation(r.home, { conversationId: r.id });
        const s = new Spool(r.base, newThread()); s.append({ kind: 'notice', text: 'batch' });
        const id = s.dir.split('/').at(-1)!; requestWake(r.base, id, { MCP_EVENTS_BATCH_MS: '60000' });
        await r.sidecar.tick(); assert.equal(r.fake.calls().length, 2, 'not before batch deadline');
    } finally { r.sidecar.close(); }
});
test('W-5 non-UUID requests, a mismatched body, and delivered events never reach agentapi', async () => {
    const r = rig(); r.append(); invocation(r.home, { conversationId: r.id });
    mkdirSync(requestsDir(r.base), { recursive: true });
    writeFileSync(join(requestsDir(r.base), 'not-uuid.json'), JSON.stringify({ conversationId: 'not-uuid', after: 0 }));
    const other = newThread(); new Spool(r.base, other).append({ kind: 'notice', text: 'x' });
    writeFileSync(join(requestsDir(r.base), `${other}.json`), JSON.stringify({ conversationId: r.id, after: 0 }));
    try { await r.sidecar.tick(); assert.equal(r.fake.calls().length, 0); }
    finally { r.sidecar.close(); }
});
test('W-6 a send interrupted by a crash is counted once; the event is still injectable', async () => {
    const r = rig(); r.append();
    const budget = new WakeBudget({ gapMs: 0, perHour: 1 }, join(r.spool.dir, 'wakes.json'));
    const upto = Buffer.byteLength(readFileSync(r.spool.file, 'utf8')); assert.ok(budget.handBatch(['w-1'], upto));
    try {
        await r.sidecar.tick(); assert.equal(r.fake.calls().length, 0);
        assert.equal(JSON.parse(readFileSync(join(r.spool.dir, 'wakes.json'), 'utf8')).wakes.length, 1);
        assert.ok(invocation(r.home, { conversationId: r.id }).injectSteps);
    } finally { r.sidecar.close(); }
});
test('W-7 timed-out and nonzero agentapi sends are bounded and not retried as new wakes', async () => {
    const r = rig({ ANTIGRAVITY_TEST_AGENTAPI_EXIT: '1' }); r.append();
    try {
        await r.sidecar.tick(); await r.sidecar.tick(); assert.equal(r.fake.calls().length, 1);
        assert.match(readFileSync(join(r.spool.dir, 'wake-error.json'), 'utf8'), /acceptance is unknown/);
        const sent = await sendMessage(findAgentapi(r.env)!, r.id, 'timeout', { ...r.env, ANTIGRAVITY_TEST_AGENTAPI_EXIT: '0', ANTIGRAVITY_TEST_AGENTAPI_HANG: '1' }, 100);
        assert.equal(sent.ok, false); assert.ok(!sent.ok && sent.maybe);
    } finally { r.sidecar.close(); }
});
test('W-11 a crash while sending the budget notice restores the pause, without another notice', async () => {
    const r = rig({ MCP_EVENTS_WAKES_PER_HOUR: '1' }); r.append();
    const budget = new WakeBudget({ gapMs: 0, perHour: 1 }, join(r.spool.dir, 'wakes.json'));
    budget.woke(['w-1']); budget.handNotice();
    assert.ok(budget.handBatch(['w-1'], Buffer.byteLength(readFileSync(r.spool.file, 'utf8'))));
    try {
        await r.sidecar.tick(); invocation(r.home, { conversationId: r.id }); r.append(); await r.sidecar.tick();
        assert.equal(r.fake.calls().length, 0);
        assert.equal(JSON.parse(readFileSync(join(r.spool.dir, 'wakes.json'), 'utf8')).paused, true);
    } finally { r.sidecar.close(); }
});
test('W-8 missing, stale and fresh heartbeats accurately report availability', async () => {
    const r = rig(); assert.match(wakeAvailability(r.base, Date.now(), 'app'), /unavailable.*next model call/);
    try {
        await r.sidecar.tick(); assert.match(wakeAvailability(r.base, Date.now(), 'app'), /available:.*recent heartbeat/);
        assert.match(wakeAvailability(r.base, Date.now() + HEARTBEAT_MS * 4, 'app'), /unavailable/);
        r.sidecar.heartbeat(undefined); assert.match(wakeAvailability(r.base, Date.now(), 'app'), /no agentapi/);
        // A conversation the plugin can't place is never told wakes are available.
        assert.match(wakeAvailability(r.base), /could not tell that it is the App's/);
    } finally { r.sidecar.close(); }
});
test('W-9 real sidecar entry uses its documented cwd; duplicate process and stand-down cannot wake', async () => {
    const r = rig(); r.append();
    const start = () => spawn(process.execPath, ['../../dist/server.mjs', '--sidecar'], { cwd: join(ROOT, 'plugin/sidecars/wake'), env: r.env, stdio: 'ignore' });
    const a = start(), b = start();
    try {
        await waitFor(() => r.fake.calls().length === 1); await sleep(1300); assert.equal(r.fake.calls().length, 1);
        writePrivate(join(r.base, 'settings.json'), JSON.stringify({ MCP_EVENTS_OFF: '1' }));
        invocation(r.home, { conversationId: r.id }, { MCP_EVENTS_OFF: '0' }); r.append();
        await sleep(1300); assert.equal(r.fake.calls().length, 1);
    } finally {
        await Promise.all([a, b].map(p => new Promise<void>(resolve => { p.once('close', () => resolve()); p.kill(); })));
    }
});
test('W-10 list_watches reports no sidecar and then a running sidecar', async () => {
    const w = world(), h = await startHelper(w, {}, false), id = newThread();
    try {
        assert.match((await h.call('list_watches', {}, id)).text, /unavailable:.*next model call/);
        const s = spawn(process.execPath, [SERVER, '--sidecar'], { env: w.env(), stdio: 'ignore' });
        try { await waitFor(() => existsSync(join(w.state, 'wake-heartbeat.json'))); assert.match((await h.call('list_watches', {}, id)).text, /available:.*recent heartbeat/); }
        finally { await new Promise<void>(r => { s.once('close', () => r()); s.kill(); }); }
    } finally { await h.stop(); }
});

// A running App sidecar doesn't make idle wakes available to a CLI conversation. Only the
// App's conversations can be woken (agentapi reaches the App's own); a CLI or IDE one is told
// so and never sent a wake.
test('W-9 a CLI, IDE or unknown conversation is never woken, and says why; an App one is', async () => {
    for (const surface of ['cli', 'ide'] as const) {
        const r = rig();
        recordSurface(r.base, r.id, surface);
        r.append();
        assert.equal(existsSync(join(requestsDir(r.base), `${r.id}.json`)), false, `${surface}: no wake request`);
        // A request written before the surface was known is dropped by the sidecar.
        mkdirSync(requestsDir(r.base), { recursive: true });
        writeFileSync(join(requestsDir(r.base), `${r.id}.json`), JSON.stringify({ conversationId: r.id, after: 0 }));
        try {
            await r.sidecar.tick();
            assert.equal(r.fake.calls().length, 0, `${surface}: agentapi never called`);
            assert.equal(existsSync(join(requestsDir(r.base), `${r.id}.json`)), false);
        } finally { r.sidecar.close(); }
        assert.match(wakeAvailability(r.base, Date.now(), surface), new RegExp(`unavailable in the Antigravity ${surface.toUpperCase()}`));
        assert.match(invocation(r.home, { conversationId: r.id }).injectSteps[0].systemMessage.systemMessage, /One new event or notice is waiting/, `${surface}: still delivered at the next model call`);
    }
    // Nor one recorded as neither: only an App conversation is woken.
    const unknown = rig({ SURFACE: 'none' });
    unknown.append();
    assert.equal(existsSync(join(requestsDir(unknown.base), `${unknown.id}.json`)), false, 'unknown: no wake request');
    try { await unknown.sidecar.tick(); assert.equal(unknown.fake.calls().length, 0, 'unknown: agentapi never called'); } finally { unknown.sidecar.close(); }
    const app = rig();
    recordSurface(app.base, app.id, 'app');
    app.append();
    try { await app.sidecar.tick(); assert.equal(app.fake.calls().length, 1); } finally { app.sidecar.close(); }
    assert.equal(surfaceOfSession(app.base, newThread()), 'unknown');
});

// main's takeover fix (Pi's session.ts calls budget.reload() when a standby takes over;
// Codex's threads.ts reads the count again): here the sidecar builds its wake budget from
// the conversation's wakes.json at every wake, so one that takes over from another carries
// on the hour's count and pause instead of starting afresh.
test('W-10 a sidecar that takes over carries on the previous one\'s hourly wake count and pause', async () => {
    const r = rig({ MCP_EVENTS_WAKES_PER_HOUR: '2' });
    r.append();
    await r.sidecar.tick(); r.sidecar.close();
    assert.equal(r.fake.calls().length, 1);
    const b = new WakeSidecar(r.base, r.env);
    try {
        invocation(r.home, { conversationId: r.id }); r.append();
        await b.tick();
        assert.equal(r.fake.calls().length, 2, 'the second wake of the hour, counted on from the first sidecar');
        invocation(r.home, { conversationId: r.id }); r.append();
        await b.tick();
        assert.equal(r.fake.calls().length, 3);
        assert.match(r.fake.calls()[2]!.args[2]!, /stopped waking/, 'the third is the pause notice, not a fresh count');
        invocation(r.home, { conversationId: r.id }); r.append();
        await b.tick(); await b.tick();
        assert.equal(r.fake.calls().length, 3, 'paused for the rest of the hour');
    } finally { b.close(); }
});
