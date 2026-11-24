// Which MCP servers to look for events on: the ones Copilot itself uses in this session.
//
// Copilot gives an extension the names of the session's servers and whether each is on
// (`session.rpc.mcp.listConfigured()`, after folder trust, `disabledMcpServers` and your
// organisation's policy), but not how to reach them. This extension opens its own connection
// to each, so it reads that from the files Copilot reads, and never reaches further:
//
//   - only a server the session lists as enabled is used; when Copilot cannot say (an older
//     CLI), `disabledMcpServers` in settings.json is honoured and workspace files are read only
//     for a folder in `trustedFolders`;
//   - files, later winning as in Copilot: $COPILOT_HOME/mcp-config.json (default ~/.copilot),
//     then `.mcp.json` / `.github/mcp.json` from the repository root down to the working folder
//     (a nearer file wins; a folder's `.github/mcp.json` is ignored when it has a `.mcp.json`);
//   - `${VAR}` in a server's command, args, env, cwd, url and headers is expanded from this
//     extension's environment, as Copilot expands it (seen live in 1.0.115). Copilot strips
//     sensitive variables (GITHUB_TOKEN, say) from an extension, so a server that needs one is
//     left out with the reason;
//   - a server that signs in through Copilot (OAuth, `/mcp auth`) is left alone: Copilot keeps
//     that sign-in to itself, and this extension never reads Copilot's stored credentials;
//   - servers a plugin brings, servers given for one run (`--additional-mcp-config`) and the
//     built-in GitHub server are not read: they are listed as unavailable, with the reason.
//
// Narrow it with:
//   MCP_EVENTS_CONFIG   a file of your own ({"mcpServers": {...}}), used instead of Copilot's files
//   MCP_EVENTS_SERVERS  only these server names (comma-separated)
//   MCP_EVENTS_SKIP     never these server names

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

type Json = Record<string, unknown>;
const isTable = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;

/** Copilot's home: COPILOT_HOME, else ~/.copilot. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.COPILOT_HOME?.trim() || join(env.HOME || homedir(), '.copilot');
}

/** What Copilot says about one configured server (`session.rpc.mcp.listConfigured()`). */
export type Configured = { name: string; enabled: boolean; source?: string; sourcePlugin?: string };

/** Strict JSON, as Copilot reads it; the `//` comment lines Copilot writes at the top of config.json are dropped first. */
function readJson(path: string): Json | undefined {
    const text = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
    const j = JSON.parse(text) as unknown;
    return isTable(j) ? j : undefined;
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expands `${VAR}` from `env`. Unset variables are left as written and named in `missing`. */
export function expand(s: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
    return s.replace(VAR, (whole, name: string) => {
        const v = env[name];
        if (v === undefined) {
            missing.add(name);
            return whole;
        }
        return v;
    });
}

const stringMap = (v: unknown): Record<string, string> | undefined => (isTable(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined);

/** One server's entry, as the Events client takes it, or why it is left out. Relative `cwd` is the file's folder. */
export function parseServer(v: Json, env: NodeJS.ProcessEnv, base: string): UpstreamConfig | { skip: string } {
    const missing = new Set<string>();
    const x = (s: string) => expand(s, env, missing);
    const leave = () => ({ skip: `it needs the environment variable${missing.size > 1 ? 's' : ''} ${[...missing].join(', ')}, which this extension does not have (Copilot strips sensitive variables from extensions)` });
    const type = typeof v.type === 'string' ? v.type : undefined;
    if (isTable(v.oauth) || v.auth === 'oauth') return { skip: "it signs in through Copilot, and this extension has no access to Copilot's sign-in" };
    if (typeof v.command === 'string' && (type === undefined || type === 'local' || type === 'stdio')) {
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').map(x) : [];
        const env2 = Object.fromEntries(Object.entries(stringMap(v.env) ?? {}).map(([k, val]) => [k, x(val)]));
        const cwd = typeof v.cwd === 'string' && v.cwd ? x(v.cwd) : undefined;
        const command = x(v.command);
        if (missing.size) return leave();
        return { command, args, env: Object.keys(env2).length ? env2 : undefined, cwd: cwd ? (isAbsolute(cwd) ? cwd : resolve(base, cwd)) : undefined };
    }
    if (typeof v.url === 'string') {
        if (type === 'sse') return { skip: 'it is an SSE server, and the Events client speaks Streamable HTTP and stdio only' };
        if (type !== undefined && type !== 'http') return { skip: `its transport (${type}) is not supported (only stdio and Streamable HTTP are)` };
        const url = x(v.url);
        const headers = Object.fromEntries(Object.entries(stringMap(v.headers) ?? {}).map(([k, val]) => [k, x(val)]));
        if (missing.size) return leave();
        return { url, headers: Object.keys(headers).length ? headers : undefined };
    }
    return { skip: 'its transport is not supported (only stdio and Streamable HTTP are)' };
}

/** The repository root above `cwd` (the nearest folder with `.git`), or `cwd` itself outside git. */
function repoRoot(cwd: string): string {
    for (let d = resolve(cwd); ; d = dirname(d)) {
        if (existsSync(join(d, '.git'))) return d;
        if (d === parse(d).root) return resolve(cwd);
    }
}

/** The workspace files Copilot reads for `cwd`, farthest first, so that a nearer one wins. */
export function workspaceFiles(cwd: string): string[] {
    const root = repoRoot(cwd);
    const dirs: string[] = [];
    for (let d = resolve(cwd); ; d = dirname(d)) {
        dirs.unshift(d);
        if (d === root || d === parse(d).root) break;
    }
    const out: string[] = [];
    for (const d of dirs) {
        if (existsSync(join(d, '.mcp.json'))) out.push(join(d, '.mcp.json'));
        else if (existsSync(join(d, '.github', 'mcp.json'))) out.push(join(d, '.github', 'mcp.json'));
    }
    return out;
}

export type ReadOptions = {
    /** The session's working folder. */
    cwd?: string;
    /** What Copilot says it uses in this session; undefined when it could not say. */
    configured?: Configured[];
};

const settingsList = (home: string, key: string): string[] => {
    for (const f of ['settings.json', 'config.json']) {
        try {
            const j = readJson(join(home, f));
            const v = j?.[key];
            if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
        } catch {
            // not there, or not JSON
        }
    }
    return [];
};

/** The servers this extension may connect to, and the ones left out with their reasons. */
export function readCopilotServers(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = () => {}, o: ReadOptions = {}): ServerTable {
    const out: ServerTable = { servers: {}, skipped: {} };
    const home = copilotHome(env);
    const cwd = o.cwd ?? process.cwd();
    // name -> [entry, the folder it is relative to]
    const found = new Map<string, [Json, string]>();
    const take = (path: string) => {
        let j: Json | undefined;
        try {
            j = existsSync(path) ? readJson(path) : undefined;
        } catch (e) {
            log(`${path} could not be read (${e instanceof Error ? e.message.split('\n')[0] : 'not JSON'}); its servers are left out`);
            return;
        }
        const table = j?.mcpServers;
        if (!isTable(table)) return;
        for (const [name, value] of Object.entries(table)) if (SERVER_NAME.test(name) && isTable(value)) found.set(name, [value, dirname(path)]);
    };
    if (env.MCP_EVENTS_CONFIG) take(resolve(env.MCP_EVENTS_CONFIG));
    else {
        take(join(home, 'mcp-config.json'));
        // Workspace files count only where Copilot reads them: when it lists their servers, or, if it
        // cannot say, in a folder you trusted.
        const trusted = o.configured !== undefined || settingsList(home, 'trustedFolders').some((t) => resolve(cwd).startsWith(resolve(t)));
        if (trusted) for (const f of workspaceFiles(cwd)) take(f);
    }

    const add = (name: string, entry: Json, base: string) => {
        const r = parseServer(entry, env, base);
        if ('skip' in r) out.skipped[name] = r.skip;
        else out.servers[name] = r;
    };
    if (o.configured && !env.MCP_EVENTS_CONFIG) {
        for (const c of o.configured) {
            if (!SERVER_NAME.test(c.name)) continue;
            if (!c.enabled) continue;
            if (c.source === 'builtin') continue;
            if (c.source === 'plugin') {
                out.skipped[c.name] = `it comes from the plugin ${c.sourcePlugin ?? '(unnamed)'}, whose configuration this extension does not read`;
                continue;
            }
            const f = found.get(c.name);
            if (!f) {
                out.skipped[c.name] = c.source === 'managed' ? 'your organisation provides it, and this extension cannot read its configuration' : 'Copilot uses it, but it is not in mcp-config.json or a workspace file (given for one run with --additional-mcp-config?), so this extension cannot see how to reach it';
                continue;
            }
            add(c.name, f[0], f[1]);
        }
    } else {
        const disabled = new Set(settingsList(home, 'disabledMcpServers'));
        for (const [name, [entry, base]] of found) {
            if (disabled.has(name)) out.skipped[name] = 'it is switched off in Copilot (disabledMcpServers)';
            else add(name, entry, base);
        }
    }

    const only = env.MCP_EVENTS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean);
    const skip = new Set(env.MCP_EVENTS_SKIP?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
    for (const name of Object.keys(out.servers)) {
        if ((only && !only.includes(name)) || skip.has(name)) {
            delete out.servers[name];
            out.skipped[name] = 'excluded by MCP_EVENTS_SERVERS / MCP_EVENTS_SKIP';
        }
    }
    return out;
}
