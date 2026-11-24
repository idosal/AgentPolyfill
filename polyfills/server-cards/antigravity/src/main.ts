// mcp-server-cards for Antigravity: a stdio MCP server with
// discover_mcp_servers and add_mcp_server, and, run with --hook, the plugin's
// PreToolUse hook that puts each addition to the person (gate.ts). Bundled
// into plugin/dist/server.mjs; importing the bundle runs nothing, node
// running it starts the server or answers the hook.

import { host } from '../../claude-code/mod/hooks/configure'
import { memoryStore, isMain, logger } from '../../codex/src/host'
import { nodeFetch } from '../../codex/src/fetch'
import { serve } from '../../codex/src/mcp'
import { discoverTool, type SessionDeps } from '../../codex/src/tools'
import type { Run } from '../../codex/src/codex'
import { runHook, stateDir, type Handler } from './gate'
import { ADD, addHandler, addTool, SharedSession } from './tools'

// What the tests run against: the shared modules as bundled here, and the adapter.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/format'
export * from './antigravity'
export * from './gate'
export * from './tools'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.0'
export const DISCOVER = 'discover_mcp_servers'

/**
 * Protocol revisions Antigravity negotiates as an MCP client. Not documented
 * (unverified); its App advertises the MCP Apps extension under
 * `capabilities.extensions`, which needs 2025-11-25. Used only to skip a
 * remote whose card lists none of these.
 */
export const ANTIGRAVITY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const useAntigravityHost = () => {
  host.name = 'Antigravity'
  host.protocolVersions = ANTIGRAVITY_PROTOCOL_VERSIONS
}

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Antigravity to a service by its domain or website, or a task needs a service that has no tools in this conversation and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const INSTRUCTIONS =
  "MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server adds one to Antigravity's MCP configuration after the person approves it in Antigravity's approval card. " +
  "A card is the publisher's claim, not a check of the server. Show the person the server and the URL it connects to before you add it."

/** Antigravity's form needs no command of the host's: a stand-in so the shared Deps type holds. */
const noRun: Run = async () => ({ failure: 'not used in the Antigravity form' })

export const antigravityDeps = (env: NodeJS.ProcessEnv, userAgent: string): SessionDeps => ({
  fetch: nodeFetch({ userAgent }),
  store: memoryStore(),
  now: () => Date.now(),
  run: noRun,
  env,
})

export const session = (env: NodeJS.ProcessEnv) => new SharedSession(antigravityDeps(env, `${NAME}/${VERSION} (Antigravity polyfill)`), stateDir(NAME, env))

export function tools(s: SharedSession) {
  return [discoverTool(s, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(s, DISCOVER, DISCOVER)]
}

export function handlers(s: SharedSession): Record<string, Handler> {
  return { [ADD]: addHandler(s, DISCOVER) }
}

/** Stand-down (contract rule 4): Antigravity has no Server Card support to detect yet; this setting, or disabling the plugin, turns it off. */
export const isOff = (env: NodeJS.ProcessEnv) => /^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '')

export async function start(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  useAntigravityHost()
  const s = session(env)
  if (argv.includes('--hook')) return runHook(handlers(s), s.dir)
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
