// The Muse form: the same discovery as the Codex form, and an add that checks the card and the
// name exactly as there, writes nothing, and gives the person the `muse mcp add` command to run.
// All against the committed Muse bundle, ../codex/plugin/muse/dist/server.mjs.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { host, isCompatible, MUSE_PROTOCOL_VERSIONS, museCommand, shellWord, useMuseHost } from '../src/main'
import { fakeMuse, localWeb, startServer } from './harness'

const SERVER = fileURLToPath(new URL('../../../codex/plugin/muse/dist/server.mjs', import.meta.url))
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (extra: Record<string, unknown> = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', title: 'Example Docs', ...extra })

const web = await localWeb({
  '/.well-known/ai-catalog.json': {
    body: {
      specVersion: '1.0',
      entries: [
        { identifier: 'urn:air:localhost:docs', type: 'application/mcp-server-card+json', url: '{origin}/docs.json' },
        { identifier: 'urn:air:localhost:keyed', type: 'application/mcp-server-card+json', url: '{origin}/keyed.json' },
      ],
    },
  },
  '/docs.json': { body: card({ remotes: [{ type: 'streamable-http', url: '{origin}/mcp' }] }) },
  '/keyed.json': { body: card({ name: 'com.example/keyed', title: 'Keyed', remotes: [{ type: 'streamable-http', url: '{origin}/keyed/mcp', headers: [{ name: 'X-API-Key', isSecret: true }] }] }) },
})
after(() => web.close())
const addDocs = { domain: web.origin, identifier: 'urn:air:localhost:docs', url: `${web.origin}/mcp` }

// ---- the server in Muse: it checks and gives the command, and writes nothing ----

const museServer = (opts: { env?: Record<string, string> } = {}) => {
  const fake = fakeMuse()
  // Muse's client offers no form (its initialize declares no capabilities).
  const s = startServer(SERVER, { elicitation: false, env: { PATH: fake.path, HOME: fake.dir, FAKE_MUSE_STATE: fake.state, FAKE_MUSE_LOG: fake.log, ...(opts.env ?? {}) } })
  after(() => s.stop())
  return { ...s, fake }
}

test('M-1 in Muse: the same two tools, named for Muse; add_mcp_server writes nothing, so it is read-only', async () => {
  const s = museServer()
  await s.ready
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['discover_mcp_servers', 'add_mcp_server'])
  assert.deepEqual(list.result.tools.map((t: any) => t.annotations.readOnlyHint), [true, true])
  assert.ok(list.result.tools.every((t: any) => !t.description.includes('Codex')), 'named for Muse')
  const r = await s.call('discover_mcp_servers', { domain: web.origin })
  assert.match(r.text, /Server Cards are advisory \(SEP-2127\): Muse checks/)
})

test('M-2 an add gives the person the muse mcp add command, the host, the file, the sign-in and the undo; nothing is run but muse mcp get', async () => {
  const s = museServer()
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', addDocs)
  assert.equal(r.isError, false, r.text)
  assert.equal(s.asked.length, 0)
  assert.ok(r.text.startsWith('Nothing was written. Muse gives this plugin no way to ask the person first'), r.text)
  assert.ok(r.text.includes(`connects to the host ${new URL(web.origin).host} (${web.origin}/mcp)`), r.text)
  assert.ok(r.text.includes(`\n\nmuse mcp add example-docs --url ${web.origin}/mcp\n\n`), r.text)
  assert.ok(r.text.includes(`It is written to ${s.fake.dir}/.config/muse/settings.json (all their projects).`), r.text)
  assert.match(r.text, /muse mcp login example-docs/)
  assert.match(r.text, /To undo: muse mcp remove example-docs/)
  assert.deepEqual(s.fake.calls(), [['mcp', 'get', 'example-docs', '--json']])
})

test('M-3 a secret header stays a reference in the command, quoted so the shell leaves it alone; its variable is named', async () => {
  const s = museServer()
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', { domain: web.origin, identifier: 'urn:air:localhost:keyed', url: `${web.origin}/keyed/mcp` })
  assert.equal(r.isError, false, r.text)
  const line = r.text.split('\n').find(l => l.startsWith('muse mcp add'))!
  assert.match(line, /^muse mcp add keyed --url \S+\/keyed\/mcp -H 'X-API-Key: \$\{([A-Z0-9_]+)\}'$/)
  const variable = /\$\{([A-Z0-9_]+)\}/.exec(line)![1]!
  assert.match(r.text, new RegExp(`environment Muse starts in: ${variable} \\(header X-API-Key`))
})

test('M-4 a name Muse already has, or no muse to ask, is refused; so is a card not shown, or another URL, with Muse named', async () => {
  const s = museServer()
  const unseen = await s.call('add_mcp_server', addDocs)
  assert.equal(unseen.isError, true)
  assert.match(unseen.text, /was shown in this session/)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const other = await s.call('add_mcp_server', { ...addDocs, url: 'https://evil.example/mcp' })
  assert.match(other.text, /This would add .*\/mcp, not https:\/\/evil\.example\/mcp/)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(s.fake.state, JSON.stringify({ 'example-docs': { url: 'https://theirs.example/' } }))
  const taken = await s.call('add_mcp_server', addDocs)
  assert.equal(taken.isError, true)
  assert.match(taken.text, /already exists in Muse's configuration/)
  const none = museServer({ env: { PATH: '/nonexistent' } })
  await none.call('discover_mcp_servers', { domain: web.origin })
  const unknown = await none.call('add_mcp_server', addDocs)
  assert.equal(unknown.isError, true, 'unknown counts as taken')
})

test('M-5 the command is the plan, word for word: every word that needs it is quoted, and a quote inside one is kept', () => {
  assert.equal(shellWord('https://a.example/mcp?x=1&y=2'), `'https://a.example/mcp?x=1&y=2'`)
  assert.equal(shellWord("it's"), `'it'\\''s'`)
  assert.equal(
    museCommand({ name: 'n', url: 'https://a.example/mcp', bearerEnvVar: 'TOK', httpHeaders: { 'X-Team': 'blue sky' }, envHttpHeaders: { 'X-Key': 'KEY_1' }, envVars: [], toml: '' } as never),
    `muse mcp add n --url https://a.example/mcp --bearer-token-env-var TOK -H 'X-Team: blue sky' -H 'X-Key: \${KEY_1}'`,
  )
})

test("M-6 in Muse the shared checks hold: a card whose text shows as something else is refused, and a header value with a character that shows as nothing gets no command", async () => {
  const hidden = await localWeb({
    '/.well-known/ai-catalog.json': {
      body: {
        specVersion: '1.0',
        entries: [
          { identifier: 'urn:air:localhost:rtl', type: 'application/mcp-server-card+json', url: '{origin}/rtl.json' },
          { identifier: 'urn:air:localhost:zw', type: 'application/mcp-server-card+json', url: '{origin}/zw.json' },
        ],
      },
    },
    '/rtl.json': { body: card({ name: 'com.example/rtl', title: 'Docs\u202egnp', remotes: [{ type: 'streamable-http', url: '{origin}/mcp' }] }) },
    '/zw.json': { body: card({ name: 'com.example/zw', title: 'Zero width', remotes: [{ type: 'streamable-http', url: '{origin}/zw/mcp', headers: [{ name: 'X-Team', value: 'blue\u200b' }] }] }) },
  })
  after(() => hidden.close())
  const s = museServer()
  const d = await s.call('discover_mcp_servers', { domain: hidden.origin })
  // Both cards are refused as they are read: neither can be shown as what it is.
  assert.match(d.text, /MCP servers listed: 2 \(0 with a valid Server Card\)/, d.text)
  assert.equal((d.text.match(/REFUSED: /g) ?? []).length, 2, d.text)
  const rtl = await s.call('add_mcp_server', { domain: hidden.origin, identifier: 'urn:air:localhost:rtl', url: `${hidden.origin}/mcp` })
  assert.equal(rtl.isError, true)
  const zw = await s.call('add_mcp_server', { domain: hidden.origin, identifier: 'urn:air:localhost:zw', url: `${hidden.origin}/zw/mcp` })
  assert.equal(zw.isError, true, zw.text)
  assert.doesNotMatch(zw.text, /muse mcp add/)
  assert.deepEqual(s.fake.calls(), [], 'muse is not even asked about the name')
})

test('M-7 as Muse: its protocol revisions, and its name where a remote is not usable', () => {
  const before = { ...host, protocolVersions: [...host.protocolVersions] }
  useMuseHost()
  try {
    assert.deepEqual([...host.protocolVersions], MUSE_PROTOCOL_VERSIONS)
    assert.deepEqual([...MUSE_PROTOCOL_VERSIONS], ['2025-06-18', '2025-03-26', '2024-11-05'])
    assert.equal(host.name, 'Muse')
    assert.equal(isCompatible({ type: 'streamable-http', url: 'https://a.example/', supportedProtocolVersions: ['2026-07-28'] } as never), false)
  } finally {
    Object.assign(host, before)
  }
})
