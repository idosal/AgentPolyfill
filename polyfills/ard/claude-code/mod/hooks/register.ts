import type { EngineInterface, Register } from 'claude-code'
import { search, searchEndpoint, type Post } from './registry'
import { originOf } from './urls'

const PLUGIN = 'ard-discovery'
const DISCOVER = 'ard_discover'
const SEARCH = 'ard_search'
// mcp-server-cards (a dependency in plugin.json) reads the catalogs, checks
// the cards, shows them with its picker and adds the one chosen.
const PRESENT = 'mcp__mcp-server-cards__present_server_cards'
const BY = 'ard-discovery (ARD v0.91 draft)'
// ARD v0.91 §5.1: a consumer resolving a domain MUST fetch /.well-known/ard.json
// (a manifest, which need not carry specVersion) and MUST honour rel="ard".
const ARD_SOURCES = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'] }
// The plugin ships with no registry: which one sees the person's words is theirs to choose.
const NO_REGISTRY =
  'No ARD registry is set, and this search names none. Ask the person which registry to search (a registry base URL, or a domain whose catalog lists one) and pass it as `registry`; they can also set one under the plugin in /config.'

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
/** Text for the person's prompt: control characters out, one line, capped. */
/** The longest query the ask shows, and so the longest that is sent. */
const SHOWN_QUERY = 300
/** Characters that display as something else or as nothing: C0 and C1 controls,
 * zero-width and direction marks, line and paragraph separators, BOM. The same
 * set as mcp-server-cards' UNSAFE_TEXT, plus U+2028 and U+2029. */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
const shown = (v: string, max: number) => v.replace(new RegExp(UNSEEN.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, max)
/** The longest registry the ask names, and so the longest searched. */
const SHOWN_REGISTRY = 200
/** Why a registry could not be named in the ask exactly as it is searched, or undefined: shown() would change it. */
const unshowable = (registry: string, from: string) =>
  registry.length > SHOWN_REGISTRY || UNSEEN.test(registry) || /\s/.test(registry)
    ? `${from} must be at most ${SHOWN_REGISTRY} characters, with no spaces, control characters or direction marks, so the person sees exactly where the search goes.`
    : undefined
/** Where a search's registry came from, for a refusal. */
const registryFrom = (input: Record<string, unknown>) => (str(input.registry) !== undefined ? 'The `registry` in this search' : 'The `registry` setting')

type Presented = { text: string; servers: number; registries: { identifier: string; url?: string; displayName?: string }[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * mcp-server-cards' answer, however the host hands a registered tool's result
 * back to a plugin's $.tool.call: the object its tool.run returned, that object
 * as JSON text, MCP content blocks or structuredContent, or core's `text`.
 */
export const readAnswer = (r: { result?: unknown; text?: unknown }): Presented | undefined => {
  const fromObject = (v: unknown): Presented | undefined =>
    isObject(v) && typeof v.text === 'string'
      ? {
          text: v.text,
          servers: typeof v.servers === 'number' ? v.servers : 0,
          registries: Array.isArray(v.registries) ? v.registries.filter(isObject).map(x => x as Presented['registries'][number]) : [],
        }
      : undefined
  const fromText = (t: unknown): Presented | undefined => {
    if (typeof t !== 'string') return undefined
    try {
      return fromObject(JSON.parse(t))
    } catch {
      return undefined
    }
  }
  const fromBlocks = (v: unknown): Presented | undefined => {
    const blocks = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.content) ? v.content : undefined
    if (!blocks) return undefined
    return fromText(blocks.map(b => (isObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(''))
  }
  const res = r.result
  return (
    fromObject(res) ??
    (isObject(res) ? fromObject(res.structuredContent) : undefined) ??
    fromText(res) ??
    fromBlocks(res) ??
    fromText(r.text)
  )
}

/** The shape of an answer, without its content, for a message saying it can't be read. */
const shapeOf = (v: unknown): string =>
  Array.isArray(v) ? `array(${v.length})` : isObject(v) ? `{${Object.keys(v).slice(0, 6).join(',')}}` : typeof v

/** Hands a request to mcp-server-cards; what it answers, or why not. */
async function present($: EngineInterface, payload: Record<string, unknown>): Promise<Presented | { deny: string }> {
  let r: Awaited<ReturnType<EngineInterface['tool']['call']>>
  try {
    r = await $.tool.call({ tool: PRESENT, ...payload } as never)
  } catch {
    return { deny: `${PLUGIN} needs the mcp-server-cards plugin, which shows and adds what it finds: /plugin install mcp-server-cards --marketplace idosal/AgentPolyfill` }
  }
  if (r.deny !== undefined) return { deny: r.deny }
  if ((r as { isError?: boolean }).isError) return { deny: `mcp-server-cards failed: ${String(r.text ?? '').slice(0, 300)}` }
  const out = readAnswer(r as { result?: unknown; text?: unknown })
  if (!out)
    return { deny: `mcp-server-cards gave an answer ${PLUGIN} can't read (result ${shapeOf(r.result)}, text ${shapeOf(r.text)}); update both plugins.` }
  return out
}

function post($: EngineInterface): Post {
  return (url, init) => $.http.fetch(url, init)
}

export const register: Register = (on, options) => {
  if (options.disabled === true) return
  const defaultRegistry = typeof options.registry === 'string' ? options.registry.trim() : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: DISCOVER,
      isDeferred: false,
      description:
        'Find the MCP servers a domain publishes through Agentic Resource Discovery (ARD, a v0.91 draft): reads https://<domain>/.well-known/ard.json and rel="ard" links on the page, beside the AI Catalog that mcp-server-cards reads, and shows each MCP Server Card through mcp-server-cards (checked, with its Add picker). ' +
        'Use when the person wants to connect Claude Code to a service by its domain and discover_mcp_servers found nothing, or when they ask for ARD. Read-only: public documents from that domain and the card URLs its catalogs name.',
      inputSchema: {
        type: 'object',
        properties: { domain: { type: 'string', description: 'A domain ("buildkite.com") or a page URL on it.' } },
        required: ['domain'],
      },
    })
    await $.tool.register({
      name: SEARCH,
      isDeferred: false,
      description:
        'Search an ARD registry for MCP servers that can do a task, described in plain words ("check why my CI build failed"). ' +
        'The query text is sent to a third party: the registry ' +
        (defaultRegistry
          ? `(${defaultRegistry} unless \`registry\` names another)`
          : '(none is configured: pass `registry` with the one the person names. Do not choose a registry for them; if they have not named one, ask which)') +
        ', which ranks other people\'s servers. Its referrals are followed one hop. The results are shown through mcp-server-cards, which checks each card and whether the publisher\'s own domain lists the server. ' +
        'Use when the person asks to find a server for a task, or a task needs a capability no tool in this session has and the person has not named a service. Claude Code asks the person before every search, showing the query and where it goes; with nobody to ask, the search is refused. ' +
        'Say which registry answered, that its order is relevance, not trust, and which results their publisher confirms.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the person needs, in plain words. It is sent to the registry.' },
          registry: {
            type: 'string',
            description:
              'A registry base URL, or a domain whose catalog lists a registry (an application/ai-registry+json entry): the one the person names. ' +
              (defaultRegistry ? 'Leave it out to use the configured registry.' : 'No registry is configured, so a search without it is refused.'),
          },
        },
        required: ['query'],
      },
    })
    return started
  })

  on('tool.run', { tool: `mcp__${PLUGIN}__${DISCOVER}` }, async ($, e) => {
    const domain = str((e as Record<string, unknown>).domain) ?? ''
    const target = originOf(domain)
    if ('error' in target) return { deny: target.error }
    const r = await present($, { by: BY, under: e.tool_use_id, domain, ...ARD_SOURCES })
    if ('deny' in r) return { deny: r.deny }
    return { result: r.text }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: discovery failed.` }))

  // Every search is put to the person first, with the words and where they go
  // (security review M2): a search sends what Claude wrote to a registry
  // someone else runs, so no allow rule or auto mode answers it, and with
  // nobody to ask it is refused.
  on('tool.check', { tool: `mcp__${PLUGIN}__${SEARCH}` }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict
    const input = (e.input ?? {}) as Record<string, unknown>
    const named = (str(input.registry) ?? defaultRegistry).trim()
    // No registry is chosen for the person: with none set and none named,
    // there is nothing to ask about, and nothing is sent.
    if (!named) return { decision: 'deny' as const, reason: NO_REGISTRY }
    // The ask names the registry as it is searched, as it shows the query.
    const unnamed = unshowable(named, registryFrom(input))
    if (unnamed) return { decision: 'deny' as const, reason: unnamed }
    if (e.approver === undefined)
      return { decision: 'deny' as const, reason: 'A search sends your words to a registry someone else runs, and nobody can be asked in this session.' }
    const query = shown(str(input.query) ?? '', SHOWN_QUERY)
    const reason = /^https?:\/\//i.test(named)
      ? `Send this search to ${named}, and to up to three registries it refers to? "${query}"`
      : `Send this search to the registries that ${named} lists (up to three), and to up to three registries they refer to? "${query}"`
    return { decision: 'ask' as const, reason }
  }).catch(($, e, next) => ({
    decision: 'ask' as const,
    reason: 'ard-discovery could not describe this search. It sends the query in the call to an ARD registry someone else runs; check both before you allow it.',
  }))

  on('tool.run', { tool: `mcp__${PLUGIN}__${SEARCH}` }, async ($, e) => {
    const input = e as Record<string, unknown>
    const query = (str(input.query) ?? '').trim()
    if (!query) return { deny: 'Give `query`: what the person needs, in plain words.' }
    // What is sent is what the ask showed (security review R1): no longer than
    // the ask shows, and no control characters, which the ask would blank.
    if (query.length > SHOWN_QUERY)
      return { deny: `Keep the search under ${SHOWN_QUERY} characters, so the person sees all of it before it is sent.` }
    if (UNSEEN.test(query))
      return { deny: 'Write the search on one line, without control characters or direction marks, so the person sees exactly what is sent.' }
    const asked = (str(input.registry) ?? defaultRegistry).trim()
    if (!asked) return { deny: NO_REGISTRY }
    const unnamed = unshowable(asked, registryFrom(input))
    if (unnamed) return { deny: unnamed }

    // A domain whose catalogs list registries (application/ai-registry+json) is
    // used through those entries, read by mcp-server-cards under its address
    // rules; anything else is taken as a registry base URL.
    let endpoints: string[] = []
    if (!/^https?:\/\//i.test(asked)) {
      const listed = await present($, { by: BY, domain: asked, ...ARD_SOURCES })
      if ('deny' in listed && listed.deny.includes('needs the mcp-server-cards plugin')) return { deny: listed.deny }
      if (!('deny' in listed))
        for (const r of listed.registries) if (r.url) {
          const ep = searchEndpoint(r.url)
          if (typeof ep === 'string') endpoints.push(ep)
        }
    }
    if (!endpoints.length) {
      const ep = searchEndpoint(/^https?:\/\//i.test(asked) ? asked : `https://${asked}`)
      if (typeof ep !== 'string') return { deny: ep.error }
      endpoints = [ep]
    }
    const s = await search(post($), query, endpoints)
    const lines = [
      `Registry search for "${query.slice(0, 200)}" (ARD v0.91 §5.3). The query text was sent to: ${[...new Set(s.registries.map(r => new URL(r.endpoint).host))].join(', ')}.`,
      'Registries asked:',
      ...s.registries.map(r => `  - ${r.endpoint}: ${r.state === 'ok' ? `${r.results} results` : `failed (${(r.note ?? '').slice(0, 200)})`}`),
    ]
    if (s.skipped) lines.push(`(${s.skipped} results of other types were ignored.)`)
    if (s.problems.length) lines.push('Problems:', ...s.problems.map(p => `  - ${p.slice(0, 300)}`))
    if (!s.entries.length) {
      lines.push('No MCP Server Cards matched.')
      return { result: lines.join('\n') }
    }
    const hosts = [...new Set(s.entries.map(x => new URL(x.listedIn).host))].join(', ')
    // ARD's sources go with the entries, so a publisher that lists its server
    // only in ard.json still confirms it.
    const shown = await present($, { by: `the ARD registry at ${hosts}`, under: e.tool_use_id, entries: s.entries, ...ARD_SOURCES })
    if ('deny' in shown) return { deny: shown.deny }
    return { result: `${lines.join('\n')}\n\n${shown.text}` }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: the search failed.` }))
}
