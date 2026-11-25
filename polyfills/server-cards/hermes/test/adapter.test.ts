import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CardSession, planForHermes, probeOAuth, useHermesHost, host, HERMES_PROTOCOL_VERSIONS, memoryStore } from '../src/main'
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (remote = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs', remotes: [{ type: 'streamable-http', url: 'https://docs.example/mcp', ...remote }] })

test('H-1 Hermes entry preserves secret URL and mixed header references, never supplied secrets', () => {
  const c = card({ url: 'https://docs.example/{key}', variables: { key: { isSecret: true } }, headers: [{ name: 'Authorization', value: 'Bearer {token}', variables: { token: { isSecret: true } } }, { name: 'X-Region', value: 'eu' }] })
  const p = planForHermes(c as never, 0, { key: 'SECRET', token: 'SECRET' }, undefined, false)
  assert.ok('plan' in p)
  assert.match(p.plan.entry.url, /\$\{MCP_DOCS__KEY_[A-Z2-7]{16}\}/)
  assert.match(p.plan.entry.headers.Authorization, /^Bearer \$\{MCP_DOCS__TOKEN_/)
  assert.equal(p.plan.entry.headers['X-Region'], 'eu')
  assert.equal(JSON.stringify(p).includes('SECRET'), false)
})
test('H-2 SSE is selected explicitly; duplicate and literal credential headers refused', () => {
  const sse = planForHermes(card({ type: 'sse' }) as never, 0, {}, undefined, false)
  assert.ok('plan' in sse); assert.equal(sse.plan.entry.transport, 'sse')
  for (const headers of [[{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }], [{ name: 'Authorization', value: 'Bearer literal' }]])
    assert.ok('error' in planForHermes(card({ headers }) as never, 0, {}, undefined, false))
})
test('H-3 add is bound to a valid displayed card and exact URL; rediscovery invalidates stale cards', () => {
  const s = new CardSession()
  const args = { domain: 'example.com', identifier: 'docs', url: 'https://docs.example/mcp' }
  assert.throws(() => s.resolve(args, 'discover'), /No valid card/)
  const d = { origin: 'https://example.com', servers: [{ identifier: 'docs', card: card(), isLocal: false }] }
  s.remember(d as never)
  assert.equal(s.resolve(args, 'discover').entry.url, args.url)
  assert.throws(() => s.resolve({ ...args, url: 'https://wrong.example' }, 'discover'), /exact URL/)
  assert.throws(() => s.resolve({ ...args, remote: -1 }, 'discover'), /non-negative/)
  s.remember({ ...d, servers: [] } as never)
  assert.throws(() => s.resolve(args, 'discover'), /No valid card/)
})
test('H-4 Hermes protocol filtering uses its handshake revisions', () => {
  const before = { ...host }
  try { useHermesHost(); assert.equal(host.name, 'Hermes'); assert.deepEqual(host.protocolVersions, HERMES_PROTOCOL_VERSIONS)
    assert.ok('error' in planForHermes(card({ supportedProtocolVersions: ['1900-01-01'] }) as never, 0, {}, undefined, false))
    // C7: a card offering only the stateless 2026-07-28 protocol isn't added: Hermes's connection to it isn't checked.
    assert.ok('error' in planForHermes(card({ supportedProtocolVersions: ['2026-07-28'] }) as never, 0, {}, undefined, false))
    assert.ok('plan' in planForHermes(card({ supportedProtocolVersions: ['2026-07-28', '2025-11-25'] }) as never, 0, {}, undefined, false))
  } finally { Object.assign(host, before) }
})
test('H-5 OAuth comes only from an anonymous live Bearer challenge; never redirects or sends secrets', async () => {
  const p = { name: 'docs', entry: { url: 'https://docs.example/mcp', enabled: true }, envVars: [], card: 'com.example/docs', provenance: '' }
  let calls = 0
  const fetch = async (url, init) => { calls++; assert.equal(url, p.entry.url); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, undefined); return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://docs.example/meta"' } }) }
  assert.equal((await probeOAuth(p as never, fetch as never)).oauth, true)
  assert.equal((await probeOAuth({ ...p, envVars: [{ name: 'KEY', for: 'key' }] } as never, fetch as never)).oauth, false)
  assert.equal(calls, 1)
  assert.equal((await probeOAuth(p as never, (async () => new Response('', { status: 401 })) as never)).oauth, false)
})
test('H-6 installed bundle and copied Python modules match source', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const r = spawnSync(process.execPath, ['build.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const words = JSON.parse(readFileSync(new URL('../../plugin/dist/words.json', import.meta.url), 'utf8'))
  assert.deepEqual(words.tools.map(t => t.name), ['discover_mcp_servers', 'add_mcp_server', 'remove_mcp_server'])
})
