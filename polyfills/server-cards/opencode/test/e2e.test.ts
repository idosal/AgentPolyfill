// mcp-server-cards in a real OpenCode (the pinned release, tools/opencode), in
// a throwaway home, against a local web on 127.0.0.1 that publishes an AI
// Catalog with two Server Cards, one of them for a small MCP server on that
// same web, and a scripted model.

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { waitFor, World, type Rule } from '../../../../tools/opencode/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = join(ROOT, 'plugin')
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const ASK: Rule[] = [
  { action: 'mcp_server_cards_add', resource: '*', effect: 'ask' },
  { action: 'mcp_server_cards_remove', resource: '*', effect: 'ask' },
]

/** The web: a catalog, two cards, and at /mcp a streamable HTTP MCP server with one tool. */
async function localWeb() {
  let origin = ''
  const card = (extra: Record<string, unknown>) => ({ $schema: SCHEMA, version: '1.0.0', description: 'Docs.', ...extra })
  const server: Server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (req.url === '/.well-known/ai-catalog.json')
      return json(200, {
        specVersion: '1.0',
        entries: [
          { identifier: 'urn:air:localhost:docs', type: 'application/mcp-server-card+json', url: `${origin}/docs.json` },
          { identifier: 'urn:air:localhost:keyed', type: 'application/mcp-server-card+json', url: `${origin}/keyed.json` },
          { identifier: 'urn:air:localhost:locked', type: 'application/mcp-server-card+json', url: `${origin}/locked.json` },
        ],
      })
    if (req.url === '/docs.json') return json(200, card({ name: 'com.example/docs', title: 'Example Docs', remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }] }))
    if (req.url === '/keyed.json') return json(200, card({ name: 'com.example/keyed', title: 'Keyed', remotes: [{ type: 'streamable-http', url: `${origin}/keyed/mcp`, headers: [{ name: 'X-API-Key', isSecret: true }] }] }))
    if (req.url === '/locked.json') return json(200, card({ name: 'com.example/locked', title: 'Locked', remotes: [{ type: 'streamable-http', url: `${origin}/locked/mcp` }] }))
    // A server behind a sign-in: every request is refused with 401.
    if (req.url?.startsWith('/locked/')) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/locked/mcp"` })
      return res.end()
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      const m = JSON.parse(body || '{}') as { id?: number; method?: string; params?: { protocolVersion?: string } }
      if (m.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      if (m.method === 'initialize') return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1.0.0' } } })
      if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object', properties: {} } }] } })
      return json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
    res.writeHead(req.url === '/mcp' ? 405 : 404)
    res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, close: () => new Promise<void>(r => server.close(() => r())) }
}

const lastToolResult = (w: World) => {
  const r = w.llmRequests().at(-1)
  const tool = [...(r?.messages ?? [])].reverse().find(m => m.role === 'tool')
  return tool ? (typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)) : ''
}

async function turn(w: World, session: string, text: string, answer?: 'once' | 'always' | 'reject', expect?: (p: { action: string; resources: string[]; metadata?: Record<string, unknown> }) => void) {
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

const servers = async (w: World) => (await w.api<{ data: { name: string; status: unknown }[] }>('GET', `/api/mcp?location[directory]=${encodeURIComponent(w.project)}`)).data

describe('mcp-server-cards in OpenCode', () => {
  let web: Awaited<ReturnType<typeof localWeb>>
  const world = new World({ plugins: [PLUGIN], permissions: ASK })
  let session = ''
  let add = ''
  before(async () => {
    web = await localWeb()
    await world.start()
    session = await world.createSession()
    add = `CALL server_cards_add_mcp_server ${JSON.stringify({ domain: web.origin, identifier: 'urn:air:localhost:docs', url: `${web.origin}/mcp` })}`
  })
  after(async () => {
    await world.stop()
    await web.close()
  })

  test('discover reads the catalog and checks each card, with OpenCode named', async () => {
    const out = await turn(world, session, `CALL server_cards_discover_mcp_servers {"domain":"${web.origin}"}`)
    assert.match(out, /MCP servers listed: 3 \(3 with a valid Server Card\)\. Server Cards are advisory \(SEP-2127\): OpenCode checks/)
  })

  test("an add is put to OpenCode's permission rules, naming the server, URL and headers; rejected, nothing is added", async () => {
    await turn(world, session, add, 'reject', p => {
      assert.equal(p.action, 'mcp_server_cards_add')
      assert.match(p.resources[0]!, /^[a-z0-9-]+=http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      assert.equal(p.metadata?.url, `${web.origin}/mcp`)
      assert.equal(p.metadata?.headers, 'none')
    })
    assert.equal((await servers(world)).length, 0)
  })

  test('approved, the server is in OpenCode, and OpenCode connects to it', async () => {
    const out = await turn(world, session, add, 'once')
    assert.match(out, /Added "[^"]+" \(http:\/\/127\.0\.0\.1:\d+\/mcp\) to OpenCode's MCP servers/)
    const name = /Added "([^"]+)"/.exec(out)![1]!
    const s = await waitFor(async () => (await servers(world)).find(x => x.name === name && JSON.stringify(x.status).includes('connected')), 20000, 'OpenCode to connect')
    assert.ok(s)
  })

  test('added to this project only: another folder with the same plugin does not get it', async () => {
    const elsewhere = join(world.dir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    copyFileSync(join(world.project, 'opencode.json'), join(elsewhere, 'opencode.json'))
    const there = async () => (await world.api<{ data: { name: string }[] }>('GET', `/api/mcp?location[directory]=${encodeURIComponent(elsewhere)}`)).data
    // Loading that folder runs the plugin there too.
    await waitFor(async () => (await world.api<{ data: { id: string }[] }>('GET', `/api/plugin?location[directory]=${encodeURIComponent(elsewhere)}`)).data.length > 0, 20000, 'the plugin in the other folder').catch(() => undefined)
    await new Promise(r => setTimeout(r, 1500))
    assert.equal((await there()).length, 0)
    assert.ok((await servers(world)).length > 0)
  })

  test('kept across an OpenCode restart', async () => {
    await world.restart()
    const s = await waitFor(async () => (await servers(world)).find(x => JSON.stringify(x.status).includes('connected')), 30000, 'the added server after the restart')
    assert.ok(s)
  })

  test('a card that needs a secret is not added: the person gets the entry for opencode.json, with {env:…}', async () => {
    await turn(world, session, `CALL server_cards_discover_mcp_servers {"domain":"${web.origin}"}`)
    const out = await turn(world, session, `CALL server_cards_add_mcp_server ${JSON.stringify({ domain: web.origin, identifier: 'urn:air:localhost:keyed', url: `${web.origin}/keyed/mcp` })}`)
    assert.match(out, /nothing was added/)
    assert.match(out, /\{env:[A-Z0-9_]+\}/)
    assert.equal((await world.permissions(session)).length, 0)
  })

  test('a server behind a sign-in is added, and the answer says the sign-in is OpenCode\'s', async () => {
    const out = await turn(world, session, `CALL server_cards_add_mcp_server ${JSON.stringify({ domain: web.origin, identifier: 'urn:air:localhost:locked', url: `${web.origin}/locked/mcp` })}`, 'once')
    assert.match(out, /Added "[^"]+" \(http:\/\/127\.0\.0\.1:\d+\/locked\/mcp\)/)
    assert.match(out, /asks for a sign-in: the person runs `opencode mcp auth [a-z0-9-]+` in a terminal\. OpenCode holds that sign-in itself/)
  })

  test('remove takes away only what the plugin added, after OpenCode\'s rules allow it', async () => {
    const name = (await servers(world))[0]!.name
    const out = await turn(world, session, `CALL server_cards_remove_mcp_server {"name":"${name}"}`, 'once', p => assert.equal(p.action, 'mcp_server_cards_remove'))
    assert.match(out, /Removed/)
    await waitFor(async () => !(await servers(world)).some(x => x.name === name), 10000, 'the server to go')
  })
})
