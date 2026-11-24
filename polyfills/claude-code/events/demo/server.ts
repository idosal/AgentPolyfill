// A small "deploys" service for demos: a page to start deploys from, and an
// MCP server that reports each finished deploy as an MCP Event (SEP-3415).
//
// The MCP side is Mastra's MCPServer (@mastra/mcp), whose Events support is
// Mastra's own implementation of the extension: list, poll, push, and webhook
// delivery with its own subscription store, endpoint verification and signing.
// Nothing here is this plugin's code, which makes it a fair server to try the
// plugin against.
//
//   DEPLOYS_TOKEN       required; the bearer token MCP clients must send
//   PORT                default 4010
//   DEPLOYS_DELIVERY    e.g. "webhook" to offer webhook delivery only, as servers
//                       built for webhook-only hosts do (default: push, poll, webhook)
//   DEPLOYS_ALLOW_LOCAL "1" lets webhook addresses be plain http on this machine (local tries only)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTool } from '@mastra/core/tools';
import { defineEvent, MCPServer } from '@mastra/mcp';
import { z } from 'zod';

const TOKEN = process.env.DEPLOYS_TOKEN;
if (!TOKEN) throw new Error('DEPLOYS_TOKEN is required');
const PORT = Number(process.env.PORT ?? 4010);
const DELIVERY = process.env.DEPLOYS_DELIVERY?.split(',').map((s) => s.trim()).filter(Boolean) as ('push' | 'poll' | 'webhook')[] | undefined;
const ALLOW_LOCAL = process.env.DEPLOYS_ALLOW_LOCAL === '1';

// ---- the service ------------------------------------------------------------------

type Deploy = { id: string; service: string; commit: string; status: 'running' | 'ok' | 'failed'; startedAt: number; finishedAt?: number; log: string[] };
const SERVICES = ['api', 'web', 'worker'];
const deploys: Deploy[] = [];
let seq = 100;

const GOOD = ['Building image', 'Running 214 tests', 'All tests passed', 'Applying migrations: none pending', 'Rolling out 3/3 instances', 'Health checks passing'];
const BAD: Record<string, string[]> = {
    api: ['Building image', 'Running 214 tests', 'All tests passed', 'Applying migration 0042_orders_index', 'ERROR: relation "orders_archive" does not exist', 'Migration 0042_orders_index failed; rolled back', 'Deploy aborted before rollout'],
    web: ['Building image', 'Bundling assets', 'ERROR: Cannot resolve "./checkout/PaymentForm" from src/routes/checkout.tsx', 'Build failed'],
    worker: ['Building image', 'Running 88 tests', 'All tests passed', 'Rolling out 1/3 instances', 'ERROR: health check failed: queue consumer exited with code 137 (out of memory)', 'Rolled back to the previous release']
};

function startDeploy(service: string, fail: boolean): Deploy {
    const d: Deploy = { id: `d-${++seq}`, service, commit: randomBytes(4).toString('hex').slice(0, 7), status: 'running', startedAt: Date.now(), log: [] };
    deploys.unshift(d);
    const lines = fail ? BAD[service]! : GOOD;
    const step = 1800 / lines.length;
    lines.forEach((line, i) => setTimeout(() => d.log.push(line), step * (i + 1)));
    setTimeout(() => {
        d.status = fail ? 'failed' : 'ok';
        d.finishedAt = Date.now();
        void server.events.emit('deploy.finished', { id: d.id, service: d.service, status: d.status, commit: d.commit, seconds: Math.round((d.finishedAt - d.startedAt) / 100) / 10 }, { eventId: `deploy-${d.id}` });
    }, 2000);
    return d;
}

// ---- the MCP server ---------------------------------------------------------------

const server = new MCPServer({
    id: 'deploys',
    name: 'Deploys',
    version: '1.0.0',
    description: 'Deploys of the api, web and worker services: their status and logs, and an event when one finishes.',
    tools: {
        list_deploys: createTool({
            id: 'list_deploys',
            description: 'The most recent deploys, newest first: id, service, commit, status and when.',
            inputSchema: z.object({ service: z.enum(['api', 'web', 'worker']).optional(), limit: z.number().int().min(1).max(50).optional() }),
            execute: async (input: { service?: string; limit?: number }) =>
                deploys
                    .filter((d) => !input.service || d.service === input.service)
                    .slice(0, input.limit ?? 10)
                    .map(({ log: _log, ...d }) => ({ ...d, startedAt: new Date(d.startedAt).toISOString(), finishedAt: d.finishedAt ? new Date(d.finishedAt).toISOString() : undefined }))
        }),
        get_deploy_log: createTool({
            id: 'get_deploy_log',
            description: 'The log of one deploy, by id (for example "d-101"). Use it to find why a deploy failed.',
            inputSchema: z.object({ id: z.string() }),
            execute: async (input: { id: string }) => {
                const d = deploys.find((x) => x.id === input.id);
                if (!d) throw new Error(`no deploy ${input.id}`);
                return { id: d.id, service: d.service, commit: d.commit, status: d.status, log: d.log };
            }
        })
    },
    events: {
        'deploy.finished': defineEvent({
            description: 'A deploy finished, successfully or not.',
            inputSchema: z.object({ service: z.enum(['api', 'web', 'worker']).optional(), status: z.enum(['ok', 'failed']).optional() }),
            payloadSchema: z.object({
                id: z.string().regex(/^d-[0-9]{1,6}$/),
                service: z.enum(['api', 'web', 'worker']),
                status: z.enum(['ok', 'failed']),
                commit: z.string().regex(/^[0-9a-f]{7}$/),
                seconds: z.number()
            }),
            match: (args: { service?: string; status?: string }, data: { service: string; status: string }) => (!args.service || args.service === data.service) && (!args.status || args.status === data.status),
            ...(DELIVERY ? { delivery: DELIVERY } : {})
        })
    },
    eventsOptions: {
        heartbeatIntervalMs: 10000,
        webhook: {
            ttl: { maxMs: 24 * 3600 * 1000 },
            retry: { maxAttempts: 5, initialDelayMs: 1000 },
            ...(ALLOW_LOCAL ? { url: { allowInsecure: true, allowPrivate: true } } : {})
        }
    }
});

// ---- HTTP: the page, its small API, and /mcp ---------------------------------------

const PAGE = new URL('./page.html', import.meta.url);

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const c of req) {
        raw += c;
        if (raw.length > 4096) throw new Error('too large');
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''));
    const want = Buffer.from(TOKEN!);
    return given.length === want.length && timingSafeEqual(given, want);
}

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const http = createServer(async (req, res) => {
    try {
        // The address is never taken from the request's own Host header: that is the caller's to choose.
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
        if (url.pathname === '/mcp') {
            if (!authorized(req)) {
                res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'application/json' });
                return void res.end(JSON.stringify({ error: 'a bearer token is required' }));
            }
            // Who is calling: Mastra's webhook delivery keeps subscriptions per authenticated caller.
            (req as IncomingMessage & { auth?: unknown }).auth = { token: TOKEN, clientId: 'demo-user', scopes: [] };
            return await server.startHTTP({ url, httpPath: '/mcp', req, res });
        }
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return void res.end(readFileSync(PAGE));
        }
        if (req.method === 'GET' && url.pathname === '/api/deploys') {
            return json(res, 200, { services: SERVICES, deploys: deploys.slice(0, 12).map((d) => ({ ...d, log: d.log.slice(-1) })) });
        }
        if (req.method === 'POST' && url.pathname === '/api/deploy') {
            // The page is for whoever runs this demo on their own machine: local requests only, and only from
            // the page itself. Another site open in the same browser can reach localhost, but cannot send JSON
            // from this origin without a preflight this server never answers.
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return json(res, 403, { error: 'local only' });
            const origin = req.headers.origin;
            if (!LOCAL_HOSTS.has(String(req.headers.host)) || (origin !== undefined && !LOCAL_HOSTS.has(origin.replace(/^http:\/\//, ''))) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
                return json(res, 403, { error: 'same-origin JSON only' });
            }
            const b = await body(req);
            if (typeof b.service !== 'string' || !SERVICES.includes(b.service)) return json(res, 400, { error: 'unknown service' });
            return json(res, 200, startDeploy(b.service, b.fail === true));
        }
        json(res, 404, { error: 'not found' });
    } catch (e) {
        if (!res.headersSent) json(res, 500, { error: String((e as Error).message ?? e) });
    }
});

http.listen(PORT, '127.0.0.1', () => {
    console.error(`deploys: page at http://127.0.0.1:${PORT}/ · MCP at http://127.0.0.1:${PORT}/mcp · delivery ${DELIVERY?.join(', ') ?? 'push, poll, webhook'}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void server.close().finally(() => process.exit(0)));
