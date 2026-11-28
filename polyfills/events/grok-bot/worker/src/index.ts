// Cloudflare Worker entrypoint for MCP Events (SEP-3415) on Grok Bot.
//
// Endpoints:
//   GET  /healthz                                 liveness check
//   GET  /.well-known/mcp-webhook-receiver.json   SEP-3415 receiver discovery
//   POST /hooks/<hookId>                          signed MCP Events webhook deliveries & verification challenges
//   POST /mcp                                     authenticated Streamable HTTP MCP server for Grok Bot

import { sameText } from './crypto.ts';
import type { HubEnv } from './hub.ts';

export { GrokEventsHub } from './hub.ts';

const HOOK_RE = /^[0-9a-f]{32}$/;
const MAX_HOOK_BYTES = 256 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
    });
}

export default {
    async fetch(request: Request, env: HubEnv): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/healthz' && request.method === 'GET') {
            return json(200, { ok: true, off: env.MCP_EVENTS_OFF === '1' });
        }

        if (url.pathname === '/.well-known/mcp-webhook-receiver.json' && request.method === 'GET') {
            return json(200, { receivers: ['/hooks/'] });
        }

        if (url.pathname.startsWith('/hooks/')) {
            if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
            const hookId = url.pathname.slice('/hooks/'.length);
            if (!HOOK_RE.test(hookId)) return json(404, { error: 'Not found' });
            const len = Number(request.headers.get('content-length') ?? '0');
            if (len > MAX_HOOK_BYTES) return json(413, { error: 'Payload too large' });
            const raw = await request.text();
            if (new TextEncoder().encode(raw).byteLength > MAX_HOOK_BYTES) {
                return json(413, { error: 'Payload too large' });
            }
            const stub = env.HUB.get(env.HUB.idFromName('default'));
            return stub.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: raw }));
        }

        if (url.pathname === '/mcp') {
            const originHeader = request.headers.get('origin');
            const allowedOrigin = env.READER_ORIGIN?.trim();
            if (originHeader !== null && (!allowedOrigin || originHeader !== allowedOrigin)) {
                return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
            }
            const key = env.READER_KEY?.trim();
            if (!key || key.length < 32) {
                return json(503, { error: 'READER_KEY secret is not configured. Run `npm run setup`.' });
            }
            const auth = request.headers.get('authorization') ?? '';
            if (!(await sameText(auth, 'Bearer ' + key))) {
                return new Response(null, {
                    status: 401,
                    headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' }
                });
            }
            if (request.method !== 'POST') {
                return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
            }
            const stub = env.HUB.get(env.HUB.idFromName('default'));
            return stub.fetch(request);
        }

        return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
} satisfies ExportedHandler<HubEnv>;
