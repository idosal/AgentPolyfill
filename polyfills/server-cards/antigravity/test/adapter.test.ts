// The Antigravity adapter: the plan in Antigravity's terms, the file it
// writes, the gate (hook, ticket, server), and the plugin folder. The server
// and hook runs are against plugin/dist/server.mjs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { answerHook, callOf, digestOf, gateMatcher, issueTicket, redeemTicket, surfaceOf, TICKET_ARG, TICKET_TTL_MS } from '../src/gate'
import { isNameTaken, planForAntigravity, readConfig, writeEntry } from '../src/antigravity'
import { antigravityServer, localWeb, matches, preToolUse, runHook, tempHome } from './harness'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER = join(ROOT, 'plugin', 'dist', 'server.mjs')
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (extra: Record<string, unknown> = {}) => ({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', title: 'Example Docs', ...extra })
const remote = (r: Record<string, unknown>) => card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', ...r }] })
const TOOL = 'mcp_mcp-server-cards_cards_add_mcp_server'

// ---- the plan, in Antigravity's terms ----

test('P-1 a plain remote is a serverUrl entry, named as the card suggests', () => {
  const r = planForAntigravity(remote({}) as never, 0, {}, undefined, false)
  assert.ok('plan' in r)
  assert.deepEqual(r.plan.entry, { serverUrl: 'https://mcp.example.com/mcp' })
})

test('P-2 a fixed header is kept as it is; one with markup is refused (security review C4)', () => {
  const ok = planForAntigravity(remote({ headers: [{ name: 'X-Tenant', value: 'acme' }] }) as never, 0, {}, undefined, false)
  assert.ok('plan' in ok)
  assert.deepEqual(ok.plan.entry, { serverUrl: 'https://mcp.example.com/mcp', headers: { 'X-Tenant': 'acme' } })
  const bad = planForAntigravity(remote({ headers: [{ name: 'X-A', value: '[x](https://evil.example/)' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in bad ? bad.error : '', /holds `, <, > or a square bracket/)
})

test('P-3 a card that needs a secret is refused: the plugin never writes one, and the file reads no variables', () => {
  const header = planForAntigravity(remote({ headers: [{ name: 'X-API-Key', isSecret: true }] }) as never, 0, {}, undefined, false)
  assert.match('error' in header ? header.error : '', /needs a secret .*never does.*by hand/)
  const inUrl = planForAntigravity(
    card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/{key}/mcp', variables: { key: { isSecret: true } } }] }) as never,
    0,
    {},
    undefined,
    false,
  )
  assert.match('error' in inUrl ? inUrl.error : '', /needs a secret/)
})

test('P-4 an SSE remote is refused', () => {
  const r = planForAntigravity(card({ remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }] }) as never, 0, {}, undefined, false)
  assert.match('error' in r ? r.error : '', /SSE/)
})

// ---- the file ----

const tmpFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'ag-config-'))
  after(() => rmSync(d, { recursive: true, force: true }))
  return join(d, 'config', 'mcp_config.json')
}
const docsPlan = () => {
  const r = planForAntigravity(remote({}) as never, 0, {}, 'docs', false)
  assert.ok('plan' in r)
  return r.plan
}

test('W-1 a new file is created, private to the person', () => {
  const f = tmpFile()
  assert.deepEqual(writeEntry(f, docsPlan()), { ok: true })
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { mcpServers: { docs: { serverUrl: 'https://mcp.example.com/mcp' } } })
  assert.equal(statSync(f).mode & 0o777, 0o600)
})

test('W-2 everything else in the file is kept, and so are its permissions', () => {
  const f = tmpFile()
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, '﻿' + JSON.stringify({ mcpServers: { mine: { command: 'x', env: { A: '1' } } }, other: true }))
  chmodSync(f, 0o640)
  assert.deepEqual(writeEntry(f, docsPlan()), { ok: true })
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { mcpServers: { mine: { command: 'x', env: { A: '1' } }, docs: { serverUrl: 'https://mcp.example.com/mcp' } }, other: true })
  assert.equal(statSync(f).mode & 0o777, 0o640)
})

test('W-3 a file that is not JSON, or holds no object, is never overwritten', () => {
  for (const text of ['{ // a comment\n "mcpServers": {} }', '[]', '{"mcpServers": []}']) {
    const f = tmpFile()
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, text)
    const w = writeEntry(f, docsPlan())
    assert.equal(w.ok, false, text)
    assert.equal(readFileSync(f, 'utf8'), text)
    assert.equal(isNameTaken(f, 'anything'), true, 'an unreadable file counts as taken')
  }
})

test('W-4 never over a server the person has, whatever its case (security review SC2)', () => {
  const f = tmpFile()
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ mcpServers: { Docs: { serverUrl: 'https://mine.example/' } } }))
  assert.equal(isNameTaken(f, 'docs'), true)
  assert.equal(writeEntry(f, docsPlan()).ok, false)
  const c = readConfig(f)
  assert.ok('config' in c)
  assert.deepEqual(c.config.mcpServers, { Docs: { serverUrl: 'https://mine.example/' } })
})

// ---- the gate ----

const gateDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ag-gate-'))
  after(() => rmSync(d, { recursive: true, force: true }))
  return d
}

test('G-1 a ticket is good once, for its tool and digest, while fresh', () => {
  const dir = gateDir()
  const d = digestOf({ a: 1 })
  const n = issueTicket(dir, { tool: 't', digest: d, conversationId: 'c1' })
  assert.deepEqual(redeemTicket(dir, n, 't', d), { ok: true, conversationId: 'c1' })
  assert.equal(redeemTicket(dir, n, 't', d).ok, false, 'a ticket is used once')
  const other = issueTicket(dir, { tool: 't', digest: d, conversationId: 'c1' })
  assert.equal(redeemTicket(dir, other, 't', digestOf({ a: 2 })).ok, false, 'another digest')
  const tool = issueTicket(dir, { tool: 't', digest: d, conversationId: 'c1' })
  assert.equal(redeemTicket(dir, tool, 'u', d).ok, false, 'another tool')
  const old = issueTicket(dir, { tool: 't', digest: d, conversationId: 'c1' }, Date.now() - TICKET_TTL_MS - 1)
  assert.equal(redeemTicket(dir, old, 't', d).ok, false, 'expired')
  for (const bad of [undefined, '', '../../etc/passwd', 'a'.repeat(32), 42]) assert.equal(redeemTicket(dir, bad, 't', d).ok, false, String(bad))
})

test('G-6 the surface a conversation lives in, from its transcript path; a ticket carries the hook\'s meta to the server', async () => {
  assert.equal(surfaceOf('/Users/me/.gemini/antigravity/brain/ec33/.system_generated/logs/transcript.jsonl'), 'app')
  assert.equal(surfaceOf('/Users/me/.gemini/antigravity-cli/brain/ec33/.system_generated/logs/transcript.jsonl'), 'cli')
  assert.equal(surfaceOf('~/.gemini/antigravity-ide/brain/ec33/x'), 'ide')
  assert.equal(surfaceOf('C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\ec33\\x'), 'cli')
  for (const v of [undefined, 42, '/tmp/elsewhere/brain/x', '/Users/me/.gemini/antigravity-cloud/brain/x']) assert.equal(surfaceOf(v), 'unknown', String(v))
  const dir = gateDir()
  const out = await answerHook(preToolUse(TOOL, {}), { add_mcp_server: () => ({ pass: 'p', digest: 'd', meta: { surface: 'cli' } }) }, dir)
  assert.deepEqual(redeemTicket(dir, (out.overwrite as Record<string, string>)[TICKET_ARG], 'add_mcp_server', 'd'), { ok: true, conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587', meta: { surface: 'cli' } })
})

test('G-2 digests ignore key order', () => {
  assert.equal(digestOf({ a: 1, b: { c: 2, d: [1, 2] } }), digestOf({ b: { d: [1, 2], c: 2 }, a: 1 }))
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: '1' }))
})

test('G-3 the hook: another tool is let through untouched; a failing check is a deny, never an exit that fails open', async () => {
  const dir = gateDir()
  assert.deepEqual(await answerHook(preToolUse('run_command', {}), { add_mcp_server: () => ({ deny: 'x' }) }, dir), { decision: 'allow' })
  const boom = await answerHook(preToolUse(TOOL, {}), { add_mcp_server: () => { throw new Error('boom') } }, dir)
  assert.equal(boom.decision, 'deny')
  assert.match(String(boom.reason), /boom/)
  assert.equal((await answerHook('not an object', {}, dir)).decision, 'deny')
})

test('G-4 the hook: an ask is force_ask with the question, and the ticket goes in the arguments; a model-written ticket is replaced', async () => {
  const dir = gateDir()
  const out = await answerHook(preToolUse(TOOL, { x: 1, [TICKET_ARG]: 'f'.repeat(32) }), { add_mcp_server: args => ({ ask: `Q ${JSON.stringify(args)}`, digest: 'd' }) }, dir)
  assert.equal(out.decision, 'force_ask')
  assert.equal(out.reason, 'Q {"x":1}', 'the handler sees the call without the ticket')
  const ticket = (out.overwrite as Record<string, string>)[TICKET_ARG]!
  assert.match(ticket, /^[0-9a-f]{32}$/)
  assert.notEqual(ticket, 'f'.repeat(32))
  assert.deepEqual(redeemTicket(dir, ticket, 'add_mcp_server', 'd'), { ok: true, conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587' })
})

// ---- the plugin's hook matcher ----

test('H-1 the hook matcher takes call_mcp_tool (lazy tools, Antigravity\'s default) and this server\'s eager add_mcp_server, nothing else', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'plugin', 'hooks.json'), 'utf8'))
  const entry = hooks['mcp-server-cards-approval'].PreToolUse[0]
  assert.equal(entry.hooks[0].command, 'node ./dist/server.mjs --hook')
  assert.equal(entry.matcher, gateMatcher('mcp-server-cards_cards', ['add_mcp_server']))
  for (const name of ['call_mcp_tool', 'mcp_mcp-server-cards_cards_add_mcp_server']) assert.ok(matches(entry.matcher, name), name)
  for (const name of ['mcp_other_add_mcp_server', 'run_command', 'mcp_mcp-server-cards_cards_discover_mcp_servers', 'mcp_evil_mcp-server-cards_cards_add_mcp_server'])
    assert.ok(!matches(entry.matcher, name), name)
})

test('G-5 the lazy form: a call_mcp_tool of this server is gated with the ticket inside Arguments; another server\'s is left alone', async () => {
  const dir = gateDir()
  const S = 'mcp-server-cards_cards'
  const handlers = { add_mcp_server: (args: Record<string, unknown>) => ({ ask: `Q ${JSON.stringify(args)}`, digest: 'd' }) }
  const lazy = (server: string, tool: string, Arguments: unknown) => preToolUse('call_mcp_tool', { ServerName: server, ToolName: tool, Arguments })
  const out = await answerHook(lazy(S, 'add_mcp_server', { x: 1, [TICKET_ARG]: 'f'.repeat(32) }), handlers, dir, Date.now(), S)
  assert.equal(out.decision, 'force_ask')
  assert.equal(out.reason, 'Q {"x":1}')
  const args = (out.overwrite as { Arguments: Record<string, unknown> }).Arguments
  assert.equal(args.x, 1)
  assert.deepEqual(redeemTicket(dir, args[TICKET_ARG], 'add_mcp_server', 'd').ok, true)
  // Arguments sent as JSON text come back as JSON text.
  const text = await answerHook(lazy(S, 'add_mcp_server', '{"x":2}'), handlers, dir, Date.now(), S)
  assert.equal(typeof (text.overwrite as { Arguments: unknown }).Arguments, 'string')
  assert.equal(JSON.parse((text.overwrite as { Arguments: string }).Arguments).x, 2)
  // Another server, another tool of this server, or no server named: not this plugin's call.
  for (const input of [lazy('other_cards', 'add_mcp_server', {}), lazy(S, 'discover_mcp_servers', {}), lazy(S, 'constructor', {}), preToolUse('call_mcp_tool', { ToolName: 'add_mcp_server' })])
    assert.deepEqual(await answerHook(input, handlers, dir, Date.now(), S), { decision: 'allow' })
  assert.equal(callOf({ name: 'mcp_other_add_mcp_server', args: {} }, handlers, S), undefined)
  assert.equal(callOf({ name: 'call_mcp_tool', args: { ServerName: S, ToolName: 'add_mcp_server' } }, handlers), undefined, 'without the server name, a lazy call is never taken')
})

// ---- the server and the hook together, as Antigravity runs them ----

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
const addDocs = () => ({ domain: web.origin, identifier: 'urn:air:localhost:docs', url: `${web.origin}/mcp` })
const configOf = (home: string) => join(home, '.gemini', 'config', 'mcp_config.json')

test('E-1 discover, the hook asks with the server, URL, file and undo, and the approved call writes exactly that entry', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home)
  const d = await s.call('discover_mcp_servers', { domain: web.origin })
  assert.equal(d.isError, false, d.text)
  const h = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  assert.equal(h.status, 0)
  assert.equal(h.out.decision, 'force_ask', JSON.stringify(h.out))
  assert.match(h.out.reason, /^127\.0\.0\.1:\d+: add the MCP server "example-docs" to Antigravity\?/)
  assert.match(h.out.reason, new RegExp(`URL: ${web.origin}/mcp`))
  assert.match(h.out.reason, /Written to .*\.gemini\/config\/mcp_config\.json/)
  assert.match(h.out.reason, /To undo:/)
  assert.equal(existsSync(configOf(home)), false, 'nothing is written by the hook')
  const r = await s.call('add_mcp_server', { ...addDocs(), ...h.out.overwrite })
  assert.equal(r.isError, false, r.text)
  assert.deepEqual(JSON.parse(readFileSync(configOf(home), 'utf8')), { mcpServers: { 'example-docs': { serverUrl: `${web.origin}/mcp` } } })
})

test('E-2 without the hook\'s ticket nothing is written, and a used ticket is no good twice', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const none = await s.call('add_mcp_server', addDocs())
  assert.equal(none.isError, true)
  assert.match(none.text, /Nothing was written: .*PreToolUse hook didn't run/)
  const forged = await s.call('add_mcp_server', { ...addDocs(), [TICKET_ARG]: '0'.repeat(32) })
  assert.equal(forged.isError, true)
  assert.equal(existsSync(configOf(home)), false)
  const h = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  assert.equal((await s.call('add_mcp_server', { ...addDocs(), ...h.out.overwrite })).isError, false)
  rmSync(configOf(home))
  const again = await s.call('add_mcp_server', { ...addDocs(), ...h.out.overwrite })
  assert.equal(again.isError, true)
  assert.equal(existsSync(configOf(home)), false)
})

test('E-3 a ticket for one entry does not add another: a different name is refused', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const h = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  const r = await s.call('add_mcp_server', { ...addDocs(), name: 'other', ...h.out.overwrite })
  assert.equal(r.isError, true)
  assert.match(r.text, /changed after the person was asked/)
  assert.equal(existsSync(configOf(home)), false)
})

test('E-4 the hook denies what the server would refuse: a URL other than the card\'s, a card never shown, a card that needs a secret, a name taken', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home)
  const unshown = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  assert.equal(unshown.out.decision, 'deny')
  assert.match(unshown.out.reason, /was shown in this session/)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const elsewhere = runHook(SERVER, home, preToolUse(TOOL, { ...addDocs(), url: 'https://evil.example/mcp' }))
  assert.equal(elsewhere.out.decision, 'deny')
  assert.match(elsewhere.out.reason, /This would add .* not https:\/\/evil\.example\/mcp/)
  const keyed = runHook(SERVER, home, preToolUse(TOOL, { domain: web.origin, identifier: 'urn:air:localhost:keyed', url: `${web.origin}/keyed/mcp` }))
  assert.equal(keyed.out.decision, 'deny')
  assert.match(keyed.out.reason, /needs a secret/)
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
  writeFileSync(configOf(home), JSON.stringify({ mcpServers: { 'example-docs': { serverUrl: 'https://mine.example/' } } }))
  const taken = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  assert.equal(taken.out.decision, 'deny')
  assert.match(taken.out.reason, /already in/)
})

test('E-5 a hook that cannot read its input denies, with exit code 0 (Antigravity fails open on any other exit)', () => {
  const home = tempHome()
  const r = spawnSync(process.execPath, ['./dist/server.mjs', '--hook'], { cwd: join(ROOT, 'plugin'), input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).decision, 'deny')
})

test('E-6 stand-down: MCP_SERVER_CARDS_DISABLED=1 serves no tools', async () => {
  const s = antigravityServer(SERVER, tempHome(), { MCP_SERVER_CARDS_DISABLED: '1' })
  await s.ready
  assert.deepEqual((await s.request('tools/list', {})).result.tools, [])
})

test('E-8 the lazy form end to end: the hook gates call_mcp_tool, and its Arguments carry the ticket to the server', async () => {
  const home = tempHome()
  const s = antigravityServer(SERVER, home)
  await s.call('discover_mcp_servers', { domain: web.origin })
  const h = runHook(SERVER, home, preToolUse('call_mcp_tool', { ServerName: 'mcp-server-cards_cards', ToolName: 'add_mcp_server', Arguments: addDocs() }))
  assert.equal(h.out.decision, 'force_ask', JSON.stringify(h.out))
  assert.match(h.out.reason, /add the MCP server "example-docs" to Antigravity\?/)
  const r = await s.call('add_mcp_server', h.out.overwrite.Arguments)
  assert.equal(r.isError, false, r.text)
  assert.deepEqual(JSON.parse(readFileSync(configOf(home), 'utf8')).mcpServers, { 'example-docs': { serverUrl: `${web.origin}/mcp` } })
})

test('E-7 what one server process showed can be added through another (Antigravity may run more than one)', async () => {
  const home = tempHome()
  const a = antigravityServer(SERVER, home)
  await a.call('discover_mcp_servers', { domain: web.origin })
  const b = antigravityServer(SERVER, home)
  const h = runHook(SERVER, home, preToolUse(TOOL, addDocs()))
  assert.equal(h.out.decision, 'force_ask')
  assert.equal((await b.call('add_mcp_server', { ...addDocs(), ...h.out.overwrite })).isError, false)
})

// ---- the plugin folder ----

test('B-1 the committed plugin/dist/server.mjs is byte-identical to a fresh build, and is all dist/ holds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-cards-build-'))
  try {
    const built = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', dir], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(built.status, 0, built.stderr)
    assert.deepEqual(readdirSync(join(ROOT, 'plugin', 'dist')), ['server.mjs'])
    assert.ok(readFileSync(join(dir, 'server.mjs')).equals(readFileSync(SERVER)), 'plugin/dist/server.mjs is stale: run npm run build')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B-2 the manifest meets the plugin.json schema\'s rules, and a copy of plugin/ alone starts and lists its tools', async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'plugin.json'), 'utf8'))
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  const allowed = ['$schema', 'name', 'displayName', 'description', 'version', 'disabled', 'logo', 'suggestedPrompts', 'skills', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']
  assert.deepEqual(Object.keys(manifest).filter(k => !allowed.includes(k)), [])
  assert.ok(manifest.suggestedPrompts.length <= 3)
  const mcp = JSON.parse(readFileSync(join(ROOT, 'plugin', 'mcp_config.json'), 'utf8'))
  assert.deepEqual(mcp.mcpServers.cards.args, ['${PLUGIN_ROOT}/dist/server.mjs'])
  const skill = readFileSync(join(ROOT, 'plugin', 'skills', 'server-cards', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: server-cards\ndescription: .{20,1024}\n---\n/)
  const dir = mkdtempSync(join(tmpdir(), 'ag-cards-install-'))
  const installed = join(dir, 'mcp-server-cards')
  cpSync(join(ROOT, 'plugin'), installed, { recursive: true })
  const s = antigravityServer(join(installed, 'dist', 'server.mjs'), tempHome())
  try {
    await s.ready
    assert.deepEqual((await s.request('tools/list', {})).result.tools.map((t: { name: string }) => t.name), ['discover_mcp_servers', 'add_mcp_server'])
  } finally {
    s.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
