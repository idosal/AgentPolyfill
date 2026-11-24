// ARD registry search: the client side of Agentic Resource Discovery v0.91
// §5.3.2 (POST /search) and §5.4 (federation), for MCP Server Cards. What it
// finds is handed to mcp-server-cards, which fetches, checks and shows the cards.
//
// Rules implemented (see README "Client rules"):
// - §5.3: a registry entry's `url` is a base URL, and the client appends
//   `/search`; a referral's `url` is the complete search endpoint, and the
//   client MUST NOT append `/search`.
// - §5.3.2: `query.text` is required; `filter` narrows by term (`type` here);
//   `federation` is auto, referrals or none. A result MUST carry `identifier`;
//   its `url` addresses the artifact (the Server Card), not the ARD entry.
// - §5.3.2 / §5.3.3: `score` is relevance only and MUST NOT be read as trust.
// - Appendix B: the standard error codes.

import { isAllowedUrl, mayFollow, isPrivateHost } from './urls'

export const CARD_TYPE = 'application/mcp-server-card+json'
const MAX_REGISTRIES = 3
const MAX_REFERRALS = 3
const MAX_RESULTS = 10
/** Results read from one answer, whatever `pageSize` the registry honoured. */
const MAX_READ = 50
/** The largest registry answer read. */
export const MAX_BODY = 512 * 1024

export type Post = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type RegistryCall = { endpoint: string; state: 'ok' | 'error'; note?: string; results?: number }

/** A result as handed to mcp-server-cards (present_server_cards `entries`). */
export type Entry = {
  identifier: string
  type: string
  url?: string
  data?: unknown
  listedIn: string
  displayName?: string
  description?: string
  score?: number
}

export type Search = {
  query: string
  registries: RegistryCall[]
  entries: Entry[]
  skipped: number
  problems: string[]
}

/**
 * Characters that display as something else or as nothing: C0 and C1 controls,
 * line and paragraph separators, interlinear annotation marks, a blank Braille
 * pattern (it shows as a space but isn't one), and every
 * default-ignorable code point (Unicode's Default_Ignorable_Code_Point: a soft
 * hyphen, zero-width and direction marks, invisible operators, variation
 * selectors, a BOM, and plane 14's tag characters, which can carry text nobody
 * sees). A query or registry holding one is refused; a registry's own words are
 * shown without them.
 */
export const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufff9-\ufffb\u2800\p{Default_Ignorable_Code_Point}]/u
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu')

/**
 * Text a registry wrote, as it is shown: one line, each hidden character a
 * space, capped at `max` characters (with an ellipsis), so that it can't add
 * lines of its own to the answer or carry text nobody sees.
 */
export const oneLine = (v: unknown, max: number): string => {
  const s = String(v ?? '').replace(HIDDEN_ALL, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max).join('')}\u2026` : s
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

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

export const search = async (post: Post, text: string, endpoints: readonly string[]): Promise<Search> => {
  const out: Search = { query: text, registries: [], entries: [], skipped: 0, problems: [] }
  const byId = new Set<string>()
  const asked = new Set<string>()
  const referrals: string[] = []
  const found: (Entry & { order: number })[] = []

  const ask = async (endpoint: string, isReferral: boolean) => {
    if (asked.has(endpoint)) return
    asked.add(endpoint)
    const fromLocal = isPrivateHost(new URL(endpoint).hostname)
    const call: RegistryCall = { endpoint, state: 'error' }
    out.registries.push(call)
    try {
      const res = await post(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: { text, filter: { type: [CARD_TYPE] } },
          federation: 'referrals',
          pageSize: MAX_RESULTS,
        }),
      })
      if (new TextEncoder().encode(res.text).length > MAX_BODY) {
        call.note = `the answer is larger than ${MAX_BODY / 1024} KiB`
        return
      }
      if (!res.ok) {
        let code = ''
        try {
          const err = JSON.parse(res.text) as { errorCode?: string; message?: string }
          code = [err.errorCode, err.message].filter(x => typeof x === 'string').join(': ')
        } catch {}
        call.note = `HTTP ${res.status}${code ? ` (${oneLine(code, 200)})` : ''}`
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
        if (HIDDEN.test(r.identifier)) {
          out.problems.push(`${endpoint}: a result whose identifier holds control or hidden characters was skipped`)
          continue
        }
        // A registry may ignore the filter; only Server Cards are handed on.
        if (r.type !== undefined && r.type !== CARD_TYPE) {
          out.skipped++
          continue
        }
        if (byId.has(r.identifier)) continue
        byId.add(r.identifier)
        found.push({
          identifier: r.identifier,
          type: CARD_TYPE,
          ...(typeof r.url === 'string' ? { url: r.url } : {}),
          ...(r.data !== undefined ? { data: r.data } : {}),
          listedIn: endpoint,
          displayName: typeof r.displayName === 'string' ? oneLine(r.displayName, 200) || undefined : undefined,
          description: typeof r.description === 'string' ? oneLine(r.description, 300) || undefined : undefined,
          score: typeof r.score === 'number' ? r.score : undefined,
          order: found.length,
        })
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
          else out.problems.push(`${endpoint}: referral ${oneLine(ref.url, 200)} is not HTTPS on a public host; not followed`)
        }
    } catch (err) {
      call.note = oneLine(err instanceof Error ? err.message : err, 200)
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

  // The registries' relevance order, shown as theirs; never a judgement of trust.
  found.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.order - b.order)
  out.entries = found.slice(0, MAX_RESULTS).map(({ order, ...e }) => e)
  return out
}
