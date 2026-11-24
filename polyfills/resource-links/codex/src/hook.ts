// The plugin's PostToolUse hook. Codex runs it after each tool call (hooks/hooks.json),
// with the call on stdin: `tool_name` (mcp__<server>__<tool> for an MCP tool),
// `tool_response` (the MCP result) and `session_id`. It notes the resource links in an
// MCP tool's result, and prints nothing, so the result reaches the model as Codex made it.
// It always exits 0: a hook that fails must not stand in the way of the tool call.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { linksIn } from '../../core/src/links.ts';
import { describeError } from '../../core/src/untrusted.ts';
import { disabled, stateDirOf } from './config.ts';
import { addNotes, validSession } from './notes.ts';
import { PLUGIN } from './version.ts';

type Json = Record<string, unknown>;
const MAX_INPUT = 64 * 1024 * 1024;

/** `mcp__<server>__<tool>` → server and tool. The server is everything up to the first `__` after the prefix. */
export function mcpToolOf(name: unknown): { server: string; tool: string } | undefined {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined;
    const rest = name.slice(5);
    const at = rest.indexOf('__');
    if (at <= 0 || at + 2 >= rest.length) return undefined;
    return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** What the hook does with one input, apart from reading stdin: the number of links noted. */
export function onPostToolUse(input: Json, env: NodeJS.ProcessEnv, pluginRoot?: string, now = Date.now()): number {
    if (disabled(env) || input.hook_event_name !== 'PostToolUse') return 0;
    const t = mcpToolOf(input.tool_name);
    if (!t || t.server === PLUGIN) return 0;
    const session = input.session_id;
    if (!validSession(session)) return 0;
    const links = linksIn(input.tool_response, t.server, t.tool, now);
    return addNotes(stateDirOf(env, pluginRoot), session, links, now);
}

async function main(): Promise<void> {
    const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
    const state = stateDirOf(process.env, pluginRoot);
    try {
        let raw = '';
        for await (const chunk of process.stdin) {
            raw += chunk;
            if (raw.length > MAX_INPUT) return;
        }
        const input = JSON.parse(raw) as Json;
        const n = onPostToolUse(input, process.env, pluginRoot);
        if (n) log(state, `noted ${n} link(s) from ${String(input.tool_name)} in session ${String(input.session_id)}`);
    } catch (e) {
        log(state, `the hook could not note links (${describeError(e)})`);
    }
}

function log(state: string, line: string): void {
    try {
        mkdirSync(state, { recursive: true, mode: 0o700 });
        appendFileSync(join(state, `${PLUGIN}.log`), `${new Date().toISOString()} [hook] ${line}\n`, { mode: 0o600 });
    } catch {
        // nowhere to log to
    }
}

if (process.argv[1] && /hook\.(ts|js)$/.test(process.argv[1])) main().finally(() => process.exit(0));
