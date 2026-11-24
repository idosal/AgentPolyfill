// OpenCode's side of an addition, against the committed bundle (plugin/server.js):
// the plan a card gives in OpenCode's terms. The shared modules' own rules are
// tested in the Claude Code form (mod/tests) and run against the same code.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const B = (await import(join(ROOT, 'plugin', 'server.js'))) as any
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
