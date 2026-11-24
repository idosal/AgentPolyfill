// The ARD plugin as Antigravity runs it: the server on stdio, its PreToolUse
// hook as a command, a local web with an ard.json and a registry. Against
// plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { antigravityServer, localWeb, matches, preToolUse, runHook, tempHome } from '../../../server-cards/antigravity/test/harness'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER = join(ROOT, 'plugin', 'dist', 'server.mjs')
const TYPE = 'application/mcp-server-card+json'
const SEARCH = 'mcp_ard-discovery_ard_ard_search'
const ADD = 'mcp_ard-discovery_ard_add_mcp_server'
const card = (name: string, title: string, path: string) => ({
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name,
  version: '1.0.0',
  description: `${title}.`,
  title,
  remotes: [{ type: 'streamable-http', url: `{origin}${path}` }],
})

const web = await localWeb({
  '/.well-known/ard.json': { body: { entries: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: '{origin}/ci.json' }] } },
  '/ci.json': { body: card('com.example/ci', 'Example CI', '/ci/mcp') },
  '/search': { body: { results: [{ identifier: 'urn:air:localhost:ci', type: TYPE, url: '{origin}/ci.json', displayName: 'Example CI', score: 90 }] } },
})
after(() => web.close())
const searches = () => web.requests.filter(r => r.method === 'POST')
const QUERY = 'check why my CI build failed'
const configOf = (home: string) => join(home, '.gemini', 'config', 'mcp_config.json')
const env = { ARD_DISCOVERY_REGISTRY: web.origin }

test('R-1 the server: its three tools, and the registry it would send to', async () => {
  const s = antigravityServer(SERVER, tempHome(), env)
  await s.ready
  const list = await s.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['ard_discover', 'ard_search', 'add_mcp_server'])
  assert.match(list.result.tools[1].description, /Antigravity's approval card asks the person before anything is sent/)
})

test('R-2 the hook asks with the registry endpoint and the exact query, and sends nothing itself', () => {
  const before = searches().length
  const h = runHook(SERVER, tempHome(), preToolUse(SEARCH, { query: QUERY }), env)
  assert.equal(h.status, 0)
  assert.equal(h.out.decision, 'force_ask')
  assert.equal(h.out.reason, `${new URL(web.origin).host}: send this search to ${web.origin}/search, and to up to three registries it refers to?\nQuery: "${QUERY}"\nA registry is a service someone else runs, and it sees the query.`)
  assert.equal(searches().length, before)
})

test('R-3 approved: the query is posted once, as the hook showed it; without the ticket, or with it twice, nothing is sent', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home, env)
  const before = searches().length
  const none = await s.call('ard_search', { query: QUERY })
  assert.match(none.text, /^Nothing was sent: .*PreToolUse hook didn't run/)
  assert.equal(searches().length, before)
  const h = runHook(SERVER, home, preToolUse(SEARCH, { query: QUERY }), env)
  const r = await s.call('ard_search', { query: QUERY, ...h.out.overwrite })
  assert.equal(r.isError, false, r.text)
  assert.equal(searches().length, before + 1)
  assert.deepEqual(JSON.parse(searches().at(-1)!.body), { query: { text: QUERY, filter: { type: [TYPE] } }, federation: 'referrals', pageSize: 10 })
  assert.match(r.text, /identifier: urn:air:localhost:ci/)
  const again = await s.call('ard_search', { query: QUERY, ...h.out.overwrite })
  assert.equal(again.isError, true)
  assert.equal(searches().length, before + 1)
})

test('R-4 a ticket for one query does not send another', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home, env)
  const before = searches().length
  const h = runHook(SERVER, home, preToolUse(SEARCH, { query: QUERY }), env)
  const r = await s.call('ard_search', { query: `${QUERY} and also my secrets`, ...h.out.overwrite })
  assert.match(r.text, /changed after the person was asked/)
  assert.equal(searches().length, before)
})

test('R-5 no registry set and none named: the hook denies, naming where to set one, and nothing is sent', () => {
  const before = searches().length
  const h = runHook(SERVER, tempHome(), preToolUse(SEARCH, { query: QUERY }))
  assert.equal(h.out.decision, 'deny')
  assert.match(h.out.reason, /ARD_DISCOVERY_REGISTRY in the environment Antigravity starts in/)
  const bad = runHook(SERVER, tempHome(), preToolUse(SEARCH, { query: 'x'.repeat(301) }), env)
  assert.equal(bad.out.decision, 'deny')
  assert.match(bad.out.reason, /under 300 characters/)
  assert.equal(searches().length, before)
})

test('R-6 a search result is added after its own approval, which says the publisher did not confirm it', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home, env)
  const h = runHook(SERVER, home, preToolUse(SEARCH, { query: QUERY }), env)
  await s.call('ard_search', { query: QUERY, ...h.out.overwrite })
  const args = { identifier: 'urn:air:localhost:ci', url: `${web.origin}/ci/mcp` }
  const a = runHook(SERVER, home, preToolUse(ADD, args), env)
  assert.equal(a.out.decision, 'force_ask', JSON.stringify(a.out))
  assert.match(a.out.reason, /NOT confirmed by its publisher's own catalog/)
  const r = await s.call('add_mcp_server', { ...args, ...a.out.overwrite })
  assert.equal(r.isError, false, r.text)
  assert.deepEqual(JSON.parse(readFileSync(configOf(home), 'utf8')).mcpServers, { 'example-ci': { serverUrl: `${web.origin}/ci/mcp` } })
})

test('R-7 ard_discover reads ard.json, and what it showed is added after the approval', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home, env)
  const d = await s.call('ard_discover', { domain: web.origin })
  assert.match(d.text, /\/\.well-known\/ard\.json \[extra\]: found \(1 entries\)/)
  const args = { domain: web.origin, identifier: 'urn:air:localhost:ci', url: `${web.origin}/ci/mcp` }
  const none = await s.call('add_mcp_server', args)
  assert.equal(none.isError, true)
  assert.equal(existsSync(configOf(home)), false)
  const a = runHook(SERVER, home, preToolUse(ADD, args), env)
  assert.equal((await s.call('add_mcp_server', { ...args, ...a.out.overwrite })).isError, false)
})

test('R-8 the hook matcher takes this plugin\'s ard_search and add_mcp_server, and not its discover or another plugin\'s tools', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'plugin', 'hooks.json'), 'utf8'))['ard-discovery-approval'].PreToolUse[0].matcher
  for (const n of [SEARCH, ADD, 'mcp_ard_discovery_ard_ard_search']) assert.ok(matches(m, n), n)
  for (const n of ['mcp_ard-discovery_ard_ard_discover', 'mcp_mcp-server-cards_cards_add_mcp_server', 'mcp_other_ard_search']) assert.ok(!matches(m, n), n)
})

test('R-9 stand-down: ARD_DISCOVERY_DISABLED=1 serves no tools', async () => {
  const s = antigravityServer(SERVER, tempHome(), { ARD_DISCOVERY_DISABLED: '1' })
  await s.ready
  assert.deepEqual((await s.request('tools/list', {})).result.tools, [])
})

test('B-1 the committed plugin/dist/server.mjs is byte-identical to a fresh build, and a copy of plugin/ alone starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-ard-build-'))
  try {
    const built = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', dir], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(built.status, 0, built.stderr)
    assert.deepEqual(readdirSync(join(ROOT, 'plugin', 'dist')), ['server.mjs'])
    assert.ok(readFileSync(join(dir, 'server.mjs')).equals(readFileSync(SERVER)), 'plugin/dist/server.mjs is stale: run npm run build')
    const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'plugin.json'), 'utf8'))
    assert.equal(manifest.name, 'ard-discovery')
    const installed = join(dir, 'ard-discovery')
    cpSync(join(ROOT, 'plugin'), installed, { recursive: true })
    const s = antigravityServer(join(installed, 'dist', 'server.mjs'), tempHome())
    await s.ready
    assert.equal((await s.request('tools/list', {})).result.tools.length, 3)
    s.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
