import { expect, test } from 'claude-code/testing'
import { validateCard } from '../hooks/card'
import { fixtures } from './fixtures'

// V-1: every official valid example passes, every official invalid one fails.
test('V-1 official valid examples pass', async () => {
  for (const [name, card] of Object.entries(fixtures.official.valid))
    expect([name, validateCard(card)]).toEqual([name, []])
})

test('V-1 official invalid examples fail', async () => {
  for (const [name, card] of Object.entries(fixtures.official.invalid))
    expect([name, validateCard(card).length > 0]).toEqual([name, true])
})

// V-2: live cards. Ten publishers' cards are valid (as ajv with schema.json
// also found on 2026-11-24); Zapier's and the Hugging Face Spaces registry's
// are not, and are refused rather than repaired.
test('V-2 live cards: valid ones pass', async () => {
  for (const [name, card] of Object.entries(fixtures.live)) {
    if (name.startsWith('zapier') || name === 'hf-rembg') continue
    expect([name, validateCard(card)]).toEqual([name, []])
  }
})

test('V-2 live cards: Zapier is refused for a missing $schema and a long description', async () => {
  const errors = validateCard(fixtures.live['zapier.com_.well-known_mcp_server-card'])
  expect(errors.some(e => e.startsWith('$schema is required'))).toBe(true)
  expect(errors.some(e => e.startsWith('description must be at most 100'))).toBe(true)
})

test('V-2 live cards: a registry server.json served as a card is refused', async () => {
  const errors = validateCard(fixtures.live['hf-rembg'])
  expect(errors.some(e => e.startsWith('$schema must be'))).toBe(true)
  expect(errors.some(e => e.startsWith('name must be reverse-DNS'))).toBe(true)
})

test('V-3 version ranges are refused (schema.ts ServerCard.version)', async () => {
  const base = fixtures.official.valid.minimal
  for (const version of ['^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '1.*'])
    expect([version, validateCard({ ...base, version }).length]).toEqual([version, 1])
  for (const version of ['1.0.2', '2.1.0-alpha', '2026.11.1'])
    expect([version, validateCard({ ...base, version })]).toEqual([version, []])
})

test('V-4 extensionsInfo keys need a prefix and object values', async () => {
  const base = fixtures.official.valid.minimal
  const remote = (extensionsInfo: unknown) => ({
    ...base,
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', extensionsInfo }],
  })
  expect(validateCard(remote({ 'io.modelcontextprotocol/events': { keys: [] } }))).toEqual([])
  expect(validateCard(remote({ events: {} })).length).toBe(1)
  expect(validateCard(remote({ 'io.modelcontextprotocol/tasks': true })).length).toBe(1)
})

test('V-5 remote type and url pattern', async () => {
  const base = fixtures.official.valid.minimal
  const card = (r: unknown) => ({ ...base, remotes: [r] })
  expect(validateCard(card({ type: 'websocket', url: 'https://x.example/mcp' })).length).toBe(1)
  expect(validateCard(card({ type: 'sse', url: 'ftp://x.example/mcp' })).length).toBe(1)
  expect(validateCard(card({ type: 'sse', url: '{base}/mcp' }))).toEqual([])
})

// Review findings (2026-11-24): divergences from schema.ts.
test('V-6 validator follows schema.ts on icons, lengths, URIs, JSON values, key rules and ranges', async () => {
  const base = fixtures.official.valid.minimal
  const remote = (extensionsInfo: unknown) => ({ ...base, remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp', extensionsInfo }] })
  expect(validateCard({ ...base, icons: [{ src: 'https://x.example/i', mimeType: 123 }] }).length).toBe(1)
  expect(validateCard({ ...base, icons: [{ src: 'https://x.example/i', sizes: [false] }] }).length).toBe(1)
  expect(validateCard({ ...base, description: '😀'.repeat(51) })).toEqual([])
  expect(validateCard({ ...base, description: '😀'.repeat(101) }).length).toBe(1)
  expect(validateCard({ ...base, websiteUrl: 'https://x.example/a b' }).length).toBe(1)
  expect(validateCard(remote({ 'com.example/x': { value: null, ratio: 0.5 } }))).toEqual([])
  expect(validateCard(remote({ 'com.example/': {} }))).toEqual([])
  expect(validateCard({ ...base, _meta: { 'bad key': true } }).length).toBe(1)
  expect(validateCard({ ...base, _meta: { 'com.example/ok': 1, plain: 2 } })).toEqual([])
  expect(validateCard({ ...base, version: '  >=1.2.3' }).length).toBe(1)
})

test('V-7 a URI with a broken percent-encoding is not a URI', async () => {
  expect(validateCard({ ...fixtures.official.valid.minimal, websiteUrl: 'https://safe.example/%zz' }).length).toBe(1)
  expect(validateCard({ ...fixtures.official.valid.minimal, websiteUrl: 'https://safe.example/%20ok' })).toEqual([])
})

// Security review (2026-11-24): text that makes a terminal show one thing
// while another is meant.
const ESC_URL = 'https://evil.example/mcp\x1b[2K\x1b[1Ghttps://good.example/mcp'
const OSC8_TITLE = '\x1b]8;;https://good.example\x07Good Corp\x1b]8;;\x07'

test('X-1 the review\'s card is refused: an ESC sequence in a remote URL, an OSC 8 link in the title', async () => {
  const base = fixtures.official.valid.minimal
  const card = { ...base, title: OSC8_TITLE, remotes: [{ type: 'streamable-http', url: ESC_URL }] }
  const errors = validateCard(card)
  expect(errors.some(e => e.includes('control character'))).toBe(true)
  expect(errors.some(e => e.includes('printable ASCII'))).toBe(true)
  expect(validateCard({ ...base, title: OSC8_TITLE }).length > 0).toBe(true)
  expect(validateCard({ ...base, remotes: [{ type: 'streamable-http', url: ESC_URL }] }).length > 0).toBe(true)
})

test('X-2 every string, key or value, is held to it: C0, DEL, C1, bidi and format marks', async () => {
  const base = fixtures.official.valid.minimal
  for (const bad of ['\x07', '\x7f', '\u009b', '​', '‏', '‮', '⁦', '﻿']) {
    expect([JSON.stringify(bad), validateCard({ ...base, description: `x${bad}y` }).length > 0]).toEqual([JSON.stringify(bad), true])
  }
  expect(validateCard({ ...base, _meta: { 'com.example/note': 'a\x1bb' } }).length > 0).toBe(true)
  expect(validateCard({ ...base, _meta: { 'com.example/\x1bk': 1 } }).length > 0).toBe(true)
  const header = { ...base, remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-A', value: 'ok\x1b[8m' }] }] }
  expect(validateCard(header).length > 0).toBe(true)
  // Ordinary non-ASCII text is fine outside URLs.
  expect(validateCard({ ...base, description: 'Données en temps réel — 日本語' })).toEqual([])
  expect(validateCard({ ...base, remotes: [{ type: 'streamable-http', url: 'https://exämple.com/mcp' }] }).length > 0).toBe(true)
})

// Security review of the Codex forms (C1): Markdown or HTML in a card URL could
// make a host that renders either show a link text in place of the URL.
const MARKDOWN_URL = 'https://evil.example/x/[https://good.example/mcp](https://evil.example/)'

test('X-4 a URL with `, <, > or square brackets outside an IPv6 host is refused; an IPv6 host is not', async () => {
  const base = fixtures.official.valid.minimal
  const remote = (url: string) => ({ ...base, remotes: [{ type: 'streamable-http', url }] })
  for (const url of [MARKDOWN_URL, 'https://a.example/`code`', 'https://a.example/<b>', '{base}/x/[a](b)']) {
    const errors = validateCard(remote(url))
    expect([url, errors.some(e => e.includes('square brackets'))]).toEqual([url, true])
  }
  for (const url of ['https://[::1]:8080/mcp', 'https://[2001:db8::1]/mcp', 'https://{tenant}.example.com/mcp?x=1&y=%20'])
    expect([url, validateCard(remote(url))]).toEqual([url, []])
  expect(validateCard({ ...base, websiteUrl: MARKDOWN_URL }).some(e => e.startsWith('websiteUrl'))).toBe(true)
  expect(validateCard({ ...base, repository: { url: MARKDOWN_URL, source: 'github' } }).some(e => e.startsWith('repository.url'))).toBe(true)
})
