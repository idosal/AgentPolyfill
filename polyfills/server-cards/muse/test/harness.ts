// The Muse form's test helpers: a stand-in muse, and the checks of the Muse files in the Codex
// plugin folder. Everything else is the Codex form's harness (../../codex/test/harness.ts).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { startServer, type Fake } from '../../codex/test/harness'

export * from '../../codex/test/harness'

// The stand-in for muse (1.4.25): "mcp get NAME --json", as it answers. The Muse form never
// writes, so anything else is recorded and refused.
const FAKE_MUSE = `#!/usr/bin/env node
const fs = require('node:fs')
const state = process.env.FAKE_MUSE_STATE
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'mcp' && args[1] === 'get') {
  const s = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {}
  if (s[args[2]]) { console.log(JSON.stringify({ name: args[2], ...s[args[2]] })); process.exit(0) }
  console.log(JSON.stringify({ error: { kind: 'not_found', name: args[2] } })); process.exit(1)
}
console.error('fake muse: not expected: ' + args.join(' ')); process.exit(2)
`

/** A stand-in muse, as "muse" in a folder of its own (put first on PATH). */
export function fakeMuse(): Fake & { path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'muse-polyfill-test-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'muse')
  writeFileSync(bin, FAKE_MUSE)
  chmodSync(bin, 0o755)
  const state = join(dir, 'state.json')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  return {
    dir,
    bin,
    state,
    log,
    path: `${dir}:${process.env.PATH ?? ''}`,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    entries: () => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}),
  }
}

/**
 * The Muse form's files in the Codex plugin folder (`codexRoot`): its bundle is current and is all
 * plugin/muse/dist/ holds; its manifest names the same plugin, its own version and its own bundle
 * (Muse resolves the path against the plugin folder), and a skill outside skills/ (Codex lists
 * every SKILL.md there); and a copy of the folder started as Muse starts it lists the Muse tools.
 */
export function museChecks(museRoot: string, codexRoot: string, plugin: string, tools: string[]) {
  const version = JSON.parse(readFileSync(join(museRoot, 'package.json'), 'utf8')).version
  test('the committed plugin/muse/dist/server.mjs is byte-identical to a fresh build, and is all plugin/muse/dist/ holds', () => {
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-muse-build-`))
    try {
      const r = spawnSync(process.execPath, [join(museRoot, 'build.mjs'), '--out', dir], { encoding: 'utf8', timeout: 60000 })
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(readdirSync(join(codexRoot, 'plugin', 'muse', 'dist')), ['server.mjs'])
      assert.ok(readFileSync(join(dir, 'server.mjs')).equals(readFileSync(join(codexRoot, 'plugin', 'muse', 'dist', 'server.mjs'))), 'plugin/muse/dist/server.mjs is stale: run npm run build in the Muse form')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('the Muse manifest names the same plugin, its own version and its own bundle, and its files are in the folder', async () => {
    const muse = JSON.parse(readFileSync(join(codexRoot, 'plugin', '.muse-plugin', 'plugin.json'), 'utf8'))
    assert.equal(muse.schemaVersion, 1)
    assert.equal(muse.name, plugin)
    assert.equal(muse.version, version)
    assert.deepEqual(muse.compat, { source: 'native', manifestDir: '.muse-plugin' })
    assert.deepEqual(muse.capabilities.mcpServers, [{ id: plugin, transport: 'stdio', command: ['node', 'muse/dist/server.mjs'] }])
    for (const s of muse.capabilities.skills) {
      assert.ok(existsSync(join(codexRoot, 'plugin', s.path)), s.path)
      assert.ok(!s.path.startsWith('skills/'), s.path)
    }
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-muse-install-`))
    const installed = join(dir, 'cached plugin')
    mkdirSync(installed)
    cpSync(join(codexRoot, 'plugin'), installed, { recursive: true })
    const s = startServer(join(installed, 'muse', 'dist', 'server.mjs'), { elicitation: false })
    try {
      await s.ready
      const list = await s.request('tools/list', {})
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), tools)
    } finally {
      s.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
