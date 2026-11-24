import { expect, test } from 'claude-code/testing'
import { discover as discoverWith, findCatalogLinks, isPrivateHost, parseTarget, type Deps } from '../hooks/discover'

// Most tests here also read the further sources another plugin can name, as the
// ARD plugin does (a manifest at /.well-known/ard.json that need not carry
// specVersion, and rel="ard" links); DEF-1 and DEF-2 hold the default, which
// reads only what SEP-2127 and its AI Catalog name.
const ARD_LIKE = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: 'a test' }
const discover = (deps: Deps, input: string) => discoverWith(deps, input, ARD_LIKE)
import type { Fetch } from '../hooks/http'
import { fixtures } from './fixtures'

type Route = { status?: number; headers?: Record<string, string>; body: unknown }

const CARD = fixtures.official.valid.minimal
const BUILDKITE_CARD = fixtures.live['mcp.buildkite.com_mcp_server-card']

/** A fake web: routes by URL, records every request. */
const web = (routes: Record<string, Route>, clock = { t: 1_000_000 }) => {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const mem = new Map<string, unknown>()
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const r = routes[url]
    if (!r) return { status: 404, ok: false, headers: {}, text: 'not found' }
    const status = r.status ?? 200
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return { status, ok: status >= 200 && status < 300, headers: r.headers ?? {}, text }
  }
  const deps: Deps = {
    fetch,
    store: {
      get: async k => mem.get(k),
      set: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))),
      delete: async k => void mem.delete(k),
      keys: async () => [...mem.keys()],
    },
    now: () => clock.t,
  }
  return { deps, calls, clock }
}

const catalog = (entries: unknown[], specVersion: string | null = '1.0') =>
  specVersion === null ? { entries } : { specVersion, entries }

const entry = (id: string, url: string) => ({
  identifier: id,
  type: 'application/mcp-server-card+json',
  url,
})

test('T-1 target: a domain, a page URL, HTTPS only except localhost', async () => {
  expect(parseTarget('buildkite.com')).toEqual({ origin: 'https://buildkite.com', page: 'https://buildkite.com/', isLocal: false })
  expect(parseTarget('https://buildkite.com/docs/mcp#x')).toEqual({
    origin: 'https://buildkite.com',
    page: 'https://buildkite.com/docs/mcp',
    isLocal: false,
  })
  expect('error' in parseTarget('http://example.com')).toBe(true)
  expect(parseTarget('http://localhost:8787')).toEqual({ origin: 'http://localhost:8787', page: 'http://localhost:8787/', isLocal: true })
  expect('error' in parseTarget('intranet')).toBe(true)
})

test('D-1 D-2 reads ai-catalog.json (MCP discovery SHOULD) and a further catalog a caller names (ard.json, as ard-discovery does)', async () => {
  const { deps, calls } = web({})
  const d = await discover(deps, 'example.com')
  const urls = calls.map(c => c.url)
  expect(urls.includes('https://example.com/.well-known/ard.json')).toBe(true)
  expect(urls.includes('https://example.com/.well-known/ai-catalog.json')).toBe(true)
  if ('error' in d) throw new Error(d.error)
  expect(d.servers).toEqual([])
})

test('D-3 selects card entries, fetches each with the card media type', async () => {
  const { deps, calls } = web({
    'https://buildkite.com/.well-known/ai-catalog.json': { body: fixtures.catalogs['buildkite.com'] },
    'https://mcp.buildkite.com/mcp/server-card': { body: BUILDKITE_CARD },
  })
  const d = await discover(deps, 'buildkite.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.length).toBe(1)
  expect(d.servers[0]!.card?.name).toBe('com.buildkite/remote-mcp-server')
  const cardGet = calls.find(c => c.url === 'https://mcp.buildkite.com/mcp/server-card')
  expect(cardGet?.headers.accept).toBe('application/mcp-server-card+json')
})

test('D-4 an inline card (data) is validated and used', async () => {
  const { deps } = web({
    'https://example.com/.well-known/ard.json': {
      body: catalog([{ identifier: 'urn:air:example.com:mcp:x', type: 'application/mcp-server-card+json', data: CARD }]),
    },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card?.name).toBe(CARD.name)
  expect(d.servers[0]!.cardFrom).toBe('inline in https://example.com/.well-known/ard.json')
})

test('D-5 an entry with both url and data, or neither, is skipped', async () => {
  const { deps } = web({
    'https://example.com/.well-known/ard.json': {
      body: catalog([
        { identifier: 'both', type: 'application/mcp-server-card+json', url: 'https://example.com/c', data: CARD },
        { identifier: 'neither', type: 'application/mcp-server-card+json' },
      ]),
    },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers).toEqual([])
  expect(d.problems.length).toBe(2)
})

test('D-6 the same identifier in ard.json and ai-catalog.json is one server', async () => {
  const both = catalog([entry('urn:air:example.com:mcp:x', 'https://mcp.example.com/mcp/server-card')])
  const { deps, calls } = web({
    'https://example.com/.well-known/ard.json': { body: both },
    'https://example.com/.well-known/ai-catalog.json': { body: both },
    'https://mcp.example.com/mcp/server-card': { body: CARD },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.length).toBe(1)
  expect(d.servers[0]!.listedIn.length).toBe(2)
  expect(calls.filter(c => c.url === 'https://mcp.example.com/mcp/server-card').length).toBe(1)
})

test('D-7 rel="ard" in a <link> tag and in a Link header are followed', async () => {
  expect(
    findCatalogLinks('https://example.com/docs', {}, '<head><link rel="ard" href="/agents.json"></head>', ['ard', 'ai-catalog']),
  ).toEqual([{ url: 'https://example.com/agents.json', rel: 'ard' }])
  expect(
    findCatalogLinks('https://example.com/', { link: '</x.json>; rel="ai-catalog", </y>; rel=preload' }, '', ['ard', 'ai-catalog']),
  ).toEqual([{ url: 'https://example.com/x.json', rel: 'ai-catalog' }])

  const { deps } = web({
    'https://example.com/docs': { headers: { 'content-type': 'text/html' }, body: '<link rel="ard" href="/agents.json">' },
    'https://example.com/agents.json': { body: catalog([entry('urn:air:example.com:mcp:x', 'https://example.com/card')], null) },
    'https://example.com/card': { body: CARD },
  })
  const d = await discover(deps, 'https://example.com/docs')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.length).toBe(1)
})

test('D-8 nested catalogs are followed to depth 4 and no deeper', async () => {
  const routes: Record<string, Route> = {
    'https://example.com/.well-known/ai-catalog.json': {
      body: catalog([{ identifier: 'n2', type: 'application/ai-catalog+json', url: 'https://example.com/2' }]),
    },
  }
  for (let i = 2; i <= 5; i++)
    routes[`https://example.com/${i}`] = {
      body: catalog([
        entry(`server-${i}`, 'https://example.com/card'),
        { identifier: `n${i + 1}`, type: 'application/ai-catalog+json', url: `https://example.com/${i + 1}` },
      ]),
    }
  routes['https://example.com/card'] = { body: CARD }
  const { deps, calls } = web(routes)
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.map(s => s.identifier)).toEqual(['server-2', 'server-3', 'server-4'])
  expect(calls.some(c => c.url === 'https://example.com/5')).toBe(false)
})

test('D-9 specVersion: an unsupported major is refused; ard.json may omit it, ai-catalog.json may not', async () => {
  const { deps } = web({
    'https://a.example/.well-known/ai-catalog.json': { body: catalog([], '2.0') },
    'https://b.example/.well-known/ai-catalog.json': { body: catalog([], null) },
    'https://c.example/.well-known/ard.json': { body: catalog([], null) },
    'https://d.example/.well-known/ai-catalog.json': { body: catalog([], '0.9') },
  })
  const state = async (domain: string, path: string) => {
    const d = await discover(deps, domain)
    if ('error' in d) throw new Error(d.error)
    return d.sources.find(s => s.url.endsWith(path))?.state
  }
  expect(await state('a.example', 'ai-catalog.json')).toBe('invalid')
  expect(await state('b.example', 'ai-catalog.json')).toBe('invalid')
  expect(await state('c.example', 'ard.json')).toBe('found')
  expect(await state('d.example', 'ai-catalog.json')).toBe('found')
})

test('S-1 a card served over plain HTTP is refused', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ard.json': { body: catalog([entry('x', 'http://mcp.example.com/card')]) },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card).toBe(undefined)
  expect(d.servers[0]!.errors[0]).toBe('http://mcp.example.com/card: Server Cards must be served over HTTPS')
  expect(calls.some(c => c.url.startsWith('http://'))).toBe(false)
})

test('S-2 a refused card stays refused: no repair, reasons listed', async () => {
  const { deps } = web({
    'https://zapier.com/.well-known/ai-catalog.json': {
      body: catalog([entry('urn:air:zapier.com:mcp', 'https://zapier.com/.well-known/mcp/server-card.json')]),
    },
    'https://zapier.com/.well-known/mcp/server-card.json': { body: fixtures.live['zapier.com_.well-known_mcp_server-card'] },
  })
  const d = await discover(deps, 'zapier.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card).toBe(undefined)
  expect(d.servers[0]!.errors.length).toBe(2)
})

test('C-1 C-2 cache: no request while fresh, If-None-Match after, 304 reuses the body', async () => {
  const { deps, calls, clock } = web({
    'https://example.com/.well-known/ard.json': {
      headers: { 'cache-control': 'public, max-age=60', etag: '"v1"' },
      body: catalog([entry('x', 'https://example.com/card')]),
    },
    'https://example.com/card': { headers: { 'cache-control': 'public, max-age=3600', etag: '"c1"' }, body: CARD },
  })
  await discover(deps, 'example.com')
  const first = calls.length
  clock.t += 30_000
  await discover(deps, 'example.com')
  const second = calls.slice(first).map(c => c.url)
  expect(second.includes('https://example.com/.well-known/ard.json')).toBe(false)
  expect(second.includes('https://example.com/card')).toBe(false)

  clock.t += 60_000
  const before = calls.length
  await discover(deps, 'example.com')
  const reval = calls.slice(before).find(c => c.url === 'https://example.com/.well-known/ard.json')
  expect(reval?.headers['if-none-match']).toBe('"v1"')
})

test('C-2 a 304 answer keeps the stored card', async () => {
  const routes: Record<string, Route> = {
    'https://example.com/.well-known/ard.json': { body: catalog([entry('x', 'https://example.com/card')]) },
    'https://example.com/card': { headers: { 'cache-control': 'public, max-age=0, must-revalidate', etag: '"c1"' }, body: CARD },
  }
  const { deps } = web(routes)
  await discover(deps, 'example.com')
  routes['https://example.com/card'] = { status: 304, body: '' }
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card?.name).toBe(CARD.name)
})

test('C-3 no-store is not cached', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ard.json': {
      headers: { 'cache-control': 'no-store', etag: '"v1"' },
      body: catalog([]),
    },
  })
  await discover(deps, 'example.com')
  await discover(deps, 'example.com')
  const gets = calls.filter(c => c.url === 'https://example.com/.well-known/ard.json')
  expect(gets.length).toBe(2)
  expect(gets[1]!.headers['if-none-match']).toBe(undefined)
})

test('E-1 registries and other artifact types are reported, not used', async () => {
  const { deps } = web({
    'https://huggingface.co/.well-known/ai-catalog.json': { body: fixtures.catalogs['huggingface.co'] },
    'https://huggingface.co/mcp/server-card': { body: fixtures.live['huggingface.co_mcp_server-card'] },
  })
  const d = await discover(deps, 'huggingface.co')
  if ('error' in d) throw new Error(d.error)
  expect(d.registries.map(r => r.identifier)).toEqual(['urn:air:huggingface.co:registry:discover'])
  expect(d.servers.length).toBe(1)
  expect(d.servers[0]!.card?.name).toBe('huggingface.co/mcp')
})

test('C-4 a page is not stored: only its catalog links are, while fresh, never revalidated', async () => {
  const page = '<html><head><link rel="ard" href="/agents.json"></head><body>' + 'x'.repeat(50_000) + '</body></html>'
  const routes: Record<string, Route> = {
    'https://example.com/docs': { headers: { etag: '"p1"', 'cache-control': 'max-age=60' }, body: page },
    'https://example.com/agents.json': { body: catalog([entry('x', 'https://example.com/card')], null) },
    'https://example.com/card': { body: CARD },
  }
  const { deps, calls, clock } = web(routes)
  await discover(deps, 'https://example.com/docs')
  const stored = JSON.stringify(await Promise.all((await deps.store.keys()).map(k => deps.store.get(k))))
  expect(stored.includes('xxxxxxxxxx')).toBe(false)
  const d = await discover(deps, 'https://example.com/docs')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.length).toBe(1)
  expect(calls.filter(c => c.url === 'https://example.com/docs').length).toBe(1)
  clock.t += 120_000
  await discover(deps, 'https://example.com/docs')
  const again = calls.filter(c => c.url === 'https://example.com/docs')
  expect(again.length).toBe(2)
  expect(again[1]!.headers['if-none-match']).toBe(undefined)
})

test('P-1 a public catalog may not point at a local or private address', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ard.json': {
      body: catalog([
        entry('loop', 'https://127.0.0.1/card'),
        entry('lan', 'https://192.168.1.10/card'),
        entry('name', 'https://printer.local/card'),
        { identifier: 'n', type: 'application/ai-catalog+json', url: 'https://10.0.0.5/catalog.json' },
      ]),
    },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers.every(s => s.errors[0]?.includes('local or private address'))).toBe(true)
  expect(calls.some(c => /127\.0\.0\.1|192\.168|printer\.local|10\.0\.0\.5/.test(c.url))).toBe(false)
})

test('P-1 a local catalog (development) may point at a local card', async () => {
  const { deps } = web({
    'http://localhost:8787/.well-known/ard.json': { body: catalog([entry('dev', 'http://localhost:8787/card')]) },
    'http://localhost:8787/card': { body: CARD },
  })
  const d = await discover(deps, 'http://localhost:8787')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card?.name).toBe(CARD.name)
})

// Review findings (2026-11-24).
test('P-3 spellings of local names are private too', async () => {
  for (const host of ['localhost.', 'printer.local.', 'printer', '127.1.2.3', '[::1]', '[fd00::1]', '169.254.169.254', '100.64.0.1'])
    expect([host, isPrivateHost(host)]).toEqual([host, true])
  for (const host of ['example.com', 'example.com.', '8.8.8.8'])
    expect([host, isPrivateHost(host)]).toEqual([host, false])
})

test('P-4 a registry a public catalog names on a private address is not used', async () => {
  const { deps } = web({
    'https://public.example/.well-known/ard.json': {
      body: catalog([{ identifier: 'r', type: 'application/ai-registry+json', url: 'http://127.0.0.1:8080' }], null),
    },
  })
  const d = await discover(deps, 'public.example')
  if ('error' in d) throw new Error(d.error)
  expect(d.registries).toEqual([{ identifier: 'r', url: undefined, displayName: undefined }])
})

test('D-11 a registry URL is resolved against the nested catalog that lists it', async () => {
  const { deps } = web({
    'https://pub.example/.well-known/ard.json': {
      body: catalog([{ identifier: 'n', type: 'application/ai-catalog+json', url: 'https://cdn.example/v1/catalog.json' }], null),
    },
    'https://cdn.example/v1/catalog.json': { body: catalog([{ identifier: 'r', type: 'application/ai-registry+json', url: 'registry' }]) },
  })
  const d = await discover(deps, 'pub.example')
  if ('error' in d) throw new Error(d.error)
  expect(d.registries[0]!.url).toBe('https://cdn.example/v1/registry')
})

test('D-12 at most three catalog links from a page; the same resource once', async () => {
  const links = Array.from({ length: 10 }, (_, i) => `<link rel="ard" href="/c${i}.json">`).join('') + '<link rel="ard" href="/c0.json#again">'
  const { deps, calls } = web({ 'https://example.com/docs': { body: `<head>${links}</head>` } })
  await discover(deps, 'https://example.com/docs')
  expect(calls.filter(c => /\/c\d\.json/.test(c.url)).length).toBe(3)
})

test('D-13 link parsing: quoted params, comments, data- attributes, <base>, entities', async () => {
  expect(findCatalogLinks('https://e.example/', { link: '</wrong>; title="x; rel=ard"; rel=alternate' }, '', ['ard', 'ai-catalog'])).toEqual([])
  expect(findCatalogLinks('https://e.example/', {}, '<!-- <link rel="ard" href="/comment"> --><link data-rel="ard" data-href="/data">', ['ard', 'ai-catalog'])).toEqual([])
  expect(findCatalogLinks('https://e.example/p', {}, '<base href="https://cdn.example/"><link rel="ard" href="catalog.json">', ['ard', 'ai-catalog'])).toEqual([
    { url: 'https://cdn.example/catalog.json', rel: 'ard' },
  ])
  expect(findCatalogLinks('https://e.example/', {}, '<link rel="ard" href="/catalog&#46;json">', ['ard', 'ai-catalog'])).toEqual([
    { url: 'https://e.example/catalog.json', rel: 'ard' },
  ])
})

test('C-5 a full store is not an error: the answer is used uncached', async () => {
  const { deps } = web({
    'https://example.com/.well-known/ard.json': { headers: { etag: '"v"' }, body: catalog([entry('x', 'https://example.com/card')], null) },
    'https://example.com/card': { headers: { etag: '"c"' }, body: CARD },
  })
  const full = { ...deps, store: { ...deps.store, set: async () => { throw new Error('store is full') } } }
  const d = await discover(full, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.card?.name).toBe(CARD.name)
})

test('C-6 the cache keeps at most 40 entries', async () => {
  const routes: Record<string, Route> = {}
  const { deps } = web(routes)
  for (let i = 0; i < 60; i++) {
    routes[`https://d${i}.example/.well-known/ard.json`] = { headers: { etag: `"${i}"` }, body: catalog([], null) }
    await discover(deps, `d${i}.example`)
  }
  expect((await deps.store.keys()).filter(k => k.startsWith('http:')).length <= 40).toBe(true)
})

test('C-7 C-8 a 304 updates the stored validator and directives; Age counts against max-age', async () => {
  const routes: Record<string, Route> = {
    'https://example.com/.well-known/ard.json': { headers: { etag: '"a"', 'cache-control': 'max-age=0' }, body: catalog([], null) },
  }
  const { deps, calls, clock } = web(routes)
  await discover(deps, 'example.com')
  routes['https://example.com/.well-known/ard.json'] = { status: 304, headers: { etag: '"b"', 'cache-control': 'no-store' }, body: '' }
  await discover(deps, 'example.com')
  routes['https://example.com/.well-known/ard.json'] = { headers: { etag: '"c"' }, body: catalog([], null) }
  await discover(deps, 'example.com')
  const sent = calls.filter(c => c.url === 'https://example.com/.well-known/ard.json').map(c => c.headers['if-none-match'])
  expect(sent).toEqual([undefined, '"a"', undefined])

  routes['https://e2.example/.well-known/ard.json'] = { headers: { 'cache-control': 'max-age=60', age: '120' }, body: catalog([], null) }
  await discover(deps, 'e2.example')
  clock.t += 1000
  await discover(deps, 'e2.example')
  expect(calls.filter(c => c.url === 'https://e2.example/.well-known/ard.json').length).toBe(2)
})

// Second review pass (2026-11-24).
test('T-2 an IPv6 literal is a valid target', async () => {
  expect(parseTarget('https://[2001:4860:4860::8888]/')).toEqual({ origin: 'https://[2001:4860:4860::8888]', page: 'https://[2001:4860:4860::8888]/', isLocal: false })
})

test('P-5 a public card reached from a local catalog is public', async () => {
  const { deps } = web({
    'http://localhost:8787/.well-known/ard.json': { body: catalog([entry('x', 'https://public.example/card.json')], null) },
    'https://public.example/card.json': { body: CARD },
  })
  const d = await discover(deps, 'http://localhost:8787')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.isLocal).toBe(false)
})

test('D-14 an inline card is measured in bytes', async () => {
  const big = { ...CARD, _meta: { 'com.example/pad': '€'.repeat(30_000) } }
  const { deps } = web({
    'https://example.com/.well-known/ard.json': { body: catalog([{ identifier: 'big', type: 'application/mcp-server-card+json', data: big }], null) },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.errors[0]).toBe('the card is larger than 64 KiB')
})

test('D-15 an HTML tokenizer reads <link>: quoted values hold spaces, "=" and ">"', async () => {
  expect(findCatalogLinks('https://e.example/', {}, '<link title=" rel=ard href=/fake " rel="alternate" href="/real">', ['ard', 'ai-catalog'])).toEqual([])
  expect(findCatalogLinks('https://e.example/', {}, '<link title="a>b" rel="ard" href="/real">', ['ard', 'ai-catalog'])).toEqual([{ url: 'https://e.example/real', rel: 'ard' }])
})

test('C-9 the cache cap holds under concurrent writes, and sizes are bytes', async () => {
  const routes: Record<string, Route> = {}
  const { deps } = web(routes)
  for (let i = 0; i < 60; i++) routes[`https://d${i}.example/.well-known/ard.json`] = { headers: { etag: `"${i}"` }, body: catalog([], null) }
  await Promise.all(Array.from({ length: 60 }, (_, i) => discover(deps, `d${i}.example`)))
  expect((await deps.store.keys()).filter(k => k.startsWith('http:')).length <= 40).toBe(true)

  routes['https://euro.example/.well-known/ard.json'] = { headers: { etag: '"e"' }, body: JSON.stringify({ entries: [], pad: '€'.repeat(30_000) }) }
  await discover(deps, 'euro.example')
  const keys = await deps.store.keys()
  expect(keys.some(k => k.includes('euro.example/.well-known/ard.json'))).toBe(false)
})

// The default: exactly what SEP-2127 and the AI Catalog it relies on name.
test('DEF-1 by default only /.well-known/ai-catalog.json is read, not ard.json', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ai-catalog.json': { body: catalog([entry('x', 'https://example.com/card')]) },
    'https://example.com/.well-known/ard.json': { body: catalog([entry('y', 'https://example.com/card2')], null) },
    'https://example.com/card': { body: CARD },
  })
  const d = await discoverWith(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(calls.some(c => c.url === 'https://example.com/.well-known/ard.json')).toBe(false)
  expect(d.servers.map(s => s.identifier)).toEqual(['x'])
})

test('DEF-2 by default rel="ard" is not followed; rel="ai-catalog" (AI Catalog) is', async () => {
  const { deps, calls } = web({
    'https://example.com/docs': { body: '<link rel="ard" href="/a.json"><link rel="ai-catalog" href="/c.json">' },
    'https://example.com/c.json': { body: catalog([entry('x', 'https://example.com/card')]) },
    'https://example.com/card': { body: CARD },
  })
  const d = await discoverWith(deps, 'https://example.com/docs')
  if ('error' in d) throw new Error(d.error)
  expect(calls.some(c => c.url === 'https://example.com/a.json')).toBe(false)
  expect(d.servers.map(s => s.identifier)).toEqual(['x'])
})

test('P-6 a catalog\'s card or registry URL with markup is not used (security review C1)', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ai-catalog.json': {
      body: catalog([
        entry('md', 'https://cards.example/x/[https://good.example/card](https://cards.example/)'),
        { identifier: 'reg', type: 'application/ai-registry+json', url: 'https://reg.example/[a](b)' },
      ]),
    },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.errors[0]!.includes('square bracket')).toBe(true)
  expect(d.registries[0]!.url).toBe(undefined)
  expect(calls.some(c => c.url.startsWith('https://cards.example/'))).toBe(false)
})

test('P-7 a catalog\'s card or registry URL that names a user before its host is not used (security review C3)', async () => {
  const { deps, calls } = web({
    'https://example.com/.well-known/ai-catalog.json': {
      body: catalog([
        entry('at', 'https://good.example@cards.example/card'),
        { identifier: 'reg', type: 'application/ai-registry+json', url: 'https://good.example@reg.example/' },
      ]),
    },
  })
  const d = await discover(deps, 'example.com')
  if ('error' in d) throw new Error(d.error)
  expect(d.servers[0]!.errors[0]!.includes('names a user before its host')).toBe(true)
  expect(d.registries[0]!.url).toBe(undefined)
  expect(calls.some(c => c.url.includes('cards.example'))).toBe(false)
})
