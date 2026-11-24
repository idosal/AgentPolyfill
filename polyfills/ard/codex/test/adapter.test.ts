// The ARD plugin as Codex runs it: ard_discover, ard_search with its form, and
// add_mcp_server for what either showed. Against plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeCodex, localWeb, startServer } from '../../../server-cards/codex/test/harness'

const SERVER = fileURLToPath(new URL('../../plugin/dist/server.mjs', import.meta.url))
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const TYPE = 'application/mcp-server-card+json'
const card = (name: string, title: string, path: string) => ({
  $schema: SCHEMA,
  name,
  version: '1.0.0',
  description: `${title}.`,
  title,
  remotes: [{ type: 'streamable-http', url: `{origin}${path}` }],
})

const web = await localWeb({
  // ard.json only: an ARD manifest needs no specVersion.
  '/.well-known/ard.json': { body: { entries: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: '{origin}/ci.json' }] } },
  '/ci.json': { body: card('com.example/ci', 'Example CI', '/ci/mcp') },
  // A registry whose results carry Markdown: in a card's remote URL, and in a card URL (security review C1).
  '/md-registry/search': {
    body: {
      results: [
        { identifier: 'urn:air:localhost:md', type: TYPE, url: '{origin}/md.json' },
        { identifier: 'urn:air:localhost:mdurl', type: TYPE, url: '{origin}/x/[https://good.example/card](https://evil.example/)' },
      ],
    },
  },
  '/md.json': { body: card('com.example/md', 'Markdown', '/x/[https://good.example/mcp](https://evil.example/)') },
  '/search': {
    body: {
      results: [
        { identifier: 'urn:air:localhost:ci', type: TYPE, url: '{origin}/ci.json', displayName: 'Example CI', score: 90 },
        { identifier: 'urn:air:localhost:agent', type: 'application/a2a-agent-card+json', url: '{origin}/agent.json' },
      ],
    },
  },
})
after(() => web.close())

const server = (opts: Parameters<typeof startServer>[1] = {}) => {
  const fake = fakeCodex()
  const s = startServer(SERVER, {
    ...opts,
    env: { CODEX_CLI_PATH: fake.bin, CODEX_HOME: fake.dir, FAKE_CODEX_STATE: fake.state, FAKE_CODEX_LOG: fake.log, ARD_DISCOVERY_REGISTRY: web.origin, ...(opts.env ?? {}) },
  })
  after(() => s.stop())
  return { ...s, fake }
}
const searches = () => web.requests.filter(r => r.method === 'POST')
const human = { action: 'accept' as const, afterMs: 50 }
const QUERY = 'check why my CI build failed'

test('A-1 the server: its three tools', async () => {
  const s = server()
  await s.ready
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['ard_discover', 'ard_search', 'add_mcp_server'])
  assert.match(list.result.tools[1].description, new RegExp(`sent to a third party: the registry \\(${web.origin.replace(/[.]/g, '\\.')} unless`))
})

test('A-2 ard_discover reads ard.json, and a server it showed is added after the form', async () => {
  const s = server({ answer: human })
  const d = await s.call('ard_discover', { domain: web.origin })
  assert.match(d.text, /\/\.well-known\/ard\.json \[extra\]: found \(1 entries\)/)
  assert.match(d.text, /title: Example CI/)
  const r = await s.call('add_mcp_server', { domain: web.origin, identifier: 'urn:air:localhost:ci', url: `${web.origin}/ci/mcp` })
  assert.equal(r.isError, false, r.text)
  assert.deepEqual(s.fake.calls().filter(c => c[1] === 'add'), [['mcp', 'add', 'example-ci', '--url', `${web.origin}/ci/mcp`]])
})

test('A-3 a search with no form, or declined, sends nothing', async () => {
  const before = searches().length
  const none = server({ elicitation: false })
  assert.match((await none.call('ard_search', { query: QUERY })).text, /^Nothing was sent: this Codex client offers no form/)
  const no = server({ answer: { action: 'decline' } })
  assert.match((await no.call('ard_search', { query: QUERY })).text, /^Nothing was sent: the form was declined/)
  assert.equal(searches().length, before)
})

test('A-4 the question names the registry endpoint and the exact query', async () => {
  const s = server({ answer: { action: 'decline' } })
  await s.call('ard_search', { query: QUERY })
  assert.equal(s.asked[0]!.message, `Send this search to ${web.origin}/search, and to up to three registries it refers to?\nQuery: "${QUERY}"\nA registry is a service someone else runs, and it sees the query.`)
})

test('A-5 accepted: the query is posted, only Server Cards are shown, and a result is added by identifier after its own form', async () => {
  const s = server({ answer: human })
  const before = searches().length
  const r = await s.call('ard_search', { query: QUERY })
  assert.equal(r.isError, false, r.text)
  const sent = searches().slice(before)
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0]!.body), { query: { text: QUERY, filter: { type: [TYPE] } }, federation: 'referrals', pageSize: 10 })
  assert.match(r.text, /The query text was sent to: 127\.0\.0\.1:\d+/)
  assert.match(r.text, /\(1 results of other types were ignored\.\)/)
  assert.match(r.text, /identifier: urn:air:localhost:ci/)
  const add = await s.call('add_mcp_server', { identifier: 'urn:air:localhost:ci', url: `${web.origin}/ci/mcp` })
  assert.equal(add.isError, false, add.text)
  assert.equal(s.asked.length, 2)
  assert.match(s.asked[1]!.message, /NOT confirmed by its publisher's own catalog/)
})

test('A-6 a query the person could not see in full is refused before anyone is asked', async () => {
  const s = server({ answer: human })
  assert.match((await s.call('ard_search', { query: 'x'.repeat(301) })).text, /under 300 characters/)
  assert.match((await s.call('ard_search', { query: 'find ci\u202eevil' })).text, /without control characters/)
  assert.equal(s.asked.length, 0)
})

test('A-7 an empty registry setting searches only a registry the request names', async () => {
  const s = server({ env: { ARD_DISCOVERY_REGISTRY: '' } })
  assert.match((await s.call('ard_search', { query: QUERY })).text, /No registry is configured/)
})

test('A-8 a result whose card URL, or whose card\'s remote URL, holds Markdown is refused and never put in a form (security review C1)', async () => {
  const s = server({ answer: human })
  const r = await s.call('ard_search', { query: QUERY, registry: `${web.origin}/md-registry` })
  assert.equal((r.text.match(/REFUSED: [^\n]*square bracket/g) ?? []).length, 2, r.text)
  const add = await s.call('add_mcp_server', { identifier: 'urn:air:localhost:md', url: `${web.origin}/x/[https://good.example/mcp](https://evil.example/)` })
  assert.match(add.text, /is not a server shown in this session/)
  assert.equal(s.asked.length, 1) // the search's own form, and no other
})
