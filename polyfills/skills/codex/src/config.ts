// Which MCP servers to look for skills on: the ones in the user's Codex config,
// `$CODEX_HOME/config.toml`, under `[mcp_servers.<name>]`.
//
// The helper opens a connection of its own to each, so it reaches no further
// than that file says:
//
//   - a server with `enabled = false` is left alone;
//   - a server Codex starts in another environment (`environment_id`) is left alone;
//   - a local server is started with its `command`, `args`, `cwd` and `env`; the
//     variables its `env_vars` names are passed only if this process has them;
//   - a remote server gets its `http_headers`, and the headers its `env_http_headers`
//     and `bearer_token_env_var` name, again only if this process has those variables.
//     Codex starts a plugin's MCP server with a small fixed environment (HOME, PATH,
//     USER, and a few more), so such a server is usually left out, and the user told why;
//   - where a managed Codex policy exists that says anything about MCP servers, the
//     helper connects to none, because it cannot apply that policy.
//
// Not read: a project's `.codex/config.toml`, profiles, `/etc/codex/config.toml`, and
// servers that come with plugins. Nothing here reads Codex's stored sign-ins.
//
// `[[skills.config]]` (Codex's own per-skill enable and disable, by path or name) is
// read too: a served skill turned off there is not offered, loaded or read.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

/** One `[[skills.config]]` entry: a skill selected by its SKILL.md path or its name, turned on or off. */
export type SkillRule = { path?: string; name?: string; enabled: boolean };
export type CodexConfig = { table: ServerTable; skillRules: SkillRule[]; file: string };
export type ConfigOptions = {
    /** Managed policy files to look for (for tests; the default is the platform's own places). */
    managedFiles?: string[];
};

/** A server's name is repeated in tool results and in skill names: it has to look like a name. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> => (isObject(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});

/**
 * Where Codex keeps its config. An installed plugin lives at
 * `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>`, so that path says where
 * CODEX_HOME is even though Codex does not pass the variable to a plugin's server.
 */
export function codexHomeOf(env: NodeJS.ProcessEnv, pluginRoot?: string): string {
    if (env.MCP_SKILLS_CODEX_HOME) return resolve(env.MCP_SKILLS_CODEX_HOME);
    if (env.CODEX_HOME) return resolve(env.CODEX_HOME);
    if (pluginRoot) {
        const parts = resolve(pluginRoot).split(sep);
        const at = parts.lastIndexOf('cache');
        if (at >= 2 && parts[at - 1] === 'plugins' && parts.length - at === 4) return parts.slice(0, at - 1).join(sep) || sep;
    }
    return join(env.HOME ?? homedir(), '.codex');
}

function defaultManagedFiles(env: NodeJS.ProcessEnv): string[] {
    if (process.platform === 'win32') return [join(env.ProgramData ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml')];
    const files = ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'];
    if (process.platform === 'darwin') files.push('/Library/Managed Preferences/com.openai.codex.plist', `/Library/Managed Preferences/${userInfo().username}/com.openai.codex.plist`);
    return files;
}

function mentionsMcp(v: unknown, depth = 0): boolean {
    if (!isObject(v) || depth > 6) return false;
    return Object.entries(v).some(([k, x]) => /mcp/i.test(k) || mentionsMcp(x, depth + 1));
}

/**
 * A managed Codex policy that says anything about MCP servers, if there is one. A file that cannot
 * be read as TOML is taken to hold one (it might), and so is a macOS managed-preferences file for
 * Codex (its contents are not read: its presence is enough).
 */
export function managedPolicy(files: string[]): string | undefined {
    for (const f of files) {
        if (!existsSync(f)) continue;
        if (f.endsWith('.plist')) return f;
        try {
            if (mentionsMcp(parseToml(readFileSync(f, 'utf8')))) return f;
        } catch {
            return f;
        }
    }
    return undefined;
}

/** This plugin's own server, if a config lists it: connecting to it would loop. */
const isSelf = (arg: string): boolean => /(?:mcp-skills|skills[\\/]codex)(?:[\\/][^\\/]+)*[\\/](?:src[\\/]helper\.ts|dist[\\/]helper\.js)$/.test(arg);

/** Reads `[mcp_servers.*]` into the servers to connect to, and the ones left alone with the reason. */
export function parseServers(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv): ServerTable {
    const out: ServerTable = { servers: {}, skipped: {} };
    if (!isObject(raw)) return out;
    for (const [name, v] of Object.entries(raw)) {
        if (!SERVER_NAME.test(name) || !isObject(v)) continue;
        const leave = (why: string) => {
            out.skipped[name] = why;
        };
        if (v.enabled === false) {
            leave('it is turned off in your Codex config (enabled = false)');
            continue;
        }
        if (typeof v.environment_id === 'string' && v.environment_id !== 'local') {
            leave('Codex runs it in another environment, which this plugin cannot reach');
            continue;
        }
        const missing = new Set<string>();
        const fromEnv = (variable: unknown): string | undefined => {
            if (typeof variable !== 'string' || !variable) return undefined;
            const value = env[variable];
            if (value === undefined || value === '') missing.add(variable);
            return value;
        };
        let cfg: UpstreamConfig;
        if (typeof v.command === 'string' && v.command) {
            const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
            if ([v.command, ...args].some(isSelf)) continue;
            const childEnv = strings(v.env);
            for (const item of Array.isArray(v.env_vars) ? v.env_vars : []) {
                const variable = typeof item === 'string' ? item : isObject(item) && item.source !== 'remote' ? item.name : undefined;
                const value = fromEnv(variable);
                if (typeof variable === 'string' && value !== undefined) childEnv[variable] = value;
            }
            cfg = { command: v.command, args, env: childEnv, cwd: typeof v.cwd === 'string' ? (isAbsolute(v.cwd) ? v.cwd : resolve(baseDir, v.cwd)) : undefined };
        } else if (typeof v.url === 'string' && v.url) {
            const headers = strings(v.http_headers);
            for (const [header, variable] of Object.entries(strings(v.env_http_headers))) {
                const value = fromEnv(variable);
                if (value !== undefined) headers[header] = value;
            }
            const token = fromEnv(v.bearer_token_env_var);
            if (token !== undefined) headers.Authorization = `Bearer ${token}`;
            cfg = { url: v.url, headers };
        } else {
            leave('its transport is not one this plugin connects to (only a command or a streamable HTTP url)');
            continue;
        }
        if (missing.size) {
            leave(`it needs the environment variable${missing.size > 1 ? 's' : ''} ${[...missing].join(', ')}, which Codex does not pass to a plugin's MCP server (put the header in http_headers, or the value in env, to use it here)`);
            continue;
        }
        out.servers[name] = cfg;
    }
    return out;
}

function skillRulesOf(raw: unknown, baseDir: string): SkillRule[] {
    const list = isObject(raw) && Array.isArray(raw.config) ? raw.config : [];
    return list.filter(isObject).flatMap((r) => (typeof r.enabled === 'boolean' && (typeof r.path === 'string' || typeof r.name === 'string') ? [{ enabled: r.enabled, ...(typeof r.path === 'string' ? { path: resolve(baseDir, r.path) } : {}), ...(typeof r.name === 'string' ? { name: r.name } : {}) }] : []));
}

/**
 * The user's Codex config, as far as this plugin uses it. `only` and `skip` narrow the servers
 * (the plugin's own settings, see store.ts).
 */
export function readCodexConfig(codexHome: string, env: NodeJS.ProcessEnv = process.env, o: ConfigOptions & { only?: string[]; skip?: string[] } = {}): CodexConfig {
    const file = join(codexHome, 'config.toml');
    const policy = managedPolicy(o.managedFiles ?? defaultManagedFiles(env));
    if (policy) return { table: { servers: {}, skipped: { '(all servers)': `a managed Codex policy (${policy}) may say which MCP servers are allowed, and this plugin cannot apply it, so it connects to none` } }, skillRules: [], file };
    let doc: Json = {};
    try {
        const parsed = parseToml(readFileSync(file, 'utf8')) as unknown;
        if (isObject(parsed)) doc = parsed;
    } catch (e) {
        if (existsSync(file)) return { table: { servers: {}, skipped: { '(all servers)': `${file} could not be read as TOML` } }, skillRules: [], file };
        void e;
    }
    const table = parseServers(doc.mcp_servers, dirname(file), env);
    for (const name of Object.keys(table.servers)) {
        if ((o.only?.length && !o.only.includes(name)) || o.skip?.includes(name)) {
            delete table.servers[name];
            table.skipped[name] = 'left out by this plugin\'s settings (servers / skip)';
        }
    }
    return { table, skillRules: skillRulesOf(doc.skills, dirname(file)), file };
}

/** Just the `[[skills.config]]` rules, read again: Codex writes them when the user turns a skill on or off. */
export function readSkillRules(file: string): SkillRule[] {
    try {
        const parsed = parseToml(readFileSync(file, 'utf8')) as unknown;
        return isObject(parsed) ? skillRulesOf(parsed.skills, dirname(file)) : [];
    } catch {
        return [];
    }
}
