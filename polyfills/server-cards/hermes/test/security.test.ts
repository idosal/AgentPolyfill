// Connect-time address checks and refused routing headers, as tests.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { pinnedFetch, planForHermes, safeLookup } from '../src/main'
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (remote = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs', remotes: [{ type: 'streamable-http', url: 'https://docs.example/mcp', ...remote }] })
const resolver = (map: Record<string, string>) => (h: string, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: map[h] ?? '93.184.216.34', family: (map[h] ?? '').includes(':') ? 6 : 4 }])
const lookup = (fn: ReturnType<typeof safeLookup>, host: string) => new Promise<unknown>((done, fail) => fn(host, {}, (err: unknown, addr: unknown) => (err ? fail(err) : done(addr))))

test('a public name that resolves to a private address is refused when the connection is made', async () => {
  const fn = safeLookup(resolver({ 'public.example': '10.0.0.5', 'v6.example': 'fd00::1', 'meta.example': '169.254.169.254' }) as never)
  for (const h of ['public.example', 'v6.example', 'meta.example']) await assert.rejects(lookup(fn, h), /resolves to a private address/, h)
  assert.equal(await lookup(fn, 'ok.example'), '93.184.216.34')
  // A host that is itself local is left to the shared rules (allowed only where the person named it).
  assert.equal(await lookup(safeLookup(resolver({ localhost: '127.0.0.1' }) as never), 'localhost'), '127.0.0.1')
})

test('pinnedFetch uses that lookup: no request reaches a private address by a public name', async () => {
  const server = createServer((q, r) => {
    let got = ''
    q.on('data', (d) => (got += d)).on('end', () => r.end(q.method === 'POST' ? `${q.headers['content-length']}:${got}` : 'inside'))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  try {
    const f = pinnedFetch(resolver({ 'public.example': '127.0.0.1' }) as never)
    await assert.rejects(f(`http://public.example:${port}/`), /private address/)
    const ok = await pinnedFetch()(`http://127.0.0.1:${port}/`, { method: 'GET' })
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'inside')
    // A body goes whole, with its length: a server that reads no chunked request still gets it.
    const posted = await pinnedFetch()(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{"query":{"text":"x"}}', headers: { 'content-type': 'application/json' } })
    assert.equal(await posted.text(), '22:{"query":{"text":"x"}}')
  } finally {
    server.close()
  }
})

test('a card that sets a routing header (Host and the like) is not added', () => {
  for (const name of ['Host', 'host', 'X-Forwarded-Host', 'Forwarded', ':authority', 'X-Original-URL'])
    assert.ok('error' in planForHermes(card({ headers: [{ name, value: 'admin.internal' }] }) as never, 0, {}, undefined, false), name)
  assert.ok('plan' in planForHermes(card({ headers: [{ name: 'X-Region', value: 'eu' }] }) as never, 0, {}, undefined, false))
})
