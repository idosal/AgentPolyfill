// A small MCP server that implements the server side of the Skills extension
// (SEP-2640) by hand, over stdio, so the mod is tested against something that
// shares no code with it (no SDK, no line of src/).
//
// It serves exactly what a scenario file says, read again on every request, so a
// test can change the server between two requests: rotate a file, add one, drop
// the declaration. It checks nothing: a scenario may hold entries no conforming
// server would send (a wrong digest, a file outside the skill), which is the point.
//
// Env:
//   FIXTURE_SCENARIO   the scenario file (required), JSON:
//     caps           "skills" (default) | "none" | "no-resources" | "not-object" | "toplevel"
//     directoryRead  true to declare it
//     revision       "new" (default: answers server/discover with 2026-07-28) | "legacy" (initialize only, 2025-11-25)
//     serverName     what the server calls itself (serverInfo.name)
//     listed         entries skills/list returns, as given
//     unlisted       entries only skills/get returns
//     files          { uri: { text } | { blob (base64) } , mimeType? }
//     dirs           { directory uri: Resource[] }  (resources/directory/read)
//     pageSize       entries per skills/list page (default: all)
//     ttlMs          the freshness hint (default 0); null leaves ttlMs and cacheScope out
//   FIXTURE_LOG        append one line per message received (optional)

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
const SCENARIO = process.env.FIXTURE_SCENARIO;
if (!SCENARIO) throw new Error('FIXTURE_SCENARIO is required');
const LOG = process.env.FIXTURE_LOG;
const EXT = 'io.modelcontextprotocol/skills';

const scenario = (): Json => JSON.parse(readFileSync(SCENARIO, 'utf8')) as Json;
const send = (m: Json) => process.stdout.write(JSON.stringify(m) + '\n');
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { rpc: { code, message } });

function capabilities(s: Json): Json {
    const ext = s.directoryRead === true ? { directoryRead: true } : {};
    switch (s.caps ?? 'skills') {
        case 'none':
            return { resources: {} };
        case 'no-resources':
            return { extensions: { [EXT]: ext } };
        case 'not-object':
            return { resources: {}, extensions: { [EXT]: true } };
        case 'toplevel':
            return { resources: {}, skills: ext };
        default:
            return { resources: {}, extensions: { [EXT]: ext } };
    }
}

const cache = (s: Json): Json => (s.ttlMs === null ? {} : { ttlMs: typeof s.ttlMs === 'number' ? s.ttlMs : 0, cacheScope: 'private' });
const entries = (s: Json, key: 'listed' | 'unlisted'): Json[] => (Array.isArray(s[key]) ? (s[key] as Json[]) : []);

function handle(m: Json): void {
    const id = m.id as string | number | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    try {
        const s = scenario();
        const name = typeof s.serverName === 'string' ? s.serverName : 'fixture-skills';
        switch (m.method) {
            case 'server/discover':
                if (s.revision === 'legacy') throw rpcError(-32601, 'Method not found');
                return void reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: capabilities(s), _meta: { 'io.modelcontextprotocol/serverInfo': { name, version: '1.0.0' } }, ttlMs: 0, cacheScope: 'private' });
            case 'initialize':
                return void reply({ protocolVersion: '2025-11-25', capabilities: capabilities(s), serverInfo: { name, version: '1.0.0' } });
            case 'notifications/initialized':
            case 'notifications/cancelled':
                return;
            case 'ping':
                return void reply({});
            case 'resources/list':
                return void reply({ resultType: 'complete', resources: [], ...cache(s) });
            case 'skills/list': {
                const all = entries(s, 'listed');
                const size = typeof s.pageSize === 'number' ? s.pageSize : all.length || 1;
                const from = typeof p.cursor === 'string' ? Number(p.cursor) : 0;
                const page = all.slice(from, from + size);
                return void reply({ resultType: 'complete', skills: page, ...(from + size < all.length ? { nextCursor: String(from + size) } : {}), ...cache(s) });
            }
            case 'skills/get': {
                const found = [...entries(s, 'listed'), ...entries(s, 'unlisted')].find((e) => e.uri === p.uri);
                if (!found) throw rpcError(-32602, `No skill is served at ${String(p.uri)}`);
                // "getAnswers": what skills/get returns for a uri, when it should differ from the listing.
                const override = (s.getAnswers as Json | undefined)?.[String(p.uri)] as Json | undefined;
                return void reply({ resultType: 'complete', skill: override ?? found, ...cache(s) });
            }
            case 'resources/read': {
                const file = (s.files as Json | undefined)?.[String(p.uri)] as Json | undefined;
                if (!file) throw rpcError(-32602, `Resource not found: ${String(p.uri)}`);
                const { mimeType, ...content } = file;
                return void reply({ resultType: 'complete', contents: [{ uri: p.uri, mimeType: mimeType ?? 'text/markdown', ...content }], ...cache(s) });
            }
            case 'resources/directory/read': {
                const dir = (s.dirs as Json | undefined)?.[String(p.uri)];
                if (!Array.isArray(dir)) throw rpcError(-32602, `${String(p.uri)} is not a directory resource`);
                return void reply({ resultType: 'complete', resources: dir, ...cache(s) });
            }
            default:
                if (id !== undefined) throw rpcError(-32601, `Method not found: ${String(m.method)}`);
        }
    } catch (e) {
        const rpc = (e as { rpc?: Json }).rpc ?? { code: -32603, message: String(e) };
        if (id !== undefined) send({ jsonrpc: '2.0', id, error: rpc });
    }
}

createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let m: Json;
    try {
        m = JSON.parse(line) as Json;
    } catch {
        return;
    }
    if (LOG) appendFileSync(LOG, JSON.stringify(m) + '\n');
    handle(m);
});
process.stdin.on('end', () => process.exit(0));
