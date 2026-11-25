// A connection of the polyfill's own to one MCP server, on MCP SDK 2.4.0.
//
// This file stands in for what a host does not give a plugin today: sending a
// request of an extension's own (`skills/list`, `skills/get`,
// `resources/directory/read`) to a server, and reading what the server
// advertised. Nothing in here knows about skills: it connects, reports the
// capabilities exactly as the server sent them, and sends a request. skills.ts
// is written against the `Wire` interface below and never sees this file, so
// the day a host offers a plugin a request of its own over the host's
// connection, and the server's advertised capabilities, this file goes.
//
// Because the connection is the polyfill's own, it carries only what the
// user's MCP config carries: static headers, what the server's
// `headersHelper` prints (a Claude Code feature), or a local command. It does
// not do OAuth and never reads the host's stored credentials. Which client it
// says it is, and how it words a missing sign-in, are the host adapter's
// (ConnectionOptions).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod';
import { isHttp, type HeadersHelper, type UpstreamConfig } from './upstream.ts';
import { describeError, errorCode, LocalError, secrets } from './untrusted.ts';

type Json = Record<string, unknown>;

/** What skills.ts needs from a server: what it advertised, and a way to send it a request. */
export interface Wire {
    /** The host-assigned label of the server: its name in the host's config, never `serverInfo.name`. */
    readonly label: string;
    /** The protocol revision the connection settled on. */
    readonly revision: string | undefined;
    /** The capabilities exactly as the server sent them, or nothing before it answered. */
    readonly capabilities: Json | undefined;
    request(method: string, params: Json, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Json>;
}

/**
 * The most one answer from a server may weigh. A skill may hold 16 MiB of files and a host must
 * accept that much, a binary file arrives base64-encoded (a third larger), and one file can be
 * the whole skill: 16 MiB * 4/3, plus the JSON around it.
 */
export const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

/**
 * `fetch`, with a bound on what a server can make this process hold in memory. A plain response is
 * cut off past the limit; in an event stream no single message (the bytes between two blank lines)
 * may pass it. Past it the body fails, and the request with it, as any broken connection would.
 */
export function boundedFetch(limit = MAX_RESPONSE_BYTES, inner: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
        const res = await inner(input, init);
        if (!res.body) return res;
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
                    if (most > limit) controller.error(new LocalError('the server sent more in one answer than this mod accepts'));
                    else controller.enqueue(chunk);
                }
            })
        );
        const out = new Response(bounded, { status: res.status, statusText: res.statusText, headers: res.headers });
        Object.defineProperty(out, 'url', { value: res.url });
        return out;
    };
}

const Loose = z.looseObject({});

export type RetryOptions = { tries?: number; baseMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> };

/**
 * `fetch`, patient with a server that is busy. A hosted server may refuse a burst of requests
 * (HTTP 429) or be briefly unavailable (502, 503, 504). Everything this mod sends is a read, so a
 * refused request is sent again: after the wait the server names in `Retry-After`, or 1, 2 and 4
 * seconds, a few times. If it is still refused, the failure is said in this mod's own words (the
 * body of such an answer is often a web page, and is never repeated).
 */
export function patientFetch(inner: typeof fetch = fetch, o: RetryOptions = {}): typeof fetch {
    const tries = o.tries ?? 4;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    return async (input, init) => {
        // Only a request that can be sent again as it was: no body, or a body held as text.
        const repeatable = init?.body === undefined || init.body === null || typeof init.body === 'string';
        for (let attempt = 1; ; attempt++) {
            const res = await inner(input, init);
            if (![429, 502, 503, 504].includes(res.status)) return res;
            await res.body?.cancel().catch(() => {});
            if (!repeatable || attempt >= tries || init?.signal?.aborted) {
                throw new LocalError(res.status === 429 ? `the server is refusing requests for now (too many requests, HTTP 429${attempt > 1 ? `, after ${attempt} tries` : ''})` : `the server is not available for now (HTTP ${res.status}${attempt > 1 ? `, after ${attempt} tries` : ''})`);
            }
            const asked = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : (o.baseMs ?? 1000) * 2 ** (attempt - 1);
            await sleep(Math.min(wait, o.maxWaitMs ?? 15_000));
        }
    };
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
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !(helper.fromRepo && /^(ANTHROPIC_|CLAUDE_|MCP_SKILLS_)/.test(k))));
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

/** What tells one configured server from another under the same name: where it is, not what it is called. */
export function fingerprintOf(cfg: UpstreamConfig): string {
    const id = isHttp(cfg) ? { url: cfg.url } : { command: cfg.command, args: cfg.args ?? [], cwd: cfg.cwd ?? null };
    return createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 24);
}

/** What a host adapter says about itself on a connection. */
export type ConnectionOptions = {
    /** The `clientInfo` sent to the server. */
    client: { name: string; version: string };
    /** Why a server that refused for want of credentials is left alone, in the adapter's own words. */
    signInNote?: string;
};

export class Connection implements Wire {
    readonly label: string;
    readonly cfg: UpstreamConfig;
    /** What this connection was made with, to make another one like it. */
    readonly options: ConnectionOptions;
    client?: Client;
    /** Why there is no connection, in this polyfill's own words. */
    error?: string;
    needsSignIn = false;
    #rawCaps?: Json;
    #closed = false;
    #timeoutMs = 10_000;

    constructor(label: string, cfg: UpstreamConfig, options: ConnectionOptions) {
        this.label = label;
        this.cfg = cfg;
        this.options = options;
    }

    get revision(): string | undefined {
        return this.client?.getNegotiatedProtocolVersion?.();
    }

    get capabilities(): Json | undefined {
        return this.#rawCaps ?? (this.client?.getServerCapabilities() as Json | undefined);
    }

    get connected(): boolean {
        return !!this.client && !this.#closed;
    }

    /**
     * Reads the capabilities straight off the server's own answers (`initialize` or
     * `server/discover`): the SDK keeps only the keys it knows, and an extension's
     * settings are not among them. Each read of `onmessage` returns a wrapper bound to
     * the handler set at that moment, so the SDK can read and chain its handlers.
     */
    #watchCapabilities(transport: Transport): Transport {
        let inner: Transport['onmessage'];
        Object.defineProperty(transport, 'onmessage', {
            configurable: true,
            get: () => {
                const bound = inner;
                if (!bound) return undefined;
                return (msg: Parameters<NonNullable<Transport['onmessage']>>[0], extra?: unknown) => {
                    const caps = (msg as { result?: { capabilities?: unknown } }).result?.capabilities;
                    if (caps && typeof caps === 'object' && !Array.isArray(caps)) this.#rawCaps = caps as Json;
                    bound(msg, extra as never);
                };
            },
            set: (fn: Transport['onmessage']) => {
                inner = fn;
            }
        });
        return transport;
    }

    async connect(timeoutMs: number): Promise<void> {
        this.#timeoutMs = timeoutMs;
        this.error = undefined;
        this.needsSignIn = false;
        const cfg = this.cfg;
        let headers: Record<string, string> = {};
        try {
            if (isHttp(cfg)) {
                // What the helper prints goes over a static header of the same name, as in Claude Code.
                headers = { ...(cfg.headers ?? {}), ...(cfg.headersHelper ? await runHeadersHelper(cfg.headersHelper, this.label, cfg.url) : {}) };
                secrets.add(...Object.values(headers));
            }
            try {
                await this.#open('auto', headers, timeoutMs);
            } catch (e) {
                // A server from before the 2026-07-28 revision may answer the newer opening in a way
                // that settles nothing (a 400 for want of a session, say). It is opened the older way.
                if ((e as { code?: unknown })?.code !== 'ERA_NEGOTIATION_FAILED') throw e;
                await this.#open('legacy', headers, timeoutMs);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.needsSignIn = !(e instanceof LocalError) && /401|unauthori[sz]ed|invalid_token|www-authenticate/i.test(msg);
            // In this mod's own words: a server's error text is not repeated (it reaches a model).
            this.error = e instanceof LocalError ? e.message : this.needsSignIn ? (this.options.signInNote ?? "it needs a sign-in this polyfill cannot do (it has no access to the host's own sign-in)") : describeError(e);
            throw e;
        }
    }

    async #open(mode: 'auto' | 'legacy', headers: Record<string, string>, timeoutMs: number): Promise<void> {
        const client = new Client({ ...this.options.client }, { capabilities: {}, versionNegotiation: { mode } } as never);
        const cfg = this.cfg;
        const transport = isHttp(cfg)
            ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers }, fetch: boundedFetch(MAX_RESPONSE_BYTES, patientFetch()) })
            : new StdioClientTransport({
                  command: cfg.command,
                  args: cfg.args ?? [],
                  // Not this process's whole environment: the small set the MCP SDK passes by
                  // default, plus what the server's own config asks for.
                  env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
                  cwd: cfg.cwd,
                  stderr: 'ignore',
                  maxBufferSize: 2 * MAX_RESPONSE_BYTES
              });
        let timer: NodeJS.Timeout | undefined;
        this.#rawCaps = undefined;
        try {
            await Promise.race([
                client.connect(this.#watchCapabilities(transport)),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new LocalError(`no answer within ${timeoutMs} ms`)), timeoutMs);
                })
            ]);
            this.client = client;
            this.#closed = false;
            client.onclose = () => {
                this.#closed = true;
            };
            // On 2026-07-28 over stdio the SDK learns the capabilities from a probe on a sibling
            // process, whose raw answer never passes here: ask once more on this connection.
            if (!this.#rawCaps && (this.revision ?? '') >= '2026-07-28') await client.discover().catch(() => undefined);
        } catch (e) {
            await client.close().catch(() => {});
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.client?.close().catch(() => {});
    }

    /**
     * Sends one request and returns its result as the server sent it. The SDK adds the request
     * metadata the 2026-07-28 revision requires (`params._meta`: protocol version, client info and
     * capabilities). Nothing is cached here: what may be kept, and for how long, is skills.ts's call.
     */
    async request(method: string, params: Json, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Json> {
        const send = async (): Promise<Json> => {
            if (!this.client || this.#closed) throw new LocalError(`the connection to ${this.label} is closed`);
            return (await this.client.request({ method, params } as never, Loose, { signal: options.signal, timeout: options.timeoutMs ?? 60_000 } as never)) as Json;
        };
        try {
            return await send();
        } catch (e) {
            // Refused for its credentials, on a connection whose headers a headersHelper made: they
            // may have run out. The helper is run again, on a new connection, and the request sent once more.
            const refused = isHttp(this.cfg) && this.cfg.headersHelper && errorCode(e) === undefined && /\b(401|403)\b|unauthori[sz]ed|invalid_token/i.test(e instanceof Error ? e.message : '');
            if (!refused) throw e;
            await this.close();
            await this.connect(this.#timeoutMs);
            return send();
        }
    }
}
