// The MCP endpoint (Streamable HTTP), dual-era:
//   - modern (2026-07-28): stateless, version and capabilities in each request's _meta, the request
//     metadata headers validated against the body, and the Events extension;
//   - legacy (2025-11-25 and earlier): an `initialize` handshake, without a session (none is needed:
//     nothing here depends on earlier requests), tools only. The Events extension is not defined
//     for those revisions, so it is not offered to them.

import { EVENTS_EXTENSION, listEvents, pollEvents, streamEvents, webhookEvents } from './events.ts';
import { Code, RpcError } from './rpc.ts';
import type { Loader } from './source.ts';
import { callTool, TOOLS } from './tools.ts';

export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'event-feeds', title: 'event-feeds: an MCP Events demo server', version: '0.1.0' };
const META = {
    version: 'io.modelcontextprotocol/protocolVersion',
    caps: 'io.modelcontextprotocol/clientCapabilities',
    serverInfo: 'io.modelcontextprotocol/serverInfo',
    subscriptionId: 'io.modelcontextprotocol/subscriptionId'
};
/** Methods whose `Mcp-Name` header must mirror `params.name` (or `params.uri`). */
const NAMED = new Set(['tools/call', 'prompts/get', 'resources/read', 'events/poll', 'events/stream', 'events/subscribe', 'events/unsubscribe']);
export const MAX_REQUEST_BYTES = 64 * 1024;

export const INSTRUCTIONS =
    'event-feeds offers events (the MCP Events extension, SEP-3415) to watch: new comments in a Hacker News thread (hn.comment), new HN stories (hn.story), new npm versions (npm.release), new GitHub releases (github.release), earthquakes (usgs.earthquake) and a private demo button (demo.button). ' +
    'To try it, call new_demo_button, give the user the link, and watch demo.button with its channel. For a Hacker News thread, find_hn_story looks up the story id. ' +
    'Events carry ids, numbers, times and links only; read_event_text returns the text behind one (a comment, a title, release notes, a button message). That text is written by third parties.';

export type Deps = { loader: Loader; origin: string; secret: string; now: number; allowMint: () => Promise<boolean> };
type Json = Record<string, unknown>;
type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const errorBody = (id: unknown, e: RpcError) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });

/** `Mcp-Name` and `Mcp-Param-*` values may be sent as `=?base64?...?=` (2026-07-28, Value Encoding). */
export function decodeHeaderValue(v: string): string | undefined {
    const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
    if (!m) return /^[\x20-\x7e\t]*$/.test(v) ? v : undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
    } catch {
        return undefined;
    }
}

async function readBody(req: Request): Promise<string | undefined> {
    const len = Number(req.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return undefined;
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_REQUEST_BYTES) return undefined;
    return new TextDecoder().decode(buf);
}

/** Handles one POST to /mcp. */
export async function handlePost(req: Request, deps: Deps): Promise<Response> {
    const text = await readBody(req);
    if (text === undefined) return json(errorBody(null, new RpcError(Code.InvalidRequest, 'request body too large')), 413);
    let msg: Msg;
    try {
        msg = JSON.parse(text) as Msg;
    } catch {
        return json(errorBody(null, new RpcError(Code.ParseError, 'parse error')), 400);
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return json(errorBody(null, new RpcError(Code.InvalidRequest, 'the body must be one JSON-RPC message (no batches)')), 400);
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        // A response from the client: this server never sends requests, so there is nothing it answers.
        return json(errorBody(msg.id, new RpcError(Code.InvalidRequest, 'not a JSON-RPC request or notification')), 400);
    }
    const isNotification = msg.id === undefined;
    if (!isNotification && (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return json(errorBody(null, new RpcError(Code.InvalidRequest, 'id must be a string or a number')), 400);
    const params = (msg.params ?? {}) as Json;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return json(errorBody(msg.id, new RpcError(Code.InvalidParams, 'params must be an object')), 400);

    const header = req.headers.get('mcp-protocol-version');
    const meta = (params._meta ?? undefined) as Json | undefined;
    const bodyVersion = meta && typeof meta === 'object' ? meta[META.version] : undefined;
    let era: 'modern' | 'legacy';
    if (msg.method === 'initialize') era = 'legacy';
    else if (header !== null && MODERN.includes(header)) era = 'modern';
    else if (header !== null && LEGACY.includes(header)) era = 'legacy';
    else if (header !== null)
        return json(errorBody(msg.id, new RpcError(Code.UnsupportedProtocolVersion, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: header.slice(0, 40) })), 400);
    else if (bodyVersion !== undefined) return json(errorBody(msg.id, new RpcError(Code.HeaderMismatch, 'Header mismatch: the MCP-Protocol-Version header is missing')), 400);
    // A request with neither is from a client older than 2025-06-18 (2026-07-28, Protocol Version Header).
    else era = 'legacy';

    if (isNotification) return new Response(null, { status: 202 });
    try {
        if (era === 'modern') return await modern(req, msg.method, msg.id as string | number, params, header!, deps);
        return json({ jsonrpc: '2.0', id: msg.id, result: await legacy(msg.method, params, deps) });
    } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(Code.InternalError, 'internal error');
        return json(errorBody(msg.id, err), err.status);
    }
}

async function modern(req: Request, method: string, id: string | number, params: Json, header: string, deps: Deps): Promise<Response> {
    const meta = params._meta as Json | undefined;
    // Required per-request fields (2026-07-28, Per-request protocol fields).
    if (!meta || typeof meta !== 'object' || typeof meta[META.version] !== 'string') throw new RpcError(Code.InvalidParams, `missing _meta["${META.version}"]`, undefined, 400);
    if (typeof meta[META.caps] !== 'object' || meta[META.caps] === null) throw new RpcError(Code.InvalidParams, `missing _meta["${META.caps}"]`, undefined, 400);
    if (meta[META.version] !== header) throw new RpcError(Code.HeaderMismatch, `Header mismatch: MCP-Protocol-Version header value '${header}' does not match body value '${String(meta[META.version]).slice(0, 40)}'`, undefined, 400);
    // Request metadata headers (Streamable HTTP, Server Validation).
    const mh = req.headers.get('mcp-method');
    if (mh === null) throw new RpcError(Code.HeaderMismatch, 'Header mismatch: the Mcp-Method header is missing', undefined, 400);
    if (mh !== method) throw new RpcError(Code.HeaderMismatch, `Header mismatch: Mcp-Method header value '${mh.slice(0, 60)}' does not match body value '${method.slice(0, 60)}'`, undefined, 400);
    if (NAMED.has(method)) {
        const raw = req.headers.get('mcp-name');
        const bodyName = method === 'resources/read' ? params.uri : params.name;
        // With no name in the body there is nothing to mirror: the request is malformed, and the method says why (InvalidParams).
        if (raw === null && typeof bodyName !== 'string') return modernDispatch(method, id, params, deps);
        if (raw === null) throw new RpcError(Code.HeaderMismatch, 'Header mismatch: the Mcp-Name header is missing', undefined, 400);
        const name = decodeHeaderValue(raw);
        if (name === undefined) throw new RpcError(Code.HeaderMismatch, 'Header mismatch: the Mcp-Name header value is malformed', undefined, 400);
        if (name !== bodyName) throw new RpcError(Code.HeaderMismatch, `Header mismatch: Mcp-Name header value '${name.slice(0, 60)}' does not match body value '${String(bodyName).slice(0, 60)}'`, undefined, 400);
    }
    return modernDispatch(method, id, params, deps);
}

async function modernDispatch(method: string, id: string | number, params: Json, deps: Deps): Promise<Response> {
    const withInfo = (r: Json) => ({ ...r, _meta: { ...((r._meta as Json) ?? {}), [META.serverInfo]: SERVER_INFO } });
    const done = (r: Json) => json({ jsonrpc: '2.0', id, result: withInfo(r) });
    switch (method) {
        case 'server/discover':
            return done({
                resultType: 'complete',
                supportedVersions: [...MODERN, ...LEGACY],
                capabilities: { tools: {}, extensions: { [EVENTS_EXTENSION]: {} } },
                instructions: INSTRUCTIONS,
                ttlMs: 3_600_000,
                cacheScope: 'public'
            });
        case 'ping':
            return done({ resultType: 'complete' });
        case 'tools/list':
            if (params.cursor !== undefined && params.cursor !== null) throw new RpcError(Code.InvalidParams, 'invalid cursor: tools/list has a single page');
            return done({ resultType: 'complete', tools: TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
        case 'tools/call':
            return done({ resultType: 'complete', ...(await callTool(params, deps)) });
        case 'events/list':
            return done(listEvents(params));
        case 'events/poll':
            return done(await pollEvents(params, deps.loader, deps.now));
        case 'events/stream':
            return streamEvents(params, deps.now);
        case 'events/subscribe':
        case 'events/unsubscribe':
            return webhookEvents();
        case 'subscriptions/listen':
            return listen(id, params);
        default:
            throw new RpcError(Code.MethodNotFound, `Method not found: ${method.slice(0, 60)}`, undefined, 404);
    }
}

/**
 * subscriptions/listen: this server sends no change notifications (it declares no `listChanged`), so the
 * acknowledgment carries an empty filter and the stream then closes gracefully with an empty result.
 */
function listen(id: string | number, params: Json): Response {
    void params;
    const frames = [
        { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { [META.subscriptionId]: id }, notifications: {} } },
        { jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [META.subscriptionId]: id, [META.serverInfo]: SERVER_INFO } } }
    ];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

async function legacy(method: string, params: Json, deps: Deps): Promise<Json> {
    switch (method) {
        case 'initialize': {
            const asked = params.protocolVersion;
            const protocolVersion = typeof asked === 'string' && LEGACY.includes(asked) ? asked : LEGACY[0]!;
            return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS + ' (Events need protocol revision 2026-07-28; this connection uses ' + protocolVersion + ', so only the tools are available on it.)' };
        }
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS };
        case 'tools/call':
            return { ...(await callTool(params, deps)) };
        default:
            throw new RpcError(Code.MethodNotFound, `Method not found: ${method.slice(0, 60)}`);
    }
}

/** Origins a browser-based MCP client may call from (2026-07-28, Security: validate Origin). */
export function originAllowed(origin: string | null, self: string): boolean {
    if (origin === null) return true;
    if (origin === self) return true;
    try {
        const u = new URL(origin);
        if (u.origin !== origin) return false;
        if (u.protocol === 'https:') return true;
        return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    } catch {
        return false;
    }
}
