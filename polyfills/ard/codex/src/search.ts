// The ARD search and discovery rules shared by every host's form: what a
// search may hold, where it goes, the question that names both, and how its
// results are shown. Kept apart from main.ts, which starts the Codex server
// when it is the program node runs: another form imports this module instead.

import { hasMarkup, hasUserinfo } from '../../../server-cards/claude-code/mod/hooks/card'
import { discover, type DiscoverOptions } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatOffered } from '../../../server-cards/claude-code/mod/hooks/format'
import { readOffered } from '../../../server-cards/claude-code/mod/hooks/offer'
import { Session, shownText } from '../../../server-cards/codex/src/tools'
import { search, searchEndpoint } from '../../claude-code/mod/hooks/registry'

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
  'No ARD registry is set, and this search names none. Ask the person which registry to search (a registry base URL, or a domain whose catalog lists one) and pass it as `registry`; they can also set one with ARD_DISCOVERY_REGISTRY in the environment Codex starts in. Nothing was sent.'
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
/** Why a registry could not be named in the form exactly as it is searched, or undefined (as in the Claude Code form). */
const unshowable = (registry: string, from: string) =>
  registry.length > SHOWN_REGISTRY || UNSEEN.test(registry) || /\s/.test(registry)
    ? `${from} must be at most ${SHOWN_REGISTRY} characters, with no spaces, control characters or direction marks, so the form names exactly where the search goes. Nothing was sent.`
    : undefined

/** The search form's choices. */
export const SEARCH_CHOICES = { yes: { value: 'search', title: 'Send the search' }, no: { value: 'no', title: "Don't send it" } } as const

/** The registry setting: ARD_DISCOVERY_REGISTRY. Unset or empty, no registry is chosen for the person: a search names its own. */
export const registrySetting = (env: NodeJS.ProcessEnv) => (env.ARD_DISCOVERY_REGISTRY ?? '').trim()


/** A search as the person is asked about it: the query, the endpoints it goes to, and the question. */
export type PreparedSearch = { query: string; endpoints: string[]; question: string } | { refuse: string }

/**
 * Checks an ard_search call and works out where it would go, sending nothing:
 * the query as the person will see it, the registry endpoints (a domain's
 * catalogs are read to find them, a GET with no query), and the question that
 * names both. Each host's form asks it in its own way.
 */
export async function prepareSearch(session: Session, args: Record<string, unknown>, defaultRegistry: string): Promise<PreparedSearch> {
  const query = (str(args.query) ?? '').trim()
  if (!query) return { refuse: 'Give `query`: what the person needs, in plain words.' }
  // What is sent is what the question showed (security review R1).
  if (query.length > SHOWN_QUERY) return { refuse: `Keep the search under ${SHOWN_QUERY} characters, so the person sees all of it before it is sent.` }
  if (UNSEEN.test(query)) return { refuse: 'Write the search on one line, without control characters or direction marks, so the person sees exactly what is sent.' }
  if (MARKUP.test(query)) return { refuse: 'Write the search in plain words, without `, <, > or square brackets, so the form shows exactly what is sent.' }
  const asked = (str(args.registry) ?? defaultRegistry).trim()
  // No registry is chosen for the person: with none set and none named,
  // there is nothing to ask about, and nothing is sent.
  if (!asked) return { refuse: NO_REGISTRY }
  // The form names the registry as it is searched, as it shows the query.
  const unnamed = unshowable(asked, str(args.registry) !== undefined ? 'The `registry` in this search' : 'ARD_DISCOVERY_REGISTRY')
  if (unnamed) return { refuse: unnamed }

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
    if (typeof ep !== 'string') return { refuse: ep.error }
    endpoints = [ep]
  }
  endpoints = [...new Set(endpoints)].slice(0, 3)
  // Each endpoint is shown in the form as it is: it must read as the host
  // it reaches (security reviews C1 and C3).
  const unclear = endpoints.find(ep => hasMarkup(ep) || hasUserinfo(ep))
  if (unclear)
    return { refuse: `The registry ${unclear} holds markup or names a user before its host, so the form could show one host while the query goes to another. Nothing was sent.` }
  const question = shownText(
    [
      // The hosts first, as in mcp-server-cards' form: some clients join the lines.
      `${[...new Set(endpoints.map(ep => new URL(ep).host))].join(', ')}: send this search to ${endpoints.join(', ')}, and to up to three registries ${endpoints.length === 1 ? 'it refers' : 'they refer'} to?`,
      `Query: "${query}"`,
      'A registry is a service someone else runs, and it sees the query.',
    ].join('\n'),
  )
  return { query, endpoints, question }
}

/** Runs a search the person approved, and shows what came back. */
export async function runSearch(session: Session, query: string, endpoints: string[]): Promise<string> {
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
    return shownText(lines.join('\n'))
  }
  // ARD's sources go with the entries, so a publisher that lists its
  // server only in ard.json still confirms it.
  const r = await readOffered(session.deps, s.entries, ARD_SOURCES)
  session.rememberOffered(r.offered)
  const hosts = [...new Set(s.entries.map(x => new URL(x.listedIn).host))].join(', ')
  return shownText(`${lines.join('\n')}\n\n${formatOffered(r, `the ARD registry at ${hosts}`)}`)
}
