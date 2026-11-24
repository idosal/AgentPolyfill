// mcp-server-cards for OpenCode: a V2 server plugin with discover_mcp_servers,
// add_mcp_server and remove_mcp_server, in the `server_cards` namespace.
// Bundled into plugin/server.js with the shared modules it uses; importing the
// bundle runs nothing (the tests import it), OpenCode calls its `setup`.

import { host } from '../../claude-code/mod/hooks/configure'
import { nodeFetch } from '../../codex/src/fetch'
import { AddedServers, addTool, discoverTool, memoryStore, registerTools, removeTool, Shown, type ToolSet } from './cards'
import type { Context, Plugin } from './opencode'

// What the tests run against: the shared modules as bundled here, and this form's own.
export * from '../../claude-code/mod/hooks/card'
export * from '../../claude-code/mod/hooks/configure'
export * from '../../claude-code/mod/hooks/discover'
export * from './cards'

export const NAME = 'mcp-server-cards'
export const VERSION = '0.1.0'
export const NAMESPACE = 'server_cards'
export const DISCOVER = 'discover_mcp_servers'

export const DISCOVER_DESCRIPTION =
  'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
  'Use when the person wants to connect OpenCode to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
  "Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher's description of its servers."

export const NAMESPACE_DESCRIPTION =
  'MCP Server Cards (SEP-2127): discover_mcp_servers reads the MCP servers a domain publishes; add_mcp_server adds one to OpenCode once OpenCode\'s permission rules allow it. ' +
  "A card is the publisher's claim, not a check of the server. Show the person the server and the URL it connects to before you add it."

/** Sessions whose discoveries are kept at once; the oldest is let go past this. */
const MAX_SESSIONS = 64

export function shownBySession(): (session: string) => Shown {
  const all = new Map<string, Shown>()
  return session => {
    let s = all.get(session)
    if (s) {
      all.delete(session)
      all.set(session, s)
      return s
    }
    s = new Shown()
    all.set(session, s)
    while (all.size > MAX_SESSIONS) all.delete(all.keys().next().value!)
    return s
  }
}

export async function setup(ctx: Context, env: NodeJS.ProcessEnv = process.env) {
  host.name = 'OpenCode'
  // Stand-down (contract rule 4): OpenCode 2.4.1 has no Server Card support to detect. When it
  // ships, remove the plugin, or turn it off with this setting or the option `off`.
  if (/^(1|true|on|yes)$/i.test(env.MCP_SERVER_CARDS_DISABLED ?? '') || ctx.options?.off === true) return
  const added = new AddedServers(ctx)
  await added.start()
  const t: ToolSet = {
    deps: { fetch: nodeFetch({ userAgent: `${NAME}/${VERSION} (OpenCode polyfill)` }), store: memoryStore(), now: () => Date.now() },
    ctx,
    shown: shownBySession(),
    added,
    names: { discover: `${NAMESPACE}_${DISCOVER}`, add: `${NAMESPACE}_add_mcp_server`, remove: `${NAMESPACE}_remove_mcp_server` },
    foundBy: `${NAMESPACE}_${DISCOVER}`,
  }
  await registerTools(ctx, { name: NAMESPACE, description: NAMESPACE_DESCRIPTION }, [discoverTool(t, { name: DISCOVER, description: DISCOVER_DESCRIPTION }), addTool(t), removeTool(t)])
}

const plugin: Plugin = { id: NAME, setup: async ctx => void (await setup(ctx)) }
export default plugin
