import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { localWeb, startServer } from './harness'

test('Cursor loads a standalone copy and offers only the reviewed target to its native installer', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-cards-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugin = join(root, 'installed plugin')
  cpSync(fileURLToPath(new URL('../../plugin/', import.meta.url)), plugin, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(plugin, '.cursor-plugin/plugin.json'), 'utf8'))
  const spec = manifest.mcpServers[manifest.name]
  assert.equal(spec.command, 'node')
  assert.equal(spec.args.length, 1)
  const entry = spec.args[0].replace('${CURSOR_PLUGIN_ROOT}', plugin)
  assert.ok(readFileSync(join(plugin, manifest.skills, 'server-cards/SKILL.md'), 'utf8').includes('Cursor'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  for (const path of [home, cwd]) mkdirSync(join(path, '.cursor'), { recursive: true })
  const launch = (env = {}) => {
    const s = startServer(entry, { cwd, env: { HOME: home, USERPROFILE: home, ...env }, elicitation: false })
    t.after(() => { s.stop() })
    return s
  }
  const off = launch({ MCP_SERVER_CARDS_DISABLED: 'yes' })
  await off.ready
  assert.deepEqual((await off.request('tools/list', {})).result.tools, [])
  const s = launch()
  const { instructions, serverInfo } = (await s.ready).result
  assert.match(instructions, /Cursor/)
  assert.equal(serverInfo.version, manifest.version)
  assert.deepEqual((await s.request('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name), ['discover_mcp_servers', 'add_mcp_server'])

  const identifier = 'urn:air:localhost:docs'
  const web = await localWeb({
    '/.well-known/ai-catalog.json': { body: { specVersion: '1.0', entries: [
      { identifier, type: 'application/mcp-server-card+json', url: '{origin}/card.json' },
    ] } },
    '/card.json': { body: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'com.example/docs', title: 'Example Docs', version: '1.0.0', description: 'Synthetic documentation.',
      remotes: [
        { type: 'streamable-http', url: '{origin}/mcp?test=1&lang=en' },
        { type: 'streamable-http', url: '{origin}/keyed', headers: [{ name: 'X-Token', isSecret: true }] },
        { type: 'sse', url: '{origin}/sse' },
        { type: 'streamable-http', url: '{origin}/optional', headers: [{ name: 'X-Region' }] },
        { type: 'streamable-http', url: '{origin}/required', headers: [{ name: 'X-Region', isRequired: true }] },
        { type: 'streamable-http', url: '{origin}/{tenant}', variables: { tenant: { isRequired: true } } },
        { type: 'streamable-http', url: '{origin}/{key}', variables: { key: { isSecret: true, isRequired: true } } },
      ],
    } },
  })
  t.after(() => web.close())
  const url = web.origin + '/mcp?test=1&lang=en'
  const args = { domain: web.origin, identifier, url }
  const add = (extra = {}) => s.call('add_mcp_server', { ...args, ...extra })
  assert.equal((await add()).isError, true)
  const found = await s.call('discover_mcp_servers', { domain: web.origin })
  assert.ok(found.text.includes(url), found.text)
  const offered = await add()
  assert.equal(offered.isError, false, offered.text)
  const link = new URL(offered.text.split('\n')[1]!)
  assert.equal(link.protocol, 'cursor:')
  assert.equal(link.host, 'anysphere.cursor-deeplink')
  assert.equal(link.pathname, '/mcp/install')
  assert.equal(link.searchParams.get('name'), 'example-docs')
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString()), { url })
  await t.test('a fresh plugin process must discover the target for itself', async () => {
    const fresh = launch()
    const result = await fresh.call('add_mcp_server', args)
    assert.equal(result.isError, true)
    assert.doesNotMatch(result.text, /cursor:\/\//)
  })
  await t.test('declared headers are refused before collecting inputs, even when optional', async () => {
    for (const [remote, path] of [[3, 'optional'], [4, 'required']] as const) {
      const result = await add({ remote, url: web.origin + '/' + path })
      assert.equal(result.isError, true)
      assert.match(result.text, /without headers or secret inputs/)
      assert.doesNotMatch(result.text, /cursor:\/\/|ask the person/i)
    }
  })
  await t.test('ordinary URL inputs still require an exact match to the resolved remote', async () => {
    const inputs = { remote: 5, values: { tenant: 'north' } }
    const resolvedUrl = web.origin + '/north'
    assert.equal((await add({ ...inputs, url: web.origin + '/south' })).isError, true)
    const result = await add({ ...inputs, url: resolvedUrl })
    assert.equal(result.isError, false, result.text)
    const config = new URL(result.text.split('\n')[1]!).searchParams.get('config')!
    assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString()), { url: resolvedUrl })
  })
  await t.test('a secret URL input or a malformed remote selection cannot produce an install link', async () => {
    for (const remote of [6, '1', -1, 0.5, null]) {
      const result = await add({ remote })
      assert.equal(result.isError, true)
      assert.doesNotMatch(result.text, /cursor:\/\//)
    }
  })
  for (const extra of [{ identifier: 'other' }, { url: web.origin + '/other' }, { remote: 1, url: web.origin + '/keyed' }, { remote: 2, url: web.origin + '/sse' }]) {
    const denied = await add(extra)
    assert.equal(denied.isError, true)
    assert.doesNotMatch(denied.text, /cursor:\/\//)
  }
  assert.ok(web.requests.every(request => !request.path.startsWith('/mcp')))
  for (const path of [home, cwd]) {
    const file = join(path, '.cursor/mcp.json')
    assert.equal(existsSync(file), false)
    const existing = JSON.stringify({ mcpServers: { 'example-docs': { url: 'https://other.example/mcp' } } })
    writeFileSync(file, existing)
    assert.match((await add()).text, /already has a server/)
    assert.equal((await add({ name: 'another-name' })).isError, false)
    assert.equal(readFileSync(file, 'utf8'), existing)
    for (const invalid of ['{', 'null', '{"mcpServers":[]}']) {
      writeFileSync(file, invalid)
      assert.equal((await add()).isError, true)
      assert.equal(readFileSync(file, 'utf8'), invalid)
    }
    rmSync(file)
  }
  assert.deepEqual(s.asked, [])
  assert.equal(existsSync(join(home, '.codex')), false)
  await t.test('the name check stops on oversized or non-file settings', async () => {
    const file = join(cwd, '.cursor/mcp.json')
    writeFileSync(file, '{}' + ' '.repeat(1024 * 1024))
    assert.equal((await add()).isError, true)
    rmSync(file)
    mkdirSync(file)
    assert.equal((await add()).isError, true)
    rmSync(file, { recursive: true })
  })
  await t.test('a valid settings symlink is checked and a dangling one is refused', { skip: process.platform === 'win32' }, async () => {
    const settings = join(home, 'settings.json')
    const link = join(home, '.cursor/mcp.json')
    writeFileSync(settings, JSON.stringify({ mcpServers: { 'example-docs': { url } } }))
    symlinkSync(settings, link)
    assert.match((await add()).text, /already has a server/)
    assert.equal((await add({ name: 'other' })).isError, false)
    rmSync(settings)
    assert.equal((await add()).isError, true)
    assert.equal(existsSync(settings), false)
  })
})
