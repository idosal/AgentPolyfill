// Moved to ../core (polyfills/events/core), which the Codex form of this polyfill shares. Bundled into mod/dist/helper.js.
// Where Claude Code keeps this mod's state, and which session this is, stay here: they are Claude Code's.
import { homedir } from 'node:os';
import { join } from 'node:path';

export * from '../../core/src/store.ts';

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.MCP_EVENTS_STATE || env.CLAUDE_PLUGIN_DATA || join(homedir(), '.mcp-events-plugin');
}

export function sessionId(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAUDE_CODE_SESSION_ID || `pid-${env.CLAUDE_PID || process.ppid}`;
}
