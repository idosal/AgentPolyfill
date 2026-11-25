import { resolve, dirname } from 'node:path';
import { configPath, readConfig } from '../../../server-cards/antigravity/src/antigravity.ts';
import type { ServerTable } from '../../core/src/upstream.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every(x => typeof x === 'string');

/** Only Antigravity's personal MCP server declarations, never its OAuth store. */
export function readServers(env: NodeJS.ProcessEnv = process.env): ServerTable {
    const file = env.MCP_EVENTS_CONFIG ? resolve(env.MCP_EVENTS_CONFIG) : configPath(env);
    const out: ServerTable = { servers: Object.create(null), skipped: Object.create(null) };
    const read = readConfig(file);
    if ('error' in read) {
        // A parser error can quote a credential; don't repeat it.
        out.skipped['(all servers)'] = 'mcp_config.json could not be read as a JSON object; no servers were connected';
        return out;
    }
    const only = env.MCP_EVENTS_SERVERS?.split(',').map(s => s.trim());
    const skip = new Set(env.MCP_EVENTS_SKIP?.split(',').map(s => s.trim()));
    for (const [name, v] of Object.entries(read.config.mcpServers)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/.test(name)) continue;
        const omit = (why: string) => { out.skipped[name] = why; };
        if (!object(v)) { omit('its configuration is not an object'); continue; }
        if (/^mcp[-_]events(?:$|[_-])/.test(name)) { omit('this is the Events plugin itself'); continue; }
        if (v.disabled === true) { omit('it is switched off in Antigravity (disabled: true)'); continue; }
        if ('authProviderType' in v || 'oauth' in v) { omit("it signs in through Antigravity; the plugin cannot use Antigravity's sign-in"); continue; }
        if ((only && !only.includes(name)) || skip.has(name)) { omit('excluded by MCP_EVENTS_SERVERS / MCP_EVENTS_SKIP'); continue; }
        if (typeof v.command === 'string' && v.command.trim()) {
            if ((v.args !== undefined && (!Array.isArray(v.args) || !v.args.every(a => typeof a === 'string'))) ||
                (v.env !== undefined && !strings(v.env)) || (v.cwd !== undefined && typeof v.cwd !== 'string')) {
                omit('its args, env or cwd are not in the documented form'); continue;
            }
            const args = (v.args ?? []) as string[];
            if ([v.command, ...args].some(a => /(?:mcp-events|events[/\\]antigravity).*[/\\](?:server\.mjs|main\.ts)$/.test(a) || a === '${PLUGIN_ROOT}/dist/server.mjs' || a === process.argv[1])) {
                omit('this is the Events plugin itself'); continue;
            }
            out.servers[name] = { command: v.command, args, ...(v.env ? { env: v.env as Record<string, string> } : {}), ...(v.cwd ? { cwd: resolve(dirname(file), v.cwd as string) } : {}) };
        } else if (typeof (v.serverUrl ?? v.url) === 'string') {
            const url = (v.serverUrl ?? v.url) as string;
            try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); }
            catch { omit('its URL is not an HTTP or HTTPS address'); continue; }
            if (v.headers !== undefined && !strings(v.headers)) { omit('its headers are not plain text values'); continue; }
            out.servers[name] = { url, ...(v.headers ? { headers: v.headers as Record<string, string> } : {}) };
        } else omit('its transport is not supported (only stdio and Streamable HTTP are)');
    }
    return out;
}
