// How an MCP server is reached, as a host's configuration reader hands it to the Tasks client.
// The same shapes as polyfills/events/core/src/upstream.ts, without the headers helper.

export type StdioUpstream = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
export type HttpUpstream = { url: string; headers?: Record<string, string> };
export type UpstreamConfig = (StdioUpstream | HttpUpstream) & {
    /** Codex's own tool rules for this server: only these tools, and never these. */
    enabledTools?: string[];
    disabledTools?: string[];
};
export type ServerTable = { servers: Record<string, UpstreamConfig>; skipped: Record<string, string> };

export function isHttp(cfg: UpstreamConfig): cfg is HttpUpstream & UpstreamConfig {
    return typeof (cfg as HttpUpstream).url === 'string';
}

/** Whether the host would offer this tool of the server at all. */
export function toolAllowed(cfg: UpstreamConfig, tool: string): boolean {
    if (cfg.enabledTools && !cfg.enabledTools.includes(tool)) return false;
    return !cfg.disabledTools?.includes(tool);
}
