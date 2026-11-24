import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { fixtures } from './fixtures'

const DISCOVER = 'mcp__mcp-server-cards__discover_mcp_servers'
const ADD = 'mcp__mcp-server-cards__add_mcp_server'
const ID = 'urn:air:buildkite.com:mcp:buildkite'
const SHOWN = 'https://mcp.buildkite.com/mcp'

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
let calls = 0
/** An add as the model's call goes: the permission check with a person to ask, then (their yes given) the run. */
async function add($: Engine, input: Record<string, unknown>) {
  const id = `add${++calls}`
  const verdict = await $.tool.check({ tool: ADD, input, tool_use_id: id, approver: 'person' } as never)
  const ran = (await $.tool.run({ tool: ADD, tool_use_id: id, ...input } as never)) as { result?: string; deny?: string }
  return { verdict, ...ran }
}

// The engine beneath the plugin: a fake web, a recorded `claude mcp add`, and a
// connect that succeeds.
const engine = (on: On, card: { current: unknown }, taken: string[] = []) => {
  const runs: string[][] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    const body =
      e.url === 'https://buildkite.com/.well-known/ai-catalog.json'
        ? fixtures.catalogs['buildkite.com']
        : e.url === 'https://mcp.buildkite.com/mcp/server-card'
          ? card.current
          : undefined
    return body === undefined
      ? { value: { status: 404, ok: false, headers: {}, text: '' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('process.run', (_, e) => {
    // `claude mcp get NAME`: the names in `taken` exist, every other is free.
    if (e.argv[1] === 'mcp' && e.argv[2] === 'get')
      return taken.includes(e.argv[3]!)
        ? { value: { exitCode: 0, stdout: `${e.argv[3]}:\n  Scope: User`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 1, stdout: `No MCP server named "${e.argv[3]}".`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.connect', (_, e) => ({ value: { isConnected: true, server: e.server } }))
  return runs
}

test('B-1 add installs the card that was shown, and only with the URL that was shown', async ($, on) => {
  const card = { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] as unknown }
  const runs = engine(on, card)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const shown = await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  expect(String(shown.result).includes(`remote #0: streamable-http ${SHOWN}`)).toBe(true)

  // The catalog's card changes after it was shown.
  card.current = { ...(card.current as object), remotes: [{ type: 'streamable-http', url: 'https://evil.example/mcp' }] }

  const wrong = await add($, {domain: 'buildkite.com', identifier: ID, url: 'https://evil.example/mcp' })
  expect(runs.length).toBe(0)
  expect(String(wrong.deny ?? wrong.result).includes(`would add ${SHOWN}, not https://evil.example/mcp`)).toBe(true)

  const right = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN })
  expect(runs).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local', 'buildkite', SHOWN]])
  expect(String(right.result).includes('Connected as "buildkite"')).toBe(true)
})

test('B-2 a search result is added only if this session\'s search returned it', async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await add($, {identifier: ID, url: SHOWN })
  expect(runs.length).toBe(0)
  expect(String(r.deny ?? r.result).includes('is not a valid result of a search_mcp_servers call')).toBe(true)
})

test('B-3 a card that was never shown in this session is not added', async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN })
  expect(runs.length).toBe(0)
  expect(String(r.deny ?? r.result).includes('was shown in this session')).toBe(true)
})

test('B-4 with no `claude` on PATH, the usual install places are tried', async ($, on) => {
  const card = { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] as unknown }
  const runs: string[][] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/Users/someone' }))
  on('http.fetch', (_, e) => {
    const body =
      e.url === 'https://buildkite.com/.well-known/ai-catalog.json' ? fixtures.catalogs['buildkite.com']
        : e.url === 'https://mcp.buildkite.com/mcp/server-card' ? card.current : undefined
    return body === undefined
      ? { value: { status: 404, ok: false, headers: {}, text: '' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'claude') {
      if (e.argv[2] === 'add') runs.push([...e.argv])
      return { deny: 'spawn claude ENOENT' }
    }
    if (e.argv[2] === 'get') return { value: { exitCode: 1, stdout: 'No MCP server named "x".', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.connect', (_, e) => ({ value: { isConnected: true, server: e.server } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const r = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN })
  expect(runs.map(a => a[0])).toEqual(['claude', '/Users/someone/.local/bin/claude'])
  expect(String(r.result).includes('Connected as "buildkite"')).toBe(true)
})

test('B-5 with `ard` off: no ard.json, no rel="ard", no registry search', { options: { ard: false } }, async ($, on) => {
  const fetched: string[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    if (e.url === 'https://buildkite.com/.well-known/ai-catalog.json')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(fixtures.catalogs['buildkite.com']) } }
    if (e.url === 'https://buildkite.com/')
      return { value: { status: 200, ok: true, headers: {}, text: '<link rel="ard" href="/agents.json">' } }
    if (e.url === 'https://mcp.buildkite.com/mcp/server-card')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(fixtures.live['mcp.buildkite.com_mcp_server-card']) } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const d = await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  expect(String(d.result).includes('urn:air:buildkite.com:mcp:buildkite')).toBe(true)
  expect(fetched.includes('https://buildkite.com/.well-known/ard.json')).toBe(false)
  expect(fetched.includes('https://buildkite.com/agents.json')).toBe(false)
  let refused = false
  try {
    const s = await $.tool.call({ tool: 'mcp__mcp-server-cards__search_mcp_servers', query: 'ci' })
    refused = s.deny !== undefined || s.isError === true
  } catch {
    refused = true
  }
  expect(refused).toBe(true)
})

test('B-6 with `ard` turned on: ard.json is read and registry search is offered', { options: { ard: true } }, async ($, on) => {
  const fetched: string[] = []
  const registered: string[] = []
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__mcp-server-cards__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    if (e.url === 'https://buildkite.com/.well-known/ard.json')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(fixtures.catalogs['buildkite.com']) } }
    if (e.url === 'https://mcp.buildkite.com/mcp/server-card')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(fixtures.live['mcp.buildkite.com_mcp_server-card']) } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered.includes('search_mcp_servers')).toBe(true)
  const d = await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  expect(fetched.includes('https://buildkite.com/.well-known/ard.json')).toBe(true)
  expect(String(d.result).includes('urn:air:buildkite.com:mcp:buildkite')).toBe(true)
})

test('B-7 by default registry search is not offered', async ($, on) => {
  const registered: string[] = []
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__mcp-server-cards__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['discover_mcp_servers', 'add_mcp_server'])
})

// Security review SC2: a server of the same name in another scope is never replaced.
test('B-8 Claude\'s add refuses a name that already exists in any scope', async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] }, ['buildkite'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const r = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN })
  expect(runs.length).toBe(0)
  expect(String(r.deny ?? r.result).includes('already exists')).toBe(true)
  const named = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN, name: 'buildkite-ci' })
  expect(runs).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local', 'buildkite-ci', SHOWN]])
  expect(String(named.result).includes('claude mcp remove buildkite-ci -s local')).toBe(true)
})

// Security review SC4: the add is always put to a person, naming what is written.
test('B-9 the permission check asks, naming the server, URL, scope and undo; refuses with nobody to ask', async ($, on) => {
  engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  on('tool.check', () => ({ decision: 'allow' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const input = { domain: 'buildkite.com', identifier: ID, url: SHOWN, scope: 'project' }
  const asked = await $.tool.check({ tool: ADD, input, approver: 'person' } as never)
  expect(asked.decision).toBe('ask')
  const reason = String((asked as { reason?: string }).reason)
  expect(reason.includes('"buildkite"')).toBe(true)
  expect(reason.includes(SHOWN)).toBe(true)
  expect(reason.includes('.mcp.json')).toBe(true)
  expect(reason.includes('claude mcp remove buildkite -s project')).toBe(true)
  const nobody = await $.tool.check({ tool: ADD, input } as never)
  expect(nobody.decision).toBe('deny')
})
