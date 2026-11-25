// The MCP server Codex starts for this plugin, over stdio: newline-delimited JSON-RPC, written by
// hand so that it does exactly this and nothing more (adapted from polyfills/skills/codex/src/mcp.ts):
//
//   initialize, ping, tools/list, tools/call    from Codex
//   elicitation/create                          to Codex: a question Codex puts to the person
//
// It speaks the 2025 revisions' opening (`initialize`), which Codex 0.172 uses. A client on revision
// 2026-07-28 opens with `server/discover` instead. That request's declaration is read, and it is
// answered "method not found", as a 2025-only server answers it (this server's questions are
// server-to-client requests, which 2026-07-28 has no place for), so such a client goes on with
// `initialize`. (Answering with only 2025 revisions in `supportedVersions` stops Codex 0.172 there.) What a client declares, at `initialize`,
// on `server/discover` and in any request's `_meta`, is how the plugin learns whether Codex speaks
// Tasks itself (`onDeclared`).
//
// Everything this server sends Codex (a tool's answer, a question) has the secrets this process
// knows taken out first (`scrub`).

import type { Readable, Writable } from 'node:stream';
import { oneLine } from '../../core/src/untrusted.ts';

type Json = Record<string, unknown>;
const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 4 * 1024 * 1024;
/** How long a question waits for the person. Codex waits as long for the tool (.mcp.json). */
export const ASK_TIMEOUT_MS = 9 * 60 * 1000;

export type ToolSpec = { name: string; title?: string; description: string; inputSchema: Json; annotations?: Json };
/** A tool's answer: text of this plugin's own, then content blocks a server sent (shown as data). */
export type ToolAnswer = { text: string; content?: Json[]; isError?: boolean };
/** What the person did with a form, as Codex reported it, or why nobody could be asked. */
export type FormAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Json } | { unavailable: string };
/** Puts a form to the person through Codex. */
export type AskForm = (message: string, requestedSchema: Json) => Promise<FormAnswer>;
export type CallContext = { ask: AskForm; meta: Json; /** The revision Codex and this server agreed on (how a titled choice is written). */ revision: string };

export type ServeOptions = {
    name: string;
    title: string;
    version: string;
    instructions: () => string;
    tools: () => readonly ToolSpec[];
    call: (name: string, args: Json, ctx: CallContext) => Promise<ToolAnswer>;
    onInitialize?: (clientCapabilities: Json, clientInfo: Json) => void;
    /** The client's capabilities as a request declared them (`initialize`, `server/discover`, a request's `_meta`). */
    onDeclared?: (clientCapabilities: Json, where: string) => void;
    /** Takes known secrets out of text bound for Codex. */
    scrub?: (text: string) => string;
    input: Readable;
    output: Writable;
    log?: (line: string) => void;
    askTimeoutMs?: number;
};

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function serve(o: ServeOptions): { done: Promise<void>; revision: () => string } {
    const log = o.log ?? (() => {});
    let clientCaps: Json = {};
    let revision = REVISIONS[0]!;
    let next = 1;
    const waiting = new Map<string, (m: Json) => void>();
    const scrub = o.scrub ?? ((t: string) => t);
    const deep = (v: unknown, depth = 0): unknown => (typeof v === 'string' ? scrub(v) : depth > 32 || typeof v !== 'object' || v === null ? v : Array.isArray(v) ? v.map((x) => deep(x, depth + 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, depth + 1)])));
    const send = (m: Json) => {
        try {
            o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...(deep(m) as Json) })}\n`);
        } catch {
            // Codex is gone
        }
    };
    const reply = (id: unknown, result: Json) => (typeof id === 'string' || typeof id === 'number') && send({ id, result });
    const fail = (id: unknown, code: number, message: string) => (typeof id === 'string' || typeof id === 'number') && send({ id, error: { code, message } });

    /** One form to the person, through Codex. Only Codex's answer counts; a malformed one is a decline. */
    const ask: AskForm = (message, requestedSchema) => {
        if (!isObject(clientCaps.elicitation)) return Promise.resolve({ unavailable: 'Codex did not offer to put questions to you on this connection' });
        const id = `ask-${next++}`;
        return new Promise<FormAnswer>((done) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                done({ unavailable: 'no answer came in time' });
            }, o.askTimeoutMs ?? ASK_TIMEOUT_MS);
            waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.error !== undefined) return done({ unavailable: 'Codex could not put the question' });
                const r = (isObject(m.result) ? m.result : {}) as { action?: unknown; content?: unknown };
                if (r.action === 'accept') return done({ action: 'accept', content: isObject(r.content) ? r.content : {} });
                done({ action: r.action === 'cancel' ? 'cancel' : 'decline' });
            });
            send({ id, method: 'elicitation/create', params: { ...(revision >= '2025-11-25' ? { mode: 'form' } : {}), message, requestedSchema } });
        });
    };

    const handle = async (m: Json) => {
        const id = m.id;
        const method = m.method;
        if (method === undefined) {
            if (typeof id === 'string' || typeof id === 'number') {
                waiting.get(String(id))?.(m);
                waiting.delete(String(id));
            }
            return;
        }
        const params = isObject(m.params) ? m.params : {};
        const declared = isObject(params._meta) ? params._meta['io.modelcontextprotocol/clientCapabilities'] : undefined;
        if (isObject(declared)) o.onDeclared?.(declared, String(method));
        switch (method) {
            case 'server/discover':
                // Read for what it declares (above), and answered as a 2025-only server answers it, so a
                // 2026-07-28 client goes on with `initialize` (see the top).
                return fail(id, -32601, 'Method not found');
            case 'initialize': {
                clientCaps = isObject(params.capabilities) ? params.capabilities : {};
                o.onDeclared?.(clientCaps, 'initialize');
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                revision = REVISIONS.includes(asked) ? asked : REVISIONS[0]!;
                o.onInitialize?.(clientCaps, isObject(params.clientInfo) ? params.clientInfo : {});
                return reply(id, { protocolVersion: revision, capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, title: o.title, version: o.version }, instructions: o.instructions() });
            }
            case 'ping':
                return reply(id, {});
            case 'tools/list':
                return reply(id, { tools: o.tools() });
            case 'tools/call': {
                const meta = isObject(params._meta) ? params._meta : {};
                let answer: ToolAnswer;
                try {
                    answer = await o.call(String(params.name ?? ''), isObject(params.arguments) ? params.arguments : {}, { ask, meta, revision });
                } catch (e) {
                    log(`tools/call ${oneLine(params.name, 60)} failed: ${e instanceof Error ? e.message : String(e)}`);
                    answer = { text: 'mcp-tasks failed to answer this call; its log says why.', isError: true };
                }
                return reply(id, { content: [{ type: 'text', text: answer.text }, ...(answer.content ?? [])], ...(answer.isError ? { isError: true } : {}) });
            }
            default:
                if (typeof method === 'string' && method.startsWith('notifications/')) return;
                return fail(id, -32601, 'Method not found');
        }
    };

    const done = new Promise<void>((resolve) => {
        let buf = '';
        o.input.setEncoding?.('utf8');
        o.input.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.length > MAX_LINE && !buf.includes('\n')) buf = '';
            let at: number;
            while ((at = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, at).trim();
                buf = buf.slice(at + 1);
                if (!line) continue;
                let m: unknown;
                try {
                    m = JSON.parse(line);
                } catch {
                    send({ id: null, error: { code: -32700, message: 'Parse error' } });
                    continue;
                }
                if (!isObject(m)) continue;
                handle(m).catch((e) => {
                    log(`a request failed (${e instanceof Error ? e.message : String(e)})`);
                    fail(m.id, -32603, 'Internal error');
                });
            }
        });
        o.input.on('end', () => resolve());
        o.input.on('close', () => resolve());
    });
    return { done, revision: () => revision };
}
