// How to reach one MCP server, as a host adapter read it from the host's own
// configuration: a local command, or a URL with the headers to send. Each
// adapter has its own reader (codex/src/config.ts reads Codex's config.toml,
// pi/src/pi-config.ts Pi's mcp.json, opencode/src/config.ts OpenCode's
// configuration); this is what they hand to the connection (wire.ts).

export type StdioUpstream = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
/**
 * A command of the user's that prints a JSON object of headers, run through a shell before each
 * connection (Claude Code's `headersHelper`; no adapter here reads one from its host's
 * configuration today). `fromRepo`: it came from the project's `.mcp.json`.
 */
export type HeadersHelper = { command: string; cwd: string; fromRepo: boolean };
export type HttpUpstream = { url: string; headers?: Record<string, string>; headersHelper?: HeadersHelper };
export type UpstreamConfig = StdioUpstream | HttpUpstream;
/** The servers to look at, by the host's name for each, and the ones left alone with the reason. */
export type ServerTable = { servers: Record<string, UpstreamConfig>; skipped: Record<string, string> };

export function isHttp(cfg: UpstreamConfig): cfg is HttpUpstream {
    return typeof (cfg as HttpUpstream).url === 'string';
}
