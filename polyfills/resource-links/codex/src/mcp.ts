// The MCP server Codex starts for this plugin, over stdio: newline-delimited
// JSON-RPC, written by hand so that it does exactly this and nothing more:
//
//   initialize, ping, tools/list, tools/call    from Codex
//   elicitation/create                          to Codex: the question before a
//                                               cross-server read, which Codex puts to the person

import type { Readable, Writable } from 'node:stream';
import { describeError } from '../../core/src/untrusted.ts';
import type { App, Asked } from './app.ts';
import { PLUGIN, VERSION } from './version.ts';

type Json = Record<string, unknown>;
const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 4 * 1024 * 1024;
/** How long a question waits for the person. Codex is told to wait as long for the tool (.mcp.json). */
const ASK_TIMEOUT_MS = 9 * 60 * 1000;

export const INSTRUCTIONS =
    'Reads resource links (resource_link content blocks) that other MCP tools returned in this session, which Codex shows you but does not read for you in a form you can see when they are images. When a tool result holds a resource_link you need, call read_resource_link with the server whose tool returned it and the link\'s uri. Text comes back as text and images as image content (in code mode, pass each image block to image()). Prefer it to read_mcp_resource for links.';

export const TOOL = {
    name: 'read_resource_link',
    title: 'Read a resource link',
    description:
        'Reads the resource behind a resource_link that a tool of an MCP server returned in this session, from that server, through Codex. Text comes back as text; PNG, JPEG, GIF and WebP images come back as image content blocks (in code mode, pass them to image() to see them); other types are described, not shown. Only links a tool actually returned in this session can be read. Reading a link from a different server than the one that returned it asks the user first. Links the server marked for the user only (audience ["user"]) are not given to you.',
    inputSchema: {
        type: 'object',
        properties: {
            server: { type: 'string', description: "The MCP server whose tool returned the link, by its name in Codex's config (the <server> in mcp__<server>__<tool>)." },
            uri: { type: 'string', description: "The link's uri, exactly as the tool returned it. It need not be one list_mcp_resources lists." },
        },
        required: ['server', 'uri'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

export type ServeOptions = {
    app: App;
    input: Readable;
    output: Writable;
    /** No tool is listed and none runs (MCP_RESOURCE_LINKS_DISABLED). */
    disabled?: boolean;
    log?: (line: string) => void;
    askTimeoutMs?: number;
};

export function serve(o: ServeOptions): { done: Promise<void> } {
    const log = o.log ?? (() => {});
    let clientCaps: Json = {};
    let revision = REVISIONS[0]!;
    let next = 1;
    const waiting = new Map<string, (m: Json) => void>();
    const cancelled = new Set<string | number>();
    const send = (m: Json) => {
        try {
            o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
        } catch {
            // Codex is gone
        }
    };
    const reply = (id: unknown, result: Json) => {
        if (typeof id === 'string' || typeof id === 'number') {
            if (cancelled.delete(id)) return;
            send({ id, result });
        }
    };
    const fail = (id: unknown, code: number, message: string) => (typeof id === 'string' || typeof id === 'number') && send({ id, error: { code, message } });

    /** One yes-or-no question to the person, through Codex. Only "yes", chosen by the person, counts as yes. */
    const ask = (message: string): Promise<Asked> => {
        if (typeof clientCaps.elicitation !== 'object' || clientCaps.elicitation === null) return Promise.resolve({ unavailable: 'Codex did not offer to put questions to the user on this connection' });
        const id = `ask-${next++}`;
        return new Promise<Asked>((done) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                done({ unavailable: 'no answer came in time' });
            }, o.askTimeoutMs ?? ASK_TIMEOUT_MS);
            waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.error !== undefined) return done({ unavailable: 'Codex could not put the question' });
                const r = (m.result ?? {}) as { action?: unknown; content?: { decision?: unknown } };
                done({ yes: r.action === 'accept' && r.content?.decision === 'read' });
            });
            // A choice the person has to make: a form with a required field, so Codex never answers it
            // in the person's place. "Don't read it" comes first.
            const titled = revision >= '2025-11-25';
            const choices = [
                ['no', "Don't read it"],
                ['read', 'Read it'],
            ] as const;
            const decision = titled
                ? { type: 'string', title: 'Your answer', oneOf: choices.map(([c, t]) => ({ const: c, title: t })) }
                : { type: 'string', title: 'Your answer', enum: choices.map(([c]) => c), enumNames: choices.map(([, t]) => t) };
            send({ id, method: 'elicitation/create', params: { ...(titled ? { mode: 'form' } : {}), message, requestedSchema: { type: 'object', properties: { decision }, required: ['decision'] } } });
        });
    };

    const handle = async (m: Json) => {
        const id = m.id;
        const method = m.method;
        if (method === undefined) {
            if (typeof id === 'string' || typeof id === 'number') waiting.get(String(id))?.(m);
            waiting.delete(String(id));
            return;
        }
        const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Json;
        switch (method) {
            case 'initialize': {
                clientCaps = (typeof params.capabilities === 'object' && params.capabilities !== null ? params.capabilities : {}) as Json;
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                revision = REVISIONS.includes(asked) ? asked : REVISIONS[0]!;
                return reply(id, {
                    protocolVersion: revision,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: PLUGIN, title: 'MCP resource links (polyfill)', version: VERSION },
                    ...(o.disabled ? {} : { instructions: INSTRUCTIONS }),
                });
            }
            case 'ping':
                return reply(id, {});
            case 'tools/list':
                return reply(id, { tools: o.disabled ? [] : [TOOL] });
            case 'tools/call': {
                if (o.disabled || params.name !== TOOL.name) return reply(id, { content: [{ type: 'text', text: `Unknown tool: ${String(params.name).slice(0, 80)}` }], isError: true });
                const meta = (params._meta ?? {}) as Json;
                const turn = (meta['x-codex-turn-metadata'] ?? {}) as Json;
                const str = (x: unknown) => (typeof x === 'string' && x.length <= 200 ? x : undefined);
                const answer = await o.app.readResourceLink(params.arguments, { thread: str(meta.threadId) ?? str(turn.thread_id), session: str(turn.session_id) ?? str(meta.sessionId) }, ask);
                return reply(id, { content: answer.content, ...(answer.isError ? { isError: true } : {}) });
            }
            case 'notifications/cancelled':
                if (typeof params.requestId === 'string' || typeof params.requestId === 'number') cancelled.add(params.requestId);
                return;
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
            if (buf.length > MAX_LINE && !buf.includes('\n')) {
                log('a message from Codex was too long, and was dropped');
                buf = '';
            }
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
                if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
                handle(m as Json).catch((e) => {
                    log(`a request failed (${describeError(e)})`);
                    fail((m as Json).id, -32603, 'Internal error');
                });
            }
        });
        o.input.on('end', () => resolve());
        o.input.on('close', () => resolve());
    });
    return { done };
}
