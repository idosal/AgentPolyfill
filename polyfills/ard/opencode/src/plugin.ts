// ard-discovery for OpenCode: a V2 server plugin with ard_discover, ard_search,
// add_mcp_server and remove_mcp_server, in the `ard` namespace. OpenCode gives
// one plugin no way to call another's tools, so this plugin carries the Server
// Cards core itself (the same modules, bundled) and shows and adds what it
// finds with the same checks as mcp-server-cards. Bundled into
// plugin/server.js; importing it runs nothing, OpenCode calls its `setup`.

import { hasMarkup, hasUserinfo } from '../../../server-cards/claude-code/mod/hooks/card'
import { host } from '../../../server-cards/claude-code/mod/hooks/configure'
import { discover, type DiscoverOptions } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatDiscovery, formatOffered } from '../../../server-cards/claude-code/mod/hooks/format'
import { readOffered } from '../../../server-cards/claude-code/mod/hooks/offer'
import { nodeFetch } from '../../../server-cards/codex/src/fetch'
import { ACTIONS, AddedServers, addTool, memoryStore, registerTools, removeTool, shownText, type Tool, type ToolSet } from '../../../server-cards/opencode/src/cards'
import type { Context, Plugin } from '../../../server-cards/opencode/src/opencode'
import { shownBySession } from '../../../server-cards/opencode/src/plugin'
import { askByDefault, askByDefaultOff } from '../../../server-cards/opencode/src/consent'
import { HIDDEN, search, searchEndpoint } from '../../claude-code/mod/hooks/registry'
import { originOf } from '../../claude-code/mod/hooks/urls'

// What the tests run against.
export { search, searchEndpoint, originOf, UNSEEN }

export const NAME = 'ard-discovery'
export const VERSION = '0.1.0'
export const NAMESPACE = 'ard'
export const BY = 'ard-discovery (ARD v0.91 draft)'
/** The permission action a search is put to OpenCode's rules as. Resource: the registry hosts it goes to. */
export const SEARCH_ACTION = 'ard_search'
// ARD v0.91 §5.1: a consumer resolving a domain MUST fetch /.well-known/ard.json
// (a manifest, which need not carry specVersion) and MUST honour rel="ard".
export const ARD_SOURCES: DiscoverOptions = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: BY }
/** The longest query sent (as in the other forms), so a permission request can show all of it. */
export const SHOWN_QUERY = 300
export const SHOWN_REGISTRY = 200
export const NO_REGISTRY =
  'No ARD registry is set, and this search names none. Ask the person which registry to search (a registry base URL, or a domain whose catalog lists one) and pass it as `registry`; they can also set one with ARD_DISCOVERY_REGISTRY in the environment OpenCode starts in. Nothing was sent.'
/** Characters that display as something else or as nothing, tag characters among them (registry.ts HIDDEN, as in the other forms). */
const UNSEEN = HIDDEN
const MARKUP = /[`<>[\]]/

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })
const unshowable = (registry: string, from: string) =>
  registry.length > SHOWN_REGISTRY || UNSEEN.test(registry) || /\s/.test(registry)
    ? `${from} must be at most ${SHOWN_REGISTRY} characters, with no spaces, control characters, direction marks or hidden characters, so the request names exactly where the search goes. Nothing was sent.`
    : undefined

export const registrySetting = (env: NodeJS.ProcessEnv) => (env.ARD_DISCOVERY_REGISTRY ?? '').trim()

export function tools(t: ToolSet, defaultRegistry: string): Tool[] {
  const discoverTool: Tool = {
    name: 'discover',
    description:
      'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog (/.well-known/ai-catalog.json), fetches each MCP Server Card they list and checks it against the schema. ' +
      'Use when the person wants to connect OpenCode to a service by its domain and asks for ARD, or the AI Catalog lists nothing. Read-only: public documents from that domain and the card URLs its catalogs name.',
    input: { type: 'object', properties: { domain: { type: 'string', description: 'A domain ("buildkite.com") or a page URL on it.' } }, required: ['domain'], additionalProperties: false },
    run: async (args, call) => {
      const domain = str(args.domain) ?? ''
      const target = originOf(domain)
      if ('error' in target) return refuse(target.error)
      const d = await discover(t.deps, domain, ARD_SOURCES)
      if ('error' in d) return refuse(d.error)
      t.shown(call.sessionID).remember(d)
      return { text: formatDiscovery(d) }
    },
  }

  const searchTool: Tool = {
    name: 'search',
    description:
      'Search an ARD registry for MCP servers that can do a task, described in plain words ("check why my CI build failed"). ' +
      'The query text is sent to a third party: the registry ' +
      (defaultRegistry
        ? `(${defaultRegistry} unless \`registry\` names another)`
        : '(none is configured: pass `registry` with the one the person names. Do not choose a registry for them; if they have not named one, ask which)') +
      `, which ranks other people's servers. OpenCode's permission rules decide before anything is sent (action ${SEARCH_ACTION}, on the registry hosts, with the query shown). ` +
      "Each result's card is fetched and checked, and so is whether the publisher's own domain lists the server. " +
      'Say which registry answered, that its order is relevance, not trust, and which results their publisher confirms.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the person needs, in plain words, on one line and at most 300 characters. It is sent to the registry.' },
        registry: { type: 'string', description: 'A registry base URL, or a domain whose catalog lists a registry: the one the person names.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async (args, call) => {
      const query = (str(args.query) ?? '').trim()
      if (!query) return refuse('Give `query`: what the person needs, in plain words.')
      if (query.length > SHOWN_QUERY) return refuse(`Keep the search under ${SHOWN_QUERY} characters, so the person sees all of it before it is sent.`)
      if (UNSEEN.test(query)) return refuse('Write the search on one line, without control characters, direction marks or hidden characters, so the person sees exactly what is sent.')
      if (MARKUP.test(query)) return refuse('Write the search in plain words, without `, <, > or square brackets, so the request shows exactly what is sent.')
      const asked = (str(args.registry) ?? defaultRegistry).trim()
      if (!asked) return refuse(NO_REGISTRY)
      const unnamed = unshowable(asked, str(args.registry) !== undefined ? 'The `registry` in this search' : 'ARD_DISCOVERY_REGISTRY')
      if (unnamed) return refuse(unnamed)
      let endpoints: string[] = []
      if (!/^https?:\/\//i.test(asked)) {
        const d = await discover(t.deps, asked, ARD_SOURCES)
        if (!('error' in d))
          for (const r of d.registries)
            if (r.url) {
              const ep = searchEndpoint(r.url)
              if (typeof ep === 'string') endpoints.push(ep)
            }
      }
      if (!endpoints.length) {
        const ep = searchEndpoint(/^https?:\/\//i.test(asked) ? asked : `https://${asked}`)
        if (typeof ep !== 'string') return refuse(ep.error)
        endpoints = [ep]
      }
      endpoints = [...new Set(endpoints)].slice(0, 3)
      const unclear = endpoints.find(ep => hasMarkup(ep) || hasUserinfo(ep))
      if (unclear) return refuse(`The registry ${unclear} holds markup or names a user before its host, so the request could show one host while the query goes to another. Nothing was sent.`)
      const hosts = [...new Set(endpoints.map(ep => new URL(ep).host))]
      // Every search is put to OpenCode's rules first, with the words and where they go. Not saved:
      // an approval is for this one search.
      await t.ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        source: { type: 'tool', messageID: call.messageID, id: call.id },
        action: SEARCH_ACTION,
        resources: hosts,
        save: [],
        metadata: { question: shownText(`${hosts.join(', ')}: send this search to ${endpoints.join(', ')}, and to up to three registries it refers to?`), query, endpoints, note: 'A registry is a service someone else runs, and it sees the query.' },
      })
      // A registry's answer can refer the search on to other registries (one hop). Each one this
      // request didn't name is put to OpenCode's rules too, before the query goes there; one that
      // isn't allowed gets nothing, and OpenCode's refusal is passed on once the search is done.
      const allowed = new Set(hosts)
      let refused: unknown
      const post: typeof t.deps.fetch = async (url, init) => {
        const host = new URL(url).host
        if (!allowed.has(host)) {
          try {
            await t.ctx.permission.assert({
              sessionID: call.sessionID,
              agent: call.agent,
              source: { type: 'tool', messageID: call.messageID, id: call.id },
              action: SEARCH_ACTION,
              resources: [host],
              save: [],
              metadata: { question: shownText(`${host}: a registry this search went to refers it on to ${url}. Send the search there too?`), query, endpoint: url, note: 'A registry is a service someone else runs, and it sees the query.' },
            })
            allowed.add(host)
          } catch (e) {
            refused ??= e
            throw new Error('not sent: OpenCode did not allow it')
          }
        }
        return t.deps.fetch(url, init)
      }
      const s = await search(post, query, endpoints)
      if (refused !== undefined) throw refused
      const lines = [
        `Registry search for "${query.slice(0, 200)}" (ARD v0.91 §5.3). The query text was sent to: ${[...new Set(s.registries.map(r => new URL(r.endpoint).host))].join(', ')}.`,
        'Registries asked:',
        ...s.registries.map(r => `  - ${r.endpoint}: ${r.state === 'ok' ? `${r.results} results` : `failed (${(r.note ?? '').slice(0, 200)})`}`),
      ]
      if (s.skipped) lines.push(`(${s.skipped} results of other types were ignored.)`)
      if (s.problems.length) lines.push('Problems:', ...s.problems.map(p => `  - ${p.slice(0, 300)}`))
      if (!s.entries.length) {
        lines.push('No MCP Server Cards matched.')
        return { text: shownText(lines.join('\n')) }
      }
      const r = await readOffered(t.deps, s.entries, ARD_SOURCES)
      t.shown(call.sessionID).rememberOffered(r.offered)
      const listedHosts = [...new Set(s.entries.map(x => new URL(x.listedIn).host))].join(', ')
      return { text: shownText(`${lines.join('\n')}\n\n${formatOffered(r, `the ARD registry at ${listedHosts}`)}`) }
    },
  }

  return [discoverTool, searchTool, addTool(t), removeTool(t)]
}

export const NAMESPACE_DESCRIPTION =
  "Agentic Resource Discovery (ARD v0.91 draft) for MCP servers: discover reads a domain's ard.json and AI Catalog; search sends a query to an ARD registry, a third party, once OpenCode's permission rules allow it; add_mcp_server adds a server either one showed, once they allow that too. " +
  "A registry's order is relevance, not trust; a result is confirmed only when its publisher's own catalog lists it."

export async function setup(ctx: Context, env: NodeJS.ProcessEnv = process.env) {
  host.name = 'OpenCode'
  if (/^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '') || ctx.options?.off === true) return
  // Searches, additions and removals ask by default, whatever OpenCode's default rules say (consent.ts).
  const consent = askByDefaultOff(ctx.options?.askByDefault, env.ARD_DISCOVERY_ASK_BY_DEFAULT)
    ? async () => {}
    : await askByDefault(ctx, { actions: [SEARCH_ACTION, ACTIONS.add, ACTIONS.remove], prefix: NAME, plugin: NAME, log: () => {} })
  const added = new AddedServers(ctx)
  await added.start()
  const t: ToolSet = {
    deps: { fetch: nodeFetch({ userAgent: `${NAME}/${VERSION} (OpenCode polyfill)` }), store: memoryStore(), now: () => Date.now() },
    ctx,
    shown: shownBySession(),
    added,
    names: { discover: `${NAMESPACE}_discover`, add: `${NAMESPACE}_add_mcp_server`, remove: `${NAMESPACE}_remove_mcp_server` },
    foundBy: `${NAMESPACE}_discover or ${NAMESPACE}_search`,
  }
  await registerTools(ctx, { name: NAMESPACE, description: NAMESPACE_DESCRIPTION }, tools(t, registrySetting(env)))
  return consent
}

const plugin: Plugin = { id: NAME, setup: ctx => setup(ctx) }
export default plugin
