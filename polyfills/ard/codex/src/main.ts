// ard-discovery for Codex: a stdio MCP server with ard_discover, ard_search
// and add_mcp_server. Codex gives one plugin's MCP server no way to call
// another's tools, so this plugin carries the Server Cards core itself (the
// same modules, bundled) and shows and adds what it finds with the same checks
// as mcp-server-cards. Bundled into plugin/dist/server.mjs; importing it runs
// nothing, node running it starts the server.

import { hasMarkup, hasUserinfo } from '../../../server-cards/claude-code/mod/hooks/card'
import { discover, type DiscoverOptions } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatDiscovery, formatOffered } from '../../../server-cards/claude-code/mod/hooks/format'
import { readOffered } from '../../../server-cards/claude-code/mod/hooks/offer'
import { codexDeps, isMain, logger, useCodexHost } from '../../../server-cards/codex/src/host'
import { serve, type Tool } from '../../../server-cards/codex/src/mcp'
import { addTool, askPerson, Session, shownText } from '../../../server-cards/codex/src/tools'
import { search, searchEndpoint } from '../../claude-code/mod/hooks/registry'
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
export const VERSION = '0.1.0'
export const DISCOVER = 'ard_discover'
export const SEARCH = 'ard_search'
export const BY = 'ard-discovery (ARD v0.91 draft)'
export const DEFAULT_REGISTRY = 'https://huggingface-hf-discover.hf.space'
// ARD v0.91 §5.1: a consumer resolving a domain MUST fetch /.well-known/ard.json
// (a manifest, which need not carry specVersion) and MUST honour rel="ard".
export const ARD_SOURCES: DiscoverOptions = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: BY }
/** The longest query the question shows, and so the longest that is sent (as in the Claude Code form). */
export const SHOWN_QUERY = 300
/** Characters that display as something else or as nothing (as in the Claude Code form). */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
/**
 * Markdown and HTML a host could render in the form: a query such as
 * `check [my CI](https://evil.example/)` would show "check my CI" while the
 * whole text is sent. Refused, so what is sent is exactly what the form shows
 * (the same rule as card URLs, security review C1).
 */
const MARKUP = /[`<>[\]]/

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string) => ({ text: shownText(text), isError: true })

/** The registry setting: ARD_DISCOVERY_REGISTRY, which may be empty (search only a registry the request names). */
export const registrySetting = (env: NodeJS.ProcessEnv) =>
  env.ARD_DISCOVERY_REGISTRY !== undefined ? env.ARD_DISCOVERY_REGISTRY.trim() : DEFAULT_REGISTRY

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
      (defaultRegistry ? `(${defaultRegistry} unless \`registry\` names another)` : '(none is configured: pass `registry`)') +
      ", which ranks other people's servers. Its referrals are followed one hop. Codex asks the person in a form before anything is sent, naming the registry and the query; without that form, or if they decline, nothing is sent. " +
      "Each result's card is fetched and checked, and so is whether the publisher's own domain lists the server. " +
      'Use when the person asks to find a server for a task, or a task needs a capability no tool in this session has and the person has not named a service. ' +
      'Say which registry answered, that its order is relevance, not trust, and which results their publisher confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the person needs, in plain words, on one line and at most 300 characters. It is sent to the registry.' },
        registry: { type: 'string', description: 'Optional: a domain whose catalog lists a registry ("huggingface.co"), or a registry base URL. Default: the configured registry.' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args, ctx) => {
      const query = (str(args.query) ?? '').trim()
      if (!query) return refuse('Give `query`: what the person needs, in plain words.')
      // What is sent is what the question showed (security review R1).
      if (query.length > SHOWN_QUERY) return refuse(`Keep the search under ${SHOWN_QUERY} characters, so the person sees all of it before it is sent.`)
      if (UNSEEN.test(query)) return refuse('Write the search on one line, without control characters or direction marks, so the person sees exactly what is sent.')
      if (MARKUP.test(query)) return refuse('Write the search in plain words, without `, <, > or square brackets, so the form shows exactly what is sent.')
      const asked = (str(args.registry) ?? defaultRegistry).trim()
      if (!asked) return refuse('No registry is configured; pass `registry` (a domain whose catalog lists one, or a registry base URL).')

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
            `Send this search to ${endpoints.join(', ')}, and to up to three registries ${endpoints.length === 1 ? 'it refers' : 'they refer'} to?`,
            `Query: "${query}"`,
            'A registry is a service someone else runs, and it sees the query.',
          ].join('\n'),
        ),
      )
      if ('why' in ok) return refuse(`Nothing was sent: ${ok.why}.`)

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
