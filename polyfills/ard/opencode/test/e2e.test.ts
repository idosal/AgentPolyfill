// ard-discovery in a real OpenCode (the pinned release, tools/opencode), in a
// throwaway home, against a local web on 127.0.0.1 with an ard.json, a Server
// Card, a small MCP server and an ARD registry, and a scripted model.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { waitFor, World, type Rule } from '../../../../tools/opencode/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = join(ROOT, 'plugin')
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const TYPE = 'application/mcp-server-card+json'
const ASK: Rule[] = [
  { action: 'ard_search', resource: '*', effect: 'ask' },
  { action: 'mcp_server_cards_add', resource: '*', effect: 'ask' },
]

async function localWeb() {
  let origin = ''
  const searches: unknown[] = []
  /** A registry this one refers searches on to, when set. */
  const refer: { to?: string } = {}
  const server: Server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (req.url === '/.well-known/ard.json') return json(200, { entries: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: `${origin}/ci.json` }] })
    if (req.url === '/.well-known/ai-catalog.json') return json(404, {})
    if (req.url === '/ci.json') return json(200, { $schema: SCHEMA, name: 'com.example/ci', version: '1.0.0', description: 'CI insights.', title: 'CI', remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }] })
    if (req.url === '/registry/search' && req.method === 'POST') {
      searches.push(JSON.parse(body))
      return json(200, { results: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: `${origin}/ci.json` }], ...(refer.to ? { referrals: [{ url: refer.to }] } : {}) })
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      const m = JSON.parse(body || '{}') as { id?: number; method?: string; params?: { protocolVersion?: string } }
      if (m.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      if (m.method === 'initialize') return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ci', version: '1.0.0' } } })
      if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [] } })
      return json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, searches, refer, close: () => new Promise<void>(r => server.close(() => r())) }
}

const lastToolResult = (w: World) => {
  const r = w.llmRequests().at(-1)
  const tool = [...(r?.messages ?? [])].reverse().find(m => m.role === 'tool')
  return tool ? (typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)) : ''
}

async function turn(w: World, session: string, text: string, answer?: 'once' | 'reject', expect?: (p: { action: string; resources: string[]; metadata?: Record<string, unknown> }) => void) {
  const since = Date.now()
  await w.prompt(session, text)
  if (answer) {
    const req = await waitFor(async () => (await w.permissions(session))[0], 30000, 'a permission request')
    expect?.(req)
    await w.reply(session, req.id, answer)
  }
  await w.idle(session, since).catch(() => undefined)
  return lastToolResult(w)
}

describe('ard-discovery in OpenCode', () => {
  let web: Awaited<ReturnType<typeof localWeb>>
  const world = new World({ plugins: [PLUGIN], permissions: ASK })
  let session = ''
  before(async () => {
    web = await localWeb()
    await world.start()
    session = await world.createSession()
  })
  after(async () => {
    await world.stop()
    await web.close()
  })

  test('ard_discover reads ard.json and checks the card', async () => {
    const out = await turn(world, session, `CALL ard_discover {"domain":"${web.origin}"}`)
    assert.match(out, /MCP servers listed: 1 \(1 with a valid Server Card\)/)
  })

  test('with no registry set and none named, a search is refused and nothing is sent', async () => {
    const out = await turn(world, session, 'CALL ard_search {"query":"check why my CI build failed"}')
    assert.match(out, /No ARD registry is set/)
    assert.equal(web.searches.length, 0)
  })

  test("a search is put to OpenCode's rules, naming the registry and the exact query; rejected, nothing is sent", async () => {
    await turn(world, session, `CALL ard_search {"query":"check why my CI build failed","registry":"${web.origin}/registry"}`, 'reject', p => {
      assert.equal(p.action, 'ard_search')
      assert.deepEqual(p.resources, [new URL(web.origin).host])
      assert.equal(p.metadata?.query, 'check why my CI build failed')
    })
    assert.equal(web.searches.length, 0)
  })

  test('a registry the answer refers the search to is put to OpenCode\'s rules too; rejected, it gets nothing', async () => {
    const other = await localWeb()
    try {
      web.refer.to = `${other.origin}/registry/search`
      const before = web.searches.length
      const since = Date.now()
      await world.prompt(session, `CALL ard_search {"query":"check why my CI build failed","registry":"${web.origin}/registry"}`)
      const first = await waitFor(async () => (await world.permissions(session))[0], 30000, 'the first request')
      assert.deepEqual(first.resources, [new URL(web.origin).host])
      await world.reply(session, first.id, 'once')
      const second = await waitFor(async () => (await world.permissions(session)).find(p => p.id !== first.id), 30000, 'the request for the referred registry')
      assert.equal(second.action, 'ard_search')
      assert.deepEqual(second.resources, [new URL(other.origin).host])
      await world.reply(session, second.id, 'reject')
      await world.idle(session, since).catch(() => undefined)
      assert.equal(web.searches.length, before + 1)
      assert.equal(other.searches.length, 0)
    } finally {
      web.refer.to = undefined
      await other.close()
    }
  })

  test('approved, the query goes to that registry; a result found there is added after its own approval', async () => {
    const before = web.searches.length
    const out = await turn(world, session, `CALL ard_search {"query":"check why my CI build failed","registry":"${web.origin}/registry"}`, 'once')
    assert.match(out, /The query text was sent to: 127\.0\.0\.1/)
    assert.equal(web.searches.length, before + 1)
    const added = await turn(world, session, `CALL ard_add_mcp_server ${JSON.stringify({ domain: web.origin, identifier: 'urn:air:localhost:ci', url: `${web.origin}/mcp` })}`, 'once', p => assert.equal(p.action, 'mcp_server_cards_add'))
    assert.match(added, /Added "[^"]+"/)
  })
})
