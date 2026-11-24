// Server Cards that another plugin found (a search registry, say) and hands to
// this one through present_server_cards: the same reading, checks and picker as
// the cards this plugin finds itself, and nothing taken on the finder's word.
//
// - Each entry is an AI Catalog entry (identifier; exactly one of url, data).
//   A `url` is fetched with the card media type, under the same address rules
//   as a catalog's (no step from a public source to a private address); every
//   card is validated against the schema.
// - Who stands behind a card: the publisher is the domain in the identifier's
//   `urn:air:<publisher>:…` (AI Catalog's identifier format). The server counts
//   as confirmed only when that domain's own catalog lists the same identifier
//   with a valid card, and then the publisher's card is the one shown and
//   added. A finder's ranking or description is shown as the finder's.

import { CARD_TYPE, hasMarkup, hasUserinfo, type Remote, type ServerCard } from './card'
import { discover, isAllowedUrl, isPrivateHost, mayFollow, readCard, type Deps, type DiscoverOptions } from './discover'
import { cachedGet } from './http'

/** Entries read from one hand-over. */
const MAX_READ = 50
/** Entries shown (and fetched) from one hand-over. */
export const MAX_OFFERED = 10
/** Publisher catalogs read for one hand-over. */
const MAX_PUBLISHER_CHECKS = 5

export type OfferedEntry = {
  identifier: string
  url?: string
  data?: unknown
  /** where the finder found it: a registry's endpoint, a catalog's URL */
  listedIn: string
  displayName?: string
  description?: string
  score?: number
}

export type Publisher =
  | { state: 'confirmed'; catalog: string; sameCard: boolean }
  | { state: 'card-refused'; catalog: string; errors: string[] }
  | { state: 'not-listed'; catalogs: number }
  | { state: 'no-catalog' }
  | { state: 'no-publisher' }
  | { state: 'not-checked' }

export type Offered = {
  identifier: string
  displayName?: string
  description?: string
  score?: number
  listedIn: string
  cardUrl?: string
  /** the card the finder pointed to */
  card?: ServerCard
  errors: string[]
  publisherDomain?: string
  publisher?: Publisher
  /**
   * The card shown and added: the publisher's own when the publisher confirms
   * the server, else the finder's.
   */
  installCard?: ServerCard
  /** the card and where it was found are this machine or its network */
  isLocal: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The `<publisher>` segment of a urn:air identifier, when it is a public domain
 * name: normalised the way a URL would be (so `127.0.0.0x1` is seen as
 * `127.0.0.1`), and never an address or a local name, so a finder's result
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

const sameRemotes = (a: Remote[] | undefined, b: Remote[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}

/**
 * Reads the entries a finder handed over: cards fetched, validated, and checked
 * against their publisher. `sources` are the further catalogs and link
 * relations the finder reads (ARD's ard.json, say), read on the publisher's
 * domain too, so a publisher that lists its server only there still confirms it.
 */
export const readOffered = async (
  deps: Deps,
  entries: readonly unknown[],
  sources: DiscoverOptions = {},
): Promise<{ offered: Offered[]; skipped: number; problems: string[] }> => {
  const offered: Offered[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  let skipped = 0
  if (entries.length > MAX_READ) problems.push(`${entries.length} entries handed over; only the first ${MAX_READ} were read`)
  for (const r of entries.slice(0, MAX_READ)) {
    if (!isObject(r) || typeof r.identifier !== 'string' || typeof r.listedIn !== 'string') {
      problems.push('an entry without an "identifier" or "listedIn" was skipped')
      continue
    }
    if (r.type !== undefined && r.type !== CARD_TYPE) {
      skipped++
      continue
    }
    // Where it was found is shown beside it, and in the question an add puts
    // to the person: no markup that could show as something else.
    if (hasMarkup(r.listedIn)) {
      problems.push('an entry whose "listedIn" holds `, <, > or a square bracket was skipped')
      continue
    }
    if (hasUserinfo(r.listedIn)) {
      problems.push('an entry whose "listedIn" names a user before its host (an "@") was skipped')
      continue
    }
    if (seen.has(r.identifier)) continue
    seen.add(r.identifier)
    const fromLocal = isPrivateHost(hostOf(r.listedIn) || 'x')
    const o: Offered = {
      identifier: r.identifier,
      displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      listedIn: r.listedIn,
      errors: [],
      publisherDomain: publisherOf(r.identifier),
      isLocal: fromLocal,
    }
    if ((r.url !== undefined) === (r.data !== undefined)) o.errors = ['the entry must have exactly one of "url" or "data"']
    else if (r.data !== undefined) {
      const read = readCard(r.data)
      if ('card' in read) o.card = read.card
      else o.errors = read.errors
    } else if (typeof r.url !== 'string') o.errors = ['"url" is not a string']
    else {
      let u: URL | undefined
      try {
        u = new URL(r.url)
        u.hash = ''
      } catch {}
      if (!u) o.errors = [`"${r.url}" is not a URL`]
      else if (!isAllowedUrl(u)) o.errors = [`${u.href}: Server Cards must be served over HTTPS`]
      else if (!mayFollow(u, fromLocal)) o.errors = [`${u.href}: a public source may not point at a local or private address`]
      else if (hasMarkup(u.href)) o.errors = ['the card URL holds `, <, > or a square bracket outside an IPv6 host, which could show as something else']
      else if (hasUserinfo(u.href)) o.errors = ['the card URL names a user before its host (an "@"), so it would show one host and connect to another']
      else {
        o.cardUrl = u.href
        o.isLocal = fromLocal && isPrivateHost(u.hostname)
      }
    }
    offered.push(o)
  }
  const shown = offered.slice(0, MAX_OFFERED)
  if (offered.length > MAX_OFFERED) problems.push(`${offered.length} servers handed over; only the first ${MAX_OFFERED} are shown`)

  await Promise.all(
    shown.map(async o => {
      if (!o.cardUrl || o.card || o.errors.length) return
      try {
        const res = await cachedGet(deps.fetch, deps.store, o.cardUrl, CARD_TYPE, deps.now())
        if (!res.ok) return void (o.errors = [`fetching the card answered HTTP ${res.status}`])
        let card: unknown
        try {
          card = JSON.parse(res.text)
        } catch {
          return void (o.errors = ['the card is not JSON'])
        }
        const read = readCard(card)
        if ('card' in read) o.card = read.card
        else o.errors = read.errors
      } catch (err) {
        o.errors = [`fetching the card failed: ${err instanceof Error ? err.message : String(err)}`]
      }
    }),
  )

  let checks = 0
  for (const o of shown) {
    if (!o.card) continue
    o.installCard = o.card
    if (!o.publisherDomain) {
      o.publisher = { state: 'no-publisher' }
      continue
    }
    if (++checks > MAX_PUBLISHER_CHECKS) {
      o.publisher = { state: 'not-checked' }
      continue
    }
    const d = await discover(deps, o.publisherDomain, sources)
    if ('error' in d) {
      o.publisher = { state: 'no-catalog' }
      continue
    }
    const listed = d.servers.find(s => s.identifier === o.identifier)
    const catalogs = d.sources.filter(s => s.state === 'found' && s.kind !== 'page').length
    if (listed?.card) {
      o.publisher = { state: 'confirmed', catalog: listed.listedIn[0]!, sameCard: sameRemotes(listed.card.remotes, o.card.remotes) }
      o.installCard = listed.card
      o.isLocal = false
    } else if (listed) o.publisher = { state: 'card-refused', catalog: listed.listedIn[0]!, errors: listed.errors }
    else o.publisher = catalogs ? { state: 'not-listed', catalogs } : { state: 'no-catalog' }
  }
  if (checks > MAX_PUBLISHER_CHECKS) problems.push(`only the first ${MAX_PUBLISHER_CHECKS} valid servers were checked against their publisher`)
  return { offered: shown, skipped, problems }
}
