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

test('a query or registry holding a hidden character is refused: tag characters, a blank Braille pattern, a zero-width joiner', () => {
  for (const c of ['\u{E0041}', '⠀', '‍', ' '])
    assert.ok(B.UNSEEN.test(`check my CI${c}build`), `U+${c.codePointAt(0)!.toString(16)}`)
  assert.ok(!B.UNSEEN.test('check why my CI build failed'))
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
