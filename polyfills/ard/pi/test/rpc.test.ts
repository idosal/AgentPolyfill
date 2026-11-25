import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pi, PI_BIN, BRAIN, temp, waitFor } from './pi-rpc.ts'
import { localWeb, saved, IDENTIFIER, card } from '../../../server-cards/pi/test/harness'

import { planForPi } from '../src/index'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EXTENSION = join(ROOT, 'extension')
const run = promisify(execFile)

for (const answer of ['Add it', "Don't add it", undefined]) {
  test(`RPC: ard_discover then add, answer ${String(answer)}; actual Pi CLI and connection`, async t => {
    const web = await localWeb()
    t.after(() => web.close())
    const isolated = temp('installed-')
    cpSync(EXTENSION, join(isolated, 'extension'), { recursive: true })
    const pi = new Pi({ extensions: [join(isolated, 'extension')], env: { MCP_SERVER_CARDS_DISABLED: '', ARD_DISCOVERY_DISABLED: '' }, answer: () => answer, rules: [
      { when: '^discover$', call: { name: 'ard_discover', args: { domain: web.origin } } },
      { when: '^add$', call: { name: 'ard_add_mcp_server', args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } },
    ] })
    t.after(() => pi.stop())
    await pi.ready()
    await pi.prompt('discover')
    assert.match(pi.toolResults('ard_discover')[0]!.text, /1 with a valid Server Card/)
    await pi.prompt('add')
    const result = pi.toolResults('ard_add_mcp_server')[0]!
    assert.equal(pi.ui.length, 1, pi.stderr)
    assert.deepEqual(pi.ui[0]!.options, ["Don't add it", 'Add it'])
    assert.ok(pi.ui[0]!.title!.includes(`Written to ${join(pi.agentDir, 'mcp.json')}`))
    if (answer === 'Add it') {
      assert.equal(result.isError, false, result.text + pi.stderr)
      assert.equal(saved(pi.agentDir).mcpServers['example-docs'].url, `${web.origin}/mcp`)
      assert.match(result.text, /Registered with Pi for this session/)
      await waitFor(() => web.requests.some(r => r.path === '/mcp' && r.body.includes('tools/list')), 15000, 'Pi MCP connection')
      const init = web.requests.find(r => r.path === '/mcp' && r.body.includes('initialize'))!
      assert.equal(JSON.parse(init.body).params.protocolVersion, '2025-11-25')
      assert.ok(JSON.parse(init.body).params.clientInfo.name.toLowerCase().includes('pi'))
    } else {
      assert.match(result.text, /Nothing was written/)
      assert.equal(existsSync(join(pi.agentDir, 'mcp.json')), false)
      assert.equal(web.requests.some(r => r.path === '/mcp'), false)
    }
  })
}

test('real Pi print/JSON mode refuses addition because nobody can be asked', async t => {
  const web = await localWeb()
  t.after(() => web.close())
  const agentDir = temp('print-agent-')
  const rules = [
    { when: '^print-check$', call: { name: 'ard_discover', args: { domain: web.origin } } },
    { when: 'MCP servers listed:', call: { name: 'ard_add_mcp_server', args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } },
  ]
  const pending = run(process.execPath, [PI_BIN, '--offline', '--mode', 'json', '--provider', 'scripted', '--model', 'm1', '--no-session', '-e', BRAIN, '-e', EXTENSION, '-p', 'print-check'], {
    cwd: agentDir, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_TEST_RULES: JSON.stringify(rules), PI_TEST_BRAIN_LOG: join(agentDir, 'brain.jsonl'), MCP_SERVER_CARDS_DISABLED: '', ARD_DISCOVERY_DISABLED: '' },
  })
  pending.child.stdin?.end()
  const { stdout } = await pending
  assert.match(stdout, /Pi has no one to ask in this mode/)
  assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
  assert.equal(web.requests.some(r => r.path === '/mcp'), false)
})


test('RPC: secret header stays a reference in mcp.json; Pi expands it only when connecting', async t => {
  const headers = [{ name: 'X-Test-Key', isSecret: true }, { name: 'X-Region', value: 'eu' }]
  const web = await localWeb(headers)
  t.after(() => web.close())
  const planned = planForPi(card({ remotes: [{ type: 'streamable-http', url: `${web.origin}/mcp`, headers }] }), 0, {}, undefined, true)
  assert.ok('plan' in planned)
  const variable = planned.plan.envVars[0]!.name
  const pi = new Pi({ extensions: [EXTENSION], env: { [variable]: 'test-only-placeholder', MCP_SERVER_CARDS_DISABLED: '', ARD_DISCOVERY_DISABLED: '' }, answer: () => 'Add it', rules: [
    { when: '^discover-key$', call: { name: 'ard_discover', args: { domain: web.origin } } },
    { when: '^add-key$', call: { name: 'ard_add_mcp_server', args: { domain: web.origin, identifier: IDENTIFIER, url: `${web.origin}/mcp` } } },
  ] })
  t.after(() => pi.stop())
  await pi.ready()
  await pi.prompt('discover-key')
  await pi.prompt('add-key')
  assert.equal(pi.toolResults('ard_add_mcp_server')[0]!.isError, false)
  const config = saved(pi.agentDir).mcpServers['example-docs']
  assert.deepEqual(config.headers, { ...planned.plan.headers })
  assert.doesNotMatch(JSON.stringify(config), /test-only-placeholder/)
  assert.doesNotMatch(pi.ui[0]!.title!, /test-only-placeholder/)
  const init = await waitFor(() => web.requests.find(r => r.path === '/mcp' && r.body.includes('initialize')))
  assert.equal(init.headers['x-test-key'], 'test-only-placeholder')
  assert.equal(init.headers['x-region'], 'eu')
})
