// The helper as an MCP server, over stdio: newline-delimited JSON-RPC, as Codex starts
// a plugin's server. It serves tools and nothing else, so the whole of it is here: the
// handshake, tools/list, tools/call and ping. Codex puts the calling session's id in
// every tools/call's `_meta` (`threadId`), which is how a watch knows whose it is.

import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
export type ToolSpec = { name: string; description: string; inputSchema: Json; annotations?: Json };
export type CallResult = { text: string; isError?: boolean };
export type ServerOptions = {
    name: string;
    title: string;
    version: string;
    instructions: string;
    tools: () => readonly ToolSpec[];
    call: (name: string, args: Json, meta: Json) => Promise<CallResult>;
    /** The client went away (end of standard input). */
    onClose: () => void;
    log?: (s: string) => void;
};

/** Revisions this server speaks, newest first. Codex asks for 2025-06-18. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 4 * 1024 * 1024;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function serve(o: ServerOptions, input: Readable = process.stdin, output: Writable = process.stdout): { close: () => void } {
    let closed = false;
    const send = (m: Json) => {
        if (closed) return;
        try {
            output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
        } catch {
            close();
        }
    };
    const reply = (id: unknown, result: Json) => send({ id, result });
    const error = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });
    const close = () => {
        if (closed) return;
        closed = true;
        o.onClose();
    };
    output.on('error', close);

    const handle = async (m: Json) => {
        const method = typeof m.method === 'string' ? m.method : undefined;
        const hasId = 'id' in m && (typeof m.id === 'string' || typeof m.id === 'number');
        if (!method) return; // a response, or nothing: this server sends no requests
        if (!hasId) return; // notifications (initialized, cancelled): nothing to do
        const params = isObject(m.params) ? m.params : {};
        switch (method) {
            case 'initialize': {
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                const version = PROTOCOL_VERSIONS.includes(asked) ? asked : '2025-06-18';
                return reply(m.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, title: o.title, version: o.version }, instructions: o.instructions });
            }
            case 'ping':
                return reply(m.id, {});
            case 'tools/list':
                return reply(m.id, { tools: o.tools().map((t) => ({ ...t })) });
            case 'tools/call': {
                const name = typeof params.name === 'string' ? params.name : '';
                const args = isObject(params.arguments) ? params.arguments : {};
                const meta = isObject(params._meta) ? params._meta : {};
                let r: CallResult;
                try {
                    r = await o.call(name, args, meta);
                } catch (e) {
                    o.log?.(`tools/call ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
                    r = { text: 'mcp-events failed to answer this call; its log says why.', isError: true };
                }
                return reply(m.id, { content: [{ type: 'text', text: r.text }], isError: r.isError === true });
            }
            default:
                return error(m.id, -32601, 'Method not found');
        }
    };

    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
        if (!line.trim()) return;
        if (line.length > MAX_LINE) return error(null, -32600, 'Request too large');
        let m: unknown;
        try {
            m = JSON.parse(line);
        } catch {
            return error(null, -32700, 'Parse error');
        }
        if (!isObject(m)) return error(null, -32600, 'Invalid request');
        void handle(m);
    });
    lines.on('close', close);
    return { close };
}
