import type { On, Register } from 'claude-code'
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
  // Refused at the check, the call never runs: the model reads the reason.
  if (verdict.decision === 'deny') return { verdict, deny: String((verdict as { reason?: string }).reason) }
  const ran = (await $.tool.run({ tool: ADD, tool_use_id: id, ...input } as never)) as { result?: string; deny?: string }
  return { verdict, ...ran }
}

// The engine beneath the plugin: a fake web, a recorded `claude mcp add`, and a
// connect that succeeds.
const engine = (on: On, card: { current: unknown }, taken: string[] = [], beneath: 'ask' | 'allow' = 'ask') => {
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
  // Claude Code's own verdict on the add: ask with no rule for the tool, allow under an allow rule or auto mode.
  on('tool.check', { tool: ADD }, () => ({ decision: beneath }))
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
  expect(String(r.deny ?? r.result).includes('is not a server shown in this session without a domain')).toBe(true)
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
  on('tool.check', { tool: ADD }, () => ({ decision: 'ask' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const r = await add($, {domain: 'buildkite.com', identifier: ID, url: SHOWN })
  expect(runs.map(a => a[0])).toEqual(['claude', '/Users/someone/.local/bin/claude'])
  expect(String(r.result).includes('Connected as "buildkite"')).toBe(true)
})

test('B-5 discovery reads what SEP-2127 names: ai-catalog.json and rel="ai-catalog", not ard.json or rel="ard"', async ($, on) => {
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
})

const PRESENT = 'mcp__mcp-server-cards__present_server_cards'

// Another plugin, as the ARD plugin is: its own tool `find` hands a payload to
// present_server_cards, under its own call's row. An inline plugin runs in an
// environment of its own, so each one is written out whole, literals inside.
const finderForDomain = {
  name: 'finder',
  register: (on => {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.tool.register({ name: 'find', description: 'finds servers' })
      return started
    })
    on('tool.run', { tool: 'mcp__finder__find' }, async ($, e) => {
      const r = await $.tool.call({
        tool: 'mcp__mcp-server-cards__present_server_cards',
        by: 'a test plugin',
        under: e.tool_use_id,
        domain: 'huggingface.co',
        catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }],
        rels: ['ard'],
      } as never)
      return r.deny !== undefined ? { deny: r.deny } : { result: r.result as never }
    })
  }) as Register,
}
const finderForEntries = {
  name: 'finder',
  register: (on => {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.tool.register({ name: 'find', description: 'finds servers' })
      return started
    })
    on('tool.run', { tool: 'mcp__finder__find' }, async ($, e) => {
      const r = await $.tool.call({
        tool: 'mcp__mcp-server-cards__present_server_cards',
        by: 'the registry at r.example',
        under: e.tool_use_id,
        entries: [
          {
            identifier: 'urn:air:buildkite.com:mcp:buildkite',
            type: 'application/mcp-server-card+json',
            url: 'https://mcp.buildkite.com/mcp/server-card',
            listedIn: 'https://r.example/search',
            score: 75,
          },
        ],
      } as never)
      return r.deny !== undefined ? { deny: r.deny } : { result: r.result as never }
    })
  }) as Register,
}
const FIND = 'mcp__finder__find'
/** A finder that reads a further catalog (as ard-discovery reads ard.json), and says so with its entries. */
const finderWithSources = {
  name: 'finder',
  register: (on => {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.tool.register({ name: 'find', description: 'finds servers' })
      return started
    })
    on('tool.run', { tool: 'mcp__finder__find' }, async ($, e) => {
      const r = await $.tool.call({
        tool: 'mcp__mcp-server-cards__present_server_cards',
        by: 'the registry at r.example',
        under: e.tool_use_id,
        catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }],
        rels: ['ard'],
        entries: [
          {
            identifier: 'urn:air:buildkite.com:mcp:buildkite',
            type: 'application/mcp-server-card+json',
            url: 'https://mcp.buildkite.com/mcp/server-card',
            listedIn: 'https://r.example/search',
          },
        ],
      } as never)
      return r.deny !== undefined ? { deny: r.deny } : { result: r.result as never }
    })
  }) as Register,
}
/** The engine beneath, for a plugin's own $.tool.call: the call is allowed, and runs. */
const runsCalls = (on: On) =>
  on('tool.call', { tool: PRESENT }, ($, e) => ($ as unknown as { tool: { run: (e: unknown) => Promise<never> } }).tool.run(e))

test('B-6 another plugin can have further catalogs and link types read for a domain, and gets the registries listed', { plugins: [finderForDomain] }, async ($, on) => {
  const fetched: string[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    if (e.url === 'https://huggingface.co/.well-known/ard.json')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ entries: fixtures.catalogs['huggingface.co'].entries }) } }
    if (e.url === 'https://huggingface.co/mcp/server-card')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(fixtures.live['huggingface.co_mcp_server-card']) } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('process.run', (_, e) =>
    e.argv[2] === 'get'
      ? { value: { exitCode: 1, stdout: 'No MCP server named "x".', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('mcp.connect', (_, e) => ({ value: { isConnected: true, server: e.server } }))
  on('tool.check', { tool: ADD }, () => ({ decision: 'ask' }))
  runsCalls(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: FIND } as never)
  expect(fetched.includes('https://huggingface.co/.well-known/ard.json')).toBe(true)
  const out = JSON.parse(String(r.result)) as { text: string; servers: number; registries: { identifier: string; url?: string }[] }
  expect(out.servers).toBe(1)
  expect(out.registries[0]).toEqual({ identifier: 'urn:air:huggingface.co:registry:discover', url: 'https://huggingface-hf-discover.hf.space/', displayName: 'Hugging Face Discover Registry' })
  expect(out.text.includes('further sources from a test plugin')).toBe(true)
  // Added by domain, as a card a discovery showed.
  const added = await add($, { domain: 'huggingface.co', identifier: 'urn:air:huggingface.co:mcp:hub', url: 'https://huggingface.co/mcp' })
  expect(String(added.result).includes('Added "hugging-face"')).toBe(true)
})

test('B-7 the tools: discovery, add, and a hand-over tool kept from the model', async ($, on) => {
  const registered: string[] = []
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__mcp-server-cards__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['discover_mcp_servers', 'add_mcp_server', 'present_server_cards'])
})

test('B-10 servers another plugin found are checked here, shown with the finder named, and added by identifier', { plugins: [finderForEntries] }, async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  runsCalls(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: FIND } as never)
  const out = JSON.parse(String(r.result)) as { text: string; servers: number }
  expect(out.servers).toBe(1)
  expect(out.text.includes('MCP servers found by the registry at r.example')).toBe(true)
  expect(out.text.includes("CONFIRMED: buildkite.com's own catalog")).toBe(true)
  const added = await add($, { identifier: ID, url: SHOWN })
  expect(runs).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local', 'buildkite', SHOWN]])
  expect(String(added.result).includes('confirmed by buildkite.com')).toBe(true)
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
  engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] }, [], 'allow')
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

test('B-11 the hand-over tool refuses the model: a call that is not another plugin\'s', async ($, on) => {
  engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: PRESENT, by: 'me', domain: 'buildkite.com' } as never)
  expect(String((r as { deny?: string }).deny).includes('for other plugins to call')).toBe(true)
})

test('B-12 a finder\'s further sources are read on the publisher\'s domain: a server its publisher lists only there is confirmed', { plugins: [finderWithSources] }, async ($, on) => {
  const fetched: string[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    const body =
      e.url === 'https://buildkite.com/.well-known/ard.json'
        ? fixtures.catalogs['buildkite.com']
        : e.url === 'https://mcp.buildkite.com/mcp/server-card'
          ? fixtures.live['mcp.buildkite.com_mcp_server-card']
          : undefined
    return body === undefined
      ? { value: { status: 404, ok: false, headers: {}, text: '' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  runsCalls(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: FIND } as never)
  const out = JSON.parse(String(r.result)) as { text: string }
  expect(fetched.includes('https://buildkite.com/.well-known/ard.json')).toBe(true)
  expect(out.text.includes("CONFIRMED: buildkite.com's own catalog")).toBe(true)
})

// Security review re-check, the two paths around the SC4 ask, and the
// pre-merge re-check's M1: another plugin can't add a server, whichever way in.
/**
 * A plugin that adds a shown card through its own $.tool.call. Claude Code runs
 * the permission check for such a call, opens no dialog, and turns an ask into
 * an allow; whether that check is told a person can be asked is not stated. So
 * the refusal must not rest on that: another plugin's call is refused because
 * it is not Claude's own, at the check and again at the run.
 */
const adder = {
  name: 'adder',
  register: (on => {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.tool.register({ name: 'add-it', description: 'adds a server' })
      return started
    })
    on('tool.run', { tool: 'mcp__adder__add-it' }, async ($, e) => {
      const r = await $.tool.call({
        tool: 'mcp__mcp-server-cards__add_mcp_server',
        domain: 'buildkite.com',
        identifier: 'urn:air:buildkite.com:mcp:buildkite',
        url: 'https://mcp.buildkite.com/mcp',
      } as never)
      return { result: r.deny ?? String(r.result) }
    })
  }) as Register,
}

test('B-13 another plugin\'s $.tool.call adds nothing, refused because it is not Claude\'s own call', { plugins: [adder] }, async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  // Claude Code's answer to an ask on a plugin's own call: allow, with no dialog.
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const r = await $.tool.call({ tool: 'mcp__adder__add-it' } as never)
  expect(runs.length).toBe(0)
  expect(String(r.result).includes('only for Claude\'s own call')).toBe(true)
})

test('B-14 a check that comes before the card is shown refuses, whatever the rules say, and the call can\'t run once it is shown', async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] }, [], 'allow')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const input = { domain: 'buildkite.com', identifier: ID, url: SHOWN }
  const early = await $.tool.check({ tool: ADD, input, tool_use_id: 'early', approver: 'person' } as never)
  expect(early.decision).toBe('deny')
  expect(String((early as { reason?: string }).reason).includes('was shown in this session')).toBe(true)
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const late = (await $.tool.run({ tool: ADD, tool_use_id: 'early', ...input } as never)) as { deny?: string }
  expect(runs.length).toBe(0)
  expect(String(late.deny).includes('was not put to one')).toBe(true)
})

// Security review M1, the optional binding: the run adds only what the person was asked about.
test('B-15 a run whose arguments differ from those the person approved (name, scope) adds nothing', async ($, on) => {
  const runs = engine(on, { current: fixtures.live['mcp.buildkite.com_mcp_server-card'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  const input = { domain: 'buildkite.com', identifier: ID, url: SHOWN }
  for (const [id, changed] of [['b15-name', { name: 'buildkite-prod' }], ['b15-scope', { scope: 'user' }]] as const) {
    const asked = await $.tool.check({ tool: ADD, input, tool_use_id: id, approver: 'person' } as never)
    expect(asked.decision).toBe('ask')
    const r = (await $.tool.run({ tool: ADD, tool_use_id: id, ...input, ...changed } as never)) as { deny?: string }
    expect(String(r.deny).includes('not what the person approved')).toBe(true)
  }
  expect(runs.length).toBe(0)
  const ok = await add($, input)
  expect(runs.length).toBe(1)
  expect(String(ok.result).includes('Connected as "buildkite"')).toBe(true)
})
