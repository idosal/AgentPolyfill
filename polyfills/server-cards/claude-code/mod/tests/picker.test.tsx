import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { fixtures } from './fixtures'

const DISCOVER = 'mcp__mcp-server-cards__discover_mcp_servers'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const engine = (on: On, card: unknown = fixtures.live['mcp.buildkite.com_mcp_server-card'], taken: string[] = []) => {
  const runs: string[][] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-server-cards__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    const body =
      e.url === 'https://buildkite.com/.well-known/ai-catalog.json'
        ? fixtures.catalogs['buildkite.com']
        : e.url === 'https://mcp.buildkite.com/mcp/server-card'
          ? card
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
  on('ui.toast', () => ({ value: undefined }))
  return runs
}

const row = (toolUseId: string) => ({
  plugin: 'mcp-server-cards',
  component: 'ToolUse',
  requestId: toolUseId,
  props: {
    tool_use_id: toolUseId,
    tool: DISCOVER,
    input: { domain: 'buildkite.com' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: 'Discovery for https://buildkite.com',
  },
}) as const

test('U-1 the picker lists the servers found, on every surface, and Add adds the one pressed', async ($, on) => {
  const runs = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const id = 'toolu_picker_1'
  const shown = await $.tool.call({ tool: DISCOVER, tool_use_id: id, domain: 'buildkite.com' })
  expect(String(shown.result).includes('pressing its Add button')).toBe(true)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row(id), surface })
    expect((await ui.find({ type: 'Text', text: /MCP servers you can add/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /confirmed|listed by buildkite\.com/ })) !== undefined).toBe(true)
    expect((await ui.find({ key: 'add:urn:air:buildkite.com:mcp:buildkite#0' })) !== undefined).toBe(true)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  await ui.press({ key: 'add:urn:air:buildkite.com:mcp:buildkite#0' })
  expect(runs).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local', 'buildkite', 'https://mcp.buildkite.com/mcp']])
  await ui.unmount()
  const after = await $.ui.mount({ ...row(id), surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /^added$/ })) !== undefined).toBe(true)
  expect((await after.find({ key: 'add:urn:air:buildkite.com:mcp:buildkite#0' })) === undefined).toBe(true)
  await after.unmount()
})

test('U-2 a card that needs input shows no Add button', async ($, on) => {
  const card = {
    ...fixtures.live['mcp.buildkite.com_mcp_server-card'],
    remotes: [{ type: 'streamable-http', url: 'https://{tenant}.buildkite.example/mcp', variables: { tenant: { isRequired: true } } }],
  }
  const runs = engine(on, card)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const id = 'toolu_picker_2'
  await $.tool.call({ tool: DISCOVER, tool_use_id: id, domain: 'buildkite.com' })
  const ui = await $.ui.mount({ ...row(id), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Needs tenant/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'add:urn:air:buildkite.com:mcp:buildkite#0' })) === undefined).toBe(true)
  await ui.unmount()
  expect(runs.length).toBe(0)
})

test('U-3 with the picker off, the row is the engine\'s own', { options: { picker: false } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({ tool: DISCOVER, domain: 'buildkite.com' })
  expect(String(shown.result).includes('Add button')).toBe(false)
  const ui = await $.ui.mount({ ...row('t1'), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /MCP servers you can add/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('U-4 the picker shows the name it adds, and a press never replaces a server: it takes the next free name', async ($, on) => {
  const runs = engine(on, fixtures.live['mcp.buildkite.com_mcp_server-card'], ['buildkite'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const id = 'toolu_picker_4'
  await $.tool.call({ tool: DISCOVER, tool_use_id: id, domain: 'buildkite.com' })
  const ui = await $.ui.mount({ ...row(id), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /adds "buildkite" to this project/ })) !== undefined).toBe(true)
  await ui.press({ key: 'add:urn:air:buildkite.com:mcp:buildkite#0' })
  await ui.unmount()
  expect(runs).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local', 'buildkite-2', 'https://mcp.buildkite.com/mcp']])
  const after = await $.ui.mount({ ...row(id), surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /as "buildkite-2": "buildkite" already exists/ })) !== undefined).toBe(true)
  await after.unmount()
})
