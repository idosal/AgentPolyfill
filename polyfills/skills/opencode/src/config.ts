// Which MCP servers OpenCode has, as the Skills client needs them.
//
// OpenCode gives a plugin its MCP configuration through `ctx.mcp.transform`,
// whose editor lists every server after OpenCode merged its configuration files
// (and after any other plugin's transforms). This plugin registers one transform
// that only reads: it never sets, updates or removes a server. `ctx.mcp.list()`
// says how OpenCode's own connection to each one stands.

import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';
import type { Context, McpServerConfig, McpServerInfo } from './opencode.ts';

/** A value OpenCode would fill in from a variable or a file when it loads its configuration, left unfilled. */
const UNRESOLVED = /\{(env|file):[^}]*\}/;

const statusOf = (s: McpServerInfo['status']) => (typeof s === 'string' ? s : s?.status);

/** One server's OpenCode configuration as the Skills client takes it, or why it is left alone. */
export function upstreamOf(cfg: McpServerConfig, status?: string): UpstreamConfig | { skip: string } {
    if (cfg.disabled) return { skip: 'turned off in OpenCode (disabled)' };
    if (status === 'disabled') return { skip: 'turned off in OpenCode' };
    if (cfg.type === 'local') {
        const [command, ...args] = cfg.command;
        if (!command) return { skip: 'it has no command' };
        const env = cfg.environment ?? {};
        if ([command, ...args, ...Object.values(env)].some((v) => UNRESOLVED.test(v))) return { skip: 'its configuration holds a value OpenCode fills in that this plugin was not given' };
        return { command, args, ...(Object.keys(env).length ? { env: { ...env } } : {}), ...(cfg.cwd ? { cwd: cfg.cwd } : {}) };
    }
    if (cfg.type === 'remote') {
        const headers = cfg.headers ?? {};
        if ([cfg.url, ...Object.values(headers)].some((v) => UNRESOLVED.test(v))) return { skip: 'its configuration holds a value OpenCode fills in that this plugin was not given' };
        return { url: cfg.url, ...(Object.keys(headers).length ? { headers: { ...headers } } : {}) };
    }
    return { skip: 'a kind of server this plugin does not know' };
}

/** Reads OpenCode's MCP configuration. Each call reads it as it is now. */
export class OpenCodeServers {
    #configs: (readonly [string, McpServerConfig])[] = [];
    #ctx: Context;
    #registered?: Promise<unknown>;

    constructor(ctx: Context) {
        this.#ctx = ctx;
    }

    /**
     * Waits until OpenCode has applied its MCP configuration to this location. While a location's
     * plugins are being set up, the editor lists no servers yet; OpenCode then connects them and
     * says so (`mcp.status.changed`). Resolves at once when servers are listed, and after
     * `timeoutMs` in any case (a location with no MCP servers at all).
     */
    async applied(timeoutMs = 30000): Promise<void> {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const events = this.#ctx.event.subscribe({ types: ['mcp.status.changed', 'config.updated'], signal: ac.signal });
            if (Object.keys((await this.table()).servers).length) return;
            for await (const _ of events) if (Object.keys((await this.table()).servers).length) return;
        } catch {
            // aborted (the time is up), or no event stream: go on with what is there
        } finally {
            clearTimeout(timer);
            ac.abort();
        }
    }

    async table(): Promise<ServerTable> {
        // A transform that only looks: OpenCode replays it whenever it rebuilds its MCP configuration.
        this.#registered ??= this.#ctx.mcp.transform((editor) => {
            this.#configs = editor.list().map(([name, cfg]) => [name, structuredClone(cfg) as McpServerConfig] as const);
        });
        await this.#registered;
        let statuses: McpServerInfo[] = [];
        try {
            // Reading the list also makes OpenCode apply the transforms registered so far.
            statuses = (await this.#ctx.mcp.list()).data;
        } catch {
            // the statuses only refine the table
        }
        const table: ServerTable = { servers: {}, skipped: {} };
        for (const [name, cfg] of this.#configs) {
            const status = statusOf(statuses.find((s) => s.name === name)?.status ?? '');
            const u = upstreamOf(cfg, status);
            if ('skip' in u) table.skipped[name] = u.skip;
            else table.servers[name] = u;
        }
        return table;
    }
}
