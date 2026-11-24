// For the adapter tests of both Copilot plugins (this one and polyfills/ard/copilot): a stand-in
// `copilot` command that records what it is asked and keeps its MCP entries in a file, as Copilot
// CLI 1.0.115 answers `mcp get` and `mcp add`. The local web, and the MCP client that answers the
// server's forms, are the Codex form's (../../codex/test/harness.ts).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { startServer } from '../../codex/test/harness'

export { localWeb, startServer, sleep, type Answer } from '../../codex/test/harness'

const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require('node:fs')
const state = process.env.FAKE_COPILOT_STATE
const read = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {})
const write = s => fs.writeFileSync(state, JSON.stringify(s))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_COPILOT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
if (process.env.FAKE_COPILOT_FAIL === '1') { console.error('Error: something broke'); process.exit(3) }
if (args[0] === 'mcp' && args[1] === 'get') {
  const s = read()
  if (s[args[2]]) { console.log(args[2] + '\\n  Type: ' + s[args[2]].type); process.exit(0) }
  console.error('Error: Server "' + args[2] + '" not found.\\n\\nAvailable servers:\\n  ' + Object.keys(s).join('\\n  ')); process.exit(1)
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const rest = args.slice(2); const entry = { tools: ['*'] }; const pos = []
  for (let i = 0; i < rest.length; i++) {
    // As clap parses them: --opt value and --opt=value; a separate value that starts with "-" is refused.
    const eq = /^(--[a-z]+)=(.*)$/s.exec(rest[i])
    const opt = eq ? eq[1] : rest[i]
    const val = () => { if (eq) return eq[2]; const v = rest[++i]; if (v === undefined || v.startsWith('-')) { console.error("error: unexpected argument '" + v + "' found"); process.exit(2) } return v }
    if (opt === '--transport') entry.type = val()
    else if (opt === '--header') { const h = val(); const at = h.indexOf(':'); (entry.headers ??= {})[h.slice(0, at).trim()] = h.slice(at + 1).trim() }
    else if (opt.startsWith('-')) { console.error("error: unexpected argument '" + opt + "' found"); process.exit(2) }
    else pos.push(rest[i])
  }
  const [name, url] = pos; const s = read()
  if (s[name]) { console.error('Error: Server "' + name + '" already exists. To update it, remove it first:\\n  copilot mcp remove ' + name); process.exit(1) }
  entry.url = url; s[name] = entry; write(s)
  console.log('Added server "' + name + '"'); process.exit(0)
}
console.error('fake copilot: unknown command ' + args.join(' ')); process.exit(2)
`

export type Fake = { dir: string; bin: string; state: string; log: string; calls: () => { args: string[]; cwd: string }[]; entries: () => Record<string, any> }

export function fakeCopilot(): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-polyfill-test-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'copilot.cjs')
  writeFileSync(bin, FAKE_COPILOT)
  chmodSync(bin, 0o755)
  const state = join(dir, 'state.json')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  return {
    dir,
    bin,
    state,
    log,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    entries: () => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}),
  }
}

/** The environment Copilot gives a plugin's MCP server, with the stand-in as the copilot that started it. */
export const copilotEnv = (f: Fake, extra: Record<string, string> = {}) => ({
  COPILOT_HOME: join(f.dir, 'home'),
  COPILOT_CLI_PATH: f.bin,
  COPILOT_SESSION_CWD: f.dir,
  FAKE_COPILOT_STATE: f.state,
  FAKE_COPILOT_LOG: f.log,
  ...extra,
})

/**
 * The plugin folder is installed by copying it, with nothing else, so: the committed bundle must
 * be what the sources build (byte for byte), the Copilot marketplace must point at that folder, its
 * manifest must start the server from ${PLUGIN_ROOT}, and a copy of it must start and list its tools.
 */
export function copilotBundleChecks(root: string, plugin: string, source: string, tools: string[]) {
  test('the committed plugin/dist/server.mjs is byte-identical to a fresh build, and is all dist/ holds', () => {
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-copilot-build-`))
    try {
      const built = spawnSync(process.execPath, [join(root, 'build.mjs'), '--out', dir], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(built.status, 0, built.stderr)
      assert.deepEqual(readdirSync(join(root, 'plugin', 'dist')), ['server.mjs'])
      assert.ok(readFileSync(join(dir, 'server.mjs')).equals(readFileSync(join(root, 'plugin', 'dist', 'server.mjs'))), 'plugin/dist/server.mjs is stale: run npm run build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the Copilot marketplace points at plugin/, whose manifest runs the server from ${PLUGIN_ROOT}; a copy of that folder alone starts and lists its tools', async () => {
    const market = JSON.parse(readFileSync(join(root, '..', '..', '..', '.github', 'plugin', 'marketplace.json'), 'utf8')) as { plugins: { name: string; source: string; version?: string }[] }
    const manifest = JSON.parse(readFileSync(join(root, 'plugin', 'plugin.json'), 'utf8'))
    const entry = market.plugins.find(p => p.name === plugin)
    assert.equal(entry?.source, source)
    assert.equal(entry?.version, manifest.version)
    assert.deepEqual([manifest.name, manifest.mcpServers, manifest.skills], [plugin, '.mcp.json', 'skills/'])
    const mcp = JSON.parse(readFileSync(join(root, 'plugin', '.mcp.json'), 'utf8'))
    assert.deepEqual([mcp.mcpServers[plugin].command, mcp.mcpServers[plugin].args], ['node', ['${PLUGIN_ROOT}/dist/server.mjs']])
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-copilot-install-`))
    const installed = join(dir, 'installed plugin') // a space in the path, as an install folder may have
    mkdirSync(installed)
    cpSync(join(root, 'plugin'), installed, { recursive: true })
    const s = startServer(join(installed, 'dist', 'server.mjs'))
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
