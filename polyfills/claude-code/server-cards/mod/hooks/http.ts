// HTTP GET with the caching the Server Card discovery doc asks of clients:
// respect Cache-Control, revalidate with the ETag via If-None-Match, accept 304
// (docs/discovery.md, "Caching" and "Denial of Service"). The cache is a
// convenience: when the store refuses a write, the answer is used uncached.

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>

export type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
}

export type Got = {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
  /** fresh: served from the cache without a request; revalidated: a 304 */
  from: 'network' | 'fresh' | 'revalidated'
}

type Entry = {
  etag?: string
  storedAt: number
  maxAgeMs: number
  status: number
  cacheControl: string
  contentType: string
  text: string
}

export const PREFIX = 'http:'
/** The largest answer read at all. */
export const MAX_BODY = 512 * 1024
/** The largest answer kept in the cache. */
const MAX_CACHED = 64 * 1024
/** Kept entries: at most 40 of at most 64 KiB, inside the store's 4 MiB. */
const MAX_ENTRIES = 40

export const parseCacheControl = (value: string | undefined) => {
  const out = { noStore: false, noCache: false, maxAgeMs: 0 }
  if (!value) return out
  for (const part of value.toLowerCase().split(',')) {
    const [k, v] = part.trim().split('=')
    if (k === 'no-store') out.noStore = true
    else if (k === 'no-cache') out.noCache = true
    else if (k === 'max-age' && v !== undefined) {
      const n = Number(v.replace(/"/g, ''))
      if (Number.isFinite(n) && n > 0) out.maxAgeMs = n * 1000
    }
  }
  return out
}

/** Freshness left: max-age minus the Age the answer already had. */
const lifetime = (cacheControl: string, age: string | undefined) => {
  const cc = parseCacheControl(cacheControl)
  if (cc.noCache) return 0
  const used = Number(age)
  return Math.max(0, cc.maxAgeMs - (Number.isFinite(used) && used > 0 ? used * 1000 : 0))
}

/** Size in bytes, as the store holds text. */
export const byteLength = (s: string) => new TextEncoder().encode(s).length

// Writes run one at a time, so concurrent fetches cannot each see room and all
// write past the cap.
let writes: Promise<void> = Promise.resolve()

/** Writes an entry, dropping the oldest ones first so the write fits. */
const keep = (store: Store, key: string, entry: unknown) =>
  (writes = writes.then(async () => {
    try {
      const ours = (await store.keys()).filter(k => k.startsWith(PREFIX) && k !== key)
      for (const k of ours.slice(0, Math.max(0, ours.length - (MAX_ENTRIES - 1)))) await store.delete(k)
      await store.set(key, entry)
    } catch {
      // The store is full or refused the value: forget this entry and go on.
      await store.delete(key).catch(() => {})
    }
  }))

/**
 * GET `url`. `transform`, when given, is applied to a 200's body before it is
 * returned and before it is cached, so a large page can be kept as the little
 * that is needed from it.
 */
export const cachedGet = async (
  fetch: Fetch,
  store: Store,
  url: string,
  accept: string,
  now: number,
  transform?: (text: string, headers: Record<string, string>) => string,
  /** what the transform depends on, so two transforms of one URL are kept apart */
  variant = '',
): Promise<Got> => {
  const target = url.split('#')[0]!
  const key = `${PREFIX}${accept} ${target}${transform ? ` (kept${variant ? ` ${variant}` : ''})` : ''}`
  let held: Entry | undefined
  try {
    held = (await store.get(key)) as Entry | undefined
  } catch {}
  const headersOf = (e: Entry) => ({ 'content-type': e.contentType, 'cache-control': e.cacheControl })
  if (held && now - held.storedAt < held.maxAgeMs)
    return { status: held.status, ok: true, headers: headersOf(held), text: held.text, from: 'fresh' }

  const headers: Record<string, string> = { accept }
  if (held?.etag) headers['if-none-match'] = held.etag
  const res = await fetch(target, { method: 'GET', headers })

  if (res.status === 304 && held) {
    // A 304 updates the stored headers it carries (RFC 9111 §4.3.4).
    const cacheControl = res.headers['cache-control'] ?? held.cacheControl
    const updated: Entry = {
      ...held,
      etag: res.headers['etag'] ?? held.etag,
      cacheControl,
      storedAt: now,
      maxAgeMs: lifetime(cacheControl, res.headers['age']),
    }
    if (parseCacheControl(cacheControl).noStore) await store.delete(key).catch(() => {})
    else await keep(store, key, updated)
    return { status: held.status, ok: true, headers: headersOf(updated), text: held.text, from: 'revalidated' }
  }
  if (!res.ok) return { ...res, from: 'network' }
  if (byteLength(res.text) > MAX_BODY) return { status: 413, ok: false, headers: res.headers, text: '', from: 'network' }

  const text = transform ? transform(res.text, res.headers) : res.text
  const cacheControl = res.headers['cache-control'] ?? ''
  const cc = parseCacheControl(cacheControl)
  // A transformed entry has lost its body, so a 304 could not bring its result
  // up to date (a new Link header, say): it is kept only while fresh.
  const etag = transform ? undefined : res.headers['etag']
  const maxAgeMs = lifetime(cacheControl, res.headers['age'])
  if (!cc.noStore && (etag || maxAgeMs > 0) && byteLength(text) <= MAX_CACHED)
    await keep(store, key, {
      etag,
      storedAt: now,
      maxAgeMs,
      status: res.status,
      cacheControl,
      contentType: res.headers['content-type'] ?? '',
      text,
    } satisfies Entry)
  else if (held) await store.delete(key).catch(() => {})
  return { status: res.status, ok: true, headers: res.headers, text, from: 'network' }
}
