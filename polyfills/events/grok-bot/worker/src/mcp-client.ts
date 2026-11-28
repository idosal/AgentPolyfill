// SEP-3415 Streamable HTTP MCP Events client for Cloudflare Workers.
// Handles initialize + Mcp-Session-Id, JSON and SSE responses, routing headers (Mcp-Name / Mcp-Param-*),
// and pre-standard top-level `events` servers when permitted by MCP_EVENTS_PRE_STANDARD.

import { bytesToBase64 } from './crypto.ts';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
const FIRST_REVISION = '2026-07-28';
const CLIENT_INFO = { name: 'mcp-events-grok-bot', version: '0.1.0' };
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;

export type DeliveryMode = 'poll' | 'push' | 'webhook';

export type HeaderDeclaration = { path: string[]; header: string };

export type EventType = {
    name: string;
    description?: string;
    delivery: DeliveryMode[];
    inputSchema?: unknown;
    payloadSchema?: unknown;
    headers: HeaderDeclaration[];
};

export type UpstreamServerConfig = {
    url: string;
    bearer?: string;
    headers?: Record<string, string>;
};

export type Occurrence = {
    eventId: string;
    name: string;
    timestamp: string;
    data?: Record<string, unknown>;
    cursor?: string | null;
};

export type SessionInfo = {
    sessionId?: string;
    protocolVersion: string;
    declaration?: 'extensions' | 'pre-standard';
    outsideTheSpec?: string;
};

export class RpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
        super(message);
        this.name = 'RpcError';
        this.code = code;
    }
}

export const EventsError = {
    NotFound: -32023,
    Forbidden: -32024,
    ResourceExhausted: -32025,
    Unsupported: -32026,
    CallbackEndpointError: -32027,
    HeaderMismatch: -32020
} as const;

export function preStandardPolicy(value: string | undefined): (server: string) => boolean {
    const v = (value ?? '').trim();
    if (v === '' || /^(on|1|true|yes|all)$/i.test(v)) return () => true;
    if (/^(off|0|false|no|none)$/i.test(v)) return () => false;
    const named = new Set(v.split(',').map((x) => x.trim()).filter(Boolean));
    return (server) => named.has(server);
}

// ---- SEP-3415 Routing Headers (Mcp-Name / Mcp-Param-*) -----------------------------

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_TYPES = new Set(['string', 'integer', 'boolean']);
const ELSEWHERE = ['items', 'additionalItems', 'prefixItems', 'contains', 'contentSchema', 'dependencies', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions'];
const KEYED = new Set(['patternProperties', 'dependentSchemas', 'dependencies', '$defs', 'definitions']);
const enc = new TextEncoder();

export function scanHeaders(inputSchema: unknown): { declarations: HeaderDeclaration[] } | { invalid: string } {
    const declarations: HeaderDeclaration[] = [];
    const seen = new Set<string>();
    let budget = 5000;
    const visit = (node: unknown, path: string[], reachable: boolean): string | undefined => {
        if (node === null || typeof node !== 'object') return undefined;
        if (--budget < 0) return 'schema too large';
        const schema = node as Record<string, unknown>;
        if ('x-mcp-header' in schema) {
            const at = path.join('.') || '(root)';
            const raw = schema['x-mcp-header'];
            if (!reachable || path.length === 0) return `${at}: x-mcp-header only allowed under properties`;
            if (typeof raw !== 'string' || !TOKEN.test(raw)) return `${at}: invalid header name`;
            if (typeof schema.type !== 'string' || !HEADER_TYPES.has(schema.type)) return `${at}: unsupported type`;
            if (seen.has(raw.toLowerCase())) return `${at}: duplicate header`;
            seen.add(raw.toLowerCase());
            declarations.push({ path, header: raw });
        }
        const properties = schema.properties;
        if (properties !== null && typeof properties === 'object') {
            for (const [key, child] of Object.entries(properties)) {
                const fault = visit(child, [...path, key], reachable);
                if (fault) return fault;
            }
        }
        for (const k of ELSEWHERE) {
            const sub = schema[k];
            if (sub === undefined) continue;
            const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === 'object' && KEYED.has(k) ? Object.values(sub) : [sub];
            for (const branch of branches) {
                const fault = visit(branch, [...path, `<${k}>`], false);
                if (fault) return fault;
            }
        }
        return undefined;
    };
    const fault = visit(inputSchema, [], true);
    return fault ? { invalid: fault } : { declarations };
}

function encodeHeaderValue(value: string): string {
    const plain = value.length > 0 && value === value.trim() && !(value.startsWith('=?base64?') && value.endsWith('?=')) && /^[\x20-\x7e]*$/.test(value);
    return plain ? value : `=?base64?${bytesToBase64(enc.encode(value))}?=`;
}

function asText(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return String(v);
    return undefined;
}

export function buildRoutingHeaders(eventName: string, args: unknown, declarations: HeaderDeclaration[] = []): Record<string, string> {
    const out: Record<string, string> = { 'Mcp-Name': encodeHeaderValue(eventName) };
    for (const d of declarations) {
        let v: unknown = args;
        for (const key of d.path) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
        const text = v === undefined || v === null ? undefined : asText(v);
        if (text !== undefined) out[`Mcp-Param-${d.header}`] = encodeHeaderValue(text);
    }
    return out;
}

// ---- Streamable HTTP JSON-RPC helper -----------------------------------------------

async function readTextCapped(res: Response, limit = MAX_RESPONSE_BYTES): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new Error('Upstream response exceeded size limit.');
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
}

function parseJsonRpcResponse(contentType: string, raw: string, expectedId: number): unknown {
    const ct = contentType.split(';')[0]!.trim().toLowerCase();
    const messages: unknown[] = [];
    if (ct === 'text/event-stream') {
        const blocks = raw.replace(/\r\n/g, '\n').split('\n\n');
        for (const block of blocks) {
            const dataLines = block
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart());
            if (!dataLines.length) continue;
            const payload = dataLines.join('\n').trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                messages.push(JSON.parse(payload));
            } catch {
                // ignore non-JSON SSE comments/keepalives
            }
        }
    } else {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) messages.push(...parsed);
        else messages.push(parsed);
    }
    const match = messages.find((m) => typeof m === 'object' && m !== null && (m as { id?: unknown }).id === expectedId) as
        | { result?: unknown; error?: { code?: number; message?: string } }
        | undefined;
    if (!match) throw new Error('Upstream returned no JSON-RPC response for request.');
    if (match.error) {
        const code = typeof match.error.code === 'number' ? match.error.code : -32000;
        throw new RpcError(code, match.error.message || `JSON-RPC error ${code}`);
    }
    return match.result;
}

export function isAuthenticatedServer(cfg: UpstreamServerConfig): boolean {
    if (cfg.bearer?.trim()) return true;
    return Object.keys(cfg.headers ?? {}).some((k) => /^(authorization|x-api-key|api-key|cookie)$/i.test(k));
}

function authHeaders(cfg: UpstreamServerConfig): Record<string, string> {
    const out: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (cfg.bearer?.trim() && !Object.keys(out).some((k) => k.toLowerCase() === 'authorization')) {
        out.Authorization = 'Bearer ' + cfg.bearer.trim();
    }
    return out;
}

export class UpstreamMcpClient {
    readonly name: string;
    readonly cfg: UpstreamServerConfig;
    readonly allowPreStandard: boolean;
    #nextId = 1;
    session?: SessionInfo;

    constructor(name: string, cfg: UpstreamServerConfig, allowPreStandard: boolean) {
        this.name = name;
        this.cfg = cfg;
        this.allowPreStandard = allowPreStandard;
    }

    async #post(body: unknown, extraHeaders: Record<string, string> = {}, expectResponse = true): Promise<{ res: Response; raw: string }> {
        const headers: Record<string, string> = {
            ...authHeaders(this.cfg),
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...extraHeaders
        };
        if (this.session?.sessionId) headers['mcp-session-id'] = this.session.sessionId;
        if (this.session?.protocolVersion) headers['mcp-protocol-version'] = this.session.protocolVersion;

        const res = await fetch(this.cfg.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!expectResponse) {
            await res.body?.cancel();
            return { res, raw: '' };
        }
        const raw = await readTextCapped(res);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} from upstream MCP server`);
        }
        return { res, raw };
    }

    async initialize(): Promise<SessionInfo> {
        if (this.session) return this.session;
        const id = this.#nextId++;
        const { res, raw } = await this.#post({
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: {
                protocolVersion: FIRST_REVISION,
                capabilities: { extensions: { [EVENTS_EXTENSION]: {} } },
                clientInfo: CLIENT_INFO
            }
        });
        const result = parseJsonRpcResponse(res.headers.get('content-type') ?? 'application/json', raw, id) as {
            protocolVersion?: string;
            capabilities?: Record<string, unknown>;
        };
        const protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : FIRST_REVISION;
        const caps = (result?.capabilities ?? {}) as Record<string, unknown>;
        const ext = (caps.extensions as Record<string, unknown> | undefined)?.[EVENTS_EXTENSION];
        const hasExt = typeof ext === 'object' && ext !== null && protocolVersion >= FIRST_REVISION;
        const hasSketch = typeof caps.events === 'object' && caps.events !== null;
        let declaration: 'extensions' | 'pre-standard' | undefined;
        let outsideTheSpec: string | undefined;
        if (hasExt) declaration = 'extensions';
        else if (hasSketch && this.allowPreStandard) declaration = 'pre-standard';
        else if (typeof ext === 'object' && ext !== null) {
            outsideTheSpec = `advertises Events on protocol ${protocolVersion}, older than ${FIRST_REVISION}`;
        } else if (hasSketch) {
            outsideTheSpec = 'advertises pre-standard top-level events capability and MCP_EVENTS_PRE_STANDARD disabled it';
        }
        this.session = {
            sessionId: res.headers.get('mcp-session-id') ?? undefined,
            protocolVersion,
            declaration,
            outsideTheSpec
        };
        // Send notifications/initialized best-effort per Streamable HTTP spec.
        await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, false).catch(() => {});
        return this.session;
    }

    async #request(method: string, params: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<unknown> {
        const s = await this.initialize();
        if (!s.declaration) {
            throw new Error(s.outsideTheSpec || 'Server does not advertise MCP Events.');
        }
        const id = this.#nextId++;
        try {
            const { res, raw } = await this.#post({ jsonrpc: '2.0', id, method, params }, extraHeaders);
            return parseJsonRpcResponse(res.headers.get('content-type') ?? 'application/json', raw, id);
        } catch (err) {
            if (err instanceof RpcError && s.declaration === 'pre-standard' && err.code <= -32011 && err.code >= -32015) {
                throw new RpcError(err.code - 12, err.message);
            }
            throw err;
        }
    }

    async listEventTypes(): Promise<{ declaration: 'extensions' | 'pre-standard'; eventTypes: EventType[] }> {
        const s = await this.initialize();
        if (!s.declaration) throw new Error(s.outsideTheSpec || 'Server does not advertise MCP Events.');
        const out: EventType[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const res = (await this.#request('events/list', cursor ? { cursor } : {})) as {
                events?: Array<{ name?: unknown; description?: unknown; delivery?: unknown; inputSchema?: unknown; payloadSchema?: unknown }>;
                nextCursor?: unknown;
            };
            for (const e of res?.events ?? []) {
                const delivery = Array.isArray(e.delivery)
                    ? e.delivery.filter((d): d is DeliveryMode => d === 'poll' || d === 'push' || d === 'webhook')
                    : [];
                // eslint-disable-next-line no-control-regex
                if (!delivery.length || typeof e.name !== 'string' || !e.name.length || e.name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(e.name)) {
                    continue;
                }
                const scan = scanHeaders(e.inputSchema);
                if ('invalid' in scan) continue;
                out.push({
                    name: e.name,
                    description: typeof e.description === 'string' ? e.description.slice(0, 2000) : undefined,
                    delivery: [...new Set(delivery)],
                    inputSchema: e.inputSchema,
                    payloadSchema: e.payloadSchema,
                    headers: scan.declarations
                });
                if (out.length >= 200) break;
            }
            if (typeof res?.nextCursor !== 'string' || !res.nextCursor) break;
            cursor = res.nextCursor;
        }
        return { declaration: s.declaration, eventTypes: out };
    }

    async poll(
        p: { name: string; arguments: Record<string, unknown>; cursor: string | null; maxAgeMs?: number; maxEvents?: number },
        declarations?: HeaderDeclaration[]
    ): Promise<{ events: Occurrence[]; cursor?: string | null; truncated?: boolean; hasMore?: boolean; nextPollMs?: number }> {
        const routing = buildRoutingHeaders(p.name, p.arguments, declarations);
        const res = (await this.#request('events/poll', p, routing)) as {
            events?: Occurrence[];
            cursor?: string | null;
            truncated?: boolean;
            hasMore?: boolean;
            nextPollMs?: number;
        };
        return {
            events: Array.isArray(res?.events) ? res.events : [],
            cursor: res?.cursor,
            truncated: res?.truncated,
            hasMore: res?.hasMore,
            nextPollMs: res?.nextPollMs
        };
    }

    async subscribe(
        p: { name: string; arguments: Record<string, unknown>; delivery: { mode: 'webhook'; url: string; secret: string }; cursor: string | null; ttlMs?: number | null; maxAgeMs?: number },
        declarations?: HeaderDeclaration[]
    ): Promise<{ id: string; refreshBefore?: string | null; cursor?: string | null; truncated?: boolean }> {
        const routing = buildRoutingHeaders(p.name, p.arguments, declarations);
        return (await this.#request('events/subscribe', p, routing)) as {
            id: string;
            refreshBefore?: string | null;
            cursor?: string | null;
            truncated?: boolean;
        };
    }

    async unsubscribe(
        p: { name: string; arguments: Record<string, unknown>; delivery: { url: string } },
        declarations?: HeaderDeclaration[]
    ): Promise<void> {
        const routing = buildRoutingHeaders(p.name, p.arguments, declarations);
        await this.#request('events/unsubscribe', p, routing);
    }
}
