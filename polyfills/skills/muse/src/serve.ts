// The Muse form's MCP server loop: the Codex form's (../../codex/src/mcp.ts serve), with what
// differs in Muse. Muse's MCP client offers no elicitation, so a question goes to the person as a
// phrase they type (muse-confirm.ts museAsk), and what the plugin says names Muse, not Codex
// (muse.ts museWords). The tools, their schemas and the instructions are the Codex form's.

import type { Readable, Writable } from 'node:stream';
import { describeError } from '../../core/src/untrusted.ts';
import type { App, Ask } from '../../codex/src/app.ts';
import { INSTRUCTIONS, MAX_LINE, REVISIONS, TOOLS } from '../../codex/src/mcp.ts';
import { PLUGIN } from '../../codex/src/version.ts';
import { VERSION } from './version.ts';

type Json = Record<string, unknown>;

export type MuseServeOptions = {
    app: App;
    input: Readable;
    output: Writable;
    /** How the person is asked: a phrase they type (muse-confirm.ts museAsk, which puts the question in Muse's words). */
    ask: Ask;
    /** Muse's words in place of Codex's, for what the server says (muse.ts museWords). */
    words: (text: string) => string;
    log?: (line: string) => void;
    /** Called with what the client declared at initialize. */
    onInitialize?: (clientCapabilities: Json, clientInfo: Json) => void;
};

export function serveMuse(o: MuseServeOptions): { done: Promise<void> } {
    const log = o.log ?? (() => {});
    const words = o.words;
    let revision = REVISIONS[0]!;
    const cancelled = new Set<string | number>();
    const send = (m: Json) => {
        try {
            o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
        } catch {
            // Muse is gone
        }
    };
    const reply = (id: unknown, result: Json) => {
        if (typeof id === 'string' || typeof id === 'number') {
            if (cancelled.delete(id)) return;
            send({ id, result });
        }
    };
    const fail = (id: unknown, code: number, message: string) => (typeof id === 'string' || typeof id === 'number') && send({ id, error: { code, message } });
    const tools = TOOLS.map((t) => ({ ...t, description: words(t.description), inputSchema: JSON.parse(words(JSON.stringify(t.inputSchema))) as Json }));

    const handle = async (m: Json) => {
        const id = m.id;
        const method = m.method;
        if (method === undefined) return; // no requests of ours to answer: Muse gets none
        const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Json;
        switch (method) {
            case 'initialize': {
                const caps = (typeof params.capabilities === 'object' && params.capabilities !== null ? params.capabilities : {}) as Json;
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                revision = REVISIONS.includes(asked) ? asked : REVISIONS[0]!;
                o.onInitialize?.(caps, (params.clientInfo ?? {}) as Json);
                return reply(id, { protocolVersion: revision, capabilities: { tools: { listChanged: false } }, serverInfo: { name: PLUGIN, title: 'MCP Skills (polyfill)', version: VERSION }, instructions: words(INSTRUCTIONS) });
            }
            case 'ping':
                return reply(id, {});
            case 'tools/list':
                return reply(id, { tools });
            case 'tools/call': {
                // Muse sends no thread: the session is the process's (MUSE_SESSION_ID), as the ask knows.
                const answer = await o.app.call(String(params.name ?? ''), params.arguments, { ask: o.ask });
                return reply(id, { content: [{ type: 'text', text: words(answer.text) }], ...(answer.isError ? { isError: true } : {}) });
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
                log('a message from Muse was too long, and was dropped');
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
