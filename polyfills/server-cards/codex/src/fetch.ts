// The network, for the shared modules: Node's fetch, with each redirect
// followed here rather than by fetch, so every hop is held to the same address
// rule as a URL a document names (discover.ts mayFollow: HTTPS, plain HTTP only
// for loopback, and no step from a public origin to a local or private
// address). The Claude Code form can't do this, because its host's fetch
// follows redirects without saying where they led.
//
// - No cookies, no credentials: Node's fetch keeps no cookie jar, and only the
//   headers the caller names are sent.
// - Bodies are read up to MAX_BODY and no further.
// - A request with a body (a registry search) is never sent to another origin
//   by a redirect: the person agreed to send it to the one they were shown.

import { MAX_BODY } from '../../claude-code/mod/hooks/http'
import type { Fetch } from '../../claude-code/mod/hooks/http'
import { isPrivateHost, mayFollow } from '../../claude-code/mod/hooks/discover'

export const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type FetchOptions = {
  /** stands in for globalThis.fetch in tests */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBody?: number
  userAgent?: string
}

/** The body as text, or undefined once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {})
    return undefined
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

const headersOf = (h: Headers) => {
  const out: Record<string, string> = {}
  h.forEach((v, k) => (out[k.toLowerCase()] = v))
  return out
}

export function nodeFetch(options: FetchOptions = {}): Fetch {
  const impl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const max = options.maxBody ?? MAX_BODY
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = { 'user-agent': options.userAgent ?? 'agentpolyfill-codex', ...(init?.headers ?? {}) }
    let current = new URL(url)
    for (let hop = 0; ; hop++) {
      const res = await impl(current.href, {
        method,
        headers,
        body: init?.body,
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!REDIRECTS.has(res.status)) {
        const text = await readCapped(res, max)
        if (text === undefined) return { status: 413, ok: false, headers: headersOf(res.headers), text: '' }
        return { status: res.status, ok: res.ok, headers: headersOf(res.headers), text }
      }
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!location) return { status: res.status, ok: false, headers: headersOf(res.headers), text: '' }
      if (hop >= MAX_REDIRECTS) throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`)
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new Error(`${current.href} redirected to "${location.slice(0, 200)}", which is not a URL`)
      }
      next.hash = ''
      if (!mayFollow(next, isPrivateHost(current.hostname)))
        throw new Error(`${current.href} redirected to ${next.href}, which is not HTTPS on a public host; not followed`)
      if (method !== 'GET' && method !== 'HEAD') {
        // The person agreed to send this body to one origin, and a 301, 302 or
        // 303 would turn it into a GET. Neither is followed.
        if (next.origin !== current.origin)
          throw new Error(`${current.origin} redirected the request to ${next.origin}; a request with a body is not sent to an origin the person was not shown`)
        if (res.status !== 307 && res.status !== 308)
          throw new Error(`${current.href} answered ${res.status} to a ${method}; not followed`)
      }
      current = next
    }
  }
}
