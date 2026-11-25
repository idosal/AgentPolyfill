// mcp-server-cards for Codex: a stdio MCP server with discover_mcp_servers and
// add_mcp_server. Bundled into plugin/dist/server.mjs with the shared modules
// it uses. Importing the bundle runs nothing (the tests import it); node
// running it starts the server.

import { codexDeps, isMain, logger, useCodexHost } from './host'
import { serve } from './mcp'
import { addTool, discoverTool, Session } from './tools'

// What the tests run against: the shared modules as bundled here, and the adapter.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/http'
export * from '../../claude-code/mod/hooks/sha256'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/format'
export * from '../../claude-code/mod/hooks/offer'
export * from './codex'
export * from './fetch'
export * from './host'
export * from './mcp'
export * from './tools'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.4'
export const DISCOVER = 'discover_mcp_servers'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Codex to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const INSTRUCTIONS =
  'MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server adds one to Codex after the person approves it in a form. ' +
  "A card is the publisher's claim, not a check of the server. Show the person the server and the URL it connects to before you add it."

export function tools(session: Session) {
  return [discoverTool(session, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(session, DISCOVER, DISCOVER)]
}

export function start(env: NodeJS.ProcessEnv = process.env) {
  useCodexHost()
  // Stand-down (contract rule 4): Codex has no Server Card support to detect
  // yet. When it ships, disable the plugin, or set this to register nothing.
  const off = /^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '')
  const session = new Session(codexDeps(env, `${NAME}/${VERSION} (Codex polyfill)`))
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session),
    log: logger(NAME, env),
  })
}

if (isMain(import.meta.url)) start()
