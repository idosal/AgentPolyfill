import { expect, test } from 'claude-code/testing'
import type { Deps } from '../hooks/discover'
import type { Fetch } from '../hooks/http'
import { publisherOf, search, searchEndpoint } from '../hooks/search'
import { fixtures } from './fixtures'

type Route = { status?: number; body: unknown } | ((body: unknown) => { status?: number; body: unknown })

const web = (routes: Record<string, Route>) => {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const mem = new Map<string, unknown>()
  const fetch: Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const route = routes[`${init?.method ?? 'GET'} ${url}`] ?? routes[url]
    if (!route) return { status: 404, ok: false, headers: {}, text: '{"errorCode":"NOT_FOUND"}' }
    const r = typeof route === 'function' ? route(body) : route
    const status = r.status ?? 200
    return { status, ok: status < 300, headers: {}, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
  }
  const deps: Deps = {
    fetch,
    store: {
      get: async k => mem.get(k),
      set: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))),
      delete: async k => void mem.delete(k),
      keys: async () => [...mem.keys()],
    },
    now: () => 1_000_000,
  }
  return { deps, calls }
}

const CARD_TYPE = 'application/mcp-server-card+json'
const BUILDKITE_CARD = fixtures.live['mcp.buildkite.com_mcp_server-card']
const BUILDKITE_CATALOG = fixtures.catalogs['buildkite.com']
const result = (identifier: string, url: string, score = 50) => ({ identifier, type: CARD_TYPE, url, score })

test('R-1 a registry base URL gets /search appended; HTTPS only', async () => {
  expect(searchEndpoint('https://registry.example/')).toBe('https://registry.example/search')
  expect(searchEndpoint('https://registry.example/api/v1')).toBe('https://registry.example/api/v1/search')
  expect(searchEndpoint('http://127.0.0.1:9010')).toBe('http://127.0.0.1:9010/search')
  expect(typeof searchEndpoint('http://registry.example')).toBe('object')
})

test('R-2 the request: query.text, a type filter for Server Cards, referrals mode', async () => {
  const { deps, calls } = web({ 'POST https://r.example/search': { body: { results: [] } } })
  await search(deps, 'check why my CI build failed', ['https://r.example/search'])
  expect(calls[0]).toEqual({
    url: 'https://r.example/search',
    method: 'POST',
    body: {
      query: { text: 'check why my CI build failed', filter: { type: [CARD_TYPE] } },
      federation: 'referrals',
      pageSize: 10,
    },
  })
})

test('R-3 a referral url is used as the search endpoint, with nothing appended, one hop only', async () => {
  const { deps, calls } = web({
    'POST https://r.example/search': {
      body: { results: [], referrals: [{ identifier: 'urn:air:other.example:registry:x', type: 'application/ai-registry+json', url: 'https://other.example/find' }] },
    },
    'POST https://other.example/find': {
      body: { results: [], referrals: [{ identifier: 'urn:air:third.example:registry:y', url: 'https://third.example/search' }] },
    },
  })
  const s = await search(deps, 'x', ['https://r.example/search'])
  expect(s.registries.map(r => r.endpoint)).toEqual(['https://r.example/search', 'https://other.example/find'])
  expect(calls.some(c => c.url === 'https://other.example/find/search')).toBe(false)
  expect(calls.some(c => c.url.startsWith('https://third.example'))).toBe(false)
})

test('R-4 results need an identifier; other types are ignored; cards are checked like any other', async () => {
  const { deps } = web({
    'POST https://r.example/search': {
      body: {
        results: [
          { displayName: 'no id', type: CARD_TYPE, url: 'https://a.example/card' },
          { identifier: 'urn:air:a.example:skill:s', type: 'application/agent-skills+md', url: 'https://a.example/SKILL.md' },
          result('urn:air:huggingface.co:mcp:space', 'https://r.example/space/server.json'),
        ],
      },
    },
    'https://r.example/space/server.json': { body: fixtures.live['hf-rembg'] },
  })
  const s = await search(deps, 'remove background', ['https://r.example/search'])
  expect(s.skipped).toBe(1)
  expect(s.problems.length).toBe(1)
  expect(s.hits.length).toBe(1)
  expect(s.hits[0]!.card).toBe(undefined)
  expect(s.hits[0]!.errors.some(e => e.startsWith('$schema must be'))).toBe(true)
})

test('R-5 a valid result is confirmed only when the publisher\'s own catalog lists it', async () => {
  const { deps } = web({
    'POST https://r.example/search': {
      body: {
        results: [
          result('urn:air:buildkite.com:mcp:buildkite', 'https://mcp.buildkite.com/mcp/server-card', 90),
          result('urn:air:buildkite.com:mcp:impostor', 'https://cards.r.example/impostor', 99),
          result('urn:air:nocatalog.example:mcp:x', 'https://cards.r.example/x', 10),
        ],
      },
    },
    'https://buildkite.com/.well-known/ai-catalog.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
    'https://cards.r.example/impostor': { body: { ...BUILDKITE_CARD, name: 'com.buildkite/totally-official' } },
    'https://cards.r.example/x': { body: fixtures.official.valid.minimal },
  })
  const s = await search(deps, 'ci', ['https://r.example/search'])
  const by = (id: string) => s.hits.find(h => h.identifier === id)!
  expect(by('urn:air:buildkite.com:mcp:buildkite').publisher?.state).toBe('confirmed')
  expect(by('urn:air:buildkite.com:mcp:impostor').publisher?.state).toBe('not-listed')
  expect(by('urn:air:nocatalog.example:mcp:x').publisher?.state).toBe('no-catalog')
  // Ranking is the registry's; it is reported, never used as trust.
  expect(s.hits[0]!.identifier).toBe('urn:air:buildkite.com:mcp:impostor')
})

test('R-6 a confirmed result carries the publisher\'s own card', async () => {
  const { deps } = web({
    'POST https://r.example/search': { body: { results: [result('urn:air:buildkite.com:mcp:buildkite', 'https://mirror.r.example/bk')] } },
    'https://mirror.r.example/bk': { body: { ...BUILDKITE_CARD, description: 'A mirror copy.' } },
    'https://buildkite.com/.well-known/ai-catalog.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
  })
  const s = await search(deps, 'ci', ['https://r.example/search'])
  expect(s.hits[0]!.publisher?.state).toBe('confirmed')
  expect(s.hits[0]!.installCard?.description).toBe(BUILDKITE_CARD.description)
  expect(s.hits[0]!.publisher).toEqual({ state: 'confirmed', catalog: 'https://buildkite.com/.well-known/ai-catalog.json', sameCard: true })
})

test('R-7 registry errors are reported with their ARD error code', async () => {
  const { deps } = web({
    'POST https://r.example/search': { status: 429, body: { errorCode: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } },
  })
  const s = await search(deps, 'x', ['https://r.example/search'])
  expect(s.registries[0]).toEqual({ endpoint: 'https://r.example/search', state: 'error', note: 'HTTP 429 (RATE_LIMIT_EXCEEDED: slow down)' })
})

test('R-8 the publisher is the domain in urn:air:<publisher>:…', async () => {
  expect(publisherOf('urn:air:buildkite.com:mcp:buildkite')).toBe('buildkite.com')
  expect(publisherOf('urn:air:example.com:weather-server')).toBe('example.com')
  expect(publisherOf('hf-space-hysts-mcp-rembg')).toBe(undefined)
  expect(publisherOf('urn:air:localhost:x')).toBe(undefined)
})

test('P-2 a public registry may not send the client to a private address', async () => {
  const { deps, calls } = web({
    'POST https://r.example/search': {
      body: {
        results: [result('urn:air:r.example:mcp:x', 'https://127.0.0.1:8080/card'), result('urn:air:10.0.0.1:mcp:y', 'https://r.example/y')],
        referrals: [{ identifier: 'z', url: 'https://192.168.0.2/search' }],
      },
    },
    'https://r.example/y': { body: fixtures.official.valid.minimal },
  })
  const s = await search(deps, 'x', ['https://r.example/search'])
  expect(s.hits.find(h => h.identifier === 'urn:air:r.example:mcp:x')!.errors[0]).toBe(
    'https://127.0.0.1:8080/card: a public registry may not point at a local or private address',
  )
  expect(s.hits.find(h => h.identifier === 'urn:air:10.0.0.1:mcp:y')!.publisher?.state).toBe('no-publisher')
  expect(calls.some(c => /127\.0\.0\.1|192\.168|10\.0\.0\.1/.test(c.url))).toBe(false)
})

// Review findings (2026-11-24).
test('R-9 a publisher that lists the identifier with a refused card does not confirm it', async () => {
  const { deps } = web({
    'POST https://r.example/search': { body: { results: [result('urn:air:pub.example:mcp:x', 'https://cards.r.example/x')] } },
    'https://cards.r.example/x': { body: { ...BUILDKITE_CARD, remotes: [{ type: 'streamable-http', url: 'https://evil.example/mcp' }] } },
    'https://pub.example/.well-known/ard.json': { body: { entries: [{ identifier: 'urn:air:pub.example:mcp:x', type: CARD_TYPE, data: {} }] } },
  })
  const s = await search(deps, 'x', ['https://r.example/search'])
  expect(s.hits[0]!.publisher?.state).toBe('card-refused')
  expect(s.hits[0]!.installCard?.remotes?.[0]?.url).toBe('https://evil.example/mcp')
})

test('R-10 the card shown is the card installed; different endpoints are flagged', async () => {
  const { deps } = web({
    'POST https://r.example/search': { body: { results: [result('urn:air:buildkite.com:mcp:buildkite', 'https://mirror.r.example/bk')] } },
    'https://mirror.r.example/bk': { body: { ...BUILDKITE_CARD, remotes: [{ type: 'streamable-http', url: 'https://shown.example/mcp' }] } },
    'https://buildkite.com/.well-known/ai-catalog.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
  })
  const s = await search(deps, 'ci', ['https://r.example/search'])
  expect(s.hits[0]!.publisher).toEqual({ state: 'confirmed', catalog: 'https://buildkite.com/.well-known/ai-catalog.json', sameCard: false })
  expect(s.hits[0]!.installCard?.remotes?.[0]?.url).toBe('https://mcp.buildkite.com/mcp')
})

test('R-11 hex and other disguised addresses are not publishers', async () => {
  expect(publisherOf('urn:air:127.0.0.0x1:mcp:x')).toBe(undefined)
  expect(publisherOf('urn:air:0x7f.0.0.1:mcp:x')).toBe(undefined)
  expect(publisherOf('urn:air:printer.local:mcp:x')).toBe(undefined)
  expect(publisherOf('urn:air:Example.COM:mcp:x')).toBe('example.com')
})

test('R-12 bounds: registries asked, results read, inline card size', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ identifier: `urn:air:a.example:mcp:${i}`, type: CARD_TYPE, url: `https://a.example/${i}` }))
  const big = { ...fixtures.official.valid.minimal, _meta: { 'com.example/pad': 'x'.repeat(70_000) } }
  const routes: Record<string, Route> = {
    'POST https://r1.example/search': { body: { results: [...many, { identifier: 'urn:air:a.example:mcp:big', type: CARD_TYPE, data: big, score: 1000 }] } },
  }
  for (const n of [2, 3, 4, 5]) routes[`POST https://r${n}.example/search`] = { body: { results: [] } }
  const { deps, calls } = web(routes)
  const s = await search(deps, 'x', [1, 2, 3, 4, 5].map(n => `https://r${n}.example/search`))
  expect(calls.filter(c => c.method === 'POST').length).toBe(3)
  expect(s.problems.some(p => p.includes('only the first 50'))).toBe(true)
  expect(s.hits.length).toBe(10)
})

test('R-13 a registry URL keeps its query and drops its fragment when /search is appended', async () => {
  expect(searchEndpoint('https://r.example/api?key=x')).toBe('https://r.example/api/search?key=x')
  expect(searchEndpoint('https://r.example/api/#frag')).toBe('https://r.example/api/search')
})

