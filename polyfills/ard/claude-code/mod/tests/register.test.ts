import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { readAnswer } from '../hooks/register'

const DISCOVER = 'mcp__ard-discovery__ard_discover'
const SEARCH = 'mcp__ard-discovery__ard_search'
const PRESENT = 'mcp__mcp-server-cards__present_server_cards'

/** mcp-server-cards beneath: records what it is handed, answers as it does. */
// A search's run, as Claude Code makes it once the person said yes to the ask (A-7): $.tool.run.
const cards = (on: On, registries: unknown[] = []) => {
  const handed: Record<string, unknown>[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ard-discovery__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: PRESENT }, (_, e) => {
    const { tool, tool_use_id, ...payload } = e as Record<string, unknown>
    void tool
    void tool_use_id
    handed.push(payload)
    // As the real host hands it back: the tool's result is text, here JSON.
    return { result: JSON.stringify({ text: `shown by mcp-server-cards (${payload.entries ? 'entries' : 'domain'})`, servers: 1, registries }) as never }
  })
  return handed
}

test('A-1 discovery hands the domain to mcp-server-cards with ARD\'s sources: ard.json (no specVersion needed) and rel="ard"', async ($, on) => {
  const handed = cards(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: DISCOVER, tool_use_id: 'toolu_a1', domain: 'buildkite.com' } as never)
  expect(handed).toEqual([
    {
      by: 'ard-discovery (ARD v0.91 draft)',
      under: 'toolu_a1',
      domain: 'buildkite.com',
      catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }],
      rels: ['ard'],
    },
  ])
  expect(String(r.result)).toBe('shown by mcp-server-cards (domain)')
})

test('A-2 search sends the query to the configured registry and hands its results over under its own row, with ARD\'s sources for the publisher check', async ($, on) => {
  const handed = cards(on)
  const posted: { url: string; body: string }[] = []
  on('http.fetch', (_, e) => {
    posted.push({ url: e.url, body: String(e.init?.body) })
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ results: [{ identifier: 'urn:air:buildkite.com:mcp:buildkite', type: 'application/mcp-server-card+json', url: 'https://mcp.buildkite.com/mcp/server-card', score: 75 }] }),
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.run({ tool: SEARCH, tool_use_id: 'toolu_a2', query: 'why did my CI build fail', registry: 'https://registry.example' } as never)
  expect(posted[0]!.url).toBe('https://registry.example/search')
  expect(JSON.parse(posted[0]!.body).query.text).toBe('why did my CI build fail')
  expect(handed[0]).toEqual({
    by: 'the ARD registry at registry.example',
    under: 'toolu_a2',
    entries: [{ identifier: 'urn:air:buildkite.com:mcp:buildkite', type: 'application/mcp-server-card+json', url: 'https://mcp.buildkite.com/mcp/server-card', listedIn: 'https://registry.example/search', score: 75 }],
    catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }],
    rels: ['ard'],
  })
  const text = String(r.result)
  expect(text.includes('The query text was sent to: registry.example')).toBe(true)
  expect(text.includes('shown by mcp-server-cards (entries)')).toBe(true)
})

test('A-3 a registry named by domain is found in that domain\'s catalogs, read by mcp-server-cards', async ($, on) => {
  const handed = cards(on, [{ identifier: 'urn:air:publisher.example:registry:search', url: 'https://registry.example/' }])
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.run({ tool: SEARCH, query: 'x', registry: 'publisher.example' } as never)
  expect(handed[0]).toEqual({ by: 'ard-discovery (ARD v0.91 draft)', domain: 'publisher.example', catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'] })
  expect(posted).toEqual(['https://registry.example/search'])
})

test('A-4 without mcp-server-cards it says so, and how to install it', async ($, on) => {
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ard-discovery__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' } as never)
  expect(String((r as { deny?: string; result?: unknown }).deny ?? (r as { result?: unknown }).result).includes('needs the mcp-server-cards plugin')).toBe(true)
})

test('A-5 the registry is a setting: the configured one is asked when none is named', { options: { registry: 'https://registry.example/api' } }, async ($, on) => {
  cards(on)
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.run({ tool: SEARCH, query: 'x' } as never)
  expect(posted).toEqual(['https://registry.example/api/search'])
  expect(String(r.result).includes('The query text was sent to: registry.example')).toBe(true)
})

test('A-6 mcp-server-cards\' answer is read however the host hands it back: object, JSON text, content blocks, structuredContent, core text', () => {
  const answer = { text: 'shown', servers: 2, registries: [{ identifier: 'r', url: 'https://r.example/' }] }
  const json = JSON.stringify(answer)
  for (const r of [
    { result: answer },
    { result: json },
    { result: [{ type: 'text', text: json }] },
    { result: { content: [{ type: 'text', text: json }], isError: false } },
    { result: { content: [], isError: false, structuredContent: answer } },
    { result: undefined, text: json },
  ])
    expect(readAnswer(r)).toEqual(answer)
  expect(readAnswer({ result: 'plain words' })).toBe(undefined)
})

// Security review M2: a search sends the person's words to a third party, so each one is put to them first.
test('A-7 every search asks the person, naming the registry and the query; refused with nobody to ask; a deny beneath stands', async ($, on) => {
  cards(on)
  const beneath = { decision: 'allow' as 'allow' | 'deny' }
  on('tool.check', { tool: SEARCH }, () => (beneath.decision === 'deny' ? { decision: 'deny', reason: 'a rule' } : { decision: 'allow' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const input = { query: 'why did my\u001b[2K CI build\nfail', registry: 'https://registry.example/api' }
  const asked = await $.tool.check({ tool: SEARCH, input, tool_use_id: 'a7', approver: 'person' } as never)
  expect(asked.decision).toBe('ask')
  expect(String((asked as { reason?: string }).reason)).toBe(
    'Send this search to https://registry.example/api, and to up to three registries it refers to? "why did my [2K CI build fail"',
  )
  const byDomain = await $.tool.check({ tool: SEARCH, input: { query: 'x', registry: 'publisher.example' }, tool_use_id: 'a7b', approver: 'person' } as never)
  expect(String((byDomain as { reason?: string }).reason).startsWith('Send this search to the registries that publisher.example lists (up to three), and to up to three registries they refer to?')).toBe(true)
  const nobody = await $.tool.check({ tool: SEARCH, input } as never)
  expect(nobody.decision).toBe('deny')
  beneath.decision = 'deny'
  const ruled = await $.tool.check({ tool: SEARCH, input, tool_use_id: 'a7c', approver: 'person' } as never)
  expect(ruled.decision).toBe('deny')
})

test('A-8 with nobody to ask (claude -p, a background loop), nothing is sent', async ($, on) => {
  const handed = cards(on)
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  on('tool.check', { tool: SEARCH }, () => ({ decision: 'allow' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: SEARCH, query: 'check why my CI build failed', registry: 'https://registry.example/api' } as never)
  expect(String((r as { deny?: string; text?: string }).deny ?? (r as { text?: string }).text).includes('nobody can be asked')).toBe(true)
  expect(posted).toEqual([])
  expect(handed).toEqual([])
})

// Security review R1: the ask shows at most 300 characters with control
// characters blanked, so a query the ask could not show whole is not sent.
test('A-9 a query longer than the ask shows, or with control characters or direction marks, is refused and nothing is sent', async ($, on) => {
  const handed = cards(on)
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  on('tool.check', { tool: SEARCH }, () => ({ decision: 'allow' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const long = await $.tool.run({ tool: SEARCH, tool_use_id: 'a9', query: `check why my CI build failed ${'x'.repeat(300)}`, registry: 'https://registry.example/api' } as never)
  expect(String((long as { deny?: string }).deny)).toContain('under 300 characters')
  const hidden = await $.tool.run({ tool: SEARCH, tool_use_id: 'a9b', query: 'CI build\u001b[8m secret words', registry: 'https://registry.example/api' } as never)
  expect(String((hidden as { deny?: string }).deny)).toContain('without control characters')
  // A right-to-left override would make the ask read differently from the bytes sent.
  const flipped = await $.tool.run({ tool: SEARCH, tool_use_id: 'a9d', query: 'CI build \u202Edeliaf', registry: 'https://registry.example/api' } as never)
  expect(String((flipped as { deny?: string }).deny)).toContain('direction marks')
  const asked = await $.tool.check({ tool: SEARCH, input: { query: 'a\u202Eb\u2028c\u200Bd', registry: 'https://registry.example/api' }, tool_use_id: 'a9e', approver: 'person' } as never)
  expect(String((asked as { reason?: string }).reason).endsWith('"a b c d"')).toBe(true)
  expect(posted).toEqual([])
  expect(handed).toEqual([])
  const ok = await $.tool.run({ tool: SEARCH, tool_use_id: 'a9c', query: 'x'.repeat(300), registry: 'https://registry.example/api' } as never)
  expect((ok as { deny?: string }).deny).toBe(undefined)
  expect(posted).toEqual(['https://registry.example/api/search'])
})

// The plugin ships with no registry, so none is chosen for the person.
test('A-10 with no registry set and none named, the search is refused before any ask, nothing is sent, and Claude is told to ask the person', async ($, on) => {
  const descriptions: Record<string, string> = {}
  on('tool.register', (_, e) => {
    descriptions[e.name] = String((e as { description?: unknown }).description)
    return { value: { tool: `mcp__ard-discovery__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.check', { tool: SEARCH }, () => ({ decision: 'allow' }))
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(descriptions.ard_search).toContain('Do not choose a registry for them')
  for (const input of [{ query: 'check why my CI build failed' }, { query: 'check why my CI build failed', registry: '  ' }]) {
    const checked = await $.tool.check({ tool: SEARCH, input, tool_use_id: 'a10', approver: 'person' } as never)
    expect(checked.decision).toBe('deny')
    expect(String((checked as { reason?: string }).reason)).toContain('Ask the person which registry to search')
    const ran = await $.tool.run({ tool: SEARCH, tool_use_id: 'a10b', ...input } as never)
    expect(String((ran as { deny?: string }).deny)).toContain('No ARD registry is set')
  }
  expect(posted).toEqual([])
})
