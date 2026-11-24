// The site is static assets. This Worker runs only for /media/*.mp4 (see
// run_worker_first in wrangler.jsonc), for one reason: Workers static assets
// answer a Range request with the whole file (200), and Safari plays a video
// only from a server that answers byte ranges (206). Everything else is served
// by Cloudflare's asset handling without invoking this code.
//
// The first request for a video in a data centre reads it from the assets and
// puts the whole file in that data centre's cache (the Cache API, with a
// Content-Length). After that, cache.match() answers each byte range itself
// (206) without reading the file again, so a video starts as fast as a static
// file. A URL with ?v=<hash> names one rendering and is cached for a year;
// one without it, for a day.

const UNVERSIONED = 'public, max-age=86400'
const VERSIONED = 'public, max-age=31536000, immutable'

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request)
    const url = new URL(request.url)
    const cacheControl = url.searchParams.has('v') ? VERSIONED : UNVERSIONED
    const cache = caches.default
    const key = new Request(url.toString(), { method: 'GET' })

    // A hit: the cache answers the Range (206), If-None-Match (304) or the
    // whole file itself.
    const hit = await cache.match(request, { ignoreMethod: true })
    if (hit) return hit

    const asset = await env.ASSETS.fetch(key)
    if (asset.status !== 200) return asset
    const bytes = await asset.arrayBuffer()
    const headers = new Headers(asset.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', cacheControl)
    headers.set('Content-Length', String(bytes.byteLength))
    ctx.waitUntil(cache.put(key, new Response(bytes, { status: 200, headers })))

    // This request, from the bytes in hand.
    const body = request.method === 'HEAD' ? null : bytes
    const range = request.headers.get('Range')
    const ifRange = request.headers.get('If-Range')
    if (!range || asset.headers.has('Content-Encoding') || (ifRange && ifRange !== asset.headers.get('ETag'))) {
      return new Response(body, { status: 200, headers })
    }
    const size = bytes.byteLength
    const bounds = parseRange(range, size)
    if (bounds === 'ignore') return new Response(body, { status: 200, headers })
    if (bounds === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    const [start, end] = bounds
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes, start, end - start + 1), { status: 206, headers })
  },
}

// One range, as browsers send it: "bytes=a-b", "bytes=a-" or "bytes=-n".
// Several ranges, or a header that is not bytes, get the whole file.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'ignore'
  const [, first, last] = match
  if (first === '' && last === '') return 'ignore'
  let start
  let end
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(first)
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  }
  if (start >= size || end < start) return 'unsatisfiable'
  return [start, end]
}
