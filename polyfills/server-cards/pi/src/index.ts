import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { install } from './host'
import { addTool, discoverTool, Session } from './tools'

// What the tests run against: the shared modules as bundled here, and the adapter.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/http'
export * from '../../claude-code/mod/hooks/sha256'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/format'
export * from '../../claude-code/mod/hooks/offer'
export * from './pi'
export * from '../../codex/src/fetch'
export * from './host'
export * from './tools'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.0'
export const DISCOVER = 'discover_mcp_servers'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Pi to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export function tools(session: Session) {
  return [discoverTool(session, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(session, DISCOVER, DISCOVER)]
}

export default function serverCards(pi: ExtensionAPI) {
  install(pi, 'MCP_SERVER_CARDS_DISABLED', tools)
}
