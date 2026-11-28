// ard-discovery for Muse Code: a stdio MCP server with ard_discover and add_mcp_server, bundled
// into the Codex plugin folder as plugin/muse/dist/server.mjs, beside the Codex bundle and apart
// from it. Discovery is the Codex form's (a domain's ard.json beside its AI Catalog, read by the
// shared Server Cards core); adding is mcp-server-cards' Muse add, which writes nothing and gives
// the person the `muse mcp add` command (../../../server-cards/muse/src/muse.ts). No registry
// search: it sends the person's words to a third party, which needs their yes first, and Muse
// gives a plugin no way to ask for it. Importing the bundle runs nothing; node running it starts
// the server. It doesn't import the Codex form's main.ts, which starts the Codex server when it is
// the file node runs; the ard_discover tool below is that file's, named for Muse.

import { discover, type DiscoverOptions } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatDiscovery } from '../../../server-cards/claude-code/mod/hooks/format'
import { codexDeps, isMain, logger } from '../../../server-cards/codex/src/host'
import { serve, type Tool } from '../../../server-cards/codex/src/mcp'
import { Session, shownText } from '../../../server-cards/codex/src/tools'
import { museAddTool, museRunner, useMuseHost } from '../../../server-cards/muse/src/muse'
import { originOf } from '../../claude-code/mod/hooks/urls'

// What the tests run against: the shared modules as bundled here, and the adapters.
export * from '../../../server-cards/claude-code/mod/hooks/card'
export * from '../../../server-cards/claude-code/mod/hooks/http'
export * from '../../../server-cards/claude-code/mod/hooks/sha256'
export * from '../../../server-cards/claude-code/mod/hooks/discover'
export * from '../../../server-cards/claude-code/mod/hooks/configure'
export * from '../../../server-cards/claude-code/mod/hooks/format'
export * from '../../../server-cards/claude-code/mod/hooks/offer'
export * from '../../../server-cards/codex/src/codex'
export * from '../../../server-cards/codex/src/fetch'
export * from '../../../server-cards/codex/src/host'
export * from '../../../server-cards/codex/src/mcp'
export * from '../../../server-cards/codex/src/tools'
export * from '../../../server-cards/muse/src/muse'
export { originOf }

export const NAME = 'ard-discovery'
/** The Muse Code form's own version. Kept equal to package.json and the plugin's .muse-plugin/plugin.json (test/bundle.test.ts checks). */
export const VERSION = '0.1.1'
export const DISCOVER = 'ard_discover'
export const BY = 'ard-discovery (ARD v0.91 draft)'
/** Where ARD discovery looks, as in the Codex form: ard.json (no specVersion needed) and rel="ard" links, beside the AI Catalog. */
export const ARD_SOURCES: DiscoverOptions = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: BY }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })

export function tools(session: Session): Tool[] {
  const discoverTool: Tool = {
    name: DISCOVER,
    description:
      'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog (/.well-known/ai-catalog.json), fetches each MCP Server Card they list and checks it against the schema. ' +
      'Use when the person wants to connect Muse to a service by its domain and asks for ARD, or the AI Catalog lists nothing. Read-only: public documents from that domain and the card URLs its catalogs name.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'A domain ("buildkite.com") or a page URL on it.' } },
      required: ['domain'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async args => {
      const domain = str(args.domain) ?? ''
      const target = originOf(domain)
      if ('error' in target) return refuse(target.error)
      const d = await discover(session.deps, domain, ARD_SOURCES)
      if ('error' in d) return refuse(d.error)
      session.remember(d)
      const count = d.servers.length
      const summary = `The directory lists ${count} MCP server${count === 1 ? '' : 's'}. Each remote URL is a connection option for the server it appears under.`
      return { text: summary + '\n\n' + formatDiscovery(d) }
    },
  }
  return [discoverTool, museAddTool(session, DISCOVER, DISCOVER)]
}

export const INSTRUCTIONS =
  "Agentic Resource Discovery (ARD v0.91 draft) for MCP servers: ard_discover reads a domain's ard.json and AI Catalog; add_mcp_server checks a server it showed and gives the `muse mcp add` command that adds it, which the person runs themselves. " +
  "Registry search (ard_search) is not offered in Muse: it sends the words of a request to a third party. This adapter only looks up domains the person names. " +
  "A result is the publisher's claim, not a check of the server."

export function start(env: NodeJS.ProcessEnv = process.env) {
  useMuseHost()
  const off = /^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '')
  const deps = codexDeps(env, `${NAME}/${VERSION} (Muse polyfill)`)
  deps.run = museRunner(env)
  const session = new Session(deps)
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session),
    log: logger(NAME, env, env.ARD_DISCOVERY_LOG ?? env.MCP_SERVER_CARDS_LOG),
  })
}

if (isMain(import.meta.url)) start()
