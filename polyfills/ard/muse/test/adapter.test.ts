// The ARD plugin's Muse form: ard_discover as in Codex, no registry search, and add_mcp_server
// giving the `muse mcp add` command, writing nothing. Against the committed Muse bundle,
// ../codex/plugin/muse/dist/server.mjs.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeMuse, localWeb, startServer } from '../../../server-cards/muse/test/harness'

const SERVER = fileURLToPath(new URL('../../../codex/plugin/muse/dist/server.mjs', import.meta.url))
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
  // A registry, which the Muse form never asks.
  '/search': { body: { results: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: '{origin}/ci.json', displayName: 'Example CI', score: 90 }] } },
})
after(() => web.close())
const searches = () => web.requests.filter(r => r.method === 'POST')
const QUERY = 'check why my CI build failed'

const museServer = () => {
  const fake = fakeMuse()
  // Muse's client offers no form (its initialize declares no capabilities).
  const s = startServer(SERVER, { elicitation: false, env: { PATH: fake.path, HOME: fake.dir, FAKE_MUSE_STATE: fake.state, FAKE_MUSE_LOG: fake.log } })
  after(() => s.stop())
  return { ...s, fake }
}

test('M-1 in Muse there is no registry search: it is not listed, a call to it is refused, and nothing is sent', async () => {
  const s = museServer()
  await s.ready
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['ard_discover', 'add_mcp_server'])
  const before = searches().length
  const r = await s.request('tools/call', { name: 'ard_search', arguments: { query: QUERY, registry: web.origin } })
  assert.ok(r.error || r.result?.isError, JSON.stringify(r))
  assert.equal(searches().length, before)
})

test('M-2 in Muse ard_discover reads ard.json, and add_mcp_server gives the muse mcp add command, writing nothing', async () => {
  const s = museServer()
  const d = await s.call('ard_discover', { domain: web.origin })
  assert.match(d.text, /^The directory lists 1 MCP server\./)
  assert.match(d.text, /urn:air:localhost:ci/)
  const r = await s.call('add_mcp_server', { domain: web.origin, identifier: 'urn:air:localhost:ci', url: `${web.origin}/ci/mcp` })
  assert.equal(r.isError, false, r.text)
  assert.ok(r.text.includes(`\n\nmuse mcp add example-ci --url ${web.origin}/ci/mcp\n\n`), r.text)
  assert.deepEqual(s.fake.calls(), [['mcp', 'get', 'example-ci', '--json']])
})

test("M-3 in Muse the shared hidden-character handling holds for a card ard.json lists: what is shown, and the command, carry none of them", async () => {
  const hidden = await localWeb({
    '/.well-known/ard.json': { body: { entries: [{ identifier: 'urn:air:localhost:tag', type: TYPE, url: '{origin}/tag.json' }] } },
    '/tag.json': { body: card('com.example/tag', 'Tag\u{e0041}\u{e0042}', '/tag/mcp') },
  })
  after(() => hidden.close())
  const s = museServer()
  const d = await s.call('ard_discover', { domain: hidden.origin })
  assert.match(d.text, /title: Tag\n/, d.text)
  assert.doesNotMatch(d.text, /[\u{e0000}-\u{e007f}]/u, 'the tag characters are not shown')
  const r = await s.call('add_mcp_server', { domain: hidden.origin, identifier: 'urn:air:localhost:tag', url: `${hidden.origin}/tag/mcp` })
  assert.equal(r.isError, false, r.text)
  assert.doesNotMatch(r.text, /[\u{e0000}-\u{e007f}]/u, 'nor in the command or its words')
})
