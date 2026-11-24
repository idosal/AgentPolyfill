// Client side of the MCP Events extension (SEP-3415), on MCP SDK 2.4.0.
//
// The SDK has no Events support yet (typescript-sdk#3209 is in review), so
// this sends the `events/*` requests itself through `client.request()`:
//   - push notifications are read straight off the transport and routed by
//     `_meta["io.modelcontextprotocol/subscriptionId"]`, the id of the
//     `events/stream` request, which the SDK assigns; a private `_meta` key on
//     the outgoing request (stripped before it is sent) ties the two together;
//   - over Streamable HTTP the routing headers the extension requires
//     (`Mcp-Name`, `Mcp-Param-*`) are added to each request as it goes out;
//   - `events/*` goes only to a server that advertised the extension.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod';
import { isHttp, type HeadersHelper, type UpstreamConfig } from './upstream.ts';
import { routingHeaders, scanHeaders, type HeaderDeclaration } from './routing-headers.ts';
import { describeError, LocalError, secrets, tameSchema } from './untrusted.ts';
import { host } from './host.ts';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const SUB_ID = 'io.modelcontextprotocol/subscriptionId';
const STREAM_KEY = 'dev.mcp-events-plugin/streamKey';
const FOREVER = 2 ** 31 - 1;
/** The first protocol revision the extension is defined for. */
const FIRST_REVISION = '2026-07-28';

export type DeliveryMode = 'poll' | 'push' | 'webhook';
export type EventType = { name: string; description?: string; delivery: DeliveryMode[]; inputSchema?: unknown; payloadSchema?: unknown; /** Arguments mirrored into HTTP headers (`x-mcp-header`). */ headers: HeaderDeclaration[] };
export type Occurrence = { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor?: string | null };
type Json = Record<string, unknown>;

/** Error codes the extension defines (SEP-3415, Error Handling). */
export const EventsError = { NotFound: -32023, Forbidden: -32024, ResourceExhausted: -32025, Unsupported: -32026, CallbackEndpointError: -32027, HeaderMismatch: -32020 } as const;

const Loose = z.looseObject({});
const ListResult = z.looseObject({ events: z.array(z.looseObject({ name: z.string(), delivery: z.array(z.string()) })), nextCursor: z.string().optional() });
const PollResult = z.looseObject({
    events: z.array(z.looseObject({ eventId: z.string(), name: z.string() })),
    cursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    nextPollMs: z.number().optional()
});
const SubscribeResult = z.looseObject({ id: z.string(), refreshBefore: z.string().nullable().optional(), cursor: z.string().nullable().optional(), truncated: z.boolean().optional() });

export type StreamHandlers = {
    active?: (p: { cursor?: string | null; truncated?: boolean; heartbeatMs?: number }) => void;
    event: (o: Occurrence) => void;
    heartbeat?: (p: { cursor?: string | null }) => void;
    error?: (p: Json) => void;
    terminated?: (p: { error?: { code: number; message: string; data?: unknown } }) => void;
};

export function errorCode(e: unknown): number | undefined {
    const c = (e as { code?: unknown })?.code;
    return typeof c === 'number' ? c : undefined;
}

/** Adds the extension's routing headers to a request that names an event (see routing-headers.ts). */
function routed(init: RequestInit | undefined, declarationsOf: (event: string) => HeaderDeclaration[] | undefined): RequestInit | undefined {
    if (typeof init?.body !== 'string') return init;
    let body: unknown;
    try {
        body = JSON.parse(init.body);
    } catch {
        return init;
    }
    const extra = Object.entries(routingHeaders(body, declarationsOf));
    if (!extra.length) return init;
    const headers = new Headers(init.headers);
    for (const [k, v] of extra) headers.set(k, v);
    return { ...init, headers };
}

/** The most one answer from a remote server may weigh: a whole JSON response, or one message of a stream. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * `fetch`, with a bound on what a server can make this process hold in memory. A plain response is
 * cut off past the limit; an event stream may run for as long as it likes, but no single message in
 * it (the bytes between two blank lines) may pass the limit. Past it the body fails, and the request
 * with it, as any broken connection would.
 */
export function boundedFetch(limit = MAX_RESPONSE_BYTES, inner: typeof fetch = fetch, declarationsOf?: (event: string) => HeaderDeclaration[] | undefined): typeof fetch {
    return async (input, init) => {
        const res = await inner(input, declarationsOf ? routed(init, declarationsOf) : init);
        if (!res.body) return res;
        // Only a successful answer whose type is an event stream is read message by message; anything
        // else (an error page, a plain answer) is bounded as a whole.
        const stream = res.ok && (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
        let since = 0;
        let newline = false; // the last byte that was not a carriage return ended a line
        const bounded = res.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    let most = 0;
                    if (stream) {
                        for (let i = 0; i < chunk.length; i++) {
                            const b = chunk[i];
                            if (b === 13) continue;
                            if (b === 10 && newline) since = 0;
                            else if (++since > most) most = since;
                            newline = b === 10;
                        }
                    } else most = since += chunk.byteLength;
                    if (most > limit) controller.error(new LocalError('the server sent more in one answer than this plugin accepts'));
                    else controller.enqueue(chunk);
                }
            })
        );
        const out = new Response(bounded, { status: res.status, statusText: res.statusText, headers: res.headers });
        Object.defineProperty(out, 'url', { value: res.url });
        return out;
    };
}

/**
 * Which servers may be used although they advertise events only in the form that came before the
 * standard (a top-level `events` capability, the sketch's error codes: what ChatGPT reads), as
 * MCP_EVENTS_PRE_STANDARD says: every server when it is unset; none when it is "off"; otherwise
 * only the servers it names.
 */
export function preStandardPolicy(value: string | undefined): (server: string) => boolean {
    const v = (value ?? '').trim();
    if (v === '' || /^(on|1|true|yes|all)$/i.test(v)) return () => true;
    if (/^(off|0|false|no|none)$/i.test(v)) return () => false;
    const named = new Set(v.split(',').map((x) => x.trim()).filter(Boolean));
    return (server) => named.has(server);
}

const HELPER_TIMEOUT_MS = 10000;
const HELPER_MAX_OUTPUT = 64 * 1024;

/**
 * Runs a server's `headersHelper` as Claude Code documents it: through a shell, given up on after
 * 10 seconds, told which server it is for in CLAUDE_CODE_MCP_SERVER_NAME and
 * CLAUDE_CODE_MCP_SERVER_URL, and expected to print a JSON object of text values. A helper that
 * came with the repository is not handed Claude's or this mod's own credentials.
 */
export async function runHeadersHelper(helper: HeadersHelper, name: string, url: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !(helper.fromRepo && /^(ANTHROPIC_|CLAUDE_|MCP_EVENTS_)/.test(k))));
    const out = await new Promise<string>((done, fail) => {
        const child = spawn(helper.command, { shell: true, cwd: helper.cwd, env: { ...childEnv, CLAUDE_CODE_MCP_SERVER_NAME: name, CLAUDE_CODE_MCP_SERVER_URL: url }, stdio: ['ignore', 'pipe', 'ignore'], timeout: HELPER_TIMEOUT_MS, killSignal: 'SIGKILL' });
        let text = '';
        child.stdout.on('data', (d: Buffer) => {
            text += d.toString('utf8');
            if (text.length > HELPER_MAX_OUTPUT) child.kill('SIGKILL');
        });
        child.on('error', () => fail(new LocalError('its headersHelper could not be run')));
        child.on('close', (code, signal) => (code === 0 && text.length <= HELPER_MAX_OUTPUT ? done(text) : fail(new LocalError(signal ? `its headersHelper did not finish within ${HELPER_TIMEOUT_MS / 1000} seconds` : 'its headersHelper failed'))));
    });
    let parsed: unknown;
    try {
        parsed = JSON.parse(out);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) throw new LocalError('its headersHelper did not print a JSON object of text values');
    return parsed as Record<string, string>;
}

export function fingerprintOf(cfg: UpstreamConfig): string {
    const id = isHttp(cfg) ? { url: cfg.url } : { command: cfg.command, args: cfg.args ?? [], cwd: cfg.cwd ?? null };
    return createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 24);
}

export class EventsConnection {
    readonly name: string;
    readonly cfg: UpstreamConfig;
    readonly fingerprint: string;
    client?: Client;
    error?: string;
    needsSignIn = false;
    /** Capabilities exactly as the server sent them. */
    rawCaps?: Json;
    eventTypes: EventType[] = [];
    log: (s: string) => void = () => {};
    /** Called after the list of event types was read again because the server said it changed. */
    onListChanged?: () => void;
    #listening?: { close: () => Promise<void> };
    #relisting = false;
    #relistAgain = false;
    #listeners = new Map<string | number, (method: string, params: Json) => void>();
    #keys = new Map<string, (id: string | number) => void>();
    #closed = false;

    /**
     * Whether this server may be used if it speaks the design sketch that came before SEP-3415 (the
     * form ChatGPT reads): it advertises a top-level `events` capability and uses the sketch's error
     * codes. The SEP says that key "is not part of this extension", so using such a server is outside
     * it. The helper allows it unless MCP_EVENTS_PRE_STANDARD says otherwise (`preStandardPolicy`).
     */
    readonly preStandard: boolean;

    constructor(name: string, cfg: UpstreamConfig, o: { preStandard?: boolean } = {}) {
        this.preStandard = o.preStandard === true;
        this.name = name;
        this.cfg = cfg;
        this.fingerprint = fingerprintOf(cfg);
    }

    get origin(): string {
        return isHttp(this.cfg) ? this.cfg.url : [this.cfg.command, ...(this.cfg.args ?? [])].join(' ');
    }

    /** The protocol revision this connection settled on. */
    get revision(): string | undefined {
        return this.client?.getNegotiatedProtocolVersion?.();
    }

    /**
     * The server's settings for the extension, if it advertised Events as SEP-3415 defines it: under
     * `capabilities.extensions["io.modelcontextprotocol/events"]`, on protocol revision 2026-07-28 or
     * later. A client must not send `events/*` to a server that has not.
     */
    get extension(): { listChanged?: boolean } | undefined {
        const caps = this.rawCaps ?? (this.client?.getServerCapabilities() as Json | undefined);
        const ext = (caps?.extensions as Json | undefined)?.[EVENTS_EXTENSION];
        if (typeof ext !== 'object' || ext === null) return undefined;
        const revision = this.revision;
        return typeof revision === 'string' && revision >= FIRST_REVISION ? (ext as { listChanged?: boolean }) : undefined;
    }

    /** Whether this is a pre-standard server that may be used, advertising the sketch's top-level `events` key. */
    get #sketch(): boolean {
        if (!this.preStandard || this.extension) return false;
        const caps = this.rawCaps ?? (this.client?.getServerCapabilities() as Json | undefined);
        return typeof caps?.events === 'object' && caps.events !== null;
    }

    /**
     * `'extensions'` when the server advertised Events as the SEP defines it; `'pre-standard'` for a
     * server that advertises only the earlier form, where that form is allowed; nothing otherwise.
     */
    get declaration(): 'extensions' | 'pre-standard' | undefined {
        return this.extension ? 'extensions' : this.#sketch ? 'pre-standard' : undefined;
    }

    /**
     * Why a server that looks as if it has events is left alone, if that is so: it advertises them
     * somewhere the SEP does not define. Said to the user; it changes nothing about what is sent.
     */
    get outsideTheSpec(): string | undefined {
        if (this.declaration) return undefined;
        const caps = this.rawCaps ?? (this.client?.getServerCapabilities() as Json | undefined);
        const ext = (caps?.extensions as Json | undefined)?.[EVENTS_EXTENSION];
        if (typeof ext === 'object' && ext !== null) return `it advertises Events on a protocol revision older than ${FIRST_REVISION}, which the Events extension is not defined for`;
        if (caps?.events !== undefined && caps.events !== null) return 'it advertises events only under a top-level "events" capability from before the standard (the form ChatGPT reads), not as the Events extension (SEP-3415) defines, and MCP_EVENTS_PRE_STANDARD has turned that form off for it';
        return undefined;
    }

    /**
     * Whether this connection carries credentials of the user's (a header from their config).
     * `events/subscribe` and `events/unsubscribe` must be called with an authenticated principal,
     * so webhook delivery is used only on such a connection.
     */
    get authenticated(): boolean {
        return isHttp(this.cfg) && (Object.keys(this.cfg.headers ?? {}).length > 0 || !!this.cfg.headersHelper);
    }

    /** Whether the server is a local process spoken to over stdio (not Streamable HTTP). */
    get stdio(): boolean {
        return !isHttp(this.cfg);
    }

    get connected(): boolean {
        return !!this.client && !this.#closed;
    }

    /** Taps outgoing requests (before connect) to learn the ids of `events/stream` requests. */
    #wrap(transport: Transport): Transport {
        const send = transport.send.bind(transport);
        transport.send = (message, options) => {
            const m = message as { id?: string | number; method?: string; params?: { _meta?: Json } };
            const key = m.params?._meta?.[STREAM_KEY];
            if (typeof key === 'string' && m.id !== undefined) {
                this.#keys.get(key)?.(m.id);
                this.#keys.delete(key);
                const { [STREAM_KEY]: _drop, ...rest } = m.params!._meta!;
                message = { ...m, params: { ...m.params, _meta: rest } } as typeof message;
            }
            return send(message, options);
        };
        // Read raw capabilities off responses (the SDK drops keys it doesn't know). Each read
        // of `onmessage` returns a wrapper bound to the handler set at that moment, so the
        // SDK can read and chain its handlers without looping back into a later one.
        let inner: Transport['onmessage'];
        Object.defineProperty(transport, 'onmessage', {
            configurable: true,
            get: () => {
                const bound = inner;
                if (!bound) return undefined;
                return (msg: Parameters<NonNullable<Transport['onmessage']>>[0], extra?: unknown) => {
                    const caps = (msg as { result?: { capabilities?: unknown } }).result?.capabilities;
                    if (caps && typeof caps === 'object') this.rawCaps = caps as Json;
                    bound(msg, extra as never);
                };
            },
            set: (fn: Transport['onmessage']) => {
                inner = fn;
            }
        });
        return transport;
    }

    /**
     * Taps incoming messages, after connect: the SDK installs and chains its own handlers
     * while it negotiates the protocol version, so a tap set earlier breaks it on 2026-07-28.
     */
    #tap(transport: Transport): void {
        const final = transport.onmessage;
        transport.onmessage = (msg, extra) => {
            const m = msg as { method?: string; params?: Json };
            if (m.method === 'notifications/events/list_changed') {
                void this.#relist();
                return;
            }
            if (typeof m.method === 'string' && m.method.startsWith('notifications/events/')) {
                const sid = (m.params?._meta as Json | undefined)?.[SUB_ID] as string | number | undefined;
                if (sid !== undefined) this.#listeners.get(sid)?.(m.method, m.params ?? {});
                return; // handled here; the SDK has no handler for these
            }
            final?.(msg, extra as never);
        };
    }

    async connect(timeoutMs: number): Promise<void> {
        const client = new Client(
            { ...host.client },
            { capabilities: { extensions: { [EVENTS_EXTENSION]: {} } } as never, versionNegotiation: { mode: 'auto' } }
        );
        const cfg = this.cfg;
        let headers: Record<string, string> = {};
        if (isHttp(cfg)) {
            try {
                // Run anew for each connection, as Claude Code does: what it prints goes over the static headers.
                headers = { ...(cfg.headers ?? {}), ...(cfg.headersHelper ? await runHeadersHelper(cfg.headersHelper, this.name, cfg.url) : {}) };
            } catch (e) {
                this.error = describeError(e);
                throw e;
            }
            secrets.add(...Object.values(headers));
        }
        const transport = isHttp(cfg)
            ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers }, fetch: boundedFetch(MAX_RESPONSE_BYTES, fetch, (event) => this.eventTypes.find((t) => t.name === event)?.headers) })
            : new StdioClientTransport({
                  command: cfg.command,
                  args: cfg.args ?? [],
                  // Not this process's whole environment (which holds the plugin's own settings and whatever
                  // else the user exported): the small set the MCP SDK passes by default, plus what the
                  // server's own config asks for.
                  env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
                  cwd: cfg.cwd,
                  stderr: 'ignore'
              });
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                client.connect(this.#wrap(transport)),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new LocalError(`no answer within ${timeoutMs} ms`)), timeoutMs);
                })
            ]);
            this.#tap(transport);
            this.client = client;
            this.#closed = false;
            client.onclose = () => {
                this.#closed = true;
                // The opt-in to change notices went with the connection: it is made again on the next one.
                this.#listening = undefined;
            };
            // On 2026-07-28 over stdio the SDK learns the capabilities from a probe on a sibling
            // process, whose raw response never passes here: ask once more on this connection.
            if (!this.declaration && (client.getNegotiatedProtocolVersion?.() ?? '') >= FIRST_REVISION) {
                await client.discover().catch(() => undefined);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.needsSignIn = !(e instanceof LocalError) && /401|unauthori[sz]ed|invalid_token|www-authenticate/i.test(msg);
            // In this plugin's own words: a server's error text is not repeated (it reaches a model).
            this.error = e instanceof LocalError ? e.message : this.needsSignIn ? host.signIn : describeError(e);
            await client.close().catch(() => {});
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#listening = undefined;
        await this.client?.close().catch(() => {});
    }

    /**
     * Asks to be told when the server's event types change, if it said it sends such notices
     * (`listChanged: true`): opts in with `eventsListChanged` on a `subscriptions/listen` stream.
     */
    async #listenForChanges(): Promise<void> {
        if (this.extension?.listChanged !== true || this.#listening || !this.client) return;
        try {
            this.#listening = await this.client.listen({ eventsListChanged: true } as never, { timeout: 15000 });
        } catch (e) {
            this.log(`${this.name}: could not listen for changes to its event types (${describeError(e)})`);
        }
    }

    /** `notifications/events/list_changed`: read the event types again. */
    async #relist(): Promise<void> {
        // A notice that arrives while the list is being read means the list may be stale again.
        if (this.#relisting) {
            this.#relistAgain = true;
            return;
        }
        this.#relisting = true;
        try {
            do {
                this.#relistAgain = false;
                await this.list();
                this.onListChanged?.();
            } while (this.#relistAgain);
        } catch (e) {
            this.log(`${this.name}: events/list failed after a change notice (${describeError(e)})`);
        } finally {
            this.#relisting = false;
        }
    }

    #req<T extends z.ZodType>(method: string, params: Json, schema: T, options?: { signal?: AbortSignal; timeout?: number }) {
        if (!this.client) throw new Error(`server ${this.name} is not connected`);
        // A client MUST NOT send events/* to a server that has not advertised the extension.
        if (!this.declaration) throw new LocalError('this server does not advertise the Events extension');
        const sent = (this.client.request({ method, params }, schema, options as never) as Promise<z.infer<T>>).catch((e: unknown) => {
            // Refused for its credentials, on a connection whose headers come from a headersHelper: the
            // next use connects again, which runs the helper again (a short-lived token has run out).
            if (isHttp(this.cfg) && this.cfg.headersHelper && errorCode(e) === undefined && /\b(401|403)\b|unauthori[sz]ed|invalid_token/i.test(e instanceof Error ? e.message : '')) void this.close();
            throw e;
        });
        // The sketch numbered its errors -32011 to -32015; the SEP moved the same five to -32023 to -32027.
        return this.declaration === 'pre-standard'
            ? sent.catch((e: unknown) => {
                  const code = errorCode(e);
                  throw code !== undefined && code <= -32011 && code >= -32015 ? Object.assign(new Error('the server answered an error'), { code: code - 12 }) : e;
              })
            : sent;
    }

    /** `events/list`, every page. A client MUST NOT send it unless the server declared Events. */
    async list(): Promise<EventType[]> {
        if (!this.declaration) return [];
        const out: EventType[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const r = await this.#req('events/list', cursor ? { cursor } : {}, ListResult);
            for (const e of r.events) {
                const delivery = (e.delivery as string[]).filter((d): d is DeliveryMode => d === 'poll' || d === 'push' || d === 'webhook');
                // A name is any text of a reasonable length with no control characters in it.
                // eslint-disable-next-line no-control-regex
                if (!delivery.length || typeof e.name !== 'string' || !e.name.length || e.name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(e.name)) continue;
                // Not one that is, or holds, a secret this process knows (a server echoing back its token as a name).
                if (secrets.scrub(e.name) !== e.name) continue;
                // An event type whose header annotations break the transport's rules is left out (SEP-3415).
                const scan = scanHeaders(e.inputSchema);
                if ('invalid' in scan) {
                    this.log(`${this.name}: an event type is left out because an x-mcp-header annotation in its inputSchema is invalid (${scan.invalid})`);
                    continue;
                }
                out.push({ name: e.name, description: typeof e.description === 'string' ? secrets.scrub(e.description).slice(0, 2000) : undefined, delivery: [...new Set(delivery)], inputSchema: secrets.scrubDeep(tameSchema(e.inputSchema)), payloadSchema: secrets.scrubDeep(tameSchema(e.payloadSchema)), headers: scan.declarations });
                if (out.length >= 200) break;
            }
            if (!r.nextCursor) break;
            cursor = r.nextCursor;
        }
        this.eventTypes = out;
        void this.#listenForChanges();
        return out;
    }

    poll(p: { name: string; arguments: Json; cursor: string | null; maxAgeMs?: number; maxEvents?: number }) {
        return this.#req('events/poll', p, PollResult) as Promise<{ events: Occurrence[]; cursor?: string | null; truncated?: boolean; hasMore?: boolean; nextPollMs?: number }>;
    }

    /**
     * Opens one `events/stream` (push). `done` settles when the stream ends: resolves on
     * the server's graceful close, rejects on an error response or a lost connection.
     * `cancel()` ends it (on stdio the SDK sends `notifications/cancelled`).
     */
    stream(p: { name: string; arguments: Json; cursor: string | null; maxAgeMs?: number; heartbeatMs?: number }, on: StreamHandlers) {
        const ac = new AbortController();
        const key = randomUUID();
        let sid: string | number | undefined;
        this.#keys.set(key, (id) => {
            sid = id;
            this.#listeners.set(id, (method, params) => {
                if (method === 'notifications/events/event') on.event(params as unknown as Occurrence);
                else if (method === 'notifications/events/active') on.active?.(params as never);
                else if (method === 'notifications/events/heartbeat') on.heartbeat?.(params as never);
                else if (method === 'notifications/events/error') on.error?.(params);
                else if (method === 'notifications/events/terminated') on.terminated?.(params as never);
            });
        });
        const done = this.#req('events/stream', { ...p, _meta: { [STREAM_KEY]: key } }, Loose, { signal: ac.signal, timeout: FOREVER })
            .then(() => undefined)
            .finally(() => {
                this.#keys.delete(key);
                if (sid !== undefined) this.#listeners.delete(sid);
            });
        return { done, cancel: () => ac.abort() };
    }

    subscribe(p: { name: string; arguments: Json; delivery: { mode: 'webhook'; url: string; secret: string }; cursor: string | null; ttlMs?: number | null; maxAgeMs?: number }) {
        return this.#req('events/subscribe', p, SubscribeResult) as Promise<{ id: string; refreshBefore?: string | null; cursor?: string | null; truncated?: boolean; deliveryStatus?: Json }>;
    }

    unsubscribe(p: { name: string; arguments: Json; delivery: { url: string } }) {
        return this.#req('events/unsubscribe', p, Loose);
    }
}
