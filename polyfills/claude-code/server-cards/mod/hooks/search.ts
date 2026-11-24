// ARD registry search: the client side of Agentic Resource Discovery v0.91
// §5.3.2 (POST /search) and §5.4 (federation), restricted to MCP Server Cards.
// This is not part of SEP-2127; it is a second spec, kept in its own module.
//
// Rules implemented (see README "Registry search"):
// - §5.3: a registry entry's `url` is a base URL, and the client appends
//   `/search`; a referral's `url` is the complete search endpoint, and the
//   client MUST NOT append `/search`.
// - §5.3.2: `query.text` is required; `filter` narrows by term (`type` here);
//   `federation` is auto, referrals or none. A result MUST carry `identifier`;
//   its `url` addresses the artifact (the Server Card), not the ARD entry.
// - §5.3.2 / §5.3.3: `score` is relevance only and MUST NOT be read as trust.
// - §4.5.1 / Appendix C: the publisher is the domain in `urn:air:<publisher>:…`.
//   Trust manifests are not verified here; instead each valid result is checked
//   against the publisher's own catalog (Server Card domain discovery).

import { CARD_TYPE, type Remote, type ServerCard } from './card'
import { discover, isAllowedUrl, isPrivateHost, mayFollow, readCard, type Deps } from './discover'
import { cachedGet, MAX_BODY } from './http'

const MAX_REGISTRIES = 3
const MAX_REFERRALS = 3
const MAX_RESULTS = 10
/** Results read from one answer, whatever `pageSize` the registry honoured. */
const MAX_READ = 50
/** Publisher catalogs read for one search. */
const MAX_PUBLISHER_CHECKS = 5

export type Publisher =
  | { state: 'confirmed'; catalog: string; sameCard: boolean }
  | { state: 'card-refused'; catalog: string; errors: string[] }
  | { state: 'not-listed'; catalogs: number }
  | { state: 'no-catalog' }
  | { state: 'no-publisher' }
  | { state: 'not-checked' }

export type SearchHit = {
  identifier: string
  displayName?: string
  description?: string
  score?: number
  /** the registry (search endpoint) that returned it */
  registry: string
  /** the registry's `source`, when it reports one */
  source?: string
  cardUrl?: string
  /** the card the registry pointed to */
  card?: ServerCard
  errors: string[]
  publisherDomain?: string
  publisher?: Publisher
  /**
   * The card add_mcp_server installs and the one shown: the publisher's own
   * when the publisher confirms the server, else the registry's.
   */
  installCard?: ServerCard
}

export type RegistryCall = { endpoint: string; state: 'ok' | 'error'; note?: string; results?: number }

export type Search = {
  query: string
  registries: RegistryCall[]
  hits: SearchHit[]
  skipped: number
  problems: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The `<publisher>` segment of a urn:air identifier, when it is a public domain
 * name: normalised the way a URL would be (so `127.0.0.0x1` is seen as
 * `127.0.0.1`), and never an address or a local name, so a registry's result
 * cannot send the publisher check to this machine's own network.
 */
export const publisherOf = (identifier: string): string | undefined => {
  const m = /^urn:air:([^:]+):/i.exec(identifier)
  const raw = m?.[1]?.toLowerCase()
  if (!raw || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return undefined
  let host: string
  try {
    host = new URL(`https://${raw}/`).hostname
  } catch {
    return undefined
  }
  if (host !== raw || !/[a-z]/.test(host.split('.').pop()!) || isPrivateHost(host)) return undefined
  return host
}

/** A registry's search endpoint from its base URL (§5.3: append `/search` to the path). */
export const searchEndpoint = (base: string): string | { error: string } => {
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return { error: `"${base}" is not a URL` }
  }
  if (!isAllowedUrl(u)) return { error: `${u.href}: registries are reached over HTTPS (plain HTTP only for localhost)` }
  u.hash = ''
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/search`
  return u.href
}

/** Same remotes, compared as data. */
const sameRemotes = (a: Remote[] | undefined, b: Remote[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

export const search = async (deps: Deps, text: string, endpoints: string[]): Promise<Search> => {
  const out: Search = { query: text, registries: [], hits: [], skipped: 0, problems: [] }
  const byId = new Map<string, SearchHit>()
  const asked = new Set<string>()
  const referrals: string[] = []

  const ask = async (endpoint: string, isReferral: boolean) => {
    if (asked.has(endpoint)) return
    asked.add(endpoint)
    const fromLocal = isPrivateHost(new URL(endpoint).hostname)
    const call: RegistryCall = { endpoint, state: 'error' }
    out.registries.push(call)
    try {
      const res = await deps.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: { text, filter: { type: [CARD_TYPE] } },
          federation: 'referrals',
          pageSize: MAX_RESULTS,
        }),
      })
      if (res.text.length > MAX_BODY) {
        call.note = `the answer is larger than ${MAX_BODY / 1024} KiB`
        return
      }
      if (!res.ok) {
        let code = ''
        try {
          const err = JSON.parse(res.text) as { errorCode?: string; message?: string }
          code = [err.errorCode, err.message].filter(x => typeof x === 'string').join(': ')
        } catch {}
        call.note = `HTTP ${res.status}${code ? ` (${code.slice(0, 200)})` : ''}`
        return
      }
      let body: unknown
      try {
        body = JSON.parse(res.text)
      } catch {
        call.note = 'the answer is not JSON'
        return
      }
      if (!isObject(body) || !Array.isArray(body.results)) {
        call.note = 'the answer has no "results" array'
        return
      }
      call.state = 'ok'
      call.results = body.results.length
      if (body.results.length > MAX_READ)
        out.problems.push(`${endpoint} returned ${body.results.length} results; only the first ${MAX_READ} were read`)
      for (const r of body.results.slice(0, MAX_READ)) {
        if (!isObject(r) || typeof r.identifier !== 'string') {
          out.problems.push(`${endpoint}: a result without an "identifier" was skipped`)
          continue
        }
        // A registry may ignore the filter; only Server Cards are used here.
        if (r.type !== undefined && r.type !== CARD_TYPE) {
          out.skipped++
          continue
        }
        if (byId.has(r.identifier)) continue
        const hit: SearchHit = {
          identifier: r.identifier,
          displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
          description: typeof r.description === 'string' ? r.description : undefined,
          score: typeof r.score === 'number' ? r.score : undefined,
          registry: endpoint,
          source: typeof r.source === 'string' ? r.source : undefined,
          errors: [],
          publisherDomain: publisherOf(r.identifier),
        }
        if (r.data !== undefined) {
          const read = readCard(r.data)
          if ('card' in read) hit.card = read.card
          else hit.errors = read.errors
        } else if (typeof r.url !== 'string') {
          hit.errors = ['the result has no card "url" or "data"']
        } else {
          let u: URL | undefined
          try {
            u = new URL(r.url)
            u.hash = ''
          } catch {}
          if (!u) hit.errors = [`"${r.url}" is not a URL`]
          else if (!isAllowedUrl(u)) hit.errors = [`${u.href}: Server Cards must be served over HTTPS`]
          else if (!mayFollow(u, fromLocal)) hit.errors = [`${u.href}: a public registry may not point at a local or private address`]
          else hit.cardUrl = u.href
        }
        byId.set(hit.identifier, hit)
        out.hits.push(hit)
      }
      if (!isReferral && Array.isArray(body.referrals))
        for (const ref of body.referrals.slice(0, MAX_READ)) {
          if (!isObject(ref) || typeof ref.url !== 'string') continue
          let u: URL | undefined
          try {
            u = new URL(ref.url)
            u.hash = ''
          } catch {}
          // §5.3: a referral's url is the search endpoint itself; nothing is appended.
          if (u && mayFollow(u, fromLocal)) referrals.push(u.href)
          else out.problems.push(`${endpoint}: referral ${String(ref.url).slice(0, 200)} is not HTTPS on a public host; not followed`)
        }
    } catch (err) {
      call.note = err instanceof Error ? err.message : String(err)
    }
  }

  const first = [...new Set(endpoints)]
  if (first.length > MAX_REGISTRIES)
    out.problems.push(`${first.length} registries named; only the first ${MAX_REGISTRIES} were asked`)
  await Promise.all(first.slice(0, MAX_REGISTRIES).map(e => ask(e, false)))
  // One hop of referrals, bounded, so a registry cannot fan the client out.
  const follow = [...new Set(referrals)].filter(r => !asked.has(r))
  if (follow.length > MAX_REFERRALS)
    out.problems.push(`${follow.length} referrals offered; only the first ${MAX_REFERRALS} were followed`)
  await Promise.all(follow.slice(0, MAX_REFERRALS).map(e => ask(e, true)))

  out.hits.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  out.hits = out.hits.slice(0, MAX_RESULTS)

  // The registry's cards.
  await Promise.all(
    out.hits.map(async hit => {
      if (!hit.cardUrl || hit.card || hit.errors.length) return
      try {
        const res = await cachedGet(deps.fetch, deps.store, hit.cardUrl, CARD_TYPE, deps.now())
        if (!res.ok) return void (hit.errors = [`fetching the card answered HTTP ${res.status}`])
        let card: unknown
        try {
          card = JSON.parse(res.text)
        } catch {
          return void (hit.errors = ['the card is not JSON'])
        }
        const read = readCard(card)
        if ('card' in read) hit.card = read.card
        else hit.errors = read.errors
      } catch (err) {
        hit.errors = [`fetching the card failed: ${err instanceof Error ? err.message : String(err)}`]
      }
    }),
  )

  // Who stands behind a valid card: does the publisher's own catalog list it,
  // with a valid card of its own? Only then is the server confirmed, and the
  // publisher's card is the one shown and installed.
  let checks = 0
  for (const hit of out.hits) {
    if (!hit.card) continue
    hit.installCard = hit.card
    if (!hit.publisherDomain) {
      hit.publisher = { state: 'no-publisher' }
      continue
    }
    if (++checks > MAX_PUBLISHER_CHECKS) {
      hit.publisher = { state: 'not-checked' }
      continue
    }
    const d = await discover(deps, hit.publisherDomain)
    if ('error' in d) {
      hit.publisher = { state: 'no-catalog' }
      continue
    }
    const listed = d.servers.find(s => s.identifier === hit.identifier)
    const catalogs = d.sources.filter(s => s.state === 'found' && s.kind !== 'page').length
    if (listed?.card) {
      hit.publisher = { state: 'confirmed', catalog: listed.listedIn[0]!, sameCard: sameRemotes(listed.card.remotes, hit.card.remotes) }
      hit.installCard = listed.card
    } else if (listed) {
      hit.publisher = { state: 'card-refused', catalog: listed.listedIn[0]!, errors: listed.errors }
    } else hit.publisher = catalogs ? { state: 'not-listed', catalogs } : { state: 'no-catalog' }
  }
  if (checks > MAX_PUBLISHER_CHECKS)
    out.problems.push(`only the first ${MAX_PUBLISHER_CHECKS} valid results were checked against their publisher`)
  return out
}
