// How an MCP server is reached, as every host's configuration reader hands it to the Events client.

export type StdioUpstream = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
/**
 * A command of the user's that prints a JSON object of headers, run through a shell before each
 * connection (Claude Code's `headersHelper`, Codex's `http_headers_helper`). `fromRepo`: it came
 * from a file in the project's repository.
 */
export type HeadersHelper = { command: string; cwd: string; fromRepo: boolean };
export type HttpUpstream = { url: string; headers?: Record<string, string>; headersHelper?: HeadersHelper };
export type UpstreamConfig = StdioUpstream | HttpUpstream;
export type ServerTable = { servers: Record<string, UpstreamConfig>; skipped: Record<string, string> };

export function isHttp(cfg: UpstreamConfig): cfg is HttpUpstream {
    return typeof (cfg as HttpUpstream).url === 'string';
}
