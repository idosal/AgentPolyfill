// mcp-server-cards for Copilot: a stdio MCP server with discover_mcp_servers and add_mcp_server,
// shipped in a Copilot plugin (plugin/.mcp.json). Bundled into plugin/dist/server.mjs with the
// shared modules it uses. Importing the bundle runs nothing (the tests import it); node running
// it starts the server.

import { isMain, logger } from '../../codex/src/host'
import { serve } from '../../codex/src/mcp'
import { discoverTool, Session } from '../../codex/src/tools'
import { copilotDeps, useCopilotHost } from './host'
import { addTool } from './tools'

// What the tests run against: the shared modules as bundled here, and the adapter.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/http'
export * from '../../claude-code/mod/hooks/sha256'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/format'
export * from '../../claude-code/mod/hooks/offer'
export { nodeFetch } from '../../codex/src/fetch'
export { memoryStore, isMain, logger } from '../../codex/src/host'
export { serve, offersForm, PROTOCOL_VERSIONS } from '../../codex/src/mcp'
export { ADD, ADD_CHOICES, askPerson, choiceSchema, discoverTool, Session, shownText } from '../../codex/src/tools'
export * from './copilot'
export * from './host'
export { addTool, askText, resolveAdd } from './tools'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.1'
export const DISCOVER = 'discover_mcp_servers'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Copilot to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const INSTRUCTIONS =
  'MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server adds one to Copilot after the person approves it in a form. ' +
  "A card is the publisher's claim, not a check of the server. Show the person the server and the URL it connects to before you add it."

export function tools(session: Session) {
  return [discoverTool(session, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(session, DISCOVER, DISCOVER)]
}

export function start(env: NodeJS.ProcessEnv = process.env) {
  useCopilotHost()
  // Stand-down (contract rule 4): Copilot 1.0.115 doesn't read Server Cards from a domain (no AI
  // Catalog or .well-known path in its runtime's JavaScript or SDK types). Its SDK types declare a
  // catalogue API, mcp.planInstall among it, that accepts the card media type, for a catalogue
  // Copilot is given; that wasn't run (README, "Copilot's own catalogue"). When Copilot reads a
  // domain's catalog, uninstall the plugin, or set this to register nothing.
  const off = /^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '')
  const session = new Session(copilotDeps(env, `${NAME}/${VERSION} (Copilot polyfill)`))
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session),
    log: logger(NAME, env),
  })
}

if (isMain(import.meta.url)) start()
