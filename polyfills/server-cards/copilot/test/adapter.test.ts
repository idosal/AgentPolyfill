// The Copilot adapter: the plan in Copilot's terms, and the server as Copilot runs it, with its
// forms. All against plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COPILOT_PROTOCOL_VERSIONS, formatServer, host, isCompatible, planForCopilot, useCopilotHost } from '../plugin/dist/server.mjs'
import { copilotEnv, fakeCopilot, localWeb, startServer } from './harness'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER = join(ROOT, 'plugin', 'dist', 'server.mjs')
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (extra: Record<string, unknown> = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', title: 'Example Docs', ...extra })
const remote = (r: Record<string, unknown>) => card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', ...r }] })

// ---- the plan, in Copilot's terms ----

test('C-1 a plain remote is `copilot mcp add --transport http NAME URL`', () => {
  const r = planForCopilot(remote({}) as never, 0, {}, undefined, false)
  assert.ok('plan' in r)
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', '--transport=http', 'example-docs', 'https://mcp.example.com/mcp'])
  assert.deepEqual(JSON.parse(r.plan.json), { 'example-docs': { type: 'http', url: 'https://mcp.example.com/mcp', tools: ['*'] } })
})

test('C-2 a secret is a ${VAR} reference named for this card alone, never a value; Copilot expands it when it connects', () => {
  const r = planForCopilot(remote({ headers: [{ name: 'Authorization', value: 'Bearer {token}', isSecret: true, variables: { token: { isSecret: true } } }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in r)
  const v = r.plan.envVars[0]!.name
  assert.match(v, /^MCP_EXAMPLE_DOCS__TOKEN_[A-Z2-7]{16}$/)
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', '--transport=http', `--header=Authorization: Bearer \${${v}}`, 'example-docs', 'https://mcp.example.com/mcp'])
})

test('C-3 what Codex could not take, Copilot can: SSE, a fixed header beside a secret one, a secret mixed into a header or in the path', () => {
  const sse = planForCopilot(remote({ type: 'sse' }) as never, 0, {}, undefined, false)
  assert.ok('plan' in sse)
  assert.deepEqual(sse.plan.addArgs.slice(0, 3), ['mcp', 'add', '--transport=sse'])
  const both = planForCopilot(remote({ headers: [{ name: 'X-API-Key', isSecret: true }, { name: 'X-Region', value: 'eu' }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in both)
  const h = both.plan.addArgs.filter(a => a.startsWith('--header='))
  assert.match(h[0]!, /^--header=X-API-Key: \$\{MCP_EXAMPLE_DOCS__X_API_KEY_[A-Z2-7]{16}\}$/)
  assert.equal(h[1], '--header=X-Region: eu')
  const mixed = planForCopilot(remote({ headers: [{ name: 'Authorization', value: 'Token {k}', isSecret: true, variables: { k: { isSecret: true } } }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in mixed)
  const inPath = planForCopilot(remote({ url: 'https://mcp.example.com/{key}/mcp', variables: { key: { isSecret: true } } }) as never, 0, {}, undefined, false)
  assert.ok('plan' in inPath)
  assert.match(inPath.plan.url, /^https:\/\/mcp\.example\.com\/\$\{MCP_EXAMPLE_DOCS__KEY_[A-Z2-7]{16}\}\/mcp$/)
})

test('C-7 nothing from a card can be read as an option: a header whose name starts with "-" is the value of its --header=, and the name and URL are checked again', () => {
  const r = planForCopilot(remote({ headers: [{ name: '-x', value: 'v' }, { name: '--tools', value: 'none' }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in r, JSON.stringify(r))
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', '--transport=http', '--header=-x: v', '--header=--tools: none', 'example-docs', 'https://mcp.example.com/mcp'])
  // Every argument before the two positionals is one of ours, each one whole.
  assert.ok(r.plan.addArgs.slice(2, -2).every(a => /^--(transport|header)=/.test(a)))
  for (const name of ['--transport', '-x', 'Has Space', 'a'.repeat(80)]) {
    const n = planForCopilot(remote({}) as never, 0, {}, name, false)
    if ('plan' in n) assert.match(n.plan.name, /^[a-z0-9][a-z0-9-]*$/, name)
  }
})

test('C-8 a card that sets one header twice, in any letter case, is refused', () => {
  const r = planForCopilot(remote({ headers: [{ name: 'X-Region', value: 'eu' }, { name: 'x-region', value: 'us' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in r ? r.error : JSON.stringify(r), /sets the header x-region twice/)
})

test('C-4 the shared rules hold: no "$" from a card, no private remote from a public card, no secret in the host part', () => {
  const dollar = planForCopilot(remote({ headers: [{ name: 'X-T', value: '${HOME}' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in dollar ? dollar.error : '', /may not contain "\$"/)
  const priv = planForCopilot(card({ remotes: [{ type: 'streamable-http', url: 'https://10.1.2.3/mcp' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in priv ? priv.error : '', /local or private address/)
  const hostPart = planForCopilot(remote({ url: 'https://{tenant}.example.com/mcp', variables: { tenant: { isSecret: true } } }) as never, 0, {}, undefined, false)
  assert.match('error' in hostPart ? hostPart.error : '', /host part/)
})

test('C-5 a fixed header value with markup is refused, since the form shows it as it is (security review C4)', () => {
  const r = planForCopilot(remote({ headers: [{ name: 'X-A', value: '[https://good.example/mcp](https://evil.example/) <b>x</b>' }] }) as never, 0, {}, undefined, false)
  assert.ok('error' in r, JSON.stringify(r))
})

test('C-6 as Copilot: its name, and its protocol revisions where a remote is not usable', () => {
  const before = { ...host }
  useCopilotHost()
  try {
    assert.equal(host.name, 'Copilot')
    assert.deepEqual([...host.protocolVersions], COPILOT_PROTOCOL_VERSIONS)
    assert.equal(isCompatible({ type: 'streamable-http', url: 'https://a.example/', supportedProtocolVersions: ['2026-07-28'] } as never), true)
    assert.equal(isCompatible({ type: 'streamable-http', url: 'https://a.example/', supportedProtocolVersions: ['2099-01-01'] } as never), false)
    const text = formatServer({ identifier: 'x', listedIn: ['l'], cardFrom: 'c', isLocal: false, errors: [], card: remote({ supportedProtocolVersions: ['2099-01-01'] }) } as never, 1)
    assert.match(text, /NOT usable: Copilot speaks none of these versions/)
  } finally {
    Object.assign(host, before)
  }
})

// ---- the server, as Copilot runs it ----

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

// Copilot CLI 1.0.115 asks its MCP servers for 2025-11-25 (seen live).
const server = (opts: Parameters<typeof startServer>[1] & { fail?: boolean } = {}) => {
  const fake = fakeCopilot()
  const s = startServer(SERVER, { protocol: '2025-11-25', ...opts, env: copilotEnv(fake, { ...(opts.fail ? { FAKE_COPILOT_FAIL: '1' } : {}), ...(opts.env ?? {}) }) })
  after(() => s.stop())
  return { ...s, fake }
}
const addDocs = { domain: web.origin, identifier: 'urn:air:localhost:docs', url: `${web.origin}/mcp` }
const adds = (f: ReturnType<typeof fakeCopilot>) => f.calls().filter(c => c.args[1] === 'add')

test('E-1 the server: initialize, its two tools, with annotations', async () => {
  const s = server()
  const init = await s.ready
  assert.equal(init.result.protocolVersion, '2025-11-25')
  assert.equal(init.result.serverInfo.name, 'mcp-server-cards')
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['discover_mcp_servers', 'add_mcp_server'])
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true)
  assert.equal(list.result.tools[1].annotations.readOnlyHint, false)
})

test('E-2 discover shows the cards, with Copilot named', async () => {
  const s = server()
  const r = await s.call('discover_mcp_servers', { domain: web.origin })
  assert.equal(r.isError, false)
  assert.match(r.text, /MCP servers listed: 2 \(2 with a valid Server Card\)\. Server Cards are advisory \(SEP-2127\): Copilot checks/)
})

test('E-3 an add with a form: the question names the server, URL, headers, file and undo; accepted, `copilot mcp add` runs in the session folder', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', addDocs)
  assert.equal(r.isError, false, r.text)
  assert.equal(s.asked.length, 1)
  const q = s.asked[0]!
  assert.equal(q.mode, 'form')
  assert.deepEqual(q.requestedSchema, {
    type: 'object',
    properties: { decision: { type: 'string', title: 'Your answer', oneOf: [{ const: 'no', title: "Don't add it" }, { const: 'add', title: 'Add it' }] } },
    required: ['decision'],
  })
  const h = new URL(web.origin).host
  assert.ok(q.message.startsWith(`${h}: add the MCP server "example-docs" to Copilot?\nIt connects to the host ${h}\nURL: ${web.origin}/mcp (streamable HTTP)\nHeaders: none\n`), q.message)
  assert.ok(q.message.endsWith(`Written to ${join(s.fake.dir, 'home', 'mcp-config.json')} (all your projects).\nTo undo: copilot mcp remove example-docs`), q.message)
  assert.deepEqual(adds(s.fake).map(c => c.args), [['mcp', 'add', '--transport=http', 'example-docs', `${web.origin}/mcp`]])
  assert.ok(s.fake.calls().every(c => c.cwd.endsWith(s.fake.dir.split('/').pop()!)), 'run in COPILOT_SESSION_CWD')
  assert.deepEqual(s.fake.entries()['example-docs'], { tools: ['*'], type: 'http', url: `${web.origin}/mcp` })
  assert.match(r.text, /To remove it: copilot mcp remove example-docs/)
  assert.match(r.text, /\/mcp reload/)
})

test('E-4 declined, closed, failed, or no form at all: nothing is written', async () => {
  for (const answer of [{ action: 'decline' as const }, { action: 'cancel' as const }, 'error' as const]) {
    const s = server({ answer })
    await s.call('discover_mcp_servers', { domain: web.origin })
    const r = await s.call('add_mcp_server', addDocs)
    assert.equal(r.isError, true)
    assert.match(r.text, /^Nothing was written/)
    assert.doesNotMatch(r.text, /Codex|codex exec/)
    assert.deepEqual(adds(s.fake), [])
  }
  const s = server({ elicitation: false })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', addDocs)
  assert.match(r.text, /offers no form to ask the person/)
  assert.equal(s.asked.length, 0)
  assert.deepEqual(adds(s.fake), [])
})

test('E-5 only a card shown in this session, at the URL it gives, under a name not taken; none of these asks the person', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  const unseen = await s.call('add_mcp_server', addDocs)
  assert.match(unseen.text, /was shown in this session/)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const other = await s.call('add_mcp_server', { ...addDocs, url: 'https://evil.example/mcp' })
  assert.match(other.text, /This would add .*\/mcp, not https:\/\/evil\.example\/mcp/)
  writeFileSync(s.fake.state, JSON.stringify({ 'example-docs': { type: 'http', url: 'https://theirs.example/' } }))
  const taken = await s.call('add_mcp_server', addDocs)
  assert.match(taken.text, /already exists in Copilot's configuration/)
  assert.equal(s.asked.length, 0)
  assert.deepEqual(adds(s.fake), [])
})

test('E-6 a secret header is written as a ${VAR} reference, never a value, and the person is told which variable to set', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', { domain: web.origin, identifier: 'urn:air:localhost:keyed', url: `${web.origin}/keyed/mcp` })
  assert.equal(r.isError, false, r.text)
  assert.match(s.asked[0]!.message, /Headers: X-API-Key: <the value of \$MCP_KEYED__X_API_KEY_[A-Z2-7]{16}>/)
  const entry = s.fake.entries().keyed
  assert.match(entry.headers['X-API-Key'], /^\$\{MCP_KEYED__X_API_KEY_[A-Z2-7]{16}\}$/)
  assert.match(r.text, /reads a secret from the environment: MCP_KEYED__X_API_KEY_/)
})

test('E-7 when copilot mcp add fails, nothing is claimed, and the entry to add by hand is given', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 }, fail: true })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', addDocs)
  assert.equal(r.isError, true)
  // `copilot mcp get` failed too, so the name counts as taken and nothing is asked.
  assert.match(r.text, /already exists in Copilot's configuration \(or copilot could not say\)/)
  assert.equal(s.asked.length, 0)
})

test('E-8 stand-down: MCP_SERVER_CARDS_DISABLED registers no tools', async () => {
  const s = server({ env: { MCP_SERVER_CARDS_DISABLED: '1' } })
  await s.ready
  assert.deepEqual((await s.request('tools/list', {})).result.tools, [])
})

test('E-9 only the explicit "add" adds: an accept without the choice, with "no", or with another value writes nothing', async () => {
  for (const content of [{}, { decision: 'no' }, { decision: 'yes' }, { decision: ['add'] }, { other: 'add' }]) {
    const s = server({ answer: { action: 'accept', afterMs: 50, content } })
    await s.call('discover_mcp_servers', { domain: web.origin })
    const r = await s.call('add_mcp_server', addDocs)
    assert.equal(r.isError, true, JSON.stringify(content))
    assert.deepEqual(adds(s.fake), [], JSON.stringify(content))
  }
})
