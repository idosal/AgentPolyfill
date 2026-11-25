import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerTable } from '../../core/src/upstream.ts';
import { secrets } from '../../core/src/untrusted.ts';
import type { Store } from '../../codex/src/store.ts';

export const NAME = 'mcp-skills';
export const VERSION = '0.1.0';
export const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
export const configPath = (env: NodeJS.ProcessEnv) => join(homeOf(env), '.gemini', 'config', 'mcp_config.json');
export const isOff = (env: NodeJS.ProcessEnv, store: Store) => /^(1|true|yes|on)$/i.test(env.MCP_SKILLS_DISABLED ?? '') || store.settings().off === true;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every(x => typeof x === 'string');
export const SIGN_IN = "it needs Antigravity's own sign-in, which this plugin cannot use; use plain headers in mcp_config.json or leave it to Antigravity";

/** Only the personal JSON config. No plugin/workspace discovery or host token files. */
export function readConfig(env: NodeJS.ProcessEnv, store: Store): ServerTable {
    const table: ServerTable = { servers: Object.create(null), skipped: Object.create(null) };
    const file = configPath(env);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { if (existsSync(file)) table.skipped['(all servers)'] = 'the personal mcp_config.json could not be read as JSON'; return table; }
    if (!object(raw) || (raw.mcpServers !== undefined && !object(raw.mcpServers))) {
        table.skipped['(all servers)'] = 'mcp_config.json must hold an object with an mcpServers object';
        return table;
    }
    const settings = store.settings();
    for (const [name, v] of Object.entries(raw.mcpServers ?? {})) {
        const skip = (why: string) => { table.skipped[name] = why; };
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { skip('its name is not a plain server label (1 to 64 letters, digits, underscores or hyphens)'); continue; }
        if (!object(v)) { skip('its configuration is not an object'); continue; }
        if (v.disabled === true) { skip('disabled in Antigravity'); continue; }
        if ((settings.servers?.length && !settings.servers.includes(name)) || settings.skip?.includes(name)) { skip('left out by settings.json (servers / skip)'); continue; }
        if (name === 'mcp-skills_skills') { skip('this is the plugin itself'); continue; }
        if ('authProviderType' in v || 'oauth' in v) { skip(SIGN_IN); continue; }
        const url = v.serverUrl ?? v.url;
        if (url !== undefined) {
            if (typeof url !== 'string' || !/^https?:\/\//.test(url) || (v.headers !== undefined && !strings(v.headers))) { skip('a URL needs http(s) and plain string headers'); continue; }
            try { const u = new URL(url); if (u.username || u.password) throw new Error(); }
            catch { skip('its URL is invalid or includes credentials; use plain headers'); continue; }
            table.servers[name] = { url, ...(v.headers ? { headers: v.headers as Record<string, string> } : {}) };
        } else if (typeof v.command === 'string' && v.command.trim() &&
            (v.args === undefined || (Array.isArray(v.args) && v.args.every(x => typeof x === 'string'))) &&
            (v.env === undefined || strings(v.env)) && (v.cwd === undefined || typeof v.cwd === 'string')) {
            table.servers[name] = { command: v.command, args: v.args as string[] | undefined, env: v.env as Record<string, string> | undefined, cwd: v.cwd as string | undefined };
        } else skip('needs a command with string args/env/cwd, or a URL');
    }
    // A header or environment value can be a secret (an API key): known to the redactor, it is
    // taken out of the log, the stubs and every listing, also when a server echoes it back.
    for (const cfg of Object.values(table.servers)) {
        secrets.add(...Object.values(('headers' in cfg && cfg.headers) || {}), ...Object.values(('env' in cfg && cfg.env) || {}));
        // A URL's query can carry a key too (security review S2), as the Codex and Pi forms register.
        if ('url' in cfg) try { const u = new URL(cfg.url); secrets.add(u.username, u.password, ...u.searchParams.values()); } catch {}
    }
    return table;
}
