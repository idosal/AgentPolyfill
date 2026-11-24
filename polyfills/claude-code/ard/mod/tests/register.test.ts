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
  const r = await $.tool.run({ tool: SEARCH, tool_use_id: 'toolu_a2', query: 'why did my CI build fail', registry: 'https://huggingface-hf-discover.hf.space' } as never)
  expect(posted[0]!.url).toBe('https://huggingface-hf-discover.hf.space/search')
  expect(JSON.parse(posted[0]!.body).query.text).toBe('why did my CI build fail')
  expect(handed[0]).toEqual({
    by: 'the ARD registry at huggingface-hf-discover.hf.space',
    under: 'toolu_a2',
    entries: [{ identifier: 'urn:air:buildkite.com:mcp:buildkite', type: 'application/mcp-server-card+json', url: 'https://mcp.buildkite.com/mcp/server-card', listedIn: 'https://huggingface-hf-discover.hf.space/search', score: 75 }],
    catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }],
    rels: ['ard'],
  })
  const text = String(r.result)
  expect(text.includes('The query text was sent to: huggingface-hf-discover.hf.space')).toBe(true)
  expect(text.includes('shown by mcp-server-cards (entries)')).toBe(true)
})

test('A-3 a registry named by domain is found in that domain\'s catalogs, read by mcp-server-cards', async ($, on) => {
  const handed = cards(on, [{ identifier: 'urn:air:huggingface.co:registry:discover', url: 'https://huggingface-hf-discover.hf.space/' }])
  const posted: string[] = []
  on('http.fetch', (_, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"results":[]}' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.run({ tool: SEARCH, query: 'x', registry: 'huggingface.co' } as never)
  expect(handed[0]).toEqual({ by: 'ard-discovery (ARD v0.91 draft)', domain: 'huggingface.co', catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'] })
  expect(posted).toEqual(['https://huggingface-hf-discover.hf.space/search'])
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
  const byDomain = await $.tool.check({ tool: SEARCH, input: { query: 'x', registry: 'huggingface.co' }, tool_use_id: 'a7b', approver: 'person' } as never)
  expect(String((byDomain as { reason?: string }).reason).startsWith('Send this search to the registry that huggingface.co lists')).toBe(true)
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
