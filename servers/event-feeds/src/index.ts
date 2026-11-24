// event-feeds: a public MCP server that implements the server side of MCP Events (SEP-3415).
//
//   /            what this is
//   /mcp         the MCP endpoint (Streamable HTTP)
//   /b/new       a new private demo-button page
//   /b/<id>      a demo-button page
//   /api/press   what the button posts

import { CHANNEL_RE, checkChannel, mintChannel } from './channel.ts';
import type { Env } from './env.ts';
import { handlePost, originAllowed } from './mcp.ts';
import { buttonPage, expiredPage, frontPage, ROUTE_LIMITS } from './pages.ts';
import { Code } from './rpc.ts';
import { MAX_MESSAGE } from './button-do.ts';
import { allow, clientKeyOf } from './limits.ts';
import { workerLoader } from './upstream.ts';

export { ButtonChannel } from './button-do.ts';
export { UpstreamGate } from './gate-do.ts';

const MCP_CORS_HEADERS = 'content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id, authorization';

const security = (nonce?: string) => ({
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ''}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
});

const html = (body: string, nonce: string, status = 200, cache = 'no-store') => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache, ...security(nonce) } });
const jsonRes = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const nonceOf = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
const clientKey = (req: Request) => clientKeyOf(req.headers.get('cf-connecting-ip'));

const tooMany = (what: string, max: number) => new Response(`Too many ${what} from this address: at most ${max} a minute. Wait a minute.`, { status: 429, headers: { 'retry-after': '30', 'content-type': 'text/plain', 'cache-control': 'no-store' } });

async function mcp(req: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
    const o = req.headers.get('origin');
    if (!originAllowed(o, origin)) return jsonRes({ jsonrpc: '2.0', id: null, error: { code: Code.InvalidRequest, message: 'Origin not allowed' } }, 403);
    const cors: Record<string, string> = o ? { 'access-control-allow-origin': o, vary: 'origin' } : {};
    // Every request to /mcp counts, whatever its method.
    if (!(await allow(env.RL_CLIENT, clientKey(req))))
        return jsonRes({ jsonrpc: '2.0', id: null, error: { code: Code.ResourceExhausted, message: `Too many requests from this address: at most ${ROUTE_LIMITS.mcp} a minute`, data: { limit: 'requests_per_minute', max: ROUTE_LIMITS.mcp } } }, 429, { 'retry-after': '30', ...cors });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': MCP_CORS_HEADERS, 'access-control-max-age': '86400' } });
    // No standalone stream and no sessions (2026-07-28 removed both; earlier revisions allow 405).
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...cors } });
    const res = await handlePost(req, {
        loader: workerLoader(env, ctx, clientKey(req)),
        origin,
        secret: env.CHANNEL_SECRET,
        now: Date.now(),
        allowMint: () => allow(env.RL_PRESS, clientKey(req))
    });
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers: h });
}

async function press(req: Request, env: Env, origin: string): Promise<Response> {
    // Only this site's own button page posts here (a JSON body from another site needs CORS, which is not offered).
    const o = req.headers.get('origin');
    if (o !== null && o !== origin) return jsonRes({ ok: false, error: 'Not allowed from another site.' }, 403);
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return jsonRes({ ok: false, error: 'Send JSON.' }, 415);
    const text = await req.text();
    if (text.length > 1000) return jsonRes({ ok: false, error: 'Too large.' }, 413);
    let body: { channel?: unknown; message?: unknown };
    try {
        body = JSON.parse(text);
    } catch {
        return jsonRes({ ok: false, error: 'Send JSON.' }, 400);
    }
    const channel = typeof body.channel === 'string' ? body.channel : '';
    const now = Date.now();
    const c = await checkChannel(env.CHANNEL_SECRET, channel, now);
    if (!c.ok) return jsonRes({ ok: false, error: c.why === 'expired' ? 'This button has expired. Get a new one.' : 'Unknown button.' }, c.why === 'expired' ? 410 : 404);
    const message = typeof body.message === 'string' ? Array.from(body.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, MAX_MESSAGE).join('') : '';
    const r = await env.CHANNELS.get(env.CHANNELS.idFromName(channel)).press(message || undefined, now, c.expiresAt);
    if (r.ok) return jsonRes({ ok: true, press: r.n });
    const why = { too_fast: 'One press a second, please.', full: 'This button has had its 50 presses. Get a new one.', expired: 'This button has expired. Get a new one.' }[r.why];
    return jsonRes({ ok: false, error: why }, r.why === 'too_fast' ? 429 : 410);
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        const origin = url.origin;
        const path = url.pathname;
        // Without its secret the server cannot sign button channels: the button is off, the feeds still work.
        if (!env.CHANNEL_SECRET || env.CHANNEL_SECRET.length < 16) env = { ...env, CHANNEL_SECRET: '' };
        const buttonOff = env.CHANNEL_SECRET === '';
        if (path === '/mcp') return mcp(req, env, ctx, origin);
        // Every other route is limited too: presses and new buttons share one budget, pages another.
        if (path === '/api/press' || path === '/b/new') {
            if (!(await allow(env.RL_PRESS, clientKey(req)))) return path === '/api/press' ? jsonRes({ ok: false, error: 'Too many presses from this address; wait a minute.' }, 429, { 'retry-after': '30' }) : tooMany('new buttons', ROUTE_LIMITS.press);
        } else if (!(await allow(env.RL_PAGE, clientKey(req)))) return tooMany('requests', ROUTE_LIMITS.page);
        if (buttonOff && (path === '/api/press' || path.startsWith('/b/'))) return new Response('The demo button is not configured on this server (CHANNEL_SECRET is not set).', { status: 503, headers: { 'content-type': 'text/plain' } });
        if (path === '/api/press') return req.method === 'POST' ? press(req, env, origin) : new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
        if (path === '/') {
            const n = nonceOf();
            return html(frontPage(origin, env.SOURCE_URL, n), n, 200, 'no-cache');
        }
        if (path === '/b/new') {
            const id = await mintChannel(env.CHANNEL_SECRET, Date.now());
            return new Response(null, { status: 303, headers: { location: `/b/${id}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
        }
        const b = /^\/b\/([^/]+)$/.exec(path);
        if (b) {
            const n = nonceOf();
            const id = b[1]!;
            const c = CHANNEL_RE.test(id) ? await checkChannel(env.CHANNEL_SECRET, id, Date.now()) : ({ ok: false, why: 'invalid' } as const);
            if (!c.ok) return html(expiredPage(n), n, c.why === 'expired' ? 410 : 404);
            return html(buttonPage(id, c.expiresAt, n), n);
        }
        if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /b/\nDisallow: /mcp\n', { headers: { 'content-type': 'text/plain' } });
        if (path === '/favicon.ico') return new Response(null, { status: 204 });
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
} satisfies ExportedHandler<Env>;
