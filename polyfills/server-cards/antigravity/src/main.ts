// mcp-server-cards for Antigravity: a stdio MCP server with
// discover_mcp_servers and add_mcp_server, and, run with --hook, the plugin's
// PreToolUse hook that puts each addition to the person (gate.ts). Bundled
// into plugin/dist/server.mjs; importing the bundle runs nothing, node
// running it starts the server or answers the hook.

import { isMain, logger } from '../../codex/src/host'
import { serve } from '../../codex/src/mcp'
import { discoverTool } from '../../codex/src/tools'
import { antigravityDeps, useAntigravityHost } from './host'
import { runHook, runStop, stateDir, type Handler } from './gate'
import { ADD, addHandler, addTool, setServerName, SharedSession } from './tools'

// What the tests run against: the shared modules as bundled here, and the adapter.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/format'
export * from './antigravity'
export * from './gate'
export * from './host'
export * from './tools'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.0'
export const DISCOVER = 'discover_mcp_servers'
/** The plugin's MCP server as Antigravity names it: `<plugin>_<key in mcp_config.json>`. */
export const SERVER = 'mcp-server-cards_cards'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Antigravity to a service by its domain or website, or a task needs a service that has no tools in this conversation and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const INSTRUCTIONS =
  "MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server adds one to Antigravity's MCP configuration after the person approves it in Antigravity's approval card. " +
  "A card is the publisher's claim, not a check of the server. Show the person the server and the URL it connects to before you add it."

export const session = (env: NodeJS.ProcessEnv) => new SharedSession(antigravityDeps(env, `${NAME}/${VERSION} (Antigravity polyfill)`), stateDir(NAME, env))

export function tools(s: SharedSession) {
  return [discoverTool(s, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(s, DISCOVER, DISCOVER)]
}

export function handlers(s: SharedSession): Record<string, Handler> {
  return { [ADD]: addHandler(s, DISCOVER) }
}

/** The tools the hook gates: marked eager in plugin/mcp_config.json, and named in hooks.json's matcher. */
export const GATED = [ADD] as const

/** Stand-down (contract rule 4): Antigravity has no Server Card support to detect yet; this setting, or disabling the plugin, turns it off. */
export const isOff = (env: NodeJS.ProcessEnv) => /^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '')

export async function start(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  useAntigravityHost()
  setServerName(SERVER)
  // The hooks open the state folder only once they know the call is this plugin's (gate.ts).
  if (argv.includes('--hook'))
    return argv[argv.indexOf('--hook') + 1] === 'stop'
      ? runStop(() => stateDir(NAME, env))
      : runHook({ server: SERVER, tools: GATED, gate: () => { const s = session(env); return { handlers: handlers(s), dir: s.dir } } })
  const s = session(env)
  const off = isOff(env)
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(s),
    log: logger(NAME, env),
  })
}

if (isMain(import.meta.url)) void start()
