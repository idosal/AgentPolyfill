// OpenCode's side of an addition, against the committed bundle (plugin/server.js):
// the plan a card gives in OpenCode's terms. The shared modules' own rules are
// tested in the Claude Code form (mod/tests) and run against the same code.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const B = (await import(pathToFileURL(join(ROOT, 'plugin', 'server.js')).href)) as any
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
const card = (remotes: unknown[]) => B.readCard({ $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', remotes }).card

test('a plain remote is added as an OpenCode remote entry', () => {
  const r = B.planForOpenCode(card([{ type: 'streamable-http', url: 'https://docs.example.com/mcp' }]), 0, {}, undefined, false)
  assert.deepEqual(r.plan.config, { type: 'remote', url: 'https://docs.example.com/mcp' })
})

test('an SSE remote is refused: OpenCode connects to streamable HTTP only', () => {
  const r = B.planForOpenCode(card([{ type: 'sse', url: 'https://docs.example.com/sse' }]), 0, {}, undefined, false)
  assert.match(r.error, /SSE/)
})

test('a secret header is never a value: the entry is given for opencode.json, with {env:VAR}', () => {
  const r = B.planForOpenCode(card([{ type: 'streamable-http', url: 'https://docs.example.com/mcp', headers: [{ name: 'X-API-Key', isSecret: true }] }]), 0, {}, undefined, false)
  assert.ok(r.byHand)
  assert.match(r.byHand, /"X-API-Key": "\{env:[A-Z0-9_]+\}"/)
  assert.equal(r.plan.config, undefined)
})

test('the bundle is a V2 plugin, and what the sources build', () => {
  assert.equal(B.default.id, 'mcp-server-cards')
  assert.equal(typeof B.default.setup, 'function')
  execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' })
})

test('a fixed header value holding a character that shows as nothing is not written', () => {
  // A soft hyphen: a card may hold one (it is not refused for it), but a written value may not.
  const c = card([{ type: 'streamable-http', url: 'https://docs.example.com/mcp', headers: [{ name: 'X-Team', value: 'docs\u00adteam' }] }])
  assert.ok(c, 'the card itself is valid')
  const r = B.planForOpenCode(c, 0, {}, undefined, false)
  assert.ok(r.error || r.missing, JSON.stringify(r))
  assert.equal(r.plan, undefined)
})

test('plugin/package.json makes the folder an installable package: this form, its bundle, nothing to install', async () => {
  const { readFileSync } = await import('node:fs')
  const form = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'))
  assert.equal(pkg.name, form.name)
  assert.equal(pkg.version, form.version)
  assert.equal(pkg.main, './server.js')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, true)
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) assert.equal(pkg[k], undefined, k)
})
