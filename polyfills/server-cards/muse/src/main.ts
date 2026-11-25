// mcp-server-cards for Muse Code: a stdio MCP server with discover_mcp_servers and
// add_mcp_server, bundled into the Codex plugin folder as plugin/muse/dist/server.mjs, beside the
// Codex bundle and apart from it. It runs the Codex form's code unchanged (../../codex/src: the
// fetch rules, the card checks and the plan) with what differs in Muse (muse.ts): add_mcp_server
// writes nothing, and gives the person the `muse mcp add` command to run themselves. Importing
// the bundle runs nothing (the tests import it); node running it starts the server. It doesn't
// import the Codex form's main.ts, which starts the Codex server when it is the file node runs.

import { codexDeps, isMain, logger } from '../../codex/src/host'
import { serve } from '../../codex/src/mcp'
import { discoverTool, Session } from '../../codex/src/tools'
import { museAddTool, museRunner, useMuseHost } from './muse'

// What the tests run against: the shared modules as bundled here, the Codex adapter, and Muse's.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/http'
export * from '../../claude-code/mod/hooks/sha256'
export * from '../../claude-code/mod/hooks/discover'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/format'
export * from '../../claude-code/mod/hooks/offer'
export * from '../../codex/src/codex'
export * from '../../codex/src/fetch'
export * from '../../codex/src/host'
export * from '../../codex/src/mcp'
export * from '../../codex/src/tools'
export * from './muse'

export const NAME = 'mcp-server-cards'
/** The Muse Code form's own version. Kept equal to package.json and the plugin's .muse-plugin/plugin.json (test/bundle.test.ts checks). */
export const VERSION = '0.1.0'
export const DISCOVER = 'discover_mcp_servers'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect Muse to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const INSTRUCTIONS =
  'MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server checks one and gives the `muse mcp add` command that adds it, which the person runs themselves (Muse gives this plugin no way to ask them first). ' +
  "A card is the publisher's claim, not a check of the server. Show the person the server, the URL it connects to and the command, exactly as given."

export function tools(session: Session) {
  return [discoverTool(session, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), museAddTool(session, DISCOVER, DISCOVER)]
}

export function start(env: NodeJS.ProcessEnv = process.env) {
  useMuseHost()
  // Stand-down (contract rule 4): Muse has no Server Card support to detect yet. When it ships,
  // disable the plugin (muse plugins disable mcp-server-cards).
  const off = /^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '')
  const deps = codexDeps(env, `${NAME}/${VERSION} (Muse polyfill)`)
  deps.run = museRunner(env)
  const session = new Session(deps)
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session),
    log: logger(NAME, env),
  })
}

if (isMain(import.meta.url)) start()
