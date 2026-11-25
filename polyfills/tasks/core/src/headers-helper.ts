// A server's `http_headers_helper`, run as Codex 0.172 runs it (codex-rs/rmcp-client/src/http_headers.rs):
// through a shell, with an environment cleared down to the small default set an MCP server gets,
// before each connection. It prints a JSON object of headers. Its headers replace configured ones of
// the same name, except an `Authorization` written in the config; a reserved header is refused.
// Given up on after 10 seconds.

import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { LocalError } from './untrusted.ts';

const TIMEOUT_MS = 10000;
const MAX_OUTPUT = 64 * 1024;
const RESERVED = new Set(['accept', 'connection', 'content-encoding', 'content-length', 'content-type', 'host', 'keep-alive', 'last-event-id', 'mcp-protocol-version', 'mcp-session-id', 'origin', 'proxy-connection', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type HeadersHelper = { command: string; cwd: string };

export async function runHeadersHelper(helper: HeadersHelper, env: Record<string, string> = getDefaultEnvironment()): Promise<Record<string, string>> {
    const out = await new Promise<string>((done, fail) => {
        const child = spawn(helper.command, { shell: true, cwd: helper.cwd, env, stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
        let text = '';
        child.stdout.on('data', (d: Buffer) => {
            text += d.toString('utf8');
            if (text.length > MAX_OUTPUT) child.kill('SIGKILL');
        });
        child.on('error', () => fail(new LocalError('its http_headers_helper could not be run')));
        child.on('close', (code, signal) => (code === 0 && text.length <= MAX_OUTPUT ? done(text) : fail(new LocalError(signal ? `its http_headers_helper did not finish within ${TIMEOUT_MS / 1000} seconds` : 'its http_headers_helper failed'))));
    });
    let parsed: unknown;
    try {
        parsed = JSON.parse(out);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) throw new LocalError('its http_headers_helper did not print a JSON object of text values');
    for (const name of Object.keys(parsed)) {
        if (!HEADER.test(name)) throw new LocalError('its http_headers_helper printed a header name that is not one');
        if (RESERVED.has(name.toLowerCase())) throw new LocalError('its http_headers_helper returned a reserved header');
    }
    return parsed as Record<string, string>;
}

/** The helper's headers over the configured ones, except an Authorization the config sets itself. */
export function mergeHeaders(configured: Record<string, string>, fromHelper: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...configured };
    const lower = (o: Record<string, string>) => new Set(Object.keys(o).map((k) => k.toLowerCase()));
    const explicitAuth = lower(configured).has('authorization');
    for (const [k, v] of Object.entries(fromHelper)) {
        if (k.toLowerCase() === 'authorization' && explicitAuth) continue;
        for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
        out[k] = v;
    }
    return out;
}
