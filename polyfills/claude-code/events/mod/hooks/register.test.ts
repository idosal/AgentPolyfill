// The hooks module, run by `claude plugin test .` against the engine itself, with stand-ins
// beneath it for what the engine would do: start the helper, reach it, judge a server, take a
// prompt. No helper process runs here; test/ covers the helper.

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { isThePersons } from './tools'

// The test environment has timers; the mod API's types leave them out.
declare const setTimeout: (fn: () => void, ms: number) => unknown

type Call = { route: string; body: Record<string, unknown>; authorization: string | undefined }

/** Stands in for the engine and for a helper that says the lines in `says`, one batch per step. */
function standIn(on: On, o: { node?: string; says: string[][]; take?: () => Record<string, unknown>; attended?: boolean; off?: boolean; fails?: (route: string) => boolean }) {
  const seen = { registered: [] as { name: string; isDeferred?: unknown }[], spawned: [] as string[][], calls: [] as Call[], submitted: [] as string[], order: [] as string[] }
  let step: () => void = () => {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: o.off && e.name === 'MCP_EVENTS_OFF' ? '1' : undefined }))
  on('tool.register', (_, e) => {
    seen.registered.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__mcp-events__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_SESSION_ATTENDED: o.attended === false ? '0' : '1' } }))
  on('process.run', (_, e) => {
    const found = e.argv[0] === 'node' && o.node !== undefined
    // Only the fields the mod reads; the rest of the engine's record is left out.
    return { value: { exitCode: found ? 0 : 127, stdout: found ? `${o.node}\n` : '', stderr: '' } } as never
  })
  const spawn = async function* (_: unknown, e: { argv: readonly string[] }) {
    seen.spawned.push([...e.argv])
    for (const lines of o.says) {
      yield { stream: 'stdout' as const, text: lines.map((l) => l + '\n').join('') }
      await new Promise<void>((r) => (step = r))
    }
    return { code: 0, signal: null }
  }
  on('process.spawn', spawn as never)
  on('mcp.connect', (_, e) =>
    e.server === 'used'
      ? { value: { isConnected: true as const, server: 'used' } }
      : { value: { isConnected: false as const, reason: e.server === 'down' ? ('failed' as const) : ('disabled' as const), message: 'no' } },
  )
  on('http.fetch', (_, e) => {
    const route = new URL(e.url).pathname
    const body = JSON.parse(typeof e.init?.body === 'string' ? e.init.body : '{}') as Record<string, unknown>
    seen.calls.push({ route, body, authorization: e.init?.headers?.authorization })
    seen.order.push(route)
    if (o.fails?.(route)) return { value: { status: 500, ok: false, headers: {}, text: '{}' } }
    const answer = route === '/tool' ? { text: `answer to ${String(body.name)}`, ...(body.name === 'get_event' ? { isError: true } : {}) } : route === '/take' ? (o.take?.() ?? {}) : {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push(e.text)
    seen.order.push('submit')
    return { text: e.text, origin: e.origin }
  })
  return { seen, next: () => step() }
}
const READY = JSON.stringify({ t: 'ready', url: 'http://127.0.0.1:9', token: 'tok' })
const settle = () => new Promise<void>((r) => setTimeout(r, 20))
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

test('the six tools are registered and the helper is started with the bundle', async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY]] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(seen.registered.map((t) => t.name).sort()).toEqual(['get_event', 'list_event_types', 'list_watches', 'recent_events', 'unwatch_event', 'watch_event'])
  expect(seen.spawned.length).toBe(1)
  expect(seen.spawned[0]?.slice(0, 2)).toEqual(['node', '--no-warnings'])
  expect(seen.spawned[0]?.[2]?.endsWith('/dist/helper.js')).toBe(true)
})

test('a tool call goes to the helper with its token; its error is the call\'s error', async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY]] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const listed = await $.tool.call({ tool: 'mcp__mcp-events__list_watches' })
  expect(listed.result).toBe('answer to list_watches')
  const watched = await $.tool.call({ tool: 'mcp__mcp-events__watch_event', server: 'used', event: 'x', arguments: { a: 1 } })
  expect(watched.result).toBe('answer to watch_event')
  const call = seen.calls.find((c) => c.body.name === 'watch_event')
  expect(call?.authorization).toBe('Bearer tok')
  expect(call?.body.input).toEqual({ server: 'used', event: 'x', arguments: { a: 1 } })
  const failed = await $.tool.call({ tool: 'mcp__mcp-events__get_event', id: 'e1' })
  expect(failed.deny ?? failed.text).toBe('answer to get_event')
})

test("each server the helper names gets Claude Code's verdict: used or tried is yes, anything else is no", async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY, JSON.stringify({ t: 'servers', names: ['used', 'down', 'off'] })]] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  const verdicts = Object.fromEntries(seen.calls.filter((c) => c.route === '/verdict').map((c) => [c.body.name, { ok: c.body.ok, reason: c.body.reason }]))
  expect(verdicts).toEqual({ used: { ok: true, reason: undefined }, down: { ok: true, reason: undefined }, off: { ok: false, reason: 'disabled' } })
})

test('waiting events are taken, submitted as a prompt, and only then acknowledged', async ($, on) => {
  const batches = [{ lines: ['[mcp-events] one', '[mcp-events] two'], upto: 40 }, { lines: ['[mcp-events] three'], upto: 60 }]
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY, JSON.stringify({ t: 'pending' })]], take: () => batches.shift() ?? {} })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(seen.submitted).toEqual(['[mcp-events] one\n[mcp-events] two', '[mcp-events] three'])
  expect(seen.order.filter((s) => s !== '/verdict')).toEqual(['/take', 'submit', '/ack', '/take', 'submit', '/ack', '/take'])
  expect(seen.calls.filter((c) => c.route === '/ack').map((c) => c.body.upto)).toEqual([40, 60])
})

test('a batch whose acknowledgement was lost (the helper restarted after the submit) is acknowledged again before the next take, not shown again', async ($, on) => {
  const batches = [{ lines: ['[mcp-events] one'], upto: 40, spool: 's' }, { lines: ['[mcp-events] two'], upto: 60, spool: 's' }]
  let acks = 0
  const { seen, next } = standIn(on, {
    node: 'v22.3.0',
    says: [[READY, JSON.stringify({ t: 'pending' })], [JSON.stringify({ t: 'pending' })]],
    take: () => batches.shift() ?? {},
    // The first /ack never reaches a helper that is still there.
    fails: (route) => route === '/ack' && ++acks === 1,
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  next()
  await settle()
  expect(seen.submitted).toEqual(['[mcp-events] one', '[mcp-events] two'])
  expect(seen.order.filter((s) => s !== '/verdict')).toEqual(['/take', 'submit', '/ack', '/ack', '/take', 'submit', '/ack', '/take'])
  expect(seen.calls.filter((c) => c.route === '/ack').map((c) => [c.body.upto, c.body.spool])).toEqual([[40, 's'], [40, 's'], [60, 's']])
})

test('the catalog joins the instructions only while there is something to watch, and watch_event is then loaded from the start', async ($, on) => {
  const catalog = (eventTypes: number) => JSON.stringify({ t: 'catalog', text: 'Event types: deploys / deploy.finished', eventTypes, watches: 0 })
  const { seen, next } = standIn(on, { node: 'v22.3.0', says: [[READY, catalog(0)], [catalog(1)]] })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'intro', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect((await $.prompt.compose(COMPOSE)).sections.map((s) => s.id)).toEqual(['intro'])
  next()
  await settle()
  const sections = (await $.prompt.compose(COMPOSE)).sections
  expect(sections.map((s) => s.id)).toEqual(['intro', 'mcp-events:catalog'])
  expect(sections[1]?.text).toBe('Event types: deploys / deploy.finished')
  expect(seen.registered.filter((t) => t.name === 'watch_event').map((t) => t.isDeferred)).toEqual([undefined, false])
})

test('with neither Node 20 nor Bun, nothing is started and a tool says what is needed', async ($, on) => {
  const { seen } = standIn(on, { node: 'v18.19.0', says: [[READY]] })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__mcp-events__list_watches' })
  expect(String(answer.deny ?? answer.text)).toContain('needs Node 20 or newer, or Bun')
  expect(seen.spawned.length).toBe(0)
})

test('an unattended run starts the helper only when a tool is called', async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY]], attended: false })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await settle()
  expect(seen.spawned.length).toBe(0)
  await $.tool.call({ tool: 'mcp__mcp-events__list_watches' })
  expect(seen.spawned.length).toBe(1)
})

test('MCP_EVENTS_OFF=1: installed, and doing nothing', async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY]], off: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(seen.registered).toEqual([])
  expect(seen.spawned).toEqual([])
})

test("the helper is told when the person speaks, and not when a plugin's prompt (the mod's own wake) goes by", async ($, on) => {
  const { seen } = standIn(on, { node: 'v22.3.0', says: [[READY]] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  // A prompt submitted here is a plugin's, as the mod's own wake is.
  await $.prompt.submit({ text: '[mcp-events] deploys · deploy.finished: 1 new event' })
  await settle()
  expect(seen.calls.filter((c) => c.route === '/spoke').length).toBe(0)
  expect(['composer', 'bridge', 'sdk'].map(isThePersons)).toEqual([true, true, true])
  expect(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'channel', 'unclassified', undefined].map(isThePersons)).toEqual(Array(8).fill(false))
})
