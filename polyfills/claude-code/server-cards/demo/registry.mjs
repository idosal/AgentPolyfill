#!/usr/bin/env node
// A demo ARD registry (Agentic Resource Discovery v0.91 §5.2, §5.3.2), for
// showing search_mcp_servers before a public registry serves valid Server Cards.
//
// It is not a real registry. At start it reads (web ingestion, §5.2) the live
// catalogs of the publisher domains below, keeps their MCP Server Card entries
// as the publishers wrote them, and answers POST /search with a plain word-match
// score. Every result's `url` is the publisher's own card, so the polyfill can
// confirm each one against the publisher's catalog.
//
//   node demo/registry.mjs [port]        (default 9011, binds 127.0.0.1)
//   then: search_mcp_servers({ query, registry: "http://127.0.0.1:9011" })

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 9011)
const PUBLISHERS = [
  'buildkite.com', 'github.com', 'notion.com', 'neon.tech', 'supabase.com',
  'netlify.com', 'exa.ai', 'context7.com', 'huggingface.co', 'zapier.com',
]
const CARD = 'application/mcp-server-card+json'

const stem = w => w.toLowerCase().replace(/(ing|ed|es|s)$/, '')
const words = s => (String(s ?? '').match(/[a-z0-9]+/gi) ?? []).map(stem).filter(w => w.length > 1)
const STOP = new Set(['the', 'a', 'an', 'my', 'me', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it', 'what', 'why', 'how', 'do', 'did', 'thi', 'with', 'from', 'can', 'i'])

const index = []
const ingest = async domain => {
  for (const path of ['/.well-known/ard.json', '/.well-known/ai-catalog.json']) {
    try {
      const res = await fetch(`https://${domain}${path}`, { headers: { accept: 'application/ai-catalog+json, application/json' } })
      if (!res.ok) continue
      const doc = await res.json()
      for (const e of doc.entries ?? []) {
        if (e?.type !== CARD || typeof e.identifier !== 'string' || typeof e.url !== 'string') continue
        if (index.some(x => x.entry.identifier === e.identifier)) continue
        let card = {}
        try {
          card = await (await fetch(e.url, { headers: { accept: CARD } })).json()
        } catch {}
        const text = [e.displayName, e.description, card.title, card.description, ...(e.tags ?? [])].join(' ')
        index.push({
          entry: {
            identifier: e.identifier,
            displayName: e.displayName ?? card.title ?? card.name,
            type: CARD,
            url: e.url,
            description: e.description ?? card.description,
            tags: e.tags,
          },
          terms: new Set(words(text)),
          queries: (e.representativeQueries ?? []).map(q => new Set(words(q))),
        })
      }
      return
    } catch {}
  }
}

// Rare words count more (inverse document frequency); a word in the
// publisher's representativeQueries counts double.
const idf = w => Math.log(1 + index.length / (1 + index.filter(i => i.terms.has(w) || i.queries.some(q => q.has(w))).length))
const score = (item, q) => {
  const qw = [...new Set(words(q).filter(w => !STOP.has(w)))]
  if (!qw.length) return 0
  const total = qw.reduce((n, w) => n + idf(w), 0)
  const hit = qw.reduce((n, w) => n + (item.terms.has(w) ? idf(w) : 0) + (item.queries.some(set => set.has(w)) ? 2 * idf(w) : 0), 0)
  return Math.round((100 * hit) / (3 * total))
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

await Promise.all(PUBLISHERS.map(ingest))
console.error(`[demo registry] indexed ${index.length} MCP servers from ${PUBLISHERS.length} publishers`)

createServer((req, res) => {
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/search')
    return send(res, 404, { errorCode: 'NOT_FOUND', message: `${req.method} ${req.url}` })
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return send(res, 400, { errorCode: 'INVALID_ARGUMENT', message: 'Invalid JSON' })
    }
    const text = body?.query?.text
    if (typeof text !== 'string' || !text.trim())
      return send(res, 400, { errorCode: 'INVALID_ARGUMENT', message: "Missing 'query.text'" })
    const types = body.query.filter?.type
    const want = types === undefined ? null : [].concat(types)
    const size = Math.min(Math.max(Number(body.pageSize) || 10, 1), 100)
    const results = index
      .filter(i => !want || want.includes(i.entry.type))
      .map(i => ({ ...i.entry, score: score(i, text), source: `http://127.0.0.1:${PORT}/` }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, size)
    console.error(`[demo registry] "${text}" -> ${results.map(r => `${r.displayName} ${r.score}`).join(', ') || 'nothing'}`)
    send(res, 200, { results, referrals: [] })
  })
}).listen(PORT, '127.0.0.1', () => console.error(`[demo registry] POST http://127.0.0.1:${PORT}/search`))
