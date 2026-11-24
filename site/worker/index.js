// The site is static assets. This Worker runs only for /media/* (see
// run_worker_first in wrangler.jsonc), for one reason: Workers static assets
// answer a Range request with the whole file (200), and Safari plays a video
// only from a server that answers byte ranges (206). Everything else is served
// by Cloudflare's asset handling without invoking this code.

const MEDIA_CACHE = 'public, max-age=86400'

export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 200) return asset
    const headers = new Headers(asset.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', MEDIA_CACHE)

    const range = request.headers.get('Range')
    const ifRange = request.headers.get('If-Range')
    if (!range || request.method !== 'GET' || asset.headers.has('Content-Encoding') || (ifRange && ifRange !== asset.headers.get('ETag'))) {
      return new Response(asset.body, { status: 200, headers })
    }

    // The asset binding gives no Content-Length, so the file is read whole
    // (at most a few MB; they come from Cloudflare's cache) and the range is
    // cut from it.
    const bytes = await asset.arrayBuffer()
    const size = bytes.byteLength
    const bounds = parseRange(range, size)
    if (bounds === 'ignore') return new Response(bytes, { status: 200, headers })
    if (bounds === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    const [start, end] = bounds
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    return new Response(new Uint8Array(bytes, start, end - start + 1), { status: 206, headers })
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
