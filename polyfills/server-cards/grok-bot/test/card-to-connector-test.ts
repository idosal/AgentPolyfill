// The built script, run as the skill runs it (node, arguments), against a local web on 127.0.0.1
// that serves an AI Catalog, Server Cards and OAuth metadata.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../skills/server-card-connector/scripts/card-to-connector.mjs', import.meta.url))
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (extra: Record<string, unknown>) => ({ $schema: SCHEMA, name: 'com.example/tickets', version: '1.2.0', description: 'Support tickets.', title: 'Example Tickets', ...extra })

let origin = ''
let server: ReturnType<typeof createServer>

before(async () => {
  const routes = (o: string): Record<string, unknown> => ({
    '/.well-known/ai-catalog.json': {
      specVersion: '1.0',
      entries: [
        { identifier: 'urn:air:localhost:tickets', type: 'application/mcp-server-card+json', url: `${o}/tickets.json` },
        { identifier: 'urn:air:localhost:open', type: 'application/mcp-server-card+json', url: `${o}/open.json` }
      ]
    },
    '/.well-known/ard.json': { entries: [{ identifier: 'urn:air:localhost:ard-only', type: 'application/mcp-server-card+json', url: o + '/oauth.json' }] },
    '/tickets.json': card({
      remotes: [
        {
          type: 'streamable-http',
          url: `${o}/mcp`,
          headers: [
            { name: 'Authorization', value: 'Bearer {token}', variables: { token: { isSecret: true, isRequired: true, description: 'Your API token' } } },
            { name: 'X-Region', value: 'eu' }
          ]
        }
      ]
    }),
    '/open.json': card({ name: 'com.example/open', title: 'Open', remotes: [{ type: 'streamable-http', url: `${o}/{workspace}/mcp`, variables: { workspace: { isRequired: true, description: 'Your workspace id' } } }] }),
    '/oauth.json': card({ name: 'com.example/oauth', title: 'OAuthy', remotes: [{ type: 'streamable-http', url: `${o}/oauth/mcp` }] }),
    '/.well-known/oauth-protected-resource/oauth/mcp': { resource: `${o}/oauth/mcp`, authorization_servers: [`${o}/auth`] },
    '/.well-known/oauth-authorization-server/auth': { issuer: `${o}/auth`, authorization_endpoint: `${o}/auth/authorize`, token_endpoint: `${o}/auth/token`, registration_endpoint: `${o}/auth/register` }
  })
  server = createServer((req, res) => {
    const body = routes(origin)[req.url ?? '']
    if (body === undefined) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

// Asynchronously: the local web runs in this process, so a blocking spawn would never be answered.
const run = (...args: string[]) =>
  new Promise<{ code: number | null; out: string }>(resolve =>
    execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )

describe('card-to-connector', () => {
  test('a domain with two servers: it says which there are', async () => {
    const r = await run(origin)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /2 servers found; run again with --server/)
    assert.match(r.out, /urn:air:localhost:tickets: Example Tickets, Support tickets\./)
  })

  test('one server: the URL, a plain header as it is, a secret header to type, and the OAuth answer', async () => {
    const r = await run(origin, '--server', 'urn:air:localhost:tickets')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Add a custom connector → Remote HTTPS/)
    assert.match(r.out, /Name: {2}example-tickets/)
    assert.ok(r.out.includes(`URL:   ${origin}/mcp`), r.out)
    assert.match(r.out, /Header: Authorization = Bearer <token \(Your API token\)> {3}← type this value yourself; it is a secret/)
    assert.match(r.out, /Header: X-Region = eu/)
    assert.match(r.out, /OAuth client id: leave empty \(the server advertises no OAuth/)
    assert.match(r.out, /Note: This URL is not https/)
  })

  test('a card read by its own URL, whose server uses OAuth with dynamic registration', async () => {
    const r = await run(`${origin}/oauth.json`)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /OAuthy \(com\.example\/oauth 1\.2\.0\)/)
    assert.match(r.out, /OAuth client id: leave empty\. The server signs in with OAuth through http:\/\/127\.0\.0\.1:\d+\/auth, which lets clients register themselves/)
  })

  test('an input the card leaves open is asked for with --set, then filled in', async () => {
    const first = await run(origin, '--server', 'com.example/open')
    assert.equal(first.code, 1)
    assert.match(first.out, /--set workspace=<value> {3}\(Your workspace id\)/)
    const second = await run(origin, '--server', 'com.example/open', '--set', 'workspace=acme', '--json')
    assert.equal(second.code, 0, second.out)
    const j = JSON.parse(second.out)
    assert.equal(j.connector.url, `${origin}/acme/mcp`)
    assert.deepEqual(j.connector.headers, [])
  })

  test('an ARD-only entry produces the connector fields', async () => {
    const r = await run(origin, '--ard', '--server', 'urn:air:localhost:ard-only', '--json')
    assert.equal(r.code, 0, r.out)
    assert.equal(JSON.parse(r.out).connector.url, origin + '/oauth/mcp')
  })

  test('nothing there: it says so', async () => {
    const r = await run("http://127.0.0.1:9/") // a port nothing listens on
    assert.equal(r.code, 1)
    assert.match(r.out, /No valid Server Card found/)
  })
})
