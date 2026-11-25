// The committed bundle (plugin/server.js): what the sources build, a V2 plugin,
// and the registry client's endpoint rule. The ARD registry client's own rules
// are tested in the Claude Code form (mod/tests/registry.test.ts) against the same code.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const B = (await import(pathToFileURL(join(ROOT, 'plugin', 'server.js')).href)) as any

test('a registry is searched at <base>/search, over HTTPS (plain HTTP only on loopback)', () => {
  assert.equal(B.searchEndpoint('https://registry.example.com/v1/'), 'https://registry.example.com/v1/search')
  assert.ok(B.searchEndpoint('http://registry.example.com').error)
})

test('the plugin ships with no registry', () => {
  assert.equal(B.registrySetting({}), '')
})

test('the bundle is a V2 plugin, and what the sources build', () => {
  assert.equal(B.default.id, 'ard-discovery')
  execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' })
})
