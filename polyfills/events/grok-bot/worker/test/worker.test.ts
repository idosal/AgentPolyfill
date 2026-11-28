import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workerRoot = fileURLToPath(new URL('..', import.meta.url));
const wranglerBin = join(workerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

async function freePort(): Promise<number> {
    const srv = createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
}

async function until(fn: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await sleep(30);
    }
}

function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

type MockUpstream = {
    url: string;
    subscriptions: Array<{ id: string; url: string; secret: string; name: string; args: Record<string, unknown> }>;
    unsubscribed: string[];
    pollEvents: Array<{ eventId: string; name: string; timestamp: string; data: Record<string, unknown> }>;
    sendWebhook: (subIndex: number, payload: Record<string, unknown>, opts?: { deliveryId?: string; secret?: string; timestamp?: number }) => Promise<Response>;
    close: () => Promise<void>;
};

async function startMockUpstream(): Promise<MockUpstream> {
    const subscriptions: MockUpstream['subscriptions'] = [];
    const unsubscribed: string[] = [];
    const pollEvents: MockUpstream['pollEvents'] = [];
    let pollCursor = 0;

    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const raw = await readBody(req);
        const msg = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
        if (msg.method === 'notifications/initialized') {
            res.writeHead(202).end();
            return;
        }
        const reply = (result: unknown) => {
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session-1' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
            return reply({
                protocolVersion: '2026-07-28',
                capabilities: { extensions: { 'io.modelcontextprotocol/events': {} } },
                serverInfo: { name: 'mock-upstream', version: '1.0.0' }
            });
        }
        if (msg.method === 'events/list') {
            return reply({
                events: [
                    {
                        name: 'deploy.finished',
                        description: 'Fired when a deploy finishes',
                        delivery: ['webhook'],
                        inputSchema: { type: 'object', properties: { env: { type: 'string', 'x-mcp-header': 'Env' } } }
                    },
                    {
                        name: 'demo.button',
                        description: 'Button press',
                        delivery: ['poll'],
                        inputSchema: { type: 'object', properties: { channel: { type: 'string' } } }
                    }
                ]
            });
        }
        if (msg.method === 'events/subscribe') {
            const p = msg.params as { name: string; arguments: Record<string, unknown>; delivery: { url: string; secret: string } };
            assert.equal(req.headers['mcp-name'], p.name);
            // Send synchronous SEP-3415 signed verification challenge BEFORE replying!
            const challenge = 'chal_' + randomBytes(8).toString('hex');
            const body = JSON.stringify({ type: 'verification', challenge });
            const ts = Math.floor(Date.now() / 1000);
            const deliveryId = 'msg_verify_' + randomBytes(4).toString('hex');
            const verifyRes = await fetch(p.delivery.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'webhook-id': deliveryId,
                    'webhook-timestamp': String(ts),
                    'webhook-signature': signWebhook(p.delivery.secret, deliveryId, ts, body)
                },
                body
            });
            assert.equal(verifyRes.status, 200, 'verification challenge must return 200');
            const echoed = (await verifyRes.json()) as { challenge?: string };
            assert.equal(echoed.challenge, challenge, 'verification challenge must echo exact challenge');
            const id = 'sub_' + (subscriptions.length + 1);
            subscriptions.push({ id, url: p.delivery.url, secret: p.delivery.secret, name: p.name, args: p.arguments });
            return reply({ id, cursor: 'c0', refreshBefore: new Date(Date.now() + 3600_000).toISOString() });
        }
        if (msg.method === 'events/unsubscribe') {
            const p = msg.params as { delivery: { url: string } };
            unsubscribed.push(p.delivery.url);
            return reply({});
        }
        if (msg.method === 'events/poll') {
            const batch = pollEvents.slice(pollCursor);
            pollCursor = pollEvents.length;
            return reply({ events: batch, cursor: 'p' + pollCursor, nextPollMs: 60 });
        }
        res.writeHead(400).end();
    });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as { port: number }).port;

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        subscriptions,
        unsubscribed,
        pollEvents,
        async sendWebhook(subIndex, payload, opts = {}) {
            const sub = subscriptions[subIndex]!;
            const body = JSON.stringify(payload);
            const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
            const id = opts.deliveryId ?? 'msg_' + randomBytes(6).toString('hex');
            const secret = opts.secret ?? sub.secret;
            return fetch(sub.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'webhook-id': id,
                    'webhook-timestamp': String(ts),
                    'webhook-signature': signWebhook(secret, id, ts, body),
                    'x-mcp-subscription-id': sub.id
                },
                body
            });
        },
        close: () => new Promise<void>((resolve) => srv.close(() => resolve()))
    };
}

type MockRoutine = {
    url: string;
    calls: Array<{ auth: string | undefined; body: { source: string; batch: string } }>;
    setNextStatuses: (statuses: Array<{ status: number; retryAfter?: string }>) => void;
    close: () => Promise<void>;
};

async function startMockRoutine(): Promise<MockRoutine> {
    const calls: MockRoutine['calls'] = [];
    let queue: Array<{ status: number; retryAfter?: string }> = [];
    const srv: Server = createServer(async (req, res) => {
        const raw = await readBody(req);
        calls.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        const next = queue.shift();
        if (next) {
            const headers: Record<string, string> = {};
            if (next.retryAfter) headers['retry-after'] = next.retryAfter;
            res.writeHead(next.status, headers).end('{}');
        } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"ok"}');
        }
    });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${port}/routine`,
        calls,
        setNextStatuses: (s) => { queue = [...s]; },
        close: () => new Promise<void>((resolve) => srv.close(() => resolve()))
    };
}

async function startWorker(vars: Record<string, string>): Promise<{ origin: string; stop: () => Promise<void> }> {
    const port = await freePort();
    const persist = mkdtempSync(join(tmpdir(), 'grok-worker-test-'));
    const args = ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--log-level', 'error'];
    for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
    const child: ChildProcess = spawn(wranglerBin, args, {
        cwd: workerRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' }
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${origin}/healthz`);
            if (r.status === 200) break;
        } catch {
            // starting up
        }
        if (child.exitCode !== null) throw new Error(`wrangler dev exited early (${child.exitCode}): ${stderr}`);
        await sleep(150);
    }
    const r = await fetch(`${origin}/healthz`).catch(() => null);
    if (!r || r.status !== 200) {
        child.kill('SIGKILL');
        rmSync(persist, { recursive: true, force: true });
        throw new Error(`wrangler dev failed to start: ${stderr}`);
    }
    return {
        origin,
        async stop() {
            child.kill('SIGTERM');
            await Promise.race([once(child, 'exit'), sleep(3000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
            rmSync(persist, { recursive: true, force: true });
        }
    };
}

async function mcpCall(origin: string, token: string, method: string, params: Record<string, unknown> = {}) {
    const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    assert.equal(res.status, 200);
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
}

async function callTool(origin: string, token: string, name: string, args: Record<string, unknown> = {}) {
    const res = await mcpCall(origin, token, 'tools/call', { name, arguments: args });
    assert.ok(!res.error, res.error?.message);
    return res.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

describe('Cloudflare Worker Grok Bot MCP Events polyfill', { concurrency: false }, () => {
    const readerKey = randomBytes(32).toString('hex');
    const routineKey = 'grok-routine-secret-key';
    let upstream: MockUpstream;
    let routine: MockRoutine;
    let worker: { origin: string; stop: () => Promise<void> };

    before(async () => {
        upstream = await startMockUpstream();
        routine = await startMockRoutine();
        worker = await startWorker({
            READER_KEY: readerKey,
            GROK_ROUTINE_URL: routine.url,
            GROK_ROUTINE_KEY: routineKey,
            UPSTREAM_SERVERS: JSON.stringify({
                mock: { url: upstream.url, bearer: 'upstream-secret-token' }
            }),
            NO_DEFAULT_DEMO: '1',
            MCP_EVENTS_DEV: '1',
            BATCH_MS: '40',
            WAKE_GAP_S: '1',
            MIN_POLL_MS: '60',
            RETRY_BASE_MS: '80',
            RETRY_MAX_MS: '200'
        });
    });

    after(async () => {
        await worker?.stop();
        await upstream?.close();
        await routine?.close();
    });

    test('healthz, well-known discovery, bearer auth, and browser origin guard', async () => {
        const h = await fetch(`${worker.origin}/healthz`);
        assert.equal(h.status, 200);
        assert.deepEqual(await h.json(), { ok: true, off: false });

        const wk = await fetch(`${worker.origin}/.well-known/mcp-webhook-receiver.json`);
        assert.equal(wk.status, 200);
        assert.deepEqual(await wk.json(), { receivers: ['/hooks/'] });

        assert.equal((await fetch(`${worker.origin}/mcp`, { method: 'POST', body: '{}' })).status, 401);
        assert.equal(
            (await fetch(`${worker.origin}/mcp`, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + readerKey, origin: 'https://evil.example' },
                body: '{}'
            })).status,
            403
        );
        assert.equal(
            (await fetch(`${worker.origin}/mcp`, {
                method: 'GET',
                headers: { authorization: 'Bearer ' + readerKey }
            })).status,
            405
        );

        const cb = await fetch(`${worker.origin}/oauth/callback`);
        assert.equal(cb.status, 400);
        assert.ok((await cb.text()).includes('Missing OAuth state'));

        const init = await mcpCall(worker.origin, readerKey, 'initialize', { protocolVersion: '2025-11-25' });
        assert.ok((init.result as { capabilities?: { tools?: object } })?.capabilities?.tools);
        const list = await mcpCall(worker.origin, readerKey, 'tools/list');
        const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
        assert.deepEqual(names, ['read_batch', 'list_event_types', 'watch_event', 'unwatch_event', 'list_watches', 'get_event', 'recent_events']);
    });

    test('webhook delivery: challenge verification, signature check, replay dedupe, wake retry on 503/429, read_batch, and unwatch', async () => {
        const types = await callTool(worker.origin, readerKey, 'list_event_types', { server: 'mock' });
        assert.ok(!types.isError);
        assert.ok(types.content[0]!.text.includes('deploy.finished'));

        const watched = await callTool(worker.origin, readerKey, 'watch_event', {
            server: 'mock',
            event: 'deploy.finished',
            arguments: { env: 'prod' },
            note: 'Report prod deploys'
        });
        assert.ok(!watched.isError, watched.content[0]!.text);
        assert.equal(upstream.subscriptions.length, 1);
        const watchId = /w-[0-9a-f]{6}/.exec(watched.content[0]!.text)![0]!;

        // Bad signature must be rejected with 401.
        const badSig = await upstream.sendWebhook(0, { eventId: 'bad-1', name: 'deploy.finished', data: {} }, { secret: 'whsec_' + randomBytes(32).toString('base64') });
        assert.equal(badSig.status, 401);

        // Simulate transient 503 + 429 before 200 to verify backoff retry reuses exact batch ID.
        routine.setNextStatuses([{ status: 503 }, { status: 429, retryAfter: '0' }]);

        const deliveryId = 'msg_deploy_1';
        const d1 = await upstream.sendWebhook(0, { eventId: 'dep-1', name: 'deploy.finished', timestamp: new Date().toISOString(), data: { sha: 'abc123' } }, { deliveryId });
        assert.equal(d1.status, 200);
        // Replay of the same webhook-id must be deduplicated cleanly.
        const d1Replay = await upstream.sendWebhook(0, { eventId: 'dep-1', name: 'deploy.finished', timestamp: new Date().toISOString(), data: { sha: 'abc123' } }, { deliveryId });
        assert.equal(d1Replay.status, 200);

        await until(() => routine.calls.length >= 3);
        assert.equal(routine.calls[0]!.auth, 'Bearer ' + routineKey);
        assert.equal(routine.calls[0]!.body.source, 'mcp-events');
        assert.equal(routine.calls[0]!.body.batch, routine.calls[1]!.body.batch);
        assert.equal(routine.calls[0]!.body.batch, routine.calls[2]!.body.batch);

        const batchRes = await callTool(worker.origin, readerKey, 'read_batch', { batch: routine.calls[2]!.body.batch });
        assert.ok(!batchRes.isError, batchRes.content[0]!.text);
        const parsed = JSON.parse(batchRes.content[0]!.text) as { untrustedEvents: Array<{ eventId: string; data: { sha: string } }>; nextOffset: number | null };
        assert.equal(parsed.untrustedEvents.length, 1);
        assert.equal(parsed.untrustedEvents[0]!.eventId, 'dep-1');
        assert.equal(parsed.untrustedEvents[0]!.data.sha, 'abc123');
        assert.equal(parsed.nextOffset, null);

        // Gap notice wakes routine and surfaces under `notices`.
        const beforeGap = routine.calls.length;
        const gapRes = await upstream.sendWebhook(0, { type: 'gap', cursor: 'c9' });
        assert.equal(gapRes.status, 200);
        await until(() => routine.calls.length > beforeGap);
        const gapBatch = JSON.parse((await callTool(worker.origin, readerKey, 'read_batch', { batch: routine.calls.at(-1)!.body.batch })).content[0]!.text) as {
            untrustedEvents: unknown[];
            notices?: Array<{ text: string }>;
        };
        assert.deepEqual(gapBatch.untrustedEvents, []);
        assert.equal(gapBatch.notices?.length, 1);
        assert.ok(gapBatch.notices![0]!.text.includes('Replay gap'));

        // Unwatch calls events/unsubscribe and removes watch.
        const unwatched = await callTool(worker.origin, readerKey, 'unwatch_event', { watch: watchId });
        assert.ok(!unwatched.isError);
        assert.equal(upstream.unsubscribed.length, 1);
    });

    test('poll delivery via Durable Object alarm wakes routine and supports get_event / recent_events', async () => {
        const watched = await callTool(worker.origin, readerKey, 'watch_event', {
            server: 'mock',
            event: 'demo.button',
            arguments: { channel: 'ch-1' },
            note: 'Button press'
        });
        assert.ok(!watched.isError, watched.content[0]!.text);
        const watchId = /w-[0-9a-f]{6}/.exec(watched.content[0]!.text)![0]!;

        const beforeCalls = routine.calls.length;
        upstream.pollEvents.push({
            eventId: 'press-1',
            name: 'demo.button',
            timestamp: new Date().toISOString(),
            data: { count: 1 }
        });

        await until(() => routine.calls.length > beforeCalls);
        const batch = routine.calls.at(-1)!.body.batch;
        const read = JSON.parse((await callTool(worker.origin, readerKey, 'read_batch', { batch })).content[0]!.text) as {
            untrustedEvents: Array<{ id: string; eventId: string }>;
        };
        assert.equal(read.untrustedEvents[0]!.eventId, 'press-1');

        const got = await callTool(worker.origin, readerKey, 'get_event', { id: read.untrustedEvents[0]!.id });
        assert.ok(!got.isError);
        assert.ok(got.content[0]!.text.includes('press-1'));

        const recent = await callTool(worker.origin, readerKey, 'recent_events', { watch: watchId, limit: 5 });
        assert.ok(!recent.isError);
        assert.ok(recent.content[0]!.text.includes('press-1'));

        const listed = JSON.parse((await callTool(worker.origin, readerKey, 'list_watches')).content[0]!.text) as {
            watches: Array<{ id: string; mode: string }>;
            delivery: { held: boolean; routineConfigured: boolean };
        };
        assert.equal(listed.watches.length, 1);
        assert.equal(listed.watches[0]!.mode, 'poll');
        assert.equal(listed.delivery.routineConfigured, true);
        assert.equal(listed.delivery.held, false);

        await callTool(worker.origin, readerKey, 'unwatch_event', { watch: watchId });
    });

    test('MCP_EVENTS_OFF=1 stands down cleanly with zero tools', async () => {
        const offWorker = await startWorker({ READER_KEY: readerKey, MCP_EVENTS_OFF: '1' });
        try {
            const list = await mcpCall(offWorker.origin, readerKey, 'tools/list');
            assert.deepEqual((list.result as { tools: unknown[] }).tools, []);
        } finally {
            await offWorker.stop();
        }
    });
});
