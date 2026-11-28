import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve, PROTOCOL_VERSIONS, type Tool, type ToolResult } from '../../polyfills/server-cards/codex/src/mcp';

export type Settings = { sources: Record<string, string>; askBeforeReading?: boolean; tools?: Record<string, string[]> };
export function settings(defaults: Settings): Settings {
    const configAt = process.argv.indexOf('--config');
    const path = configAt !== -1 ? process.argv[configAt + 1] : process.env.MUSE_PLUGIN_DATA_DIR && resolve(process.env.MUSE_PLUGIN_DATA_DIR, 'sources.json');
    if (configAt !== -1 && !path) throw Error('--config needs a configuration file');
    const cfg = path && (configAt !== -1 || existsSync(path)) ? JSON.parse(readFileSync(path, 'utf8')) : defaults;
    if (!cfg || !cfg.sources || Array.isArray(cfg.sources) || typeof cfg.sources !== 'object') throw Error('Configure a sources object');
    if (cfg.tools !== undefined && (!cfg.tools || typeof cfg.tools !== 'object' || Array.isArray(cfg.tools))) throw Error('Configure tools as an object keyed by source');
    if (cfg.askBeforeReading !== undefined && typeof cfg.askBeforeReading !== 'boolean') throw Error('askBeforeReading must be a boolean');
    for (const [label, value] of Object.entries(cfg.sources)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || typeof value !== 'string') throw Error('Invalid source');
        const u = new URL(value);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) {
            throw Error('Use an HTTPS endpoint or a loopback HTTP fixture, without credentials, query or fragment');
        }
    }
    return cfg;
}

export function schema(fields: Record<string, object>, required = Object.keys(fields)) {
    return { type: 'object', properties: fields, required, additionalProperties: false };
}
export const stringField = { type: 'string', minLength: 1 };
export function sourceUrl(cfg: Settings, label: unknown): string {
    if (typeof label !== 'string' || !Object.hasOwn(cfg.sources, label)) throw Error('Choose a configured source');
    return cfg.sources[label]!;
}
export const text = (value: unknown): ToolResult => ({ text: typeof value === 'string' ? value : JSON.stringify(value) });

function send(res: ServerResponse, status: number, data?: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(data === undefined ? undefined : JSON.stringify(data));
}
async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) throw Error('Request too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Single-operator, stateless Streamable HTTP for the Bot's remote connector. Put HTTPS in front. */
export function launch(name: string, instructions: string, tools: Tool[]) {
    if (!process.argv.includes('--http')) {
        serve({ name, version: '0.1.1', instructions, tools });
        return;
    }
    const secret = process.env.AGENTPOLYFILL_TOKEN;
    if (!secret || Buffer.byteLength(secret) < 32) throw Error('Set AGENTPOLYFILL_TOKEN to a random secret of at least 32 bytes');
    const digest = (str: string) => createHash('sha256').update(str).digest();
    const wanted = digest('Bearer ' + secret);
    const port = Number(process.env.PORT ?? 8787);
    let activeTools = 0;
    const server = createServer(async (req, res) => {
        if (req.url !== '/mcp') return send(res, 404);
        if (req.headers.origin) return send(res, 403);
        if (!timingSafeEqual(wanted, digest(req.headers.authorization ?? ''))) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            return send(res, 401);
        }
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return send(res, 405);
        }
        const revision = req.headers['mcp-protocol-version'];
        if (revision !== undefined && (typeof revision !== 'string' || !PROTOCOL_VERSIONS.includes(revision))) return send(res, 400);
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415);
        let q;
        try { q = await body(req); } catch { return send(res, 400); }
        if (q?.jsonrpc !== '2.0' || typeof q.method !== 'string') return send(res, 400);
        if (q.id == null) return send(res, 202);
        const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: q.id, result });
        const error = (code: number, message: string) => send(res, 200, { jsonrpc: '2.0', id: q.id, error: { code, message } });
        if (q.method === 'initialize') return reply({
            protocolVersion: PROTOCOL_VERSIONS.includes(q.params?.protocolVersion) ? q.params.protocolVersion : PROTOCOL_VERSIONS[0],
            serverInfo: { name, version: '0.1.1' }, capabilities: { tools: {} }, instructions
        });
        if (q.method === 'ping') return reply({});
        if (q.method === 'tools/list') return reply({ tools: tools.map(({ run, ...def }) => def) });
        if (q.method !== 'tools/call') return error(-32601, 'Unsupported method');
        const tool = tools.find(t => t.name === q.params?.name);
        if (!tool) return error(-32602, 'Unknown tool');
        if (activeTools >= 16) {
            res.setHeader('Retry-After', '1');
            return send(res, 429);
        }
        const args = q.params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Supply an arguments object');
        activeTools++;
        try {
            const result = await tool.run(args, { canElicit: false, protocol: revision ?? PROTOCOL_VERSIONS[0]!, meta: {}, elicit: async () => ({ action: 'cancel' }) });
            reply({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
        } catch {
            reply({ isError: true, content: [{ type: 'text', text: 'The request did not return a confirmed result. If you started a job, check the publisher before retrying.' }] });
        } finally {
            activeTools--;
        }
    });
    server.requestTimeout = 30000;
    server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') process.stderr.write('Listening on 127.0.0.1:' + address.port + '\n');
    });
}
