// A connection of this polyfill's own to one MCP server, on protocol revision 2026-07-28, that
// declares the Tasks extension on every request it sends.
//
// Why its own: no host lets a plugin declare a client extension on the host's connection, or see a
// raw result there (docs/host-changes.md, change 4). Why not the SDK's `client.request()` for the
// task traffic: MCP SDK 2.4.0 rejects a result whose `resultType` is "task" ("Unsupported result
// type"), and the extension's own TypeScript client (`@modelcontextprotocol/ext-tasks`) expects its
// host to supply a raw request path for the same reason ("used when SDK wire codecs reject V2 task
// traffic"). So the SDK opens the connection and negotiates the revision (`server/discover`), lists
// tools, and owns the transport; `tools/call` and `tasks/*` are framed here, sent on that same
// transport, and their responses are taken off it before the SDK decodes them.
//
// Framing (the 2026-07-28 request envelope): every request's `_meta` carries the protocol revision,
// the client's identity and its capabilities, `extensions["io.modelcontextprotocol/tasks"]` among
// them (C0). Over Streamable HTTP, `tasks/get`, `tasks/update` and `tasks/cancel` carry
// `Mcp-Name: <taskId>` and `Mcp-Method: <method>` (C16).

import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { classify, FIRST_REVISION, readGetResult, TASK_METHODS, TASKS_EXTENSION, type CallOutcome, type InputResponse, type TaskState, type TaskStatus } from './protocol.ts';
import { isHttp, type UpstreamConfig } from './upstream.ts';
import { describeError, LocalError, secrets } from './untrusted.ts';

type Json = Record<string, unknown>;
const ID_PREFIX = 'mcp-tasks-';
const REQUEST_TIMEOUT_MS = 30000;
/** The most one answer from a server may weigh. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON-RPC error from the server, kept apart from failures of this client's own. */
export class ServerError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, data?: unknown) {
        super(`server error ${code}`);
        this.code = code;
        this.data = data;
    }
}

export type ToolInfo = { name: string; description?: string; inputSchema?: unknown; annotations?: Json };

/** The capabilities this client declares: Tasks, and form elicitation (for a task's inputRequests). Never sampling or roots. */
export const CLIENT_CAPABILITIES: Json = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } };

export function fingerprintOf(cfg: UpstreamConfig): string {
    const id = isHttp(cfg) ? { url: cfg.url } : { command: cfg.command, args: cfg.args ?? [], cwd: cfg.cwd ?? null };
    return createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 24);
}

/** `fetch` that sets the Tasks routing headers and bounds what a server can make this process hold. */
export function tasksFetch(inner: typeof fetch = fetch, limit = MAX_RESPONSE_BYTES): typeof fetch {
    return async (input, init) => {
        let next = init;
        if (typeof init?.body === 'string') {
            try {
                const body = JSON.parse(init.body) as { method?: unknown; params?: { taskId?: unknown } };
                if (typeof body.method === 'string' && TASK_METHODS.has(body.method) && typeof body.params?.taskId === 'string') {
                    const headers = new Headers(init.headers);
                    headers.set('Mcp-Method', body.method);
                    headers.set('Mcp-Name', body.params.taskId);
                    next = { ...init, headers };
                }
            } catch {
                // not JSON: sent as it is
            }
        }
        const res = await inner(input, next);
        if (!res.body) return res;
        let seen = 0;
        const stream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
        const bounded = res.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    seen += chunk.byteLength;
                    // A stream may run long; one plain answer may not pass the limit. A stream is bounded per answer below.
                    if (!stream && seen > limit) controller.error(new LocalError('the server sent more in one answer than this plugin accepts'));
                    else controller.enqueue(chunk);
                }
            })
        );
        const out = new Response(bounded, { status: res.status, statusText: res.statusText, headers: res.headers });
        Object.defineProperty(out, 'url', { value: res.url });
        return out;
    };
}

export class TasksConnection {
    readonly name: string;
    readonly cfg: UpstreamConfig;
    readonly fingerprint: string;
    client?: Client;
    error?: string;
    needsSignIn = false;
    log: (s: string) => void = () => {};
    #transport?: Transport;
    #clientInfo: Json;
    #next = 1;
    #waiting = new Map<string, (m: Json) => void>();
    #closed = false;

    constructor(name: string, cfg: UpstreamConfig, clientInfo: { name: string; version: string }) {
        this.name = name;
        this.cfg = cfg;
        this.fingerprint = fingerprintOf(cfg);
        this.#clientInfo = clientInfo;
    }

    get revision(): string | undefined {
        return this.client?.getNegotiatedProtocolVersion?.();
    }

    /**
     * Whether the server offers Tasks as SEP-2663 defines it: the extension in its capabilities, on
     * revision 2026-07-28 or later. On an earlier revision the extension is not defined, and a
     * client that declares it there gets nothing (SEP-2663, Backward Compatibility).
     */
    /** Capabilities as the server sent them (the SDK drops keys it doesn't know, such as the 2025-11-25 `tasks`). */
    rawCaps?: Json;

    get #caps(): Json | undefined {
        return this.rawCaps ?? (this.client?.getServerCapabilities() as Json | undefined);
    }

    get offersTasks(): boolean {
        const ext = this.#caps?.extensions;
        const revision = this.revision ?? '';
        return isObject(ext) && isObject(ext[TASKS_EXTENSION]) && revision >= FIRST_REVISION;
    }

    /** Whether the server advertises only the form from the 2025-11-25 core specification (a top-level `tasks` capability). */
    get offersOnlyTheEarlierForm(): boolean {
        return !this.offersTasks && isObject(this.#caps?.tasks);
    }

    get connected(): boolean {
        return !!this.client && !this.#closed;
    }

    async connect(timeoutMs: number): Promise<void> {
        const client = new Client({ ...this.#clientInfo } as never, { capabilities: CLIENT_CAPABILITIES as never, versionNegotiation: { mode: 'auto' } });
        const cfg = this.cfg;
        if (isHttp(cfg)) secrets.add(...Object.values(cfg.headers ?? {}));
        const transport: Transport = isHttp(cfg)
            ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} }, fetch: tasksFetch() })
            : new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) }, cwd: cfg.cwd, stderr: 'ignore' });
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                client.connect(transport),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new LocalError(`no answer within ${timeoutMs} ms`)), timeoutMs);
                })
            ]);
            this.#tap(transport);
            this.#transport = transport;
            this.client = client;
            this.#closed = false;
            client.onclose = () => {
                this.#closed = true;
                for (const done of this.#waiting.values()) done({ error: { code: -32000, message: 'closed' }, local: 'the connection to the server closed' });
                this.#waiting.clear();
            };
            // Over stdio the SDK may have learnt the capabilities from a probe of its own: ask once more here.
            // The capabilities as sent are read off the answer here (the first answer passed before the tap).
            if ((this.revision ?? '') >= FIRST_REVISION) await client.discover().catch(() => undefined);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.needsSignIn = !(e instanceof LocalError) && /401|unauthori[sz]ed|invalid_token|www-authenticate/i.test(msg);
            this.error = e instanceof LocalError ? e.message : this.needsSignIn ? 'it needs a sign-in this plugin cannot use' : describeError(e);
            await client.close().catch(() => {});
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** Takes the responses to this client's own framed requests off the transport, before the SDK sees them. */
    #tap(transport: Transport): void {
        const inner = transport.onmessage;
        transport.onmessage = (msg, extra) => {
            const m = msg as { id?: unknown; method?: unknown; result?: { capabilities?: unknown } };
            if (isObject(m.result?.capabilities)) this.rawCaps = m.result.capabilities;
            if (m.method === undefined && typeof m.id === 'string' && m.id.startsWith(ID_PREFIX)) {
                const done = this.#waiting.get(m.id);
                this.#waiting.delete(m.id);
                done?.(msg as unknown as Json);
                return;
            }
            inner?.(msg, extra as never);
        };
    }

    /** One request, framed with the 2026-07-28 envelope and the extension declared, sent on the connection's transport. */
    async request(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
        const transport = this.#transport;
        if (!transport || !this.connected) throw new LocalError('not connected to the server');
        const id = `${ID_PREFIX}${this.#next++}`;
        const meta = {
            ...(isObject(params._meta) ? params._meta : {}),
            'io.modelcontextprotocol/protocolVersion': this.revision ?? FIRST_REVISION,
            'io.modelcontextprotocol/clientInfo': this.#clientInfo,
            'io.modelcontextprotocol/clientCapabilities': CLIENT_CAPABILITIES
        };
        const answer = await new Promise<Json>((done, fail) => {
            const timer = setTimeout(() => {
                this.#waiting.delete(id);
                fail(new LocalError(`the server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            this.#waiting.set(id, (m) => {
                clearTimeout(timer);
                done(m);
            });
            transport.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } } as never).catch((e: unknown) => {
                clearTimeout(timer);
                this.#waiting.delete(id);
                fail(e);
            });
        });
        if (typeof answer.local === 'string') throw new LocalError(answer.local);
        if (isObject(answer.error)) throw new ServerError(typeof answer.error.code === 'number' ? answer.error.code : -32603, answer.error.data);
        if (!isObject(answer.result)) throw new LocalError(`the answer to ${method} carried no result`);
        return answer.result;
    }

    /** The server's tools (with the extension declared, through the SDK, which frames these itself). */
    async listTools(): Promise<ToolInfo[]> {
        if (!this.client) throw new LocalError('not connected to the server');
        const out: ToolInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const r = await this.client.listTools(cursor ? { cursor } : undefined);
            for (const t of r.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations as Json | undefined });
            cursor = r.nextCursor;
            if (!cursor) break;
        }
        return out;
    }

    /** `tools/call` with the extension declared: a plain result or a task (C1). */
    async callTool(name: string, args: Json, timeoutMs = 5 * 60 * 1000): Promise<CallOutcome> {
        return classify('tools/call', await this.request('tools/call', { name, arguments: args }, timeoutMs));
    }

    async getTask(taskId: string, previous?: TaskStatus): Promise<TaskState | { invalid: string }> {
        return readGetResult(taskId, await this.request('tasks/get', { taskId }), previous);
    }

    /** `tasks/update` with the answers to some of the outstanding requests (C9). An empty acknowledgement is all that comes back. */
    async updateTask(taskId: string, inputResponses: Record<string, InputResponse>): Promise<void> {
        await this.request('tasks/update', { taskId, inputResponses });
    }

    /** `tasks/cancel` (C14: never `notifications/cancelled`). */
    async cancelTask(taskId: string): Promise<void> {
        await this.request('tasks/cancel', { taskId });
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.client?.close().catch(() => {});
    }
}
