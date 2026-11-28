import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startBridge, readBatch } from '../src/bridge.mjs';
import { destination } from '../src/routine.mjs';

const routineUrl = 'https://api2.cursor.sh/automations/webhook/01234567-1234-1234-1234-123456789abc';
function inspect(dir, fn) {
    const db = new DatabaseSync(join(dir, 'inbox.sqlite'), { readOnly: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}
const ledger = (dir) => inspect(dir, (db) => JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='delivery'").get().value));
const stored = (dir, n) => inspect(dir, (db) => Boolean(db.prepare('SELECT 1 FROM events WHERE n=?').get(n)));
const fixture = fileURLToPath(new URL('../../claude-code/test/fixture-events-server.ts', import.meta.url));
async function until(fn) {
    const deadline = Date.now() + 12000;
    while (!fn()) {
        if (Date.now() >= deadline) throw Error('Timed out waiting for fixture');
        await sleep(25);
    }
}
function world(t, mode = 'push') {
    const dir = mkdtempSync(join(tmpdir(), 'grok-events-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'source.jsonl');
    const log = join(dir, 'rpc.jsonl');
    const config = {
        minGapSeconds: 1,
        batchMs: 400,
        upstream: {
            command: process.execPath,
            args: [fixture],
            env: {
                FIXTURE_UPSTREAM: source,
                FIXTURE_LOG: log,
                FIXTURE_TICKET_DELIVERY: mode,
                FIXTURE_POLL_MS: '30',
                FIXTURE_HEARTBEAT_MS: '100'
            }
        }
    };
    const env = { HOME: dir, MCP_EVENTS_MIN_POLL_MS: '30', GROK_ROUTINE_URL: routineUrl, GROK_ROUTINE_KEY: 'test-bot-key' };
    config.servers = { source: { upstream: config.upstream } };
    delete config.upstream;
    config.watches = [{ server: 'source', event: 'ticket.created', arguments: { priority: 'high' } }];
    const calls = [];
    let fail = false,
        stop;
    const post = async (url, opts) => {
        calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
        return Response.json(fail ? {} : { id: 'test-message-id' }, { status: fail ? 503 : 200 });
    };
    async function close() {
        if (stop) {
            await stop();
            stop = undefined;
        }
    }
    t.after(close);
    return {
        dir,
        config,
        calls,
        close,
        ref(range) {
            return ledger(dir).inbox + '.' + range;
        },
        setFail(value) {
            fail = value;
        },
        async start(opts = {}) {
            stop = await startBridge({ dir, config, env, post, log: () => {}, ...opts });
            await until(() =>
                readFileSync(log, 'utf8').includes('"events/' + { push: 'stream', webhook: 'subscribe', poll: 'poll' }[mode] + '"')
            );
            await sleep(150);
        },
        emit(id, priority = 'high', data = {}) {
            appendFileSync(
                source,
                JSON.stringify({
                    eventId: id,
                    name: 'ticket.created',
                    timestamp: new Date().toISOString(),
                    data: { title: 'private server text', priority, ...data }
                }) + '\n'
            );
        },
        acknowledged() {
            return ledger(dir).through;
        }
    };
}

for (const mode of ['push', 'poll']) {
    test(mode + ': idle, filter, replay, batch, read, restart', async (t) => {
        const w = world(t, mode);
        await w.start();
        w.emit('irrelevant', 'low');
        await sleep(450);
        assert.equal(w.calls.length, 0);
        w.emit('one');
        w.emit('one');
        w.emit('two');
        await until(() => w.acknowledged() === 2);
        assert.equal(w.calls.length, 1);
        const { opts, body, url } = w.calls[0];
        assert.equal(opts.method, 'POST');
        assert.equal(opts.redirect, 'error');
        assert.ok(!opts.body.includes('private server text'));
        assert.equal(url, routineUrl);
        assert.equal(body.source, 'mcp-events');
        assert.equal(body.batch, w.ref('e1-e2'));
        assert.deepEqual(
            body.events.map((x) => x.eventId),
            ['one', 'two']
        );
        assert.equal(body.events[0].source, 'source');
        assert.ok(body.events[0].watch.startsWith('w-'));
        assert.throws(() => readBatch(w.dir, w.ref('e1-e1')), /Unknown or expired/);
        assert.equal(opts.headers.authorization, 'Bearer test-bot-key');
        assert.deepEqual(
            readBatch(w.dir, w.ref('e1-e2')).map((r) => r.eventId),
            ['one', 'two']
        );
        await w.close();
        await w.start();
        await sleep(450);
        assert.equal(w.calls.length, 1);
        w.emit('three');
        await until(() => w.acknowledged() === 3);
    });
}

test('unknown outcome stays held after restart; explicit retry reuses the reference', async (t) => {
    const w = world(t);
    w.setFail(true);
    await w.start();
    w.emit('one');
    await until(() => w.calls.length === 1);
    await w.close();
    w.setFail(false);
    await w.start();
    w.emit('two');
    await sleep(400);
    assert.equal(w.calls.length, 1);
    await w.close();
    await w.start({ retry: true });
    await until(() => w.acknowledged() === 2);
    assert.equal(w.calls[0].opts.body, w.calls[1].opts.body);
    assert.equal(w.calls[2].body.batch, w.ref('e2-e2'));
});

test('operator can confirm an ambiguous delivery; hourly allowance survives restart', async (t) => {
    const w = world(t);
    w.config.maxWakesPerHour = 1;
    w.setFail(true);
    await w.start();
    w.emit('one');
    await until(() => w.calls.length === 1);
    await w.close();
    w.setFail(false);
    await w.start({ acceptedBatch: w.ref('e1-e1') });
    w.emit('two');
    await until(() => stored(w.dir, 2));
    assert.throws(() => readBatch(w.dir, w.ref('e2-e2')), /Unknown or expired/);
    await sleep(1250);
    assert.equal(w.calls.length, 1);
    assert.equal(w.acknowledged(), 1);
});

test('Grok Bot requires a TLS endpoint and the documented 200 response', async () => {
    const env = { GROK_ROUTINE_URL: 'http://example.org', GROK_ROUTINE_KEY: 'test-routine-key' };
    assert.throws(() => destination(env), /HTTPS/);
    env.GROK_ROUTINE_URL = routineUrl;
    await assert.rejects(destination(env, async () => new Response(null, { status: 202 })).send('e1-e1'), /202/);
});

test('webhook-only subscription verifies the callback and delivers an event', async (t) => {
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise((ok, fail) => probe.once('error', fail).listen(0, '127.0.0.1', ok));
    const port = probe.address().port;
    await new Promise((ok) => probe.close(ok));
    const w = world(t, 'webhook');
    w.config.servers.source.upstream.env.FIXTURE_ALLOW_HTTP = '1';
    await w.start({
        env: {
            HOME: w.dir,
            MCP_EVENTS_DEV: '1',
            MCP_EVENTS_PUBLIC_URL: 'http://127.0.0.1:' + port,
            MCP_EVENTS_RECEIVER_PORT: String(port),
            GROK_ROUTINE_URL: routineUrl,
            GROK_ROUTINE_KEY: 'test-routine-key'
        }
    });
    w.emit('signed-one');
    await until(() => w.acknowledged() === 1);
    assert.equal(w.calls.length, 1);
    assert.equal(readBatch(w.dir, w.ref('e1-e1'))[0].eventId, 'signed-one');
});

test('shared Grok routine routes identical event IDs across two servers, shares the wake limit and resumes on configuration changes', async (t) => {
    const first = world(t);
    const other = world(t, 'poll');
    const config = {
        minGapSeconds: 1,
        batchMs: 300,
        maxWakesPerHour: 2,
        servers: { alpha: { upstream: first.config.servers.source.upstream }, beta: { upstream: other.config.servers.source.upstream } },
        watches: [{ server: 'alpha', event: 'ticket.created', name: 'urgent', arguments: { priority: 'high' } }]
    };
    await first.start({ config });
    first.emit('warmup');
    await until(() => first.acknowledged() === 1);
    await first.close();

    config.watches.push({ server: 'beta', event: 'ticket.created', name: 'incoming' });
    // A misconfigured third source must not disrupt the healthy pair.
    config.servers.offline = { upstream: { url: 'https://example.invalid/mcp' }, upstreamBearerEnv: 'ABSENT_TOKEN' };
    config.watches.push({ server: 'offline', event: 'ticket.created' });
    await first.start({ config });
    await until(() => readFileSync(join(other.dir, 'rpc.jsonl'), 'utf8').includes('"events/poll"'));
    first.emit('shared-id');
    other.emit('shared-id');
    first.emit('shared-id');
    await until(() => first.acknowledged() === 3);
    const inbox = ledger(first.dir).inbox;
    assert.match(inbox, /^[a-f0-9]{32}$/);
    assert.deepEqual(
        first.calls.map((x) => x.body.batch),
        [inbox + '.e1-e1', inbox + '.e2-e3']
    );
    assert.throws(() => readBatch(first.dir, 'e2-e3'), /inbox-qualified/);
    const entries = readBatch(first.dir, first.calls[1].body.batch).sort((a, b) => a.server.localeCompare(b.server));
    assert.deepEqual(
        entries.map((r) => [r.server, r.watchName, r.eventId]),
        [
            ['alpha', 'urgent', 'shared-id'],
            ['beta', 'incoming', 'shared-id']
        ]
    );
    assert.notEqual(entries[0].watch, entries[1].watch);

    await first.close();
    config.watches = config.watches.filter((w) => w.server === 'alpha');
    await first.start({ config });
    other.emit('removed-watch');
    first.emit('four');
    await until(() => stored(first.dir, 4));
    assert.throws(() => readBatch(first.dir, inbox + '.e4-e4'), /Unknown or expired/);
    await sleep(1200);
    assert.equal(first.calls.length, 2);
    await first.close();
    config.servers.alpha.upstream = { url: 'https://example.invalid/different' };
    await assert.rejects(first.start({ config }), /changed endpoint/);
});

test('installable CLI discovers a configured server and reads the stored batch', async (t) => {
    const w = world(t);
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify(w.config));
    const cli = fileURLToPath(new URL('../plugin/dist/bridge.mjs', import.meta.url));
    const run = async (...args) =>
        JSON.parse(
            (
                await promisify(execFile)(process.execPath, [cli, ...args], {
                    env: { ...process.env, GROK_EVENTS_HOME: w.dir }
                })
            ).stdout
        );
    const catalog = await run('list', 'source');
    assert.ok(catalog.source.some((type) => type.name === 'ticket.created'));
    await w.start();
    w.emit('cli-event');
    await until(() => w.acknowledged() === 1);
    const { untrustedEvents } = await run('read', w.calls[0].body.batch);
    assert.equal(untrustedEvents[0].server, 'source');
    assert.equal(untrustedEvents[0].eventId, 'cli-event');
});

test('once reserves one wake across restarts; follow delivers the queued ticket', async (t) => {
    const w = world(t);
    w.config.watches[0].name = 'triage';
    w.config.watches[0].idField = 'ticket';
    await w.start({ once: true });
    w.emit('receipt-one', 'high', { ticket: 'T-001' });
    w.emit('receipt-two', 'high', { ticket: 'T-002' });
    await until(() => w.acknowledged() === 1 && stored(w.dir, 2));
    assert.deepEqual(w.calls[0].body.events, [
        { source: 'source', watch: 'triage', handle: 'e1', eventId: 'receipt-one', ticketId: 'T-001' }
    ]);
    await sleep(1200);
    assert.equal(w.calls.length, 1);
    await w.close();
    await assert.rejects(w.start({ once: true }), /already attempted/);
    await w.start();
    await until(() => w.acknowledged() === 2);
    assert.equal(w.calls[1].body.events[0].ticketId, 'T-002');
});

test('opt-in titles are bounded and a held retry uses exactly the originally issued bytes', async (t) => {
    const w = world(t);
    w.config.watches[0].includeTitle = true;
    w.setFail(true);
    await w.start();
    w.emit('one', 'high', { id: 'T-1', title: 'Hello\nworld ' + 'a'.repeat(200), secret: 'private detail' });
    await until(() => w.calls.length === 1);
    const event = w.calls[0].body.events[0];
    assert.equal(event.title.length, 160);
    assert.match(event.title, /^Hello world /);
    assert.equal(event.ticketId, 'T-1');
    assert.ok(!w.calls[0].opts.body.includes('private detail'));
    await w.close();
    w.config.payload = 'reference';
    w.setFail(false);
    await w.start({ retry: true });
    await until(() => w.acknowledged() === 1);
    assert.equal(w.calls[1].opts.body, w.calls[0].opts.body);
});
