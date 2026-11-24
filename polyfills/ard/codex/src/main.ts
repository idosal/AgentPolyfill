// ard-discovery for Codex: a stdio MCP server with ard_discover, ard_search
// and add_mcp_server. Codex gives one plugin's MCP server no way to call
// another's tools, so this plugin carries the Server Cards core itself (the
// same modules, bundled) and shows and adds what it finds with the same checks
// as mcp-server-cards. Bundled into plugin/dist/server.mjs; importing it runs
// nothing, node running it starts the server.

import { discover } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatDiscovery } from '../../../server-cards/claude-code/mod/hooks/format'
import { codexDeps, isMain, logger, useCodexHost } from '../../../server-cards/codex/src/host'
import { serve, type Tool } from '../../../server-cards/codex/src/mcp'
import { addTool, askPerson, Session, shownText } from '../../../server-cards/codex/src/tools'
import { search, searchEndpoint } from '../../claude-code/mod/hooks/registry'
import { ARD_SOURCES, BY, NO_REGISTRY, prepareSearch, registrySetting, runSearch, SEARCH_CHOICES, SHOWN_QUERY, SHOWN_REGISTRY } from './search'
import { originOf } from '../../claude-code/mod/hooks/urls'

// What the tests run against.
export * from '../../../server-cards/claude-code/mod/hooks/card'
export * from '../../../server-cards/claude-code/mod/hooks/http'
export * from '../../../server-cards/claude-code/mod/hooks/sha256'
export * from '../../../server-cards/claude-code/mod/hooks/discover'
export * from '../../../server-cards/claude-code/mod/hooks/configure'
export * from '../../../server-cards/claude-code/mod/hooks/format'
export * from '../../../server-cards/claude-code/mod/hooks/offer'
export { search, searchEndpoint, originOf }
export * from '../../../server-cards/codex/src/codex'
export * from '../../../server-cards/codex/src/fetch'
export * from '../../../server-cards/codex/src/host'
export * from '../../../server-cards/codex/src/mcp'
export * from '../../../server-cards/codex/src/tools'

export const NAME = 'ard-discovery'
export const VERSION = '0.1.1'
export const DISCOVER = 'ard_discover'
export const SEARCH = 'ard_search'
export { ARD_SOURCES, BY, NO_REGISTRY, prepareSearch, registrySetting, runSearch, SEARCH_CHOICES, SHOWN_QUERY, SHOWN_REGISTRY }
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })

export function tools(session: Session, defaultRegistry: string): Tool[] {
  const discoverTool: Tool = {
    name: DISCOVER,
    description:
      'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog (/.well-known/ai-catalog.json), fetches each MCP Server Card they list and checks it against the schema. ' +
      'Use when the person wants to connect Codex to a service by its domain and asks for ARD, or the AI Catalog lists nothing. Read-only: public documents from that domain and the card URLs its catalogs name.',
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
      return { text: formatDiscovery(d) }
    },
  }

  const searchTool: Tool = {
    name: SEARCH,
    description:
      'Search an ARD registry for MCP servers that can do a task, described in plain words ("check why my CI build failed"). ' +
      'The query text is sent to a third party: the registry ' +
      (defaultRegistry
        ? `(${defaultRegistry} unless \`registry\` names another)`
        : '(none is configured: pass `registry` with the one the person names. Do not choose a registry for them; if they have not named one, ask which)') +
      ", which ranks other people's servers. Its referrals are followed one hop. Codex asks the person in a form before anything is sent, naming the registry and the query; without that form, or if they decline, nothing is sent. " +
      "Each result's card is fetched and checked, and so is whether the publisher's own domain lists the server. " +
      'Use when the person asks to find a server for a task, or a task needs a capability no tool in this session has and the person has not named a service. ' +
      'Say which registry answered, that its order is relevance, not trust, and which results their publisher confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the person needs, in plain words, on one line and at most 300 characters. It is sent to the registry.' },
        registry: {
          type: 'string',
          description:
            'A registry base URL, or a domain whose catalog lists a registry (an application/ai-registry+json entry): the one the person names. ' +
            (defaultRegistry ? 'Leave it out to use the configured registry.' : 'No registry is configured, so a search without it is refused.'),
        },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args, ctx) => {
      const prepared = await prepareSearch(session, args, defaultRegistry)
      if ('refuse' in prepared) return refuse(prepared.refuse)
      const { query, endpoints } = prepared
      // Every search is put to the person first, with the words and where they
      // go (security review M2); refused with no form, or a decline or close.
      const ok = await askPerson(ctx, prepared.question, SEARCH_CHOICES.yes, SEARCH_CHOICES.no)
      if ('why' in ok) return refuse(`Nothing was sent: ${ok.why}.`)

      return { text: await runSearch(session, query, endpoints) }
    },
  }

  return [discoverTool, searchTool, addTool(session, DISCOVER, `${DISCOVER} or ${SEARCH}`)]
}

export const INSTRUCTIONS =
  'Agentic Resource Discovery (ARD v0.91 draft) for MCP servers: ard_discover reads a domain\'s ard.json and AI Catalog; ard_search sends a query to an ARD registry, a third party, after the person approves it in a form; add_mcp_server adds a server either one showed, after the person approves that too. ' +
  "A registry's order is relevance, not trust; a result is confirmed only when its publisher's own catalog lists it."

export function start(env: NodeJS.ProcessEnv = process.env) {
  useCodexHost()
  const off = /^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '')
  const session = new Session(codexDeps(env, `${NAME}/${VERSION} (Codex polyfill)`))
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session, registrySetting(env)),
    log: logger(NAME, env, env.ARD_DISCOVERY_LOG ?? env.MCP_SERVER_CARDS_LOG),
  })
}

if (isMain(import.meta.url)) start()
