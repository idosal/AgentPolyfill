// The ARD plugin as Copilot runs it: ard_discover, ard_search with its form, and
// add_mcp_server for what either showed. Against plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { copilotEnv, fakeCopilot, localWeb, startServer } from '../../../server-cards/copilot/test/harness'

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
  '/at-registry/search': { body: { results: [{ identifier: 'urn:air:localhost:at', type: TYPE, url: 'https://good.example@cards.example/at.json' }] } },
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

// The local registry is set unless a test says otherwise; an env value of
// undefined leaves that variable out, as if it were never set.
type Opts = Omit<NonNullable<Parameters<typeof startServer>[1]>, 'env'> & { env?: Record<string, string | undefined> }
const server = (opts: Opts = {}) => {
  const fake = fakeCopilot()
  const all = { ...copilotEnv(fake), ARD_DISCOVERY_REGISTRY: web.origin, ...(opts.env ?? {}) }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) if (v !== undefined) env[k] = v
  // Copilot CLI 1.0.115 asks its MCP servers for 2025-11-25 (seen live).
  const s = startServer(SERVER, { protocol: '2025-11-25', ...opts, env })
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
  assert.deepEqual(s.fake.calls().filter(c => c.args[1] === 'add').map(c => c.args), [['mcp', 'add', '--transport', 'http', 'example-ci', `${web.origin}/ci/mcp`]])
})

test('A-3 a search with no form, or declined, sends nothing', async () => {
  const before = searches().length
  const none = server({ elicitation: false })
  assert.match((await none.call('ard_search', { query: QUERY })).text, /^Nothing was sent: this Copilot client offers no form/)
  const no = server({ answer: { action: 'decline' } })
  assert.match((await no.call('ard_search', { query: QUERY })).text, /^Nothing was sent: the form was declined/)
  assert.equal(searches().length, before)
})

test('A-4 the question names the registry endpoint and the exact query', async () => {
  const s = server({ answer: { action: 'decline' } })
  await s.call('ard_search', { query: QUERY })
  assert.equal(s.asked[0]!.message, `${new URL(web.origin).host}: send this search to ${web.origin}/search, and to up to three registries it refers to?\nQuery: "${QUERY}"\nA registry is a service someone else runs, and it sees the query.`)
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

// The plugin ships with no registry: which one sees the person's words is theirs to choose.
test('A-7 with no registry set and none named, the search is refused before any form, nothing is sent, and Copilot is told to ask the person; a named one is searched', async () => {
  const before = searches().length
  for (const setting of [undefined, '', '  ']) {
    // A decline, so that even a form shown by mistake sends nothing.
    const s = server({ answer: { action: 'decline' }, env: { ARD_DISCOVERY_REGISTRY: setting } })
    const list = await s.request('tools/list', {})
    const [search] = list.result.tools.filter((t: any) => t.name === 'ard_search')
    assert.match(search.description, /none is configured: pass `registry` with the one the person names\. Do not choose a registry for them; if they have not named one, ask which/)
    assert.match(search.inputSchema.properties.registry.description, /No registry is configured, so a search without it is refused/)
    assert.doesNotMatch(JSON.stringify(list.result.tools), /huggingface/i)
    for (const args of [{ query: QUERY }, { query: QUERY, registry: '  ' }]) {
      const r = await s.call('ard_search', args)
      assert.equal(r.isError, true, JSON.stringify(setting))
      assert.match(r.text, /^No ARD registry is set, and this search names none\. Ask the person which registry to search/, JSON.stringify(setting))
      assert.match(r.text, /pass it as `registry`; they can also set one with ARD_DISCOVERY_REGISTRY/)
    }
    assert.equal(s.asked.length, 0, JSON.stringify(setting))
  }
  assert.equal(searches().length, before)
  // With none set, the registry the person names is searched as before.
  const named = server({ answer: human, env: { ARD_DISCOVERY_REGISTRY: undefined } })
  const r = await named.call('ard_search', { query: QUERY, registry: web.origin })
  assert.equal(r.isError, false, r.text)
  assert.equal(named.asked.length, 1)
  assert.equal(searches().length, before + 1)
})

test('A-8 a result whose card URL, or whose card\'s remote URL, holds Markdown is refused and never put in a form (security review C1)', async () => {
  const s = server({ answer: human })
  const r = await s.call('ard_search', { query: QUERY, registry: `${web.origin}/md-registry` })
  assert.equal((r.text.match(/REFUSED: [^\n]*square bracket/g) ?? []).length, 2, r.text)
  const add = await s.call('add_mcp_server', { identifier: 'urn:air:localhost:md', url: `${web.origin}/x/[https://good.example/mcp](https://evil.example/)` })
  assert.match(add.text, /is not a server shown in this session/)
  assert.equal(s.asked.length, 1) // the search's own form, and no other
})

test('A-9 a query with `, <, > or square brackets is refused before anyone is asked, so it can\'t show differently in the form from what is sent', async () => {
  const before = searches().length
  const s = server({ answer: human })
  for (const query of ['check [my CI](https://evil.example/)', 'find `ci` tools', 'ci <b>build</b>', 'ci ]']) {
    const r = await s.call('ard_search', { query })
    assert.equal(r.isError, true, query)
    assert.match(r.text, /without `, <, > or square brackets/, query)
  }
  assert.equal(s.asked.length, 0)
  assert.equal(searches().length, before)
})

test('A-10 a registry or a result URL that names a user before its host is refused: the form would show one host while the query goes to another (security review C3)', async () => {
  const before = searches().length
  const s = server({ answer: human })
  const named = await s.call('ard_search', { query: QUERY, registry: `http://good.example@${new URL(web.origin).host}` })
  assert.match(named.text, /names a user before its host/)
  assert.equal(s.asked.length, 0)
  assert.equal(searches().length, before)
  const r = await s.call('ard_search', { query: QUERY, registry: `${web.origin}/at-registry` })
  assert.match(r.text, /REFUSED: [^\n]*names a user before its host/)
})

test('A-11 only the explicit "search" sends: an accept without the choice, or with "no", sends nothing; the form is a required choice', async () => {
  const before = searches().length
  for (const content of [{}, { decision: 'no' }, { decision: 'add' }]) {
    const s = server({ answer: { action: 'accept', afterMs: 50, content } })
    const r = await s.call('ard_search', { query: QUERY })
    assert.match(r.text, /^Nothing was sent/, JSON.stringify(content))
    assert.deepEqual(s.asked[0]!.requestedSchema, {
      type: 'object',
      properties: { decision: { type: 'string', title: 'Your answer', oneOf: [{ const: 'no', title: "Don't send it" }, { const: 'search', title: 'Send the search' }] } },
      required: ['decision'],
    })
  }
  assert.equal(searches().length, before)
  const yes = server({ answer: { action: 'accept', afterMs: 50, content: { decision: 'search' } } })
  assert.equal((await yes.call('ard_search', { query: QUERY })).isError, false)
  assert.equal(searches().length, before + 1)
})

// The form names the registry as it is searched, as it shows the query (A-6):
// one it could not name exactly is refused, whether named or set.
test('A-12 a registry over 200 characters, or with spaces, control characters or direction marks, named or set, is refused before any form and nothing is sent', async () => {
  const before = searches().length
  const s = server({ answer: human })
  for (const registry of [`${web.origin}/${'x'.repeat(200)}`, `${web.origin}/a\u202eb`, `${web.origin}/api\u200b`, `${web.origin}/a b`, `${new URL(web.origin).host}\u200b`]) {
    const r = await s.call('ard_search', { query: QUERY, registry })
    assert.equal(r.isError, true, JSON.stringify(registry))
    assert.match(r.text, /^The `registry` in this search must be at most 200 characters, with no spaces, control characters or direction marks/, JSON.stringify(registry))
  }
  const set = server({ answer: human, env: { ARD_DISCOVERY_REGISTRY: `${web.origin}/api\u200b` } })
  const r = await set.call('ard_search', { query: QUERY })
  assert.match(r.text, /^ARD_DISCOVERY_REGISTRY must be at most 200 characters/, r.text)
  assert.equal(s.asked.length + set.asked.length, 0)
  assert.equal(searches().length, before)
  // One the form can name exactly is searched as before.
  assert.equal((await s.call('ard_search', { query: QUERY, registry: web.origin })).isError, false)
  assert.equal(searches().length, before + 1)
})

test('A-13 as Copilot: its name in what the tools say, and in the no-registry answer', async () => {
  const s = server({ env: { ARD_DISCOVERY_REGISTRY: undefined } })
  const list = await s.request('tools/list', {})
  assert.match(list.result.tools[0].description, /connect Copilot to a service/)
  assert.match(list.result.tools[1].description, /Copilot asks the person in a form/)
  assert.doesNotMatch(JSON.stringify(list.result.tools), /Codex|codex/)
  assert.match((await s.call('ard_search', { query: QUERY })).text, /ARD_DISCOVERY_REGISTRY in the environment Copilot starts in/)
})

test('A-14 stand-down: ARD_DISCOVERY_DISABLED registers no tools', async () => {
  const s = server({ env: { ARD_DISCOVERY_DISABLED: '1' } })
  await s.ready
  assert.deepEqual((await s.request('tools/list', {})).result.tools, [])
})
