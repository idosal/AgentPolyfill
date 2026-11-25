// ARD Pi adapter. Registry, discovery and card logic stay in the shared modules.
import { hasMarkup, hasUserinfo } from '../../../server-cards/claude-code/mod/hooks/card'
import { discover, type DiscoverOptions } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatDiscovery, formatOffered } from '../../../server-cards/claude-code/mod/hooks/format'
import { readOffered } from '../../../server-cards/claude-code/mod/hooks/offer'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { install } from '../../../server-cards/pi/src/host'
import type { Tool } from '../../../server-cards/pi/src/tools'
import { addTool, askPerson, Session, shownText } from '../../../server-cards/pi/src/tools'
import { HIDDEN, search, searchEndpoint } from '../../claude-code/mod/hooks/registry'
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
export * from '../../../server-cards/pi/src/pi'
export * from '../../../server-cards/codex/src/fetch'
export * from '../../../server-cards/pi/src/host'
export * from '../../../server-cards/pi/src/tools'

export const NAME = 'ard-discovery'
export const VERSION = '0.1.0'
export const DISCOVER = 'ard_discover'
export const SEARCH = 'ard_search'
/** Its own name: Pi keeps the first tool registered under a name, and the Server Cards form registers add_mcp_server. */
export const ADD = 'ard_add_mcp_server'
export const BY = 'ard-discovery (ARD v0.91 draft)'
// ARD v0.91 §5.1: a consumer resolving a domain MUST fetch /.well-known/ard.json
// (a manifest, which need not carry specVersion) and MUST honour rel="ard".
export const ARD_SOURCES: DiscoverOptions = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: BY }
/** The longest query the question shows, and so the longest that is sent (as in the Claude Code form). */
export const SHOWN_QUERY = 300
/** The longest registry the question names, and so the longest searched (as in the Claude Code form). */
export const SHOWN_REGISTRY = 200
// The plugin ships with no registry: which one sees the person's words is theirs to choose.
export const NO_REGISTRY =
  'No ARD registry is set, and this search names none. Ask the person which registry to search (a registry base URL, or a domain whose catalog lists one) and pass it as `registry`; they can also set one with ARD_DISCOVERY_REGISTRY in the environment Pi starts in. Nothing was sent.'
/** Characters that display as something else or as nothing, tag characters among them (registry.ts HIDDEN, as in the Claude Code form). */
const UNSEEN = HIDDEN
/**
 * Markdown and HTML a host could render in the form: a query such as
 * `check [my CI](https://evil.example/)` would show "check my CI" while the
 * whole text is sent. Refused, so what is sent is exactly what the form shows
 * (the same rule as card URLs, security review C1).
 */
const MARKUP = /[`<>[\]]/

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })
/** Why a registry could not be named in the form exactly as it is searched, or undefined (as in the Claude Code form). */
const unshowable = (registry: string, from: string) =>
  registry.length > SHOWN_REGISTRY || UNSEEN.test(registry) || /\s/.test(registry)
    ? `${from} must be at most ${SHOWN_REGISTRY} characters, with no spaces, control characters or direction marks, so the form names exactly where the search goes. Nothing was sent.`
    : undefined

/** The search form's choices. */
export const SEARCH_CHOICES = { yes: 'Send the search', no: "Don't send it" } as const

/** The registry setting: ARD_DISCOVERY_REGISTRY. Unset or empty, no registry is chosen for the person: a search names its own. */
export const registrySetting = (env: NodeJS.ProcessEnv) => (env.ARD_DISCOVERY_REGISTRY ?? '').trim()

export function tools(session: Session, defaultRegistry: string): Tool[] {
  const discoverTool: Tool = {
    name: DISCOVER,
    description:
      'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog (/.well-known/ai-catalog.json), fetches each MCP Server Card they list and checks it against the schema. ' +
      'Use when the person wants to connect Pi to a service by its domain and asks for ARD, or the AI Catalog lists nothing. Read-only: public documents from that domain and the card URLs its catalogs name.',
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
      ", which ranks other people's servers. Its referrals are followed one hop. Pi asks the person with a question before anything is sent, naming the registry and the query; without that question, or if they decline, nothing is sent. " +
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
    // Not read-only: it sends the person's words to a third party (permission extensions read this hint).
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args, ctx, signal) => {
      const query = (str(args.query) ?? '').trim()
      if (!query) return refuse('Give `query`: what the person needs, in plain words.')
      // What is sent is what the question showed (security review R1).
      if (query.length > SHOWN_QUERY) return refuse(`Keep the search under ${SHOWN_QUERY} characters, so the person sees all of it before it is sent.`)
      if (UNSEEN.test(query)) return refuse('Write the search on one line, without control characters, direction marks or hidden characters, so the person sees exactly what is sent.')
      if (MARKUP.test(query)) return refuse('Write the search in plain words, without `, <, > or square brackets, so the form shows exactly what is sent.')
      const asked = (str(args.registry) ?? defaultRegistry).trim()
      // No registry is chosen for the person: with none set and none named,
      // there is nothing to ask about, and nothing is sent.
      if (!asked) return refuse(NO_REGISTRY)
      // The form names the registry as it is searched, as it shows the query.
      const unnamed = unshowable(asked, str(args.registry) !== undefined ? 'The `registry` in this search' : 'ARD_DISCOVERY_REGISTRY')
      if (unnamed) return refuse(unnamed)

      // A domain whose catalogs list registries (application/ai-registry+json)
      // is used through those entries; anything else is a registry base URL.
      // Reading the domain's catalogs is a GET and sends no query, so the
      // question can name the exact endpoints.
      let endpoints: string[] = []
      if (!/^https?:\/\//i.test(asked)) {
        const d = await discover(session.deps, asked, ARD_SOURCES)
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
      // Each endpoint is shown in the form as it is: it must read as the host
      // it reaches (security reviews C1 and C3).
      const unclear = endpoints.find(ep => hasMarkup(ep) || hasUserinfo(ep))
      if (unclear)
        return refuse(`The registry ${unclear} holds markup or names a user before its host, so the form could show one host while the query goes to another. Nothing was sent.`)

      // Every search is put to the person first, with the words and where they
      // go (security review M2); refused with no form, or a decline or close.
      const ok = await askPerson(
        ctx,
        shownText(
          [
            // The hosts first, as in mcp-server-cards' form: some clients join the lines.
            `${[...new Set(endpoints.map(ep => new URL(ep).host))].join(', ')}: send this search to ${endpoints.join(', ')}, and to up to three registries ${endpoints.length === 1 ? 'it refers' : 'they refer'} to?`,
            `Query: "${query}"`,
            'A registry is a service someone else runs, and it sees the query.',
          ].join('\n'),
        ),
        SEARCH_CHOICES.yes,
        SEARCH_CHOICES.no,
        signal,
      )
      if ('why' in ok) return refuse(`Nothing was sent: ${ok.why}.`)

      if (signal?.aborted) return refuse('Nothing was sent: the tool call was cancelled.')
      const s = await search(session.deps.fetch, query, endpoints)
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
      // ARD's sources go with the entries, so a publisher that lists its
      // server only in ard.json still confirms it.
      const r = await readOffered(session.deps, s.entries, ARD_SOURCES)
      session.rememberOffered(r.offered)
      const hosts = [...new Set(s.entries.map(x => new URL(x.listedIn).host))].join(', ')
      return { text: shownText(`${lines.join('\n')}\n\n${formatOffered(r, `the ARD registry at ${hosts}`)}`) }
    },
  }

  return [discoverTool, searchTool, addTool(session, DISCOVER, `${DISCOVER} or ${SEARCH}`, ADD)]
}

export default function ard(pi: ExtensionAPI) {
  install(pi, 'ARD_DISCOVERY_DISABLED', session => tools(session, registrySetting(process.env)))
}
