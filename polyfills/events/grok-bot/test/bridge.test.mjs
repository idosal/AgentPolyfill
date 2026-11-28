import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startBridge, readBatch } from '../src/bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { inboxServer } from '../src/connector.mjs';
import { destination } from '../src/routine.mjs';

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
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const source = join(dir, 'source.jsonl');
    const log = join(dir, 'rpc.jsonl');
    const config = {minGapSeconds: 1, batchMs: 80,
        upstream: {command: process.execPath, args: [fixture], env: {FIXTURE_UPSTREAM: source, FIXTURE_LOG: log,
            FIXTURE_TICKET_DELIVERY: mode, FIXTURE_POLL_MS: '30', FIXTURE_HEARTBEAT_MS: '100'}}};
    const env = {HOME: dir, MCP_EVENTS_MIN_POLL_MS: '30', GROK_ROUTINE_URL: 'https://example.org/bot', GROK_ROUTINE_KEY: 'test-bot-key'};
    config.servers = {source: {upstream: config.upstream}};
    delete config.upstream;
    config.watches = [{server: 'source', event: 'ticket.created', arguments: {priority: 'high'}}];
    const calls = [];
    let fail = false, stop;
    const post = async (url, opts) => {
        calls.push({url: String(url), opts, body: JSON.parse(opts.body)});
        return Response.json(fail ? {} : {id: 'test-message-id'}, {status: fail ? 503 : 200});
    };
    async function close() { if (stop) { await stop(); stop = undefined; } }
    t.after(close);
    return {dir, config, calls, close, ref(range) { return JSON.parse(readFileSync(join(dir, "delivery.json"))).inbox + "." + range; }, setFail(value) { fail = value; },
        async start(opts = {}) {
            stop = await startBridge({dir, config, env, post, log: () => {}, ...opts});
            await until(() => readFileSync(log, 'utf8').includes('"events/' + ({push: 'stream', webhook: 'subscribe', poll: 'poll'}[mode]) + '"'));
            await sleep(150);
        },
        emit(id, priority = 'high') { appendFileSync(source, JSON.stringify({eventId: id, name: 'ticket.created',
            timestamp: new Date().toISOString(), data: {title: 'private server text', priority}}) + '\n'); },
        acknowledged() { return JSON.parse(readFileSync(join(dir, 'delivery.json'))).through; }
    };
}

async function connectReader(t, dir) {
    const token = randomBytes(32).toString('hex');
    const receipts = [];
    const srv = inboxServer(dir, { token, origin: 'https://inbox.example', log: line => receipts.push(JSON.parse(line)) });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const url = new URL('http://127.0.0.1:' + srv.address().port + '/mcp');
    const headers = { authorization: 'Bearer ' + token };
    const client = new Client({ name: 'routine-fixture', version: '1' });
    t.after(async () => {
        await client.close();
        await new Promise(resolve => srv.close(resolve));
    });
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://other.example' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['read_batch']);
    const call = (batch, offset) => client.callTool({ name: 'read_batch', arguments: { batch, offset } });
    return { call, receipts, async read(batch, offset) {
        const result = await call(batch, offset);
        assert.ok(!result.isError);
        return JSON.parse(result.content[0].text);
    } };
}

for (const mode of ['push', 'poll']) {
    test(mode + ': idle, filter, replay, batch, read, restart', async t => {
        const w = world(t, mode);
        const reader = await connectReader(t, w.dir);
        await w.start();
        w.emit('irrelevant', 'low');
        await sleep(450);
        assert.equal(w.calls.length, 0);
        assert.equal(reader.receipts.length, 0);
        w.emit('one'); w.emit('one'); w.emit('two');
        await until(() => w.acknowledged() === 2);
        assert.equal(w.calls.length, 1);
        const {opts, body, url} = w.calls[0];
        assert.equal(opts.method, 'POST');
        assert.equal(opts.redirect, 'error');
        assert.ok(!opts.body.includes('private server text'));
        assert.equal(url, 'https://example.org/bot');
        assert.deepEqual(body, {source: 'mcp-events', batch: w.ref('e1-e2')});
        assert.equal(opts.headers.authorization, 'Bearer test-bot-key');
        assert.deepEqual(readBatch(w.dir, w.ref('e1-e2')).map(r => r.eventId), ['one', 'two']);
        assert.deepEqual((await reader.read(body.batch)).untrustedEvents.map(r => r.eventId), ['one', 'two']);
        assert.equal((await reader.call(w.ref('e1-e3'))).isError, true);
        assert.equal((await reader.call('0'.repeat(32) + '.e1-e1')).isError, true);
        await w.close();
        assert.equal((await reader.read(body.batch)).untrustedEvents[0].eventId, 'one');
        await w.start();
        await sleep(450);
        assert.equal(w.calls.length, 1);
        w.emit('three');
        await until(() => w.acknowledged() === 3);
    });
}

test('unknown outcome stays held after restart; explicit retry reuses the reference', async t => {
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
    await w.start({retry: true});
    await until(() => w.acknowledged() === 2);
    assert.equal(w.calls[0].opts.body, w.calls[1].opts.body);
    assert.equal(w.calls[2].body.batch, w.ref('e2-e2'));
});

test('operator can confirm an ambiguous delivery; hourly allowance survives restart', async t => {
    const w = world(t);
    w.config.maxWakesPerHour = 1;
    w.setFail(true);
    await w.start();
    w.emit('one');
    await until(() => w.calls.length === 1);
    await w.close();
    w.setFail(false);
    await w.start({acceptedBatch: w.ref('e1-e1')});
    w.emit('two');
    await until(() => { try {return readBatch(w.dir, w.ref('e2-e2')).length === 1;} catch {return false;} });
    await sleep(1250);
    assert.equal(w.calls.length, 1);
    assert.equal(w.acknowledged(), 1);
});

test('Grok Bot requires a TLS endpoint and the documented 200 response', async () => {
    const env = {GROK_ROUTINE_URL: 'http://example.org', GROK_ROUTINE_KEY: 'test'};
    assert.throws(() => destination(env), /HTTPS/);
    env.GROK_ROUTINE_URL = 'https://example.org';
    await assert.rejects(destination(env, async () => new Response(null, {status: 202})).send('e1-e1'), /202/);
});

test('webhook-only subscription verifies the callback and delivers an event', async t => {
    const {createServer} = await import('node:net');
    const probe = createServer();
    await new Promise((ok, fail) => probe.once('error', fail).listen(0, '127.0.0.1', ok));
    const port = probe.address().port;
    await new Promise(ok => probe.close(ok));
    const w = world(t, 'webhook');
    const reader = await connectReader(t, w.dir);
    w.config.servers.source.upstream.env.FIXTURE_ALLOW_HTTP = '1';
    await w.start({env: {HOME: w.dir, MCP_EVENTS_DEV: '1',
        MCP_EVENTS_PUBLIC_URL: 'http://127.0.0.1:' + port, MCP_EVENTS_RECEIVER_PORT: String(port),
        GROK_ROUTINE_URL: 'https://example.org/bot', GROK_ROUTINE_KEY: 'test'}});
    w.emit('signed-one');
    await until(() => w.acknowledged() === 1);
    assert.equal(w.calls.length, 1);
    const delivered = await reader.read(w.calls[0].body.batch);
    assert.equal(delivered.untrustedEvents[0].eventId, 'signed-one');
    assert.equal(delivered.nextOffset, null);
});

test('shared Grok routine routes identical event IDs across two servers, shares the wake limit and resumes on configuration changes', async t => {
    const first = world(t);
    const other = world(t, 'poll');
    const config = {
        minGapSeconds: 1, batchMs: 300, maxWakesPerHour: 2,
        servers: {alpha: {upstream: first.config.servers.source.upstream}, beta: {upstream: other.config.servers.source.upstream}},
        watches: [{server: 'alpha', event: 'ticket.created', name: 'urgent', arguments: {priority: 'high'}}]
    };
    await first.start({config});
    first.emit('warmup');
    await until(() => first.acknowledged() === 1);
    await first.close();

    config.watches.push({server: 'beta', event: 'ticket.created', name: 'incoming'});
    // A misconfigured third source must not disrupt the healthy pair.
    config.servers.offline = {upstream: {url: 'https://example.invalid/mcp'}, upstreamBearerEnv: 'ABSENT_TOKEN'};
    config.watches.push({server: 'offline', event: 'ticket.created'});
    await first.start({config});
    await until(() => readFileSync(join(other.dir, 'rpc.jsonl'), 'utf8').includes('"events/poll"'));
    first.emit('shared-id');
    other.emit('shared-id');
    first.emit('shared-id');
    await until(() => first.acknowledged() === 3);
    const inbox = JSON.parse(readFileSync(join(first.dir, 'delivery.json'))).inbox;
    assert.match(inbox, /^[a-f0-9]{32}$/);
    assert.deepEqual(first.calls.map(x => x.body.batch), [inbox + '.e1-e1', inbox + '.e2-e3']);
    assert.throws(() => readBatch(first.dir, 'e2-e3'), /inbox-qualified/);
    const entries = readBatch(first.dir, first.calls[1].body.batch).sort((a,b) => a.server.localeCompare(b.server));
    assert.deepEqual(entries.map(r => [r.server, r.watchName, r.eventId]), [
        ['alpha', 'urgent', 'shared-id'], ['beta', 'incoming', 'shared-id']
    ]);
    assert.notEqual(entries[0].watch, entries[1].watch);

    await first.close();
    config.watches = config.watches.filter(w => w.server === 'alpha');
    await first.start({config});
    other.emit('removed-watch');
    first.emit('four');
    await until(() => { try {return readBatch(first.dir, inbox + '.e4-e4')[0].eventId === 'four';} catch {return false;} });
    await sleep(1200);
    assert.equal(first.calls.length, 2);
    await first.close();
    config.servers.alpha.upstream = {url:'https://example.invalid/different'};
    await assert.rejects(first.start({config}), /changed endpoint/);
});

test('installable CLI discovers a configured server and reads the stored batch', async t => {
    const w = world(t);
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify(w.config));
    const cli = fileURLToPath(new URL('../plugin/dist/bridge.mjs', import.meta.url));
    const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args], {
        env: { ...process.env, GROK_EVENTS_HOME: w.dir }
    })).stdout);
    const catalog = await run('list', 'source');
    assert.ok(catalog.source.some(type => type.name === 'ticket.created'));
    await w.start();
    w.emit('cli-event');
    await until(() => w.acknowledged() === 1);
    const {untrustedEvents} = await run('read', w.calls[0].body.batch);
    assert.equal(untrustedEvents[0].server, 'source');
    assert.equal(untrustedEvents[0].eventId, 'cli-event');
});

test('remote reader paginates a pending wake before HTTP acceptance and picks up later appends', async t => {
    const w = world(t);
    const reader = await connectReader(t, w.dir);
    const reads = [];
    await w.start({post: async (_url, opts) => {
        const {batch} = JSON.parse(opts.body);
        const pages = [];
        let offset;
        do {
            const p = await reader.read(batch, offset);
            pages.push(p);
            offset = p.nextOffset;
        } while (offset !== null);
        reads.push(pages);
        return new Response(null, {status: 200});
    }});
    for (const id of ['a','b']) appendFileSync(join(w.dir, 'source.jsonl'), JSON.stringify({
        eventId: id, name: 'ticket.created', timestamp: new Date().toISOString(),
        data: {priority: 'high', title: 'x'.repeat(35000)}
    }) + '\n');
    await until(() => w.acknowledged() === 2);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].map(p => p.nextOffset), [1, null]);
    assert.deepEqual(reads[0].flatMap(p => p.untrustedEvents.map(r => r.eventId)), ['a', 'b']);
    w.emit('c');
    await until(() => w.acknowledged() === 3);
    assert.equal(reads[1][0].untrustedEvents[0].eventId, 'c');
});
