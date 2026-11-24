import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { readAnswer } from '../hooks/register'

const DISCOVER = 'mcp__ard-discovery__ard_discover'
const SEARCH = 'mcp__ard-discovery__ard_search'
const PRESENT = 'mcp__mcp-server-cards__present_server_cards'

/** mcp-server-cards beneath: records what it is handed, answers as it does. */
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
  const r = await $.tool.call({ tool: SEARCH, tool_use_id: 'toolu_a2', query: 'why did my CI build fail', registry: 'https://huggingface-hf-discover.hf.space' } as never)
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
  await $.tool.call({ tool: SEARCH, query: 'x', registry: 'huggingface.co' } as never)
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
  const r = await $.tool.call({ tool: SEARCH, query: 'x' } as never)
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
