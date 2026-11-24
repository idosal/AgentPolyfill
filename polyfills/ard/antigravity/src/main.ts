// ard-discovery for Antigravity: a stdio MCP server with ard_discover,
// ard_search and add_mcp_server, and, run with --hook, the plugin's
// PreToolUse hook that puts each search and each addition to the person
// (polyfills/server-cards/antigravity/src/gate.ts). It carries the Server
// Cards core and Antigravity adapter (bundled), so what it finds is shown and
// added with the same checks as mcp-server-cards. Importing the bundle runs
// nothing; node running it starts the server or answers the hook.

import { formatDiscovery } from '../../../server-cards/claude-code/mod/hooks/format'
import { discover } from '../../../server-cards/claude-code/mod/hooks/discover'
import { isMain, logger } from '../../../server-cards/codex/src/host'
import { serve, type Tool } from '../../../server-cards/codex/src/mcp'
import { shownText } from '../../../server-cards/codex/src/tools'
import { antigravityDeps, useAntigravityHost } from '../../../server-cards/antigravity/src/host'
import { digestOf, ownArgs, redeemTicket, runHook, stateDir, TICKET_ARG, type Handler } from '../../../server-cards/antigravity/src/gate'
import { ADD, addHandler, addTool, SharedSession } from '../../../server-cards/antigravity/src/tools'
import { originOf } from '../../claude-code/mod/hooks/urls'
import { ARD_SOURCES, NO_REGISTRY, prepareSearch, registrySetting, runSearch } from '../../codex/src/search'

// What the tests run against.
export * from '../../../server-cards/antigravity/src/antigravity'
export * from '../../../server-cards/antigravity/src/gate'
export { ARD_SOURCES, prepareSearch }

export const NAME = 'ard-discovery'
export const VERSION = '0.1.0'
export const DISCOVER = 'ard_discover'
export const SEARCH = 'ard_search'
/** The plugin's MCP server as Antigravity names it: `<plugin>_<key in mcp_config.json>`. */
export const SERVER = 'ard-discovery_ard'

/** The Codex form's words for "no registry", with Antigravity's place to set one. */
const noRegistry = (text: string) =>
  text === NO_REGISTRY
    ? 'No ARD registry is set, and this search names none. Ask the person which registry to search (a registry base URL, or a domain whose catalog lists one) and pass it as `registry`; they can also set one with ARD_DISCOVERY_REGISTRY in the environment Antigravity starts in. Nothing was sent.'
    : text

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })

/** What a search ticket is for: the exact words and the exact endpoints. */
const searchDigest = (query: string, endpoints: string[]) => digestOf({ query, endpoints })

export function tools(session: SharedSession, defaultRegistry: string): Tool[] {
  const discoverTool: Tool = {
    name: DISCOVER,
    description:
      'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog (/.well-known/ai-catalog.json), fetches each MCP Server Card they list and checks it against the schema. ' +
      'Use when the person wants to connect Antigravity to a service by its domain and asks for ARD, or the AI Catalog lists nothing. Read-only: public documents from that domain and the card URLs its catalogs name.',
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
      ", which ranks other people's servers. Its referrals are followed one hop. Antigravity's approval card asks the person before anything is sent, naming the registry and the query; if they decline, nothing is sent. " +
      "Each result's card is fetched and checked, and so is whether the publisher's own domain lists the server. " +
      'Use when the person asks to find a server for a task, or a task needs a capability no tool in this conversation has and the person has not named a service. ' +
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
        [TICKET_ARG]: { type: 'string', description: "Set by the plugin's approval hook. Leave it out." },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async args => {
      const prepared = await prepareSearch(session, ownArgs(args), defaultRegistry)
      if ('refuse' in prepared) return refuse(noRegistry(prepared.refuse))
      // Every search is put to the person first, with the words and where
      // they go (security review M2): the hook asked about exactly these.
      const t = redeemTicket(session.dir, args[TICKET_ARG], SEARCH, searchDigest(prepared.query, prepared.endpoints))
      if (!t.ok) return refuse(`Nothing was sent: ${t.why}.`)
      return { text: await runSearch(session, prepared.query, prepared.endpoints) }
    },
  }

  return [discoverTool, searchTool, addTool(session, DISCOVER, `${DISCOVER} or ${SEARCH}`)]
}

export function handlers(session: SharedSession, defaultRegistry: string): Record<string, Handler> {
  return {
    [ADD]: addHandler(session, DISCOVER),
    [SEARCH]: async args => {
      const p = await prepareSearch(session, args, defaultRegistry)
      if ('refuse' in p) return { deny: shownText(noRegistry(p.refuse)) }
      return { ask: p.question, digest: searchDigest(p.query, p.endpoints) }
    },
  }
}

export const INSTRUCTIONS =
  "Agentic Resource Discovery (ARD v0.91 draft) for MCP servers: ard_discover reads a domain's ard.json and AI Catalog; ard_search sends a query to an ARD registry, a third party, after the person approves it in Antigravity's approval card; add_mcp_server adds a server either one showed, after the person approves that too. " +
  "A registry's order is relevance, not trust; a result is confirmed only when its publisher's own catalog lists it."

/** Stand-down (contract rule 4): nothing to detect in Antigravity yet; this setting, or disabling the plugin, turns it off. */
export const isOff = (env: NodeJS.ProcessEnv) => /^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '')

export async function start(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  useAntigravityHost()
  const session = new SharedSession(antigravityDeps(env, `${NAME}/${VERSION} (Antigravity polyfill)`), stateDir(NAME, env))
  const registry = registrySetting(env)
  if (argv.includes('--hook')) return runHook(handlers(session, registry), session.dir, SERVER)
  const off = isOff(env)
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session, registry),
    log: logger(NAME, env, env.ARD_DISCOVERY_LOG ?? env.MCP_SERVER_CARDS_LOG),
  })
}

if (isMain(import.meta.url)) void start()
