// The Codex adapter: the network guard, the plan in Codex's terms, and the
// server as Codex runs it, with its forms. All against plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CODEX_PROTOCOL_VERSIONS,
  formatServer,
  host,
  isCompatible,
  nodeFetch,
  MUSE_PROTOCOL_VERSIONS,
  museCommand,
  planForCodex,
  useMuseHost,
  shellWord,
  useCodexHost,
} from '../plugin/dist/server.mjs'
import { fakeCodex, fakeMuse, localWeb, startServer } from './harness'

const SERVER = fileURLToPath(new URL('../../plugin/dist/server.mjs', import.meta.url))
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (extra: Record<string, unknown> = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', title: 'Example Docs', ...extra })

// ---- the network: redirects are followed here, under the address rules ----

type Hop = { status: number; location?: string; body?: string }
const stubFetch = (hops: Record<string, Hop>) => {
  const seen: { url: string; method: string }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method) })
    const h = hops[url]
    if (!h) return new Response('missing', { status: 404 })
    return new Response(h.body ?? '', { status: h.status, headers: h.location ? { location: h.location } : {} })
  }) as unknown as typeof fetch
  return { impl, seen }
}

test('F-1 a redirect from a public origin to a private address is not followed', async () => {
  for (const to of ['http://127.0.0.1/x', 'https://10.0.0.5/x', 'https://localhost/x', 'https://[::1]/x', 'https://intranet/x', 'https://0x7f.1/x']) {
    const { impl, seen } = stubFetch({ 'https://public.example/a': { status: 302, location: to } })
    await assert.rejects(nodeFetch({ fetchImpl: impl })('https://public.example/a'), /not HTTPS on a public host/, to)
    assert.equal(seen.length, 1, to)
  }
})

test('F-2 a redirect between public HTTPS origins is followed, and the answer is the last hop', async () => {
  const { impl, seen } = stubFetch({
    'https://neon.tech/.well-known/ai-catalog.json': { status: 301, location: 'https://neon.com/.well-known/ai-catalog.json' },
    'https://neon.com/.well-known/ai-catalog.json': { status: 200, body: '{"ok":1}' },
  })
  const r = await nodeFetch({ fetchImpl: impl })('https://neon.tech/.well-known/ai-catalog.json')
  assert.deepEqual([r.status, r.text], [200, '{"ok":1}'])
  assert.deepEqual(seen.map(s => s.url), ['https://neon.tech/.well-known/ai-catalog.json', 'https://neon.com/.well-known/ai-catalog.json'])
})

test('F-3 a redirect from HTTPS to plain HTTP is not followed; loopback to loopback is (local development)', async () => {
  const a = stubFetch({ 'https://a.example/': { status: 302, location: 'http://b.example/' } })
  await assert.rejects(nodeFetch({ fetchImpl: a.impl })('https://a.example/'), /not HTTPS/)
  const b = stubFetch({ 'http://127.0.0.1:9/a': { status: 307, location: '/b' }, 'http://127.0.0.1:9/b': { status: 200, body: 'ok' } })
  assert.equal((await nodeFetch({ fetchImpl: b.impl })('http://127.0.0.1:9/a')).text, 'ok')
})

test('F-4 at most five redirects', async () => {
  const hops: Record<string, Hop> = {}
  for (let i = 0; i < 7; i++) hops[`https://a.example/${i}`] = { status: 302, location: `https://a.example/${i + 1}` }
  await assert.rejects(nodeFetch({ fetchImpl: stubFetch(hops).impl })('https://a.example/0'), /more than 5 redirects/)
})

test('F-5 a request with a body (a search) is never redirected to another origin, nor turned into a GET', async () => {
  const a = stubFetch({ 'https://r.example/search': { status: 307, location: 'https://other.example/search' } })
  await assert.rejects(nodeFetch({ fetchImpl: a.impl })('https://r.example/search', { method: 'POST', body: '{}' }), /not sent to an origin the person was not shown/)
  assert.equal(a.seen.length, 1)
  const b = stubFetch({ 'https://r.example/search': { status: 303, location: '/results' } })
  await assert.rejects(nodeFetch({ fetchImpl: b.impl })('https://r.example/search', { method: 'POST', body: '{}' }), /answered 303/)
  const c = stubFetch({ 'https://r.example/search': { status: 308, location: '/v2/search' }, 'https://r.example/v2/search': { status: 200, body: 'ok' } })
  assert.equal((await nodeFetch({ fetchImpl: c.impl })('https://r.example/search', { method: 'POST', body: '{}' })).text, 'ok')
  assert.deepEqual(c.seen.map(s => s.method), ['POST', 'POST'])
})

test('F-6 an answer larger than the cap is not read (413), whatever its Content-Length says', async () => {
  const big = 'x'.repeat(2000)
  const impl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch
  assert.equal((await nodeFetch({ fetchImpl: impl, maxBody: 1000 })('https://a.example/')).status, 413)
  const chunked = (async () =>
    new Response(new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode('y'.repeat(400))); c.close() } }), { status: 200 })) as unknown as typeof fetch
  assert.equal((await nodeFetch({ fetchImpl: chunked, maxBody: 1000 })('https://a.example/')).status, 413)
})

// ---- the plan, in Codex's terms ----

const remote = (r: Record<string, unknown>) => card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', ...r }] })

test('C-1 a plain remote is `codex mcp add NAME --url URL`', async () => {
  const r = planForCodex(remote({}) as never, 0, {}, undefined, false)
  assert.ok('plan' in r)
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', 'example-docs', '--url', 'https://mcp.example.com/mcp'])
})

test('C-2 a secret bearer token is an environment variable name, tagged for this card, never a value', async () => {
  const r = planForCodex(remote({ headers: [{ name: 'Authorization', value: 'Bearer {token}', isSecret: true, variables: { token: { isSecret: true } } }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in r)
  const v = r.plan.bearerEnvVar!
  assert.match(v, /^MCP_EXAMPLE_DOCS__TOKEN_[A-Z2-7]{16}$/)
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', 'example-docs', '--url', 'https://mcp.example.com/mcp', '--bearer-token-env-var', v])
  assert.equal(r.plan.envVars[0]!.name, v)
})

test('C-3 a secret header is env_http_headers, and a fixed one http_headers; neither fits codex mcp add', async () => {
  const r = planForCodex(
    remote({ headers: [{ name: 'X-API-Key', isSecret: true }, { name: 'X-Region', value: 'eu' }] }) as never,
    0,
    {},
    undefined,
    false,
  )
  assert.ok('plan' in r)
  assert.equal(r.plan.addArgs, undefined)
  assert.deepEqual(r.plan.httpHeaders, { 'X-Region': 'eu' })
  assert.match(r.plan.envHttpHeaders['X-API-Key']!, /^MCP_EXAMPLE_DOCS__X_API_KEY_[A-Z2-7]{16}$/)
  assert.match(r.plan.toml, /^\[mcp_servers\.example-docs\]\nurl = "https:\/\/mcp\.example\.com\/mcp"\nhttp_headers = \{ X-Region = "eu" \}\nenv_http_headers = \{ X-API-Key = "MCP_/)
})

test('C-4 what Codex cannot express is refused: SSE, a secret in the URL, a secret mixed into a header', async () => {
  const sse = planForCodex(remote({ type: 'sse' }) as never, 0, {}, undefined, false)
  assert.match('error' in sse ? sse.error : '', /streamable HTTP servers only/)
  const inUrl = planForCodex(remote({ url: 'https://mcp.example.com/{key}/mcp', variables: { key: { isSecret: true } } }) as never, 0, {}, undefined, false)
  assert.match('error' in inUrl ? inUrl.error : '', /secret in the URL/)
  const mixed = planForCodex(remote({ headers: [{ name: 'Authorization', value: 'Token {k}', isSecret: true, variables: { k: { isSecret: true } } }] }) as never, 0, {}, undefined, false)
  assert.match('error' in mixed ? mixed.error : '', /mixes a secret/)
})

test('C-5 the shared rules hold: no "$" from a card, no private remote from a public card', async () => {
  const dollar = planForCodex(remote({ headers: [{ name: 'X-T', value: '${HOME}' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in dollar ? dollar.error : '', /may not contain "\$"/)
  const priv = planForCodex(card({ remotes: [{ type: 'streamable-http', url: 'https://10.1.2.3/mcp' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in priv ? priv.error : '', /local or private address/)
})

test('C-6 as Codex: its protocol revisions, and its name where a remote is not usable', async () => {
  const before = { ...host }
  useCodexHost()
  try {
    assert.deepEqual([...host.protocolVersions], CODEX_PROTOCOL_VERSIONS)
    assert.equal(isCompatible({ type: 'streamable-http', url: 'https://a.example/', supportedProtocolVersions: ['2026-07-28'] } as never), false)
    const text = formatServer({ identifier: 'x', listedIn: ['l'], cardFrom: 'c', isLocal: false, errors: [], card: remote({ supportedProtocolVersions: ['2026-07-28'] }) } as never, 1)
    assert.match(text, /NOT usable: Codex speaks none of these versions/)
  } finally {
    Object.assign(host, before)
  }
})

// ---- the server, as Codex runs it ----

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

const server = (opts: Parameters<typeof startServer>[1] & { oauth?: boolean } = {}) => {
  const fake = fakeCodex()
  const s = startServer(SERVER, {
    ...opts,
    env: { CODEX_CLI_PATH: fake.bin, CODEX_HOME: fake.dir, FAKE_CODEX_STATE: fake.state, FAKE_CODEX_LOG: fake.log, ...(opts.oauth ? { FAKE_CODEX_OAUTH: '1' } : {}), ...(opts.env ?? {}) },
  })
  after(() => s.stop())
  return { ...s, fake }
}
const addDocs = { domain: web.origin, identifier: 'urn:air:localhost:docs', url: `${web.origin}/mcp` }
const adds = (f: { calls: () => string[][] }) => f.calls().filter(c => c[1] === 'add' || c[0] === 'app-server')

test('E-1 the server: initialize, its two tools, with annotations', async () => {
  const s = server()
  const init = await s.ready
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'mcp-server-cards')
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['discover_mcp_servers', 'add_mcp_server'])
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true)
  assert.equal(list.result.tools[1].annotations.readOnlyHint, false)
})

test('E-2 discover shows the cards, with Codex named', async () => {
  const s = server()
  const r = await s.call('discover_mcp_servers', { domain: web.origin })
  assert.equal(r.isError, false)
  assert.match(r.text, /MCP servers listed: 2 \(2 with a valid Server Card\)\. Server Cards are advisory \(SEP-2127\): Codex checks/)
})

test('E-3 an add with a form: the question names the server, URL, headers, file and undo; accepted, `codex mcp add` runs', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', addDocs)
  assert.equal(r.isError, false, r.text)
  assert.equal(s.asked.length, 1)
  const q = s.asked[0]!
  // A required choice, which Codex 0.172 does not answer by itself; the
  // 2025-06-18 revision this client asks for writes it as enum and enumNames.
  assert.equal(q.mode, undefined)
  assert.deepEqual(q.requestedSchema, {
    type: 'object',
    properties: { decision: { type: 'string', title: 'Your answer', enum: ['no', 'add'], enumNames: ["Don't add it", 'Add it'] } },
    required: ['decision'],
  })
  // The host on its own line (security review C3), then the URL.
  // The host first (a client may join the lines), and on its own line (security review C3), then the URL.
  assert.ok(q.message.startsWith(`${new URL(web.origin).host}: add the MCP server "example-docs" to Codex?\nIt connects to the host ${new URL(web.origin).host}\nURL: ${web.origin}/mcp\nHeaders: none\n`), q.message)
  assert.ok(q.message.endsWith(`Written to ${s.fake.dir}/config.toml (all your projects).\nTo undo: codex mcp remove example-docs`), q.message)
  assert.deepEqual(adds(s.fake), [['mcp', 'add', 'example-docs', '--url', `${web.origin}/mcp`]])
  assert.match(r.text, /To remove it: codex mcp remove example-docs/)
})

test('E-4 declined, closed, failed, or no form at all: nothing is written', async () => {
  for (const answer of [{ action: 'decline' as const }, { action: 'cancel' as const }, 'error' as const]) {
    const s = server({ answer })
    await s.call('discover_mcp_servers', { domain: web.origin })
    const r = await s.call('add_mcp_server', addDocs)
    assert.equal(r.isError, true)
    assert.match(r.text, /^Nothing was written/)
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
  const { writeFileSync } = await import('node:fs')
  writeFileSync(s.fake.state, JSON.stringify({ 'example-docs': { url: 'https://theirs.example/' } }))
  const taken = await s.call('add_mcp_server', addDocs)
  assert.match(taken.text, /already exists/)
  assert.equal(s.asked.length, 0)
  assert.deepEqual(adds(s.fake), [])
})

test('E-6 a server that starts a sign-in: codex mcp add is stopped there, and the person is told `codex mcp login`', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 }, oauth: true })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const started = Date.now()
  const r = await s.call('add_mcp_server', addDocs)
  assert.equal(r.isError, false, r.text)
  assert.ok(Date.now() - started < 10_000)
  assert.match(r.text, /codex mcp login example-docs/)
})

test('E-7 a secret header is written through codex app-server as env_http_headers, never a value', async () => {
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  await s.call('discover_mcp_servers', { domain: web.origin })
  const r = await s.call('add_mcp_server', { domain: web.origin, identifier: 'urn:air:localhost:keyed', url: `${web.origin}/keyed/mcp` })
  assert.equal(r.isError, false, r.text)
  assert.match(s.asked[0]!.message, /Headers: X-API-Key: <the value of \$MCP_KEYED__X_API_KEY_[A-Z2-7]{16}>/)
  const entry = s.fake.entries().keyed
  assert.equal(entry.url, `${web.origin}/keyed/mcp`)
  assert.match(entry.env_http_headers['X-API-Key'], /^MCP_KEYED__X_API_KEY_[A-Z2-7]{16}$/)
  assert.match(r.text, /reads a secret from the environment: MCP_KEYED__X_API_KEY_/)
})

test('E-8 stand-down: MCP_SERVER_CARDS_DISABLED registers no tools', async () => {
  const s = server({ env: { MCP_SERVER_CARDS_DISABLED: '1' } })
  await s.ready
  assert.deepEqual((await s.request('tools/list', {})).result.tools, [])
})

test('E-9 a card whose remote URL holds Markdown is refused, so it is never put in a form (security review C1)', async () => {
  const LINK = '/x/[https://good.example/mcp](https://evil.example/)'
  const md = await localWeb({
    '/.well-known/ai-catalog.json': { body: { specVersion: '1.0', entries: [{ identifier: 'urn:air:localhost:md', type: 'application/mcp-server-card+json', url: '{origin}/md.json' }] } },
    '/md.json': { body: card({ remotes: [{ type: 'streamable-http', url: `{origin}${LINK}` }] }) },
  })
  after(() => md.close())
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  const d = await s.call('discover_mcp_servers', { domain: md.origin })
  assert.match(d.text, /REFUSED: [^\n]*square brackets/)
  const r = await s.call('add_mcp_server', { domain: md.origin, identifier: 'urn:air:localhost:md', url: `${md.origin}${LINK}` })
  assert.equal(r.isError, true)
  assert.match(r.text, /was shown in this session/)
  assert.equal(s.asked.length, 0)
  assert.deepEqual(adds(s.fake), [])
})

test('C-7 a fixed header value with markup is refused, since the form shows it as it is (security review C4)', async () => {
  const r = planForCodex(remote({ headers: [{ name: 'X-A', value: '[https://good.example/mcp](https://evil.example/) <b>x</b>' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in r ? r.error : '', /header X-A holds `, <, > or a square bracket/)
  const ok = planForCodex(remote({ headers: [{ name: 'X-A', value: 'plain-value' }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in ok)
})

test('E-10 a card whose remote URL names a user before its host, or holds a backslash, is refused, so it is never put in a form (security review C3)', async () => {
  const at = await localWeb({
    '/.well-known/ai-catalog.json': {
      body: {
        specVersion: '1.0',
        entries: [
          { identifier: 'urn:air:localhost:at', type: 'application/mcp-server-card+json', url: '{origin}/at.json' },
          { identifier: 'urn:air:localhost:bs', type: 'application/mcp-server-card+json', url: '{origin}/bs.json' },
        ],
      },
    },
    '/at.json': { body: card({ name: 'com.example/at', remotes: [{ type: 'streamable-http', url: 'https://good.example@evil.example/mcp' }] }) },
    '/bs.json': { body: card({ name: 'com.example/bs', remotes: [{ type: 'streamable-http', url: 'https://evil.example\\@good.example/mcp' }] }) },
  })
  after(() => at.close())
  const s = server({ answer: { action: 'accept', afterMs: 50 } })
  const d = await s.call('discover_mcp_servers', { domain: at.origin })
  assert.match(d.text, /MCP servers listed: 2 \(0 with a valid Server Card\)/)
  assert.match(d.text, /names a user before its host/)
  for (const [identifier, url] of [['urn:air:localhost:at', 'https://good.example@evil.example/mcp'], ['urn:air:localhost:bs', 'https://evil.example\\@good.example/mcp']]) {
    const r = await s.call('add_mcp_server', { domain: at.origin, identifier, url })
    assert.match(r.text, /was shown in this session/)
  }
  assert.equal(s.asked.length, 0)
  assert.deepEqual(adds(s.fake), [])
})

test('E-11 only the explicit "add" adds: an accept without the choice, with "no", or with another value writes nothing', async () => {
  for (const content of [{}, { decision: 'no' }, { decision: 'yes' }, { decision: ['add'] }, { other: 'add' }]) {
    const s = server({ answer: { action: 'accept', afterMs: 50, content } })
    await s.call('discover_mcp_servers', { domain: web.origin })
    const r = await s.call('add_mcp_server', addDocs)
    assert.equal(r.isError, true, JSON.stringify(content))
    assert.match(r.text, /^Nothing was written/, JSON.stringify(content))
    assert.deepEqual(adds(s.fake), [], JSON.stringify(content))
  }
  const titled = server({ protocol: '2025-11-25', answer: { action: 'accept', afterMs: 50 } })
  await titled.call('discover_mcp_servers', { domain: web.origin })
  const r = await titled.call('add_mcp_server', addDocs)
  assert.equal(r.isError, false, r.text)
  assert.equal(titled.asked[0]!.mode, 'form')
  assert.deepEqual(titled.asked[0]!.requestedSchema, {
    type: 'object',
    properties: { decision: { type: 'string', title: 'Your answer', oneOf: [{ const: 'no', title: "Don't add it" }, { const: 'add', title: 'Add it' }] } },
    required: ['decision'],
  })
})

// ---- the same server in Muse (--host=muse): it checks and gives the command, and writes nothing ----

const museServer = (opts: { env?: Record<string, string> } = {}) => {
  const fake = fakeMuse()
  // Muse's client offers no form (its initialize declares no capabilities).
  const s = startServer(SERVER, { args: ['--host=muse'], elicitation: false, env: { PATH: fake.path, HOME: fake.dir, FAKE_MUSE_STATE: fake.state, FAKE_MUSE_LOG: fake.log, ...(opts.env ?? {}) } })
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
