// How to reach one MCP server, as a host adapter read it from the host's own
// configuration: a local command, or a URL with the headers to send. Each
// adapter has its own reader (claude-code/src/config.ts reads Claude Code's
// files, codex/src/config.ts reads Codex's config.toml); this is what they
// hand to the connection (wire.ts).

export type StdioUpstream = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
/**
 * A command of the user's that prints a JSON object of headers, run through a shell before each
 * connection (Claude Code's `headersHelper`). `fromRepo`: it came from the project's `.mcp.json`.
 */
export type HeadersHelper = { command: string; cwd: string; fromRepo: boolean };
export type HttpUpstream = { url: string; headers?: Record<string, string>; headersHelper?: HeadersHelper };
export type UpstreamConfig = StdioUpstream | HttpUpstream;
/** The servers to look at, by the host's name for each, and the ones left alone with the reason. */
export type ServerTable = { servers: Record<string, UpstreamConfig>; skipped: Record<string, string> };

export function isHttp(cfg: UpstreamConfig): cfg is HttpUpstream {
    return typeof (cfg as HttpUpstream).url === 'string';
}
