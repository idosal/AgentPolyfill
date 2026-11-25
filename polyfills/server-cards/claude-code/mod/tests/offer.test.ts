import { expect, test } from 'claude-code/testing'
import type { Deps } from '../hooks/discover'
import type { Fetch } from '../hooks/http'
import { publisherOf, readOffered } from '../hooks/offer'
import { fixtures } from './fixtures'

// Cards another plugin found and handed over (present_server_cards `entries`):
// checked like this plugin's own, and confirmed only by the publisher's own catalog.

type Route = { status?: number; body: unknown }

const web = (routes: Record<string, Route>) => {
  const calls: { url: string; method: string }[] = []
  const mem = new Map<string, unknown>()
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const r = routes[url]
    if (!r) return { status: 404, ok: false, headers: {}, text: '' }
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
const REG = 'https://r.example/search'
const entry = (identifier: string, url: string, extra: Record<string, unknown> = {}) => ({ identifier, type: CARD_TYPE, url, listedIn: REG, ...extra })

test('O-1 entries need an identifier and where they were found; other types are ignored; cards are checked like any other', async () => {
  const { deps } = web({ 'https://r.example/space/server.json': { body: fixtures.live['hf-rembg'] } })
  const r = await readOffered(deps, [
    { type: CARD_TYPE, url: 'https://a.example/card', listedIn: REG },
    { identifier: 'urn:air:a.example:skill:s', type: 'application/agent-skills+md', url: 'https://a.example/SKILL.md', listedIn: REG },
    entry('urn:air:huggingface.co:mcp:space', 'https://r.example/space/server.json'),
  ])
  expect(r.skipped).toBe(1)
  expect(r.problems.length).toBe(1)
  expect(r.offered.length).toBe(1)
  expect(r.offered[0]!.installCard).toBe(undefined)
  expect(r.offered[0]!.errors.some(e => e.startsWith('$schema must be'))).toBe(true)
})

test('O-2 a valid server is confirmed only when the publisher\'s own catalog lists it', async () => {
  const { deps } = web({
    'https://buildkite.com/.well-known/ai-catalog.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
    'https://cards.r.example/impostor': { body: { ...BUILDKITE_CARD, name: 'com.buildkite/totally-official' } },
    'https://cards.r.example/x': { body: fixtures.official.valid.minimal },
  })
  const r = await readOffered(deps, [
    entry('urn:air:buildkite.com:mcp:buildkite', 'https://mcp.buildkite.com/mcp/server-card', { score: 90 }),
    entry('urn:air:buildkite.com:mcp:impostor', 'https://cards.r.example/impostor', { score: 99 }),
    entry('urn:air:nocatalog.example:mcp:x', 'https://cards.r.example/x'),
  ])
  const by = (id: string) => r.offered.find(o => o.identifier === id)!
  expect(by('urn:air:buildkite.com:mcp:buildkite').publisher?.state).toBe('confirmed')
  expect(by('urn:air:buildkite.com:mcp:impostor').publisher?.state).toBe('not-listed')
  expect(by('urn:air:nocatalog.example:mcp:x').publisher?.state).toBe('no-catalog')
})

test('O-3 a confirmed server is shown and added with the publisher\'s own card', async () => {
  const { deps } = web({
    'https://mirror.r.example/bk': { body: { ...BUILDKITE_CARD, remotes: [{ type: 'streamable-http', url: 'https://shown.example/mcp' }] } },
    'https://buildkite.com/.well-known/ai-catalog.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
  })
  const r = await readOffered(deps, [entry('urn:air:buildkite.com:mcp:buildkite', 'https://mirror.r.example/bk')])
  expect(r.offered[0]!.publisher).toEqual({ state: 'confirmed', catalog: 'https://buildkite.com/.well-known/ai-catalog.json', sameCard: false })
  expect(r.offered[0]!.installCard?.remotes?.[0]?.url).toBe('https://mcp.buildkite.com/mcp')
})

test('O-4 a publisher that lists the identifier with a refused card does not confirm it', async () => {
  const { deps } = web({
    'https://cards.r.example/x': { body: { ...BUILDKITE_CARD, remotes: [{ type: 'streamable-http', url: 'https://evil.example/mcp' }] } },
    'https://pub.example/.well-known/ai-catalog.json': { body: { specVersion: '1.0', entries: [{ identifier: 'urn:air:pub.example:mcp:x', type: CARD_TYPE, data: {} }] } },
  })
  const r = await readOffered(deps, [entry('urn:air:pub.example:mcp:x', 'https://cards.r.example/x')])
  expect(r.offered[0]!.publisher?.state).toBe('card-refused')
  expect(r.offered[0]!.installCard?.remotes?.[0]?.url).toBe('https://evil.example/mcp')
})

test('O-5 the publisher is the domain in urn:air:<publisher>:…, never an address or a local name', async () => {
  expect(publisherOf('urn:air:buildkite.com:mcp:buildkite')).toBe('buildkite.com')
  expect(publisherOf('urn:air:example.com:weather-server')).toBe('example.com')
  expect(publisherOf('urn:air:Example.COM:mcp:x')).toBe('example.com')
  expect(publisherOf('hf-space-hysts-mcp-rembg')).toBe(undefined)
  expect(publisherOf('urn:air:localhost:x')).toBe(undefined)
  expect(publisherOf('urn:air:127.0.0.0x1:mcp:x')).toBe(undefined)
  expect(publisherOf('urn:air:0x7f.0.0.1:mcp:x')).toBe(undefined)
  expect(publisherOf('urn:air:printer.local:mcp:x')).toBe(undefined)
})

test('O-6 a public finder may not send the client to a private address', async () => {
  const { deps, calls } = web({ 'https://r.example/y': { body: fixtures.official.valid.minimal } })
  const r = await readOffered(deps, [entry('urn:air:r.example:mcp:x', 'https://127.0.0.1:8080/card'), entry('urn:air:10.0.0.1:mcp:y', 'https://r.example/y')])
  expect(r.offered.find(o => o.identifier === 'urn:air:r.example:mcp:x')!.errors[0]).toBe(
    'https://127.0.0.1:8080/card: a public source may not point at a local or private address',
  )
  expect(r.offered.find(o => o.identifier === 'urn:air:10.0.0.1:mcp:y')!.publisher?.state).toBe('no-publisher')
  expect(calls.some(c => /127\.0\.0\.1|10\.0\.0\.1/.test(c.url))).toBe(false)
})

test('O-7 bounds: entries read, servers shown, inline card size', async () => {
  const many = Array.from({ length: 60 }, (_, i) => entry(`urn:air:a.example:mcp:${i}`, `https://a.example/${i}`))
  const big = { ...fixtures.official.valid.minimal, _meta: { 'com.example/pad': 'x'.repeat(70_000) } }
  const { deps } = web({})
  const r = await readOffered(deps, [{ identifier: 'urn:air:a.example:mcp:big', type: CARD_TYPE, data: big, listedIn: REG }, ...many])
  expect(r.problems.some(p => p.includes('only the first 50'))).toBe(true)
  expect(r.offered.length).toBe(10)
  expect(r.offered[0]!.errors[0]).toBe('the card is larger than 64 KiB')
})

test('O-8 the finder\'s further sources are read on the publisher\'s domain too: a server listed only in ard.json is confirmed', async () => {
  const ARD = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: 'a test' }
  const routes = {
    'https://buildkite.com/.well-known/ard.json': { body: BUILDKITE_CATALOG },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
  }
  const id = 'urn:air:buildkite.com:mcp:buildkite'
  const plain = await readOffered(web(routes).deps, [entry(id, 'https://mcp.buildkite.com/mcp/server-card')])
  expect(plain.offered[0]!.publisher?.state).toBe('no-catalog')
  const { deps, calls } = web(routes)
  const withArd = await readOffered(deps, [entry(id, 'https://mcp.buildkite.com/mcp/server-card')], ARD)
  expect(withArd.offered[0]!.publisher).toEqual({ state: 'confirmed', catalog: 'https://buildkite.com/.well-known/ard.json', sameCard: true })
  expect(calls.some(c => c.url === 'https://buildkite.com/.well-known/ai-catalog.json')).toBe(true)
})

test('O-9 a finder\'s card URL or "listedIn" with markup is not used', async () => {
  const { deps, calls } = web({})
  const r = await readOffered(deps, [
    entry('urn:air:a.example:mcp:a', 'https://cards.example/x/[https://good.example](https://cards.example/)'),
    entry('urn:air:b.example:mcp:b', 'https://cards.example/b', { listedIn: 'https://r.example/[https://good.example/search](https://r.example/)' }),
  ])
  expect(r.offered.length).toBe(1)
  expect(r.offered[0]!.errors[0]!.includes('square bracket')).toBe(true)
  expect(r.problems.some(p => p.includes('"listedIn"'))).toBe(true)
  expect(calls.length).toBe(0)
})

test('O-10 a finder\'s card URL or "listedIn" that names a user before its host is not used', async () => {
  const { deps, calls } = web({})
  const r = await readOffered(deps, [
    entry('urn:air:a.example:mcp:a', 'https://good.example@cards.example/a'),
    entry('urn:air:b.example:mcp:b', 'https://cards.example/b', { listedIn: 'https://good.example@r.example/search' }),
  ])
  expect(r.offered.length).toBe(1)
  expect(r.offered[0]!.errors[0]!.includes('names a user before its host')).toBe(true)
  expect(r.problems.some(p => p.includes('"listedIn" names a user'))).toBe(true)
  expect(calls.length).toBe(0)
})
