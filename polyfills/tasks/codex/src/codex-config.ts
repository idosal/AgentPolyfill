// Which MCP servers to look for Tasks on: the ones in Codex's own configuration.
// Adapted from polyfills/events/codex/src/codex-config.ts; it also reads Codex's tool rules
// (`enabled_tools`, `disabled_tools`), so a tool Codex wouldn't offer is never started here.
//
// Codex keeps its MCP servers in $CODEX_HOME/config.toml (default ~/.codex), as
// [mcp_servers.<name>] tables. This helper opens its own connection to each, so it
// must not reach further than Codex would:
//
//   - a server with `enabled = false` stays off;
//   - a server that signs in through Codex (`auth = "chatgpt"`, an `oauth` table,
//     `codex mcp login`) is left alone: Codex keeps that sign-in to itself, and this
//     helper never reads Codex's stored credentials;
//   - credentials are taken only where Codex itself takes them from: `http_headers`,
//     `env_http_headers` and `bearer_token_env_var` (from this helper's environment,
//     which is what Codex passes it). A server with an `http_headers_helper` is left out
//     in this form;
//   - where an organisation manages Codex (requirements.toml, managed_config.toml, or a
//     managed-preferences profile), this helper connects to none: it cannot judge that policy;
//   - Codex does not expand ${VAR} in config.toml, and neither does this.
//
// Narrow it with:
//   MCP_TASKS_CONFIG   a file of your own, TOML ([mcp_servers.*]) or JSON ({"mcpServers": {...}}),
//                       used instead of config.toml
//   MCP_TASKS_SERVERS  only these server names (comma-separated)
//   MCP_TASKS_SKIP     never these server names

import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

export type ReadOptions = {
    /** Where managed configuration lives (for tests; the default is the platform's own place). */
    managedFiles?: string[];
};

/** Codex's home: CODEX_HOME, else ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.CODEX_HOME?.trim() || join(env.HOME || homedir(), '.codex');
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
type Json = Record<string, unknown>;
const isTable = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> | undefined => (isTable(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined);

/** This plugin's own MCP server, if someone listed it in config.toml by hand: connecting to it would loop. */
function isSelf(arg: string): boolean {
    // An installed copy (…/mcp-tasks/<version>/dist/helper.js) or a checkout (…/events/codex/plugin/dist/helper.js).
    return /mcp-tasks[^\\/]*(?:[\\/][^\\/]+){0,3}[\\/]dist[\\/]helper\.js$/.test(arg) || /[\\/]tasks[\\/]codex[\\/](?:plugin[\\/]dist[\\/]helper\.js|src[\\/]helper\.ts)$/.test(arg);
}

/**
 * Where Codex reads an organisation's requirements: /etc/codex on Linux and macOS (with the legacy
 * managed_config.toml), managed-preferences profiles on macOS, and %ProgramData%\OpenAI\Codex on
 * Windows. A Windows policy set in the registry or by MDM is not visible here.
 */
export function defaultManagedFiles(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
    if (platform === 'win32') return [win32.join(env.PROGRAMDATA || env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml')];
    const files = ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'];
    if (platform === 'darwin') files.push('/Library/Managed Preferences/com.openai.codex.plist', `/Library/Managed Preferences/${userInfo().username}/com.openai.codex.plist`);
    return files;
}

/**
 * One server's table, as the Tasks client takes it, or why it is left out. `env` is this
 * helper's environment, which is all Codex passes to a plugin's server.
 */
export function parseServer(name: string, v: Json, env: NodeJS.ProcessEnv, home: string): UpstreamConfig | { skip: string } | undefined {
    const r = parseTransport(name, v, env, home);
    if (!r || 'skip' in r) return r;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === 'string') : undefined);
    const enabledTools = list(v.enabled_tools);
    const disabledTools = list(v.disabled_tools);
    return { ...r, ...(enabledTools ? { enabledTools } : {}), ...(disabledTools ? { disabledTools } : {}) };
}

function parseTransport(name: string, v: Json, env: NodeJS.ProcessEnv, home: string): UpstreamConfig | { skip: string } | undefined {
    if (v.enabled === false) return { skip: 'it is switched off in Codex (enabled = false)' };
    if (typeof v.environment_id === 'string' && v.environment_id !== 'local' && v.environment_id !== '') return { skip: 'Codex runs it in another environment, which this helper cannot reach' };
    if (v.auth === 'chatgpt' || v.auth === 'ema_auth' || isTable(v.oauth)) return { skip: 'it signs in through Codex, and this plugin has no access to Codex\'s sign-in' };
    if (typeof v.command === 'string') {
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
        if ([v.command, ...args].some(isSelf)) return undefined;
        const childEnv: Record<string, string> = { ...(strings(v.env) ?? {}) };
        // `env_vars` names variables to pass on from Codex's environment; here, from this helper's.
        const missing: string[] = [];
        for (const e of Array.isArray(v.env_vars) ? v.env_vars : []) {
            const n = typeof e === 'string' ? e : isTable(e) && typeof e.name === 'string' ? e.name : undefined;
            if (!n || !ENV_NAME.test(n)) continue;
            if (isTable(e) && e.source === 'remote') continue;
            if (env[n] !== undefined) childEnv[n] = env[n]!;
            else missing.push(n);
        }
        const cwd = typeof v.cwd === 'string' && v.cwd ? (isAbsolute(v.cwd) ? v.cwd : resolve(home, v.cwd)) : undefined;
        return { command: v.command, args, env: Object.keys(childEnv).length ? childEnv : undefined, cwd };
    }
    if (typeof v.url === 'string') {
        const headers: Record<string, string> = { ...(strings(v.http_headers) ?? {}) };
        const need: string[] = [];
        for (const [header, variable] of Object.entries(strings(v.env_http_headers) ?? {})) {
            if (!ENV_NAME.test(variable)) continue;
            const value = env[variable];
            if (value) headers[header] = value;
            else need.push(variable);
        }
        if (typeof v.bearer_token_env_var === 'string' && ENV_NAME.test(v.bearer_token_env_var)) {
            const token = env[v.bearer_token_env_var];
            if (token) headers.Authorization = `Bearer ${token}`;
            else need.push(v.bearer_token_env_var);
        }
        if (need.length) return { skip: `its credentials come from the environment variable${need.length > 1 ? 's' : ''} ${need.join(', ')}, which Codex does not pass to this plugin's helper (see "Servers that need credentials" in the README)` };
        if (v.http_headers_helper !== undefined) return { skip: 'its headers come from an http_headers_helper, which this form does not run yet' };
        return { url: v.url, headers: Object.keys(headers).length ? headers : undefined };
    }
    return { skip: 'its transport is not supported (only stdio and streamable HTTP are)' };
}

function readFile(path: string): Json | undefined {
    const text = readFileSync(path, 'utf8');
    const j = path.endsWith('.json') ? (JSON.parse(text) as unknown) : (parseToml(text) as unknown);
    return isTable(j) ? j : undefined;
}

export function readCodexServers(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = () => {}, o: ReadOptions = {}): ServerTable {
    const out: ServerTable = { servers: {}, skipped: {} };
    const off = (why: string) => {
        out.skipped['(all servers)'] = why;
        log(why);
        return out;
    };
    for (const file of o.managedFiles ?? defaultManagedFiles()) {
        if (!existsSync(file)) continue;
        if (file.endsWith('.plist')) return off(`your organisation manages Codex (${file}), and this plugin cannot judge that policy, so it connects to none`);
        // A managed file says something about MCP servers, or cannot be read: it might hold a policy.
        let managed: Json | undefined;
        try {
            managed = readFile(file);
        } catch {
            managed = undefined;
        }
        if (!managed || Object.keys(managed).some((k) => /mcp/i.test(k))) return off(`your organisation manages which MCP servers Codex may use (${file}), and this plugin cannot judge that policy, so it connects to none`);
    }
    const home = codexHome(env);
    const path = env.MCP_TASKS_CONFIG ? resolve(env.MCP_TASKS_CONFIG) : join(home, 'config.toml');
    let config: Json | undefined;
    try {
        config = existsSync(path) ? readFile(path) : {};
    } catch (e) {
        return off(`${path} could not be read (${e instanceof Error ? e.message.split('\n')[0] : 'not TOML'}), so this plugin connects to no server`);
    }
    const table = config?.mcp_servers ?? config?.mcpServers ?? config?.servers;
    const base = env.MCP_TASKS_CONFIG ? dirname(path) : home;
    if (isTable(table)) {
        for (const [name, value] of Object.entries(table)) {
            if (!SERVER_NAME.test(name) || !isTable(value)) continue;
            const r = parseServer(name, value, env, base);
            if (!r) continue;
            if ('skip' in r) out.skipped[name] = r.skip;
            else out.servers[name] = r;
        }
    }
    const only = env.MCP_TASKS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean);
    const skip = new Set(env.MCP_TASKS_SKIP?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
    for (const name of Object.keys(out.servers)) {
        if ((only && !only.includes(name)) || skip.has(name)) {
            delete out.servers[name];
            out.skipped[name] = 'excluded by MCP_TASKS_SERVERS / MCP_TASKS_SKIP';
        }
    }
    return out;
}
