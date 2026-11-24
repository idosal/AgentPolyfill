// Where things are, for the hook and the plugin's server alike: Codex's home,
// the plugin's notes, the `codex` program, and whether the plugin is turned off.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Codex's home: CODEX_HOME, or, for an installed plugin Codex started without passing it,
 * the home the plugin's folder is in ($CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>),
 * or ~/.codex.
 */
export function codexHomeOf(env: NodeJS.ProcessEnv, pluginRoot?: string): string {
    if (env.CODEX_HOME) return resolve(env.CODEX_HOME);
    if (pluginRoot) {
        const parts = resolve(pluginRoot).split(sep);
        const at = parts.lastIndexOf('cache');
        if (at >= 2 && parts[at - 1] === 'plugins' && parts.length - at === 4) return parts.slice(0, at - 1).join(sep) || sep;
    }
    return join(env.HOME ?? homedir(), '.codex');
}

/** The folder the hook writes its notes to and the server reads them from. */
export function stateDirOf(env: NodeJS.ProcessEnv, pluginRoot?: string): string {
    if (env.MCP_RESOURCE_LINKS_STATE) return resolve(env.MCP_RESOURCE_LINKS_STATE);
    return join(codexHomeOf(env, pluginRoot), 'mcp-resource-links');
}

/** `MCP_RESOURCE_LINKS_DISABLED=1` (or true, yes, on) turns the plugin off: no tool, no notes. */
export const disabled = (env: NodeJS.ProcessEnv): boolean => /^(1|true|yes|on)$/i.test(env.MCP_RESOURCE_LINKS_DISABLED ?? '');

/** Where `codex` may be: the desktop app's CODEX_CLI_PATH, PATH, then the usual install places. */
export const codexCandidates = (env: NodeJS.ProcessEnv): string[] => [
    ...(env.CODEX_CLI_PATH ? [env.CODEX_CLI_PATH] : []),
    'codex',
    ...(env.HOME ? [join(env.HOME, '.local', 'bin', 'codex')] : []),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
];

/** The app-server daemon's control socket, which Codex's terminal UI and desktop app use. */
export const daemonSocketOf = (codexHome: string): string => join(codexHome, 'app-server-control', 'app-server-control.sock');
