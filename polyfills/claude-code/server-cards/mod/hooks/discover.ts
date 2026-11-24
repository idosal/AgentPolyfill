// Domain-level discovery of MCP Server Cards.
//
// Rules implemented (see README "Client rules"):
// - ext-server-card docs/discovery.md @ 28db12c9b4: fetch
//   https://{domain}/.well-known/ai-catalog.json, select entries of type
//   application/mcp-server-card+json, follow `url` with
//   Accept: application/mcp-server-card+json or read `data` inline.
// - AI Catalog v0.9 @ 19208af2f8 (the catalog SEP-2127 hands discovery to):
//   rel="ai-catalog" links; exactly one of url/data per entry; nested catalogs
//   limited to depth 4; reject an unsupported major specVersion.
// Another plugin may name further catalog URLs and link types to read for a
// domain (DiscoverOptions, through present_server_cards): the ARD plugin names
// /.well-known/ard.json and rel="ard". Nothing here knows those names.

import { CARD_TYPE, type ServerCard, validateCard } from './card'
import { byteLength, cachedGet, type Fetch, type Store } from './http'

export const CATALOG_TYPE = 'application/ai-catalog+json'
const REGISTRY_TYPES = ['application/ai-registry+json', 'application/ai-registry']
const MAX_DEPTH = 4
const MAX_ENTRIES = 200
const MAX_CARDS = 20
const MAX_LINKS = 3
/** An inline card (`data`) larger than this is refused; a fetched one is capped by MAX_BODY. */
export const MAX_INLINE_CARD = 64 * 1024

export type Deps = { fetch: Fetch; store: Store; now: () => number }

export type SourceKind = 'ai-catalog' | 'link' | 'nested' | 'page' | 'extra'

export type Source = {
  url: string
  kind: SourceKind
  state: 'found' | 'absent' | 'invalid' | 'error'
  note?: string
}

export type FoundServer = {
  identifier: string
  /** catalogs that list this entry, in the order they were read */
  listedIn: string[]
  /** where the card came from: a URL, or "inline in <catalog>" */
  cardFrom: string
  cardUrl?: string
  card?: ServerCard
  /** the card was served from this machine or its network (local development) */
  isLocal: boolean
  /** why the card is refused; empty when it is valid */
  errors: string[]
}

export type Registry = {
  identifier: string
  /** the registry's base URL, absolute, resolved against the catalog that lists it */
  url?: string
  displayName?: string
}

export type Discovery = {
  origin: string
  /** the domain is this machine or its own network (local development) */
  isLocal: boolean
  /** who added further sources (DiscoverOptions.by), if anyone */
  extra?: string
  sources: Source[]
  servers: FoundServer[]
  registries: Registry[]
  otherEntries: Record<string, number>
  problems: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A URL's host as WHATWG URL normalises it, lower case, without a trailing dot or brackets. */
const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')

/** localhost and its subdomains, and the loopback addresses. */
export const isLoopback = (host: string) => {
  const h = bare(host)
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1'
}

/**
 * Loopback, private, shared, link-local and unique-local addresses; local
 * names (`.local`, `.internal`, `.localhost`, `.home.arpa`); and any name of a
 * single label, which only a local resolver can answer. Pass a hostname as
 * `new URL` gives it, so `0x7f.1` has already become `127.0.0.1`.
 */
export const isPrivateHost = (host: string): boolean => {
  const h = bare(host)
  if (!h) return true
  if (isLoopback(h)) return true
  if (/\.(local|internal|localhost|home\.arpa|lan)$/.test(h)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    )
  }
  if (h.includes(':'))
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:')
  return !h.includes('.')
}

/** https anywhere; http only for loopback (discovery.md, Transport Security). */
export const isAllowedUrl = (u: URL) =>
  u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname))

/**
 * Whether a URL that a fetched document names may be fetched in turn: the
 * scheme rule above, and no step from a public origin to a local or private
 * address (a public catalog must not make this machine probe its own network).
 * A public name that resolves to a private address is not caught here.
 */
export const mayFollow = (u: URL, fromLocal: boolean) =>
  isAllowedUrl(u) && (fromLocal || !isPrivateHost(u.hostname))

export const parseTarget = (
  input: string,
): { origin: string; page: string; isLocal: boolean } | { error: string } => {
  const raw = input.trim()
  if (!raw) return { error: 'No domain or URL given.' }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: `"${raw}" is not a domain or URL.` }
  }
  if (!isAllowedUrl(u))
    return { error: `${u.origin}: discovery uses HTTPS (plain HTTP only for localhost).` }
  const h = bare(u.hostname)
  if (!h.includes('.') && !h.includes(':') && !isLoopback(h))
    return { error: `"${u.hostname}" is not a full domain name.` }
  u.hash = ''
  const page = u.pathname === '/' && !u.search ? `${u.origin}/` : u.href
  return { origin: u.origin, page, isLocal: isPrivateHost(u.hostname) }
}

const resolve = (ref: string, base: string): URL | undefined => {
  try {
    const u = new URL(ref, base)
    u.hash = ''
    return u
  } catch {
    return undefined
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })

/** Splits a Link header field value into its links (RFC 8288), quotes respected. */
const parseLinkHeader = (value: string): { href: string; rel: string }[] => {
  const out: { href: string; rel: string }[] = []
  let i = 0
  while (i < value.length) {
    const open = value.indexOf('<', i)
    if (open < 0) break
    const close = value.indexOf('>', open)
    if (close < 0) break
    const href = value.slice(open + 1, close)
    // Parameters run to the next comma outside a quoted string.
    let j = close + 1
    let quoted = false
    let params = ''
    for (; j < value.length; j++) {
      const c = value[j]!
      if (c === '"' && value[j - 1] !== '\\') quoted = !quoted
      if (c === ',' && !quoted) break
      params += c
    }
    let rel = ''
    const re = /;\s*([a-z*-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;\s]+)/gi
    for (let m = re.exec(params); m; m = re.exec(params))
      if (m[1]!.toLowerCase() === 'rel' && !rel) rel = m[3] ?? m[2]!
    out.push({ href, rel })
    i = j + 1
  }
  return out
}

/**
 * The start tags named `name` in `html`, each as its attributes (lower-cased
 * names, entity-decoded values), read the way an HTML tokenizer reads them:
 * a quoted value may hold spaces, `=` and `>`.
 */
const startTags = (html: string, name: string): Record<string, string>[] => {
  const out: Record<string, string>[] = []
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'gi')
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const attrs: Record<string, string> = {}
    let i = m.index + m[0].length
    while (i < html.length) {
      while (i < html.length && /[\s/]/.test(html[i]!)) i++
      if (i >= html.length || html[i] === '>') break
      let key = ''
      while (i < html.length && !/[\s/>=]/.test(html[i]!)) key += html[i++]
      while (i < html.length && /\s/.test(html[i]!)) i++
      let value = ''
      if (html[i] === '=') {
        i++
        while (i < html.length && /\s/.test(html[i]!)) i++
        const q = html[i]
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1)
          value = html.slice(i + 1, end < 0 ? html.length : end)
          i = end < 0 ? html.length : end + 1
        } else {
          while (i < html.length && !/[\s>]/.test(html[i]!)) value += html[i++]
        }
      }
      key = key.toLowerCase()
      if (key && !(key in attrs)) attrs[key] = decodeEntities(value)
    }
    out.push(attrs)
    open.lastIndex = i
  }
  return out
}

/** Link header values and <link> tags whose rel is one of `rels` (by default the AI Catalog's "ai-catalog"). */
export const findCatalogLinks = (
  page: string,
  headers: Record<string, string>,
  html: string,
  rels: readonly string[] = ['ai-catalog'],
): { url: string; rel: string }[] => {
  const out: { url: string; rel: string }[] = []
  const add = (href: string, relList: string, base: string) => {
    for (const rel of relList.toLowerCase().split(/\s+/))
      if (rels.includes(rel)) {
        const u = resolve(href, base)
        if (u && !out.some(o => o.url === u.href)) out.push({ url: u.href, rel })
      }
  }
  for (const link of parseLinkHeader(headers['link'] ?? '')) add(link.href, link.rel, page)
  // The document's head: comments, scripts and styles are not markup.
  const head = html
    .slice(0, 256 * 1024)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
  let base = page
  const baseHref = startTags(head, 'base').find(a => a.href)?.href
  if (baseHref) base = resolve(baseHref, page)?.href ?? page
  for (const a of startTags(head, 'link')) if (a.rel && a.href) add(a.href, a.rel, base)
  return out
}

type Parsed = { entries: Record<string, unknown>[] } | { invalid: string }

/** Top-level checks. ARD manifests need only `entries`; AI Catalogs also need specVersion. */
export const parseCatalog = (text: string, needsVersion: boolean): Parsed => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { invalid: 'not JSON' }
  }
  if (!isObject(doc)) return { invalid: 'not a JSON object' }
  if (!Array.isArray(doc.entries)) return { invalid: 'has no "entries" array' }
  const v = doc.specVersion
  if (v === undefined) {
    if (needsVersion) return { invalid: 'has no "specVersion"' }
  } else {
    const m = typeof v === 'string' ? /^(\d+)\.(\d+)$/.exec(v) : null
    if (!m) return { invalid: `specVersion ${JSON.stringify(v)} is not "Major.Minor"` }
    // AI Catalog v0.9 is the release candidate of 1.0; the MCP discovery doc's own
    // examples and every live catalog found use "1.0". Majors above 1 are refused
    // ("Consumers ... SHOULD reject the document with an informative error").
    if (Number(m[1]) > 1)
      return { invalid: `specVersion ${v} is a major version this client does not support` }
  }
  return { entries: doc.entries.filter(isObject) }
}

/** A card read from JSON text or inline data: validated, size-capped. */
export const readCard = (card: unknown): { card: ServerCard } | { errors: string[] } => {
  let size = 0
  try {
    size = byteLength(JSON.stringify(card) ?? '')
  } catch {
    return { errors: ['the card is not JSON data'] }
  }
  if (size > MAX_INLINE_CARD) return { errors: [`the card is larger than ${MAX_INLINE_CARD / 1024} KiB`] }
  const errors = validateCard(card)
  return errors.length ? { errors } : { card: card as ServerCard }
}

export type DiscoverOptions = {
  /**
   * Further catalogs to read for the domain, beside /.well-known/ai-catalog.json.
   * `requireVersion: false` for a manifest that need not carry specVersion.
   */
  catalogs?: readonly { url: string; requireVersion?: boolean }[]
  /** Further link relations to follow on the page, beside "ai-catalog". */
  rels?: readonly string[]
  /** Who asked for them, shown with the result. */
  by?: string
}

export const discover = async (
  deps: Deps,
  input: string,
  options: DiscoverOptions = {},
): Promise<Discovery | { error: string }> => {
  const rels = ['ai-catalog', ...(options.rels ?? []).map(r => r.toLowerCase()).filter(r => /^[a-z][a-z0-9.-]*$/.test(r) && r !== 'ai-catalog')]
  const target = parseTarget(input)
  if ('error' in target) return target
  const { origin, page, isLocal } = target
  const result: Discovery = {
    origin,
    isLocal,
    extra: options.catalogs?.length || options.rels?.length ? (options.by ?? 'another plugin') : undefined,
    sources: [],
    servers: [],
    registries: [],
    otherEntries: {},
    problems: [],
  }
  const byId = new Map<string, FoundServer>()
  const seenCatalogs = new Set<string>()
  let entryCount = 0

  const get = (url: string, accept: string, transform?: (t: string, h: Record<string, string>) => string, variant?: string) =>
    cachedGet(deps.fetch, deps.store, url, accept, deps.now(), transform, variant)

  const readEntries = async (entries: Record<string, unknown>[], catalogUrl: string, depth: number) => {
    // What a catalog names is judged by where that catalog came from: a public
    // catalog reached from a local one is still public.
    const catalogIsLocal = isPrivateHost(new URL(catalogUrl.split('#')[0]!).hostname)
    for (const entry of entries) {
      if (++entryCount > MAX_ENTRIES) {
        result.problems.push(`stopped after ${MAX_ENTRIES} catalog entries`)
        return
      }
      const id = entry.identifier
      const type = entry.type
      const hasUrl = entry.url !== undefined
      const hasData = entry.data !== undefined
      if (typeof id !== 'string' || typeof type !== 'string') {
        result.problems.push(`${catalogUrl}: an entry without a string "identifier" and "type" was skipped`)
        continue
      }
      if (hasUrl === hasData) {
        result.problems.push(`${catalogUrl}: entry ${id} must have exactly one of "url" or "data"; skipped`)
        continue
      }
      if (type === CARD_TYPE) {
        const known = byId.get(id)
        if (known) {
          if (!known.listedIn.includes(catalogUrl)) known.listedIn.push(catalogUrl)
          continue
        }
        const found: FoundServer = {
          identifier: id,
          listedIn: [catalogUrl],
          cardFrom: hasData ? `inline in ${catalogUrl}` : String(entry.url),
          isLocal: catalogIsLocal,
          errors: [],
        }
        if (hasData) {
          const read = readCard(entry.data)
          if ('card' in read) found.card = read.card
          else found.errors = read.errors
        } else if (typeof entry.url !== 'string') {
          found.errors = ['"url" is not a string']
        } else {
          const u = resolve(entry.url, catalogUrl)
          if (!u) found.errors = [`"${entry.url}" is not a URL`]
          else if (!isAllowedUrl(u)) found.errors = [`${u.href}: Server Cards must be served over HTTPS`]
          else if (!mayFollow(u, catalogIsLocal)) found.errors = [`${u.href}: a public catalog may not point at a local or private address`]
          else {
            found.cardUrl = found.cardFrom = u.href
            found.isLocal = catalogIsLocal && isPrivateHost(u.hostname)
          }
        }
        byId.set(id, found)
        result.servers.push(found)
      } else if (type === CATALOG_TYPE) {
        if (depth >= MAX_DEPTH) {
          result.problems.push(`${catalogUrl}: nested catalog ${id} is deeper than ${MAX_DEPTH}; not read`)
          continue
        }
        if (hasData) {
          const p = isObject(entry.data) ? parseCatalog(JSON.stringify(entry.data), true) : { invalid: 'not an object' }
          if ('invalid' in p) result.problems.push(`${catalogUrl}: inline catalog ${id} ${p.invalid}`)
          else await readEntries(p.entries, `${catalogUrl}#${id}`, depth + 1)
        } else if (typeof entry.url === 'string') {
          const u = resolve(entry.url, catalogUrl)
          if (u && mayFollow(u, catalogIsLocal)) await readCatalog(u.href, 'nested', depth + 1)
          else result.problems.push(`${catalogUrl}: nested catalog ${id} has no HTTPS URL on a public host`)
        }
      } else if (REGISTRY_TYPES.includes(type)) {
        // §5.3: the entry's url is the registry's base URL, resolved here
        // against the catalog that lists it.
        const u = typeof entry.url === 'string' ? resolve(entry.url, catalogUrl.split('#')[0]!) : undefined
        if (typeof entry.url === 'string' && !(u && mayFollow(u, catalogIsLocal)))
          result.problems.push(`${catalogUrl}: registry ${id} has no HTTPS URL on a public host`)
        result.registries.push({
          identifier: id,
          url: u && mayFollow(u, catalogIsLocal) ? u.href : undefined,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
        })
      } else {
        result.otherEntries[type] = (result.otherEntries[type] ?? 0) + 1
      }
    }
  }

  const readCatalog = async (url: string, kind: SourceKind, depth: number, needsVersion = true) => {
    if (seenCatalogs.has(url)) return
    seenCatalogs.add(url)
    const source: Source = { url, kind, state: 'absent' }
    result.sources.push(source)
    try {
      const res = await get(url, `${CATALOG_TYPE}, application/json;q=0.9`)
      if (!res.ok) {
        source.state = res.status === 404 || res.status === 410 ? 'absent' : 'error'
        source.note = `HTTP ${res.status}`
        return
      }
      const parsed = parseCatalog(res.text, needsVersion)
      if ('invalid' in parsed) {
        // A host that answers every path with an HTML page is not publishing a catalog.
        const looksHtml = /^\s*</.test(res.text)
        source.state = looksHtml ? 'absent' : 'invalid'
        source.note = looksHtml ? 'an HTML page, not a catalog' : parsed.invalid
        return
      }
      source.state = 'found'
      source.note = `${parsed.entries.length} entries`
      await readEntries(parsed.entries, url, depth)
    } catch (err) {
      source.state = 'error'
      source.note = err instanceof Error ? err.message : String(err)
    }
  }

  // The page itself, for rel="ai-catalog" and any relation another plugin named (Link header or <link>).
  // Only the links are kept in the cache, never the page.
  const readLinks = async (): Promise<{ url: string; rel: string }[]> => {
    const source: Source = { url: page, kind: 'page', state: 'absent' }
    try {
      const res = await get(
        page,
        'text/html, application/xhtml+xml;q=0.9',
        (text, headers) => JSON.stringify(findCatalogLinks(page, headers, text, rels)),
        rels.join(','),
      )
      if (!res.ok) {
        source.note = `HTTP ${res.status}`
        return []
      }
      let links: { url: string; rel: string }[] = []
      try {
        links = JSON.parse(res.text)
      } catch {}
      const names = rels.map(r => `rel="${r}"`).join(' or ')
      source.state = links.length ? 'found' : 'absent'
      source.note = links.length
        ? `${links.length} ${names} link${links.length === 1 ? '' : 's'}`
        : `no ${names} link`
      return links
    } catch (err) {
      source.state = 'error'
      source.note = err instanceof Error ? err.message : String(err)
      return []
    } finally {
      result.sources.push(source)
    }
  }

  const extras: { url: string; requireVersion: boolean }[] = []
  for (const c of options.catalogs ?? []) {
    const u = resolve(c.url, `${origin}/`)
    if (u && mayFollow(u, isLocal)) extras.push({ url: u.href, requireVersion: c.requireVersion !== false })
    else result.problems.push(`${c.url}: not an HTTPS URL on a public host; not read`)
  }
  const [, links] = await Promise.all([
    Promise.all([
      readCatalog(`${origin}/.well-known/ai-catalog.json`, 'ai-catalog', 1),
      ...extras.slice(0, MAX_LINKS).map(c => readCatalog(c.url, 'extra', 1, c.requireVersion)),
    ]),
    readLinks(),
  ])
  const follow = links.filter(l => !seenCatalogs.has(l.url))
  if (follow.length > MAX_LINKS)
    result.problems.push(`the page has ${follow.length} catalog links; only the first ${MAX_LINKS} were read`)
  for (const link of follow.slice(0, MAX_LINKS)) {
    const u = new URL(link.url)
    // A link of a relation another plugin named reads like its catalogs: a
    // manifest that need not carry specVersion.
    if (mayFollow(u, isLocal)) await readCatalog(u.href, link.rel === 'ai-catalog' ? 'link' : 'extra', 1, link.rel === 'ai-catalog')
    else result.problems.push(`rel="${link.rel}" points at ${u.href}, which is not HTTPS on a public host; not read`)
  }

  // Fetch the cards (url entries), a bounded number, in parallel.
  const pending = result.servers.filter(s => s.cardUrl && !s.card && !s.errors.length)
  if (pending.length > MAX_CARDS)
    result.problems.push(`${pending.length} cards listed; only the first ${MAX_CARDS} were fetched`)
  for (const s of pending.slice(MAX_CARDS)) s.errors = ['not fetched: too many cards listed']
  await Promise.all(
    pending.slice(0, MAX_CARDS).map(async s => {
      try {
        const res = await get(s.cardUrl!, CARD_TYPE)
        if (!res.ok) return void (s.errors = [`fetching the card answered HTTP ${res.status}`])
        let card: unknown
        try {
          card = JSON.parse(res.text)
        } catch {
          return void (s.errors = ['the card is not JSON'])
        }
        const read = readCard(card)
        if ('card' in read) s.card = read.card
        else s.errors = read.errors
      } catch (err) {
        s.errors = [`fetching the card failed: ${err instanceof Error ? err.message : String(err)}`]
      }
    }),
  )
  return result
}
