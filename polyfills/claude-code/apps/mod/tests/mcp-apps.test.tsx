import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The helper process, the socket and the MCP server are all stood in for:
// `process.spawn` streams what the helper would print, `http.fetch` records
// what the mod sends it, and `mcp.call` answers for Claude Code's connection.

const TOOL_USE_ID = 'toolu_test_1'
// Widened: the generated types list only the MCP tools connected at load.
const TOOL = 'mcp__vanilla__get-time' as never
const RESULT = { content: [{ type: 'text', text: '2026-11-17T12:00:00.000Z' }] }
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
// Two cells of a Raster: "O" and "K", light grey on blue.
const FRAME = {
  cols: 2,
  rows: 1,
  cells: btoa(
    String.fromCharCode(...new Uint8Array(Uint32Array.from([0x4f, 0xdddddd, 0x2860e8, 0x4b, 0xdddddd, 0x2860e8]).buffer)),
  ),
}

type Sent = { route: string; body: Record<string, unknown> }

/** The notes for the model the plugin appended to the session, as text. */
function notesOf(session: ReturnType<typeof mock.session>): string[] {
  return session
    .appended()
    .filter((row) => row.door === 'note' && row.message.type === 'user')
    .map((row) => {
      const content = row.message.content as unknown
      return typeof content === 'string' ? content : (content as { text?: string }[]).map((block) => block.text ?? '').join('')
    })
}

function standIns(
  on: On,
  opts: {
    images?: boolean
    swapEveryDraw?: boolean
    timers?: boolean
    script?: () => AsyncIterable<unknown>
    /** The session's permission verdict for an app's tool call. */
    decision?: 'allow' | 'ask' | 'deny'
    /** What the person picks when asked. */
    answer?: string
    /** Whether the view's own tool runs without asking (checked as Claude writes the call). */
    earlyDecision?: 'allow' | 'ask' | 'deny'
    /** The verdict on that call when Claude Code runs it (after the early check). */
    callDecision?: 'allow' | 'deny'
    /** What the helper answers on these routes, in place of `{ ok: true }`. */
    answers?: Record<string, unknown>
    /** What `$.state` held before the session started (a reload of the plugin's code). */
    saved?: unknown
    /** The first picture waits for this. */
    holdFrame?: Promise<unknown>
    /** Discovery answers once this settles. */
    holdDiscover?: Promise<unknown>
    /** The helper's answer to /open waits for this. */
    holdOpen?: Promise<unknown>
    /** Whether the app calls one of its server's tools as it opens (it does, by default). */
    appCall?: boolean
    /** The person's environment, as the helper's ready line reports it. */
    readyEnv?: Record<string, string>
    /** The app's own tool calls answer once this settles. */
    holdAppCall?: Promise<unknown>
    /** The tools ToolSearch loads. */
    searchMatches?: string[]
    /** Whether the app's tool says it only reads (annotations.readOnlyHint). */
    readOnly?: boolean
    /** Claude Code's answer to `$.mcp.connect(server)`; connected under that name by default. */
    connect?: (server: string) => unknown
    /** Runs as the person is asked a question (before they answer). */
    onAsk?: () => void
  } = {},
) {
  const sent: Sent[] = []
  let opened!: () => void
  const isOpened = new Promise<void>((resolve) => (opened = resolve))
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const mcpCalls: Array<{ server: string; tool: string }> = []

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Timers never fire here (discovery always answers first), unless a test
  // wants them to, at once.
  on('clock.sleep', () => (opts.timers ? { value: undefined } : new Promise(() => {})))
  on('ui.log', () => ({ value: undefined }))
  const asked: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'ToolSearch') {
      return { result: { matches: opts.searchMatches ?? [], query: 'select:', total_deferred_tools: 3 } as never }
    }
    if (e.tool !== 'AskUserQuestion') return { result: RESULT }
    const questions = (e as unknown as { questions: Array<{ question: string }> }).questions
    asked.push(questions[0]!.question)
    opts.onAsk?.()
    return { result: { questions, answers: { [questions[0]!.question]: opts.answer ?? 'Deny' } } as never }
  })
  // Commands the mod runs (opening a link) and prompts it submits.
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    runs.push(argv)
    return { value: { exitCode: 0, stdout: argv[0] === 'uname' ? 'Darwin arm64\n' : '', stderr: '' } as never }
  })
  // The plugin carries a helper for this machine.
  on('fs.exists', (_$, e) => ({ value: e.path.includes('/helper/bin/darwin-arm64/') }))
  const submitted: string[] = []
  // The context each submitted prompt carried for the model, out of sight.
  const contexts: (readonly string[])[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    contexts.push(e.context ?? [])
    return { text: e.text, context: e.context } as never
  })
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  // Only for the tool an app asks to run, not the call that opens the view.
  on('tool.check', { tool: 'mcp__vanilla__get-weather' }, () => ({ decision: opts.decision ?? 'ask' }))
  // The view's own tool, asked while Claude writes the call (once).
  if (opts.earlyDecision) {
    let checks = 0
    on('tool.check', { tool: 'mcp__vanilla__get-time' }, () =>
      checks++ === 0
        ? { decision: opts.earlyDecision! }
        : opts.callDecision === 'deny'
          ? { decision: 'deny' as const, reason: 'The user denied it' }
          : { decision: 'allow' as const },
    )
  }
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine row'] })
  })
  let spawns = 0
  on('process.spawn', async function* () {
    spawns++
    // As the helper does, what it says of a view carries the generation of
    // the view's latest /open, unless a test gives one of its own.
    const genOf = (viewId: unknown) => sent.findLast((s) => s.route === '/open' && s.body.viewId === viewId)?.body.gen
    const line = (message: unknown) => {
      const m = message as Record<string, unknown>
      const said = typeof m.viewId === 'string' && !('gen' in m) ? { ...m, gen: genOf(m.viewId) } : m
      return { stream: 'stdout' as const, text: `${JSON.stringify(said)}\n` }
    }
    yield line({ type: 'ready', socket: '/tmp/test.sock', images: opts.images === true, swapEveryDraw: opts.swapEveryDraw, env: opts.readyEnv ?? {} })
    await isOpened
    if (opts.holdFrame) await opts.holdFrame
    yield opts.images
      ? line({ type: 'frame', viewId: TOOL_USE_ID, v: 1, image: { png: PNG, cols: 20, rows: 2 } })
      : line({ type: 'frame', viewId: TOOL_USE_ID, v: 1, frame: FRAME })
    if (opts.appCall !== false) {
      yield line({
        type: 'request',
        id: 7,
        viewId: TOOL_USE_ID,
        method: 'tools/call',
        params: { name: 'get-time', arguments: {} },
      })
    }
    if (opts.script) for await (const message of opts.script()) yield line(message)
    await finished
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const body = JSON.parse(String(e.init?.body ?? '{}')) as Record<string, unknown>
    sent.push({ route, body })
    if (route === '/discover' && opts.holdDiscover) await opts.holdDiscover
    let answer: unknown = { ok: true }
    if (route === '/discover') {
      answer = {
        ok: true,
        tools: { 'get-time': { resourceUri: 'ui://get-time/mcp-app.html' } },
        definitions: {
          'get-time': { name: 'get-time', annotations: { readOnlyHint: opts.readOnly === true } },
          'get-weather': { name: 'get-weather' },
          'poll-stats': { name: 'poll-stats', _meta: { ui: { visibility: ['app'] } } },
        },
      }
    }
    if (route === '/open') {
      opened()
      if (opts.holdOpen) await opts.holdOpen
      answer = { ok: true, mode: body.mode }
    }
    if (opts.answers?.[route] !== undefined) answer = opts.answers[route]
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  // Claude Code's verdict on a server (the mod asks before the helper hears its name).
  const connects: string[] = []
  on('mcp.connect', (_$, e) => {
    connects.push(e.server)
    return { value: (opts.connect?.(e.server) ?? { isConnected: true, server: e.server }) as never }
  })
  on('mcp.call', async (_$, e) => {
    mcpCalls.push({ server: e.server, tool: e.tool })
    if (opts.holdAppCall) await opts.holdAppCall
    return { value: { content: [{ type: 'text', text: 'fresh time' }], isError: false } }
  })
  // What it keeps in the session's state.
  const stateWrites: unknown[] = []
  on('state.get', () => ({ value: opts.saved === undefined ? { value: undefined, version: 0 } : { value: opts.saved, version: 1 } }) as never)
  on('state.set', (_$, e) => {
    stateWrites.push((e as { value: unknown }).value)
    return { value: { isSet: true, version: stateWrites.length + 1 } } as never
  })
  return { sent, mcpCalls, asked, runs, submitted, contexts, filled, copied, finish, stateWrites, connects, spawns: () => spawns }
}


async function until(check: () => boolean, tick: () => Promise<unknown>, tries = 200) {
  for (let i = 0; i < tries && !check(); i++) await tick()
  expect(check()).toBe(true)
}

// A request from the helper runs through several hooks before its reply.
const settle = (check: () => boolean) => until(check, () => Promise.resolve(), 5000)

const ROW = {
  plugin: 'mcp-apps-cli',
  component: 'ToolUse',
  requestId: TOOL_USE_ID,
  props: {
    tool_use_id: TOOL_USE_ID,
    tool: 'mcp__vanilla__get-time',
    input: {},
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

test('the tool result reaches Claude unchanged and the view opens', async ($, on) => {
  const { sent, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  expect(ran.result).toEqual(RESULT)
  // The model is told the app is on screen, in context the user doesn't see.
  expect(ran.context?.some((note) => note.includes('MCP App'))).toBe(true)
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const open = sent.find((s) => s.route === '/open')!
  expect(open.body.server).toBe('vanilla')
  expect(open.body.toolName).toBe('get-time')
  // Opened as the tool started to run: the result follows, unchanged.
  expect(open.body.toolResult).toBeUndefined()
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  expect(sent.find((s) => s.route === '/result')!.body.result).toEqual(RESULT)
  finish()
})

test('a drag reaches the helper whole and in order, its moves sent together', async ($, on) => {
  const { sent, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  }
  await ui.resize({ columns: 80, rows: 10 })
  // A drag: the button held across five moves (a drawing's path), then up.
  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left' })
  for (let x = 3; x <= 7; x++) await ui.pointer({ type: 'move', x, y: 1, button: 'left' })
  await ui.pointer({ type: 'up', x: 7, y: 1, button: 'left' })
  await until(
    () => sent.filter((s) => s.route === '/input').length >= 7,
    () => ui.advance(70),
  )
  const inputs = sent.filter((s) => s.route === '/input').map((s) => s.body.event as Record<string, unknown>)
  expect(inputs.map((e) => `${e.type}:${e.x}`)).toEqual(['down:2', 'move:3', 'move:4', 'move:5', 'move:6', 'move:7', 'up:7'])
  await ui.unmount()
  finish()
})

test('a click and a key on the frame reach the helper in order', async ($, on) => {
  const { sent, mcpCalls, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())

  let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })

  // The Client polls; the hooks module answers with the helper's frame.
  // The helper's frame is drawn as a Raster, with the Client over it.
  let raster: Awaited<ReturnType<typeof ui.find>> = undefined
  for (let i = 0; i < 20 && !raster; i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    raster = await ui.find({ type: 'Raster' })
  }
  expect(raster?.props).toMatchObject({ columns: 2, rows: 1, cells: FRAME.cells })
  expect(await ui.find({ type: 'Client', key: `app-${TOOL_USE_ID}` })).toBeDefined()
  await ui.resize({ columns: 80, rows: 10 })

  // Down and up land in the same frame: the queue keeps both.
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left' })
  await ui.pointer({ type: 'up', x: 3, y: 1, button: 'left' })
  await ui.key({ key: 'a' })
  await until(
    () => sent.filter((s) => s.route === '/input').length >= 3,
    () => ui.advance(150),
  )
  const inputs = sent.filter((s) => s.route === '/input').map((s) => s.body.event as Record<string, unknown>)
  expect(inputs.map((e) => `${e.kind}:${e.type ?? e.key}`)).toEqual(['pointer:down', 'pointer:up', 'key:a'])
  expect(inputs[0]).toMatchObject({ x: 3, y: 1, button: 'left' })

  // The app's own tool call went through Claude Code's connection.
  await until(() => sent.some((s) => s.route === '/reply'), () => ui.advance(50))
  expect(mcpCalls).toEqual([{ server: 'vanilla', tool: 'get-time' }])
  const reply = sent.find((s) => s.route === '/reply')!
  expect(reply.body).toMatchObject({ id: 7, result: { content: [{ type: 'text', text: 'fresh time' }] } })

  await ui.unmount()
  finish()
})

test('outside an interactive terminal session nothing opens', async ($, on) => {
  const { sent, finish } = standIns(on)
  for (const start of [
    { cwd: '/', surface: 'desktop' as const, isInteractive: true },
    { cwd: '/', surface: 'terminal' as const, isInteractive: false },
  ]) {
    await $.session.start(start)
    const ran = await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    expect(ran.result).toEqual(RESULT)
  }
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(sent).toEqual([])
  finish()
})

test('where the terminal shows images, the view is a picture with the Client over it', async ($, on) => {
  const { sent, finish } = standIns(on, { images: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  expect(sent.find((s) => s.route === '/open')!.body.mode).toBe('image')

  let image: Awaited<ReturnType<Awaited<ReturnType<typeof $.ui.mount>>['find']>> = undefined
  for (let i = 0; i < 20 && !image; i++) {
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    image = await ui.find({ type: 'Image' })
    if (image) {
      expect(await ui.find({ type: 'Client', key: `app-${TOOL_USE_ID}` })).toBeDefined()
      // Input still flows from the overlay to the helper.
      await ui.resize({ columns: 80, rows: 10 })
      await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left' })
      await ui.pointer({ type: 'up', x: 2, y: 1, button: 'left' })
      await until(() => sent.filter((s) => s.route === '/input').length >= 2, () => ui.advance(100))
    }
    await ui.unmount()
  }
  expect(image?.props).toMatchObject({ columns: 20, rows: 2, source: { png: PNG } })
  finish()
})

// iTerm2 shows a picture only once a fresh copy is swapped in, each time it
// is drawn; kitty and Ghostty show it at once, and get one swap per view.
for (const [terminal, swapEveryDraw, expected] of [
  ['kitty or Ghostty', false, 1],
  ['iTerm2', true, 3],
] as const) {
  test(`a picture drawn three times in ${terminal} gets ${expected} fresh ${expected === 1 ? 'copy' : 'copies'}`, async ($, on) => {
    const { sent, finish } = standIns(on, { images: true, swapEveryDraw, timers: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
    const refreshes = () => sent.filter((s) => s.route === '/refresh').length
    for (let drawing = 1; drawing <= 3; drawing++) {
      const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
      // Timers fire at once here: a swap due after this drawing is sent within these ticks.
      await settle(() => refreshes() >= Math.min(drawing, expected))
      for (let i = 0; i < 500; i++) await Promise.resolve()
      await ui.unmount()
    }
    // iTerm2: at least one per drawing (the row draws again as its tool ends).
    if (swapEveryDraw) expect(refreshes()).toBeGreaterThanOrEqual(expected)
    else expect(refreshes()).toBe(expected)
    finish()
  })
}

// An idle session paints an in-place swap only once something else on the
// screen changes, so kitty and Ghostty swap a view's first new picture (it
// finds out a terminal drawing the alt text) and draw the rest anew; iTerm2
// shows a picture drawn anew only after a swap, so it keeps swapping.
for (const [terminal, swapEveryDraw, expected] of [
  ['kitty or Ghostty', false, 1],
  ['iTerm2', true, 3],
] as const) {
  test(`three new pictures in ${terminal}: ${expected} swapped in place`, async ($, on) => {
    let mounted!: () => void
    const isMounted = new Promise<void>((resolve) => (mounted = resolve))
    const swaps: unknown[] = []
    on('ui.blit', (_$, e) => {
      swaps.push(e)
      return { value: {} }
    })
    const { sent, finish } = standIns(on, {
      images: true,
      swapEveryDraw,
      script: async function* () {
        await isMounted
        for (let v = 2; v <= 4; v++) yield { type: 'frame', viewId: TOOL_USE_ID, v, image: { png: PNG, cols: 20, rows: 2 } }
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
    let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    for (let i = 0; i < 20 && !(await ui.find({ type: 'Image' })); i++) {
      await ui.unmount()
      ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    }
    mounted()
    for (let i = 0; i < 2000; i++) await Promise.resolve()
    expect(swaps.length).toBe(expected)
    await ui.unmount()
    finish()
  })
}

// kitty and Ghostty on this machine read a picture from a file: a short
// command instead of the PNG through the terminal. Claude Code first asks
// the terminal whether it reads files; a terminal that can't (one over SSH)
// gets PNG bytes again.
for (const [deny, inlined] of [
  ['the terminal has not yet said whether it reads files', false],
  ['a file this terminal cannot read', true],
] as const) {
  test(`a picture from a file, swap refused with "${deny}": ${inlined ? 'back to PNG bytes' : 'drawn from the file'}`, async ($, on) => {
    let mounted!: () => void
    const isMounted = new Promise<void>((resolve) => (mounted = resolve))
    const swaps: Array<{ source?: unknown }> = []
    on('ui.blit', (_$, e) => {
      swaps.push(e as { source?: unknown })
      return { value: { deny } }
    })
    const FILE = '/tmp/mcp-apps-cli-test/view-1-tty-graphics-protocol.png'
    const { sent, finish } = standIns(on, {
      images: true,
      swapEveryDraw: false,
      script: async function* () {
        await isMounted
        yield { type: 'frame', viewId: TOOL_USE_ID, v: 2, image: { file: FILE, generation: 2, cols: 20, rows: 2 } }
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
    let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    for (let i = 0; i < 20 && !(await ui.find({ type: 'Image' })); i++) {
      await ui.unmount()
      ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    }
    mounted()
    await settle(() => swaps.length > 0)
    for (let i = 0; i < 500; i++) await Promise.resolve()
    expect(swaps[0]?.source).toEqual({ file: FILE, format: 'png', generation: 2 })
    expect(sent.some((s) => s.route === '/inline-png')).toBe(inlined)
    if (!inlined) {
      await ui.unmount()
      ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
      expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: FILE, format: 'png', generation: 2 } })
    }
    await ui.unmount()
    finish()
  })
}

// An app's tool call: by default (`rules`) it follows the person's permission
// rules, asking where they would ask (once, if allowed for the session), as
// for Claude's own calls (security review, A2); `ask` always asks; `allow`,
// an opt-in, runs it as Claude Desktop does. Deny rules apply in every mode.
for (const [setting, decision, answer, expected, asks] of [
  [undefined, 'allow', undefined, [true, true], 0],
  [undefined, 'deny', undefined, [false, false], 0],
  [undefined, 'ask', 'Allow get-weather this session', [true, true], 1],
  [undefined, 'ask', 'Deny', [false, false], 2],
  ['rules', 'allow', undefined, [true, true], 0],
  ['rules', 'deny', undefined, [false, false], 0],
  ['rules', 'ask', 'Allow get-weather this session', [true, true], 1],
  ['rules', 'ask', 'Deny', [false, false], 2],
  ['allow', 'ask', undefined, [true, true], 0],
  ['allow', 'deny', undefined, [false, false], 0],
  ['ask', 'allow', 'Allow', [true, true], 2],
] as const) {
  const options: Record<string, string> = setting ? { appToolCalls: setting } : {}
  test(`an app's tool call, setting ${setting ?? 'default'}, rules say ${decision}${answer ? `, answered "${answer}"` : ''}`, { options }, async ($, on) => {
    const request = (id: number) => ({
      type: 'request',
      id,
      viewId: TOOL_USE_ID,
      method: 'ui/allow-tool',
      params: { name: 'get-weather', arguments: { city: 'Paris' } },
    })
    const { sent, asked, finish } = standIns(on, {
      decision,
      answer,
      script: async function* () {
        yield request(21)
        yield request(22)
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    const replies = () => sent.filter((s) => s.route === '/reply' && [21, 22].includes(s.body.id as number))
    await settle(() => replies().length === 2)
    expect(replies().map((r) => (r.body.result as { allow: boolean }).allow)).toEqual([...expected])
    expect(asked.length).toBe(asks)
    finish()
  })
}

// The security review's A8: what an app asks about reaches Claude Code's
// dialogs only as plain text. A tool its server doesn't list is refused
// before anyone is asked; a link carrying terminal control sequences is refused.
for (const [what, name] of [
  ['a tool its server does not list', 'rm-everything'],
  ['a tool name carrying an erase-and-rewrite sequence', 'get-weather\u001b[2K\rThe vanilla app wants to run get-time'],
  ['a tool name carrying OSC 52 (a clipboard write)', 'get-weather\u001b]52;c;Y3VybCB4IHwgc2g=\u0007'],
] as const) {
  for (const setting of [undefined, 'ask'] as const) {
    const options: Record<string, string> = setting ? { appToolCalls: setting } : {}
    test(`${what}: refused, nobody asked (setting ${setting ?? 'default'})`, { options }, async ($, on) => {
      const { sent, asked, mcpCalls, finish } = standIns(on, {
        decision: 'ask',
        answer: 'Allow',
        script: async function* () {
          yield { type: 'request', id: 24, viewId: TOOL_USE_ID, method: 'ui/allow-tool', params: { name, arguments: {} } }
        },
      })
      await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
      await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
      await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 24))
      expect((sent.find((s) => s.body.id === 24)!.body.result as { allow: boolean }).allow).toBe(false)
      expect(asked).toEqual([])
      expect(mcpCalls.some((c) => c.tool === name)).toBe(false)
      finish()
    })
  }
}

for (const [what, url] of [
  ['an OSC 8 hyperlink (shows one address, opens another)', 'https://good.example/\u001b]8;;https://evil.example/\u0007click\u001b]8;;\u0007'],
  ['OSC 52 (writes the clipboard)', 'https://good.example/\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZSB8IHNo\u0007'],
  ['cursor and erase sequences (rewrite the dialog)', 'https://evil.example/\u001b[2K\u001b[1Ghttps://good.example/'],
  ['a C1 control (CSI as one character)', 'https://evil.example/\u009b2K'],
  ['a bidi override', 'https://evil.example/\u202egro.doog'],
] as const) {
  test(`a link carrying ${what} is refused, and nobody is asked`, async ($, on) => {
    const { sent, asked, runs, finish } = standIns(on, {
      answer: 'Open',
      script: async function* () {
        yield appRequest(32, 'ui/open-link', { url })
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 32))
    expect(sent.find((s) => s.route === '/reply' && s.body.id === 32)!.body.result).toEqual({ isError: true })
    expect(asked).toEqual([])
    expect(runs.some((argv) => argv.some((a) => a.includes('evil.example') || a.includes('good.example')))).toBe(false)
    finish()
  })
}

// What an app asks of the host beyond tools: the person decides on links and
// files; a message starts a turn, and says so when it couldn't.
const appRequest = (id: number, method: string, params: Record<string, unknown>) => ({
  type: 'request',
  id,
  viewId: TOOL_USE_ID,
  method,
  params,
})

for (const [answer, opened] of [
  ['Open', true],
  ["Don't open", false],
] as const) {
  test(`a link the app opens, answered "${answer}"`, async ($, on) => {
    const { sent, runs, finish } = standIns(on, {
      answer,
      script: async function* () {
        yield appRequest(31, 'ui/open-link', { url: 'https://example.com/report' })
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 31))
    const reply = sent.find((s) => s.route === '/reply' && s.body.id === 31)!.body.result
    expect(reply).toEqual(opened ? {} : { isError: true })
    expect(runs.some((argv) => argv.includes('https://example.com/report'))).toBe(opened)
    finish()
  })
}

for (const [answer, allow] of [
  ['Save', true],
  ["Don't save", false],
] as const) {
  test(`files the app saves, answered "${answer}"`, async ($, on) => {
    const { sent, asked, finish } = standIns(on, {
      answer,
      script: async function* () {
        yield appRequest(41, 'ui/allow-download', { files: [{ name: 'cohorts.csv', size: 2048 }] })
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 41))
    expect(sent.find((s) => s.route === '/reply' && s.body.id === 41)!.body.result).toEqual({ allow })
    expect(asked[0]).toContain('cohorts.csv (2 KB)')
    finish()
  })
}

// A message from the app reaches Claude only with the person's agreement,
// as in Claude Desktop: asked (the default), or put in their prompt (fill).
for (const [setting, answer, submits, fills, result] of [
  [undefined, 'Send', 1, 0, {}],
  [undefined, "Don't send", 0, 0, { isError: true }],
  ['fill', undefined, 0, 1, {}],
  ['allow', undefined, 1, 0, {}],
] as const) {
  const options: Record<string, string> = setting ? { appMessages: setting } : {}
  test(`a message from the app, setting ${setting ?? 'default'}${answer ? `, answered "${answer}"` : ''}`, { options }, async ($, on) => {
    const session = mock.session(on)
    const { sent, submitted, filled, finish } = standIns(on, {
      answer,
      script: async function* () {
        yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'week view' }] } }
        yield appRequest(51, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'Explain week 3' }] })
        yield appRequest(52, 'ui/message', { role: 'user', content: [] })
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.filter((s) => s.route === '/reply' && [51, 52].includes(s.body.id as number)).length === 2)
    expect(sent.find((s) => s.body.id === 51)!.body.result).toEqual(result)
    // An empty message is refused, whatever the setting.
    expect(sent.find((s) => s.body.id === 52)!.body.result).toEqual({ isError: true })
    expect(submitted).toHaveLength(submits)
    expect(filled).toHaveLength(fills)
    if (submits) {
      expect(submitted[0]).toBe('Message from the vanilla/get-time app:\nExplain week 3')
      // The context the app set goes with it, out of sight: a note the model reads.
      expect(notesOf(session)).toEqual(['Context the vanilla/get-time MCP App view set (ui/update-model-context), its latest:\nweek view'])
    }
    // Filled into the draft, said to be the app's (the person sends it as theirs).
    if (fills) expect(filled[0]).toBe('\n[from the vanilla app] Explain week 3')
    finish()
  })
}

test('text an app copies (clipboardWrite, after a click) reaches the clipboard', async ($, on) => {
  const { copied, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/copy', params: { text: 'week 3: 64%' } }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => copied.length > 0)
  expect(copied).toEqual(['week 3: 64%'])
  finish()
})

test('a picture in strips: drawn band by band, and only a changed band swapped', async ($, on) => {
  let mounted!: () => void
  const isMounted = new Promise<void>((resolve) => (mounted = resolve))
  const swaps: Array<{ key?: string; rows?: number }> = []
  on('ui.blit', (_$, e) => {
    swaps.push(e as { key?: string; rows?: number })
    return { value: {} }
  })
  const band = (i: number, rows: number) => ({ i, rows, png: PNG })
  const { sent, finish } = standIns(on, {
    images: true,
    swapEveryDraw: true,
    script: async function* () {
      yield { type: 'frame', viewId: TOOL_USE_ID, v: 2, image: { cols: 20, rows: 13, strips: [band(0, 6), band(1, 6), band(2, 1)], stripCount: 3 } }
      await isMounted
      yield { type: 'frame', viewId: TOOL_USE_ID, v: 3, image: { cols: 20, rows: 13, strips: [band(1, 6)], stripCount: 3 } }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Image', key: `img-inline-${TOOL_USE_ID}-0` }).catch(() => undefined)); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  }
  const bands = await Promise.all([0, 1, 2].map((i) => ui.find({ type: 'Image', key: `img-inline-${TOOL_USE_ID}-${i}` }).catch(() => undefined)))
  expect(bands.map((b) => b?.props.rows)).toEqual([6, 6, 1])
  mounted()
  await settle(() => swaps.length > 0)
  for (let i = 0; i < 500; i++) await Promise.resolve()
  expect(swaps.map((s) => [s.key?.split('-').pop(), s.rows])).toEqual([['1', 6]])
  await ui.unmount()
  finish()
})

test('when the session ends, open views get their teardown', async ($, on) => {
  const { sent, finish } = standIns(on)
  on('session.end', () => ({ sessionId: 'test' }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  await settle(() => sent.some((s) => s.route === '/result'))
  await $.session.end({ reason: 'clear' } as never)
  await settle(() => sent.some((s) => s.route === '/close'))
  expect(sent.find((s) => s.route === '/close')!.body.viewId).toBe(TOOL_USE_ID)
  finish()
})

// Found by the model (model/AppsViews.tla, Race and RaceBefore): a view's
// /open and /close are separate requests, which the helper matches by view
// id; taken out of order, a close could undo a reopen or leave a page running
// unseen. They go one at a time, the close once the open is answered.
test("a view's /open and /close reach the helper one at a time: the close waits for the open's answer", async ($, on) => {
  let release!: () => void
  const holdOpen = new Promise<void>((resolve) => (release = resolve))
  const { sent, finish } = standIns(on, { holdOpen, appCall: false })
  on('session.end', () => ({ sessionId: 'test' }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  // The session ends while the helper is still opening the view.
  const ending = $.session.end({ reason: 'clear' } as never)
  for (let i = 0; i < 500; i++) await Promise.resolve()
  expect(sent.some((s) => s.route === '/close')).toBe(false)
  release()
  await settle(() => sent.some((s) => s.route === '/close'))
  const order = sent.filter((s) => s.route === '/open' || s.route === '/close').map((s) => s.route)
  expect(order[0]).toBe('/open')
  expect(order.slice(1).every((route) => route === '/close')).toBe(true)
  await ending
  finish()
})

// Found by the model (model/AppsViews.tla, Traffic and TrafficBefore): an
// app's own traffic to its server (a call of its tools, a read of its
// resources) went on after Claude Code stopped using that server. Each is now
// let through only on Claude Code's verdict, asked afresh.
test("an app's calls and reads stop once Claude Code stops using its server", { options: { appToolCalls: 'allow' } }, async ($, on) => {
  let using = true
  let sentSoFar: Sent[] = []
  const answered = (id: number) => sentSoFar.find((s) => s.route === '/reply' && s.body.id === id)
  const { sent, finish } = standIns(on, {
    decision: 'allow',
    appCall: false,
    connect: (server) => (using ? { isConnected: true, server } : { isConnected: false, reason: 'disabled', message: 'switched off' }),
    script: async function* () {
      yield appRequest(41, 'ui/allow-tool', { name: 'get-weather', arguments: {} })
      yield appRequest(42, 'ui/allow-read', { method: 'resources/read' })
      await settle(() => answered(41) !== undefined && answered(42) !== undefined)
      // The person switches the server off in /mcp.
      using = false
      yield appRequest(43, 'ui/allow-tool', { name: 'get-weather', arguments: {} })
      yield appRequest(44, 'ui/allow-read', { method: 'resources/read' })
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => answered(43) !== undefined && answered(44) !== undefined)
  const allow = (id: number) => (answered(id)!.body.result as { allow?: boolean } | undefined)?.allow
  expect([allow(41), allow(42)]).toEqual([true, true])
  expect([allow(43), allow(44)]).toEqual([false, false])
  expect(String((answered(43)!.body.result as { reason?: string }).reason)).toContain('not using the vanilla server')
  finish()
})

// 0.1.2 kept a yes for 5 s and reused it for discovery and opening (the
// model's WindowBefore): a server switched off between the two still got the
// view's /open. No yes is kept now: the /open asks again.
test('no yes is kept: a server switched off after its discovery gets no /open', async ($, on) => {
  let using = true
  let release!: () => void
  const holdDiscover = new Promise<void>((resolve) => (release = resolve))
  const { sent, connects, finish } = standIns(on, {
    holdDiscover,
    appCall: false,
    connect: (server) => (using ? { isConnected: true, server } : { isConnected: false, reason: 'disabled', message: 'switched off' }),
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const calling = $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/discover'))
  // Discovery reached the helper on a yes; the person switches the server off in /mcp.
  using = false
  const asked = connects.length
  release()
  await calling
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(connects.length).toBeGreaterThan(asked)
  expect(sent.some((s) => s.route === '/open')).toBe(false)
  // The helper, which heard of the server, is told: it drops what it has of it.
  expect(sent.find((s) => s.route === '/revoke')?.body).toEqual({ server: 'vanilla', epoch: 1 })
  finish()
})

// Each request the helper writes to a server asks first ('check'): Claude
// Code's verdict then, with the epoch it was given in. A no tells the helper
// (/revoke), and moves the epoch on, so a yes given before it counts for nothing.
test("the helper's check before each request it writes gets Claude Code's verdict then, and its epoch", async ($, on) => {
  let using = true
  let sentSoFar: Sent[] = []
  const answered = (id: number) => sentSoFar.find((s) => s.route === '/reply' && s.body.id === id)?.body.result as
    | { allow?: boolean; epoch?: number }
    | undefined
  const { sent, finish } = standIns(on, {
    appCall: false,
    connect: (server) => (using ? { isConnected: true, server } : { isConnected: false, reason: 'disabled', message: 'switched off' }),
    script: async function* () {
      yield { type: 'check', id: 61, server: 'vanilla' }
      await settle(() => answered(61) !== undefined)
      using = false
      yield { type: 'check', id: 62, server: 'vanilla' }
      await settle(() => answered(62) !== undefined)
      using = true
      yield { type: 'check', id: 63, server: 'vanilla' }
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => answered(63) !== undefined)
  expect(answered(61)).toEqual({ allow: true, epoch: 0 })
  expect(answered(62)?.allow).toBe(false)
  expect(answered(63)).toEqual({ allow: true, epoch: 1 })
  expect(sent.filter((s) => s.route === '/revoke').map((s) => s.body)).toEqual([{ server: 'vanilla', epoch: 1 }])
  finish()
})

// The model's CancelBefore: what the helper had in flight to a server went on
// after Claude Code stopped using it, until some later request asked. While
// the helper waits on a server now, Claude Code is asked again, and a no
// cancels what is in flight.
test('while the helper waits on a server, Claude Code is asked again, and a no cancels what is in flight', { options: {} }, async ($, on) => {
  let using = true
  let sentSoFar: Sent[] = []
  const { sent, finish } = standIns(on, {
    appCall: false,
    timers: true,
    connect: (server) => (using ? { isConnected: true, server } : { isConnected: false, reason: 'disabled', message: 'switched off' }),
    script: async function* () {
      await settle(() => sentSoFar.some((s) => s.route === '/result'))
      yield { type: 'busy', server: 'vanilla', busy: true }
      for (let i = 0; i < 200; i++) await Promise.resolve()
      // Nothing is cancelled while Claude Code still uses it.
      expect(sentSoFar.some((s) => s.route === '/revoke')).toBe(false)
      using = false
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/revoke'))
  expect(sent.find((s) => s.route === '/revoke')!.body.server).toBe('vanilla')
  finish()
})

// 0.1.2 asked Claude Code before the person was asked, then sent the yes: a
// server switched off while the question was on screen still got the call.
test("an app-only tool's yes is asked of Claude Code after the person's yes, right before it goes", { options: { appToolCalls: 'ask' } }, async ($, on) => {
  let using = true
  let sentSoFar: Sent[] = []
  const answered = (id: number) => sentSoFar.find((s) => s.route === '/reply' && s.body.id === id)?.body.result as
    | { allow?: boolean; epoch?: number }
    | undefined
  const { sent, asked, finish } = standIns(on, {
    appCall: false,
    answer: 'Allow',
    // The person is asked; meanwhile the server is switched off in /mcp.
    onAsk: () => (using = false),
    connect: (server) => (using ? { isConnected: true, server } : { isConnected: false, reason: 'disabled', message: 'switched off' }),
    script: async function* () {
      yield appRequest(45, 'ui/allow-tool', { name: 'poll-stats', arguments: {}, appOnly: true })
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => answered(45) !== undefined)
  expect(asked.length).toBe(1)
  expect(answered(45)?.allow).toBe(false)
  finish()
})

// The model's InstanceBefore: requests were matched to a view by its id alone,
// so what the page of an earlier open of the call asked was done for the view
// that stood then. Each open has its own generation now.
test("what an earlier open's page asks is refused, and nothing of it is done for the view that stands now", { options: { appMessages: 'allow' } }, async ($, on) => {
  let sentSoFar: Sent[] = []
  const answered = (id: number) => sentSoFar.find((s) => s.route === '/reply' && s.body.id === id)
  const { sent, submitted, finish } = standIns(on, {
    appCall: false,
    script: async function* () {
      yield { ...appRequest(71, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'from an earlier open' }] }), gen: 'an-earlier-open' }
      yield { type: 'closed', viewId: TOOL_USE_ID, gen: 'an-earlier-open', reason: 'its page crashed' }
      await settle(() => answered(71) !== undefined)
      // The view of this open still stands: its own request is done.
      yield appRequest(72, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'from this open' }] })
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => answered(72) !== undefined)
  expect(answered(71)!.body).toMatchObject({ gen: 'an-earlier-open', error: 'this view was opened again' })
  expect(answered(72)!.body.gen).toBe(sent.find((s) => s.route === '/open')!.body.gen)
  expect(answered(72)!.body.error).toBeUndefined()
  await settle(() => submitted.length > 0)
  expect(submitted.some((text) => text.includes('from an earlier open'))).toBe(false)
  expect(submitted.some((text) => text.includes('from this open'))).toBe(true)
  finish()
})

test('a picture scrolled partly off the top still gets clicks at the right row', async ($, on) => {
  const { sent, finish } = standIns(on, { images: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  // The row: the engine's line, the view's header, then its 2-row picture.
  // Its top 3 rows are scrolled away: the header, the engine's line and one
  // row of the picture, which Claude Code's Client then reads as row 0.
  const scrolled = { ...ROW, props: { ...ROW.props, onScreen: { first: 3, last: 3, of: 4 } } }
  for (let i = 0; i < 20 && !sent.some((s) => s.route === '/input'); i++) {
    const ui = await $.ui.mount({ ...scrolled, surface: 'terminal' })
    if (await ui.find({ type: 'Image' })) {
      await ui.resize({ columns: 80, rows: 10 })
      await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
      await until(() => sent.some((s) => s.route === '/input'), () => ui.advance(100))
    }
    await ui.unmount()
  }
  const event = sent.find((s) => s.route === '/input')!.body.event as { y: number }
  expect(event.y).toBe(1)
  finish()
})

test('a view scrolled out of sight is paused, and drawn again when a row of it is back', async ($, on) => {
  const { sent, finish } = standIns(on, { images: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const at = (onScreen: { first: number; last: number; of: number } | null) => ({ ...ROW, props: { ...ROW.props, onScreen }, surface: 'terminal' as const })
  const shown = () => sent.filter((s) => s.route === '/shown').map((s) => s.body.shown)
  // In sight first (the engine's line, the header, a 2-row picture).
  for (let i = 0; i < 20; i++) {
    const ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
    const drawn = await ui.find({ type: 'Image' })
    await ui.unmount()
    if (drawn) break
  }
  expect(shown()).toEqual([])
  // Only the header rows show: the picture is out of sight.
  let ui = await $.ui.mount(at({ first: 0, last: 1, of: 4 }))
  await settle(() => shown().length === 1)
  await ui.unmount()
  // The whole row is drawn outside the viewport: still paused, nothing new.
  ui = await $.ui.mount(at(null))
  for (let i = 0; i < 200; i++) await Promise.resolve()
  await ui.unmount()
  expect(shown()).toEqual([false])
  // One row of the picture back in sight.
  ui = await $.ui.mount(at({ first: 3, last: 3, of: 4 }))
  await settle(() => shown().length === 2)
  await ui.unmount()
  expect(shown()).toEqual([false, true])
  finish()
})

test('a view fits the screen, and a picture leaves room for the reply under it', async ($, on) => {
  const { sent, finish } = standIns(on, { images: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // An earlier tool row tells the mod the screen is 32 rows tall.
  const earlier = { ...ROW, requestId: 'toolu_earlier', props: { ...ROW.props, tool_use_id: 'toolu_earlier' } }
  const first = await $.ui.mount({ ...earlier, surface: 'terminal', viewport: { columns: 94, rows: 32, isFullscreen: true } })
  await first.unmount()
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  // iTerm2 draws a picture only while it is wholly on screen: 32 - 14 rows.
  expect(sent.find((s) => s.route === '/open')!.body.maxRows).toBe(18)

  // A taller screen resizes the live view.
  const taller = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: { columns: 94, rows: 44, isFullscreen: true } })
  await until(() => sent.some((s) => s.route === '/resize'), () => taller.advance(100))
  expect(sent.find((s) => s.route === '/resize')!.body).toMatchObject({ viewId: TOOL_USE_ID, maxRows: 30 })
  await taller.unmount()
  finish()
})

test('an app can ask to fill the terminal, move to a pane, and come back', async ($, on) => {
  let sentSoFar: Sent[] = []
  const replies = () =>
    sentSoFar.filter((s) => s.route === '/reply' && Number(s.body.id) >= 20).map((s) => s.body)
  let step = 0
  const gate = async () => {
    const at = ++step
    await settle(() => replies().length >= at - 1)
  }
  const ask = (id: number, mode: string) => ({
    type: 'request',
    id,
    viewId: TOOL_USE_ID,
    method: 'ui/request-display-mode',
    params: { mode },
  })
  const { sent, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/app-modes', params: { modes: ['inline', 'fullscreen', 'pip'] } }
      await gate()
      yield ask(20, 'fullscreen')
      await gate()
      yield ask(21, 'pip')
      await gate()
      yield ask(22, 'inline')
    },
  })
  const panes: string[] = []
  on('ui.open', (_$, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const earlier = { ...ROW, requestId: 'toolu_earlier', props: { ...ROW.props, tool_use_id: 'toolu_earlier' } }
  const first = await $.ui.mount({ ...earlier, surface: 'terminal', viewport: { columns: 100, rows: 40, isFullscreen: true } })
  await first.unmount()
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })

  // Fullscreen: the view takes the screen's rows, less the prompt's.
  await settle(() => replies().length >= 1)
  expect(replies()[0]).toMatchObject({ id: 20, result: { mode: 'fullscreen' } })
  await settle(() => sent.some((s) => s.route === '/resize' && s.body.display === 'fullscreen'))
  expect(sent.find((s) => s.route === '/resize' && s.body.display === 'fullscreen')!.body.maxRows).toBe(28)

  // A pane: opened, and the view is drawn there at the pane's size.
  await settle(() => replies().length >= 2)
  expect(replies()[1]).toMatchObject({ id: 21, result: { mode: 'pip' } })
  expect(panes).toEqual([`mcp-app-${TOOL_USE_ID}`])
  const pane = await $.ui.mount({
    plugin: 'mcp-apps-cli',
    component: 'Pane',
    requestId: `mcp-app-${TOOL_USE_ID}`,
    surface: 'terminal',
    props: { title: 'MCP App · get-time', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 20 } as never, view: {} as never },
  } as never)
  await settle(() => sent.some((s) => s.route === '/resize' && s.body.display === 'pip' && s.body.cols === 59))
  expect(sent.filter((s) => s.route === '/resize' && s.body.cols === 59).at(-1)!.body).toMatchObject({ maxRows: 19 })
  expect(await pane.find({ type: 'Client', key: `app-pane-${TOOL_USE_ID}` })).toBeDefined()
  await pane.unmount()

  // Back inline.
  await settle(() => replies().length >= 3)
  expect(replies()[2]).toMatchObject({ id: 22, result: { mode: 'inline' } })
  await settle(() => sent.some((s) => s.route === '/resize' && s.body.display === 'inline'))
  finish()
})

test('a view closed as newer ones opened can be reopened, its call and result with it', async ($, on) => {
  const ids = ['toolu_open_1', 'toolu_open_2', 'toolu_open_3', 'toolu_open_4'] as const
  let sentSoFar: Sent[] = []
  const { sent, finish } = standIns(on, {
    script: async function* () {
      // The first view draws once, so it has a picture to show when closed.
      await settle(() => sentSoFar.some((s) => s.route === '/open'))
      yield { type: 'frame', viewId: ids[0], v: 1, frame: FRAME }
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Three views stay live: the fourth closes the first.
  for (const id of ids) {
    await $.tool.call({ tool: TOOL, tool_use_id: id })
    await settle(() => sent.some((s) => s.route === '/open' && s.body.viewId === id))
  }
  await settle(() => sent.some((s) => s.route === '/close' && s.body.viewId === ids[0]))
  const first = { ...ROW, requestId: ids[0], props: { ...ROW.props, tool_use_id: ids[0] } }
  let ui = await $.ui.mount({ ...first, surface: 'terminal' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Button', key: `reopen-${ids[0]}` }).catch(() => undefined)); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...first, surface: 'terminal' })
  }
  await ui.press({ key: `reopen-${ids[0]}` })
  await settle(() => sent.filter((s) => s.route === '/open' && s.body.viewId === ids[0]).length === 2)
  const [before, again] = sent.filter((s) => s.route === '/open' && s.body.viewId === ids[0]) as [Sent, Sent]
  // The same view (the helper gives back its store) with its tool's result.
  expect(again.body.toolResult).toEqual(RESULT)
  // Each open its own generation; the close was for the first one's page.
  expect(typeof before.body.gen).toBe('string')
  expect(again.body.gen).not.toBe(before.body.gen)
  expect(sent.find((s) => s.route === '/close' && s.body.viewId === ids[0])!.body.gen).toBe(before.body.gen)
  // Three stay live: reopening it closed the oldest of the others.
  await settle(() => sent.some((s) => s.route === '/close' && s.body.viewId === ids[1]))
  await ui.unmount()
  finish()
})

test('only one view in the transcript takes input, the newest or the one chosen', async ($, on) => {
  const SECOND = 'toolu_test_2'
  let sentSoFar: Sent[] = []
  const { sent, finish } = standIns(on, {
    script: async function* () {
      await settle(() => sentSoFar.filter((s) => s.route === '/open').length >= 2)
      yield { type: 'frame', viewId: SECOND, v: 1, frame: FRAME }
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  await $.tool.call({ tool: TOOL, tool_use_id: SECOND })
  const second = { ...ROW, requestId: SECOND, props: { ...ROW.props, tool_use_id: SECOND } }
  const clientOf = async (row: typeof ROW | typeof second, id: string) => {
    let ui = await $.ui.mount({ ...row, surface: 'terminal' })
    let raster = await ui.find({ type: 'Raster' })
    for (let i = 0; i < 20 && !raster; i++) {
      await ui.unmount()
      ui = await $.ui.mount({ ...row, surface: 'terminal' })
      raster = await ui.find({ type: 'Raster' })
    }
    expect(raster).toBeDefined()
    return { ui, client: await ui.find({ type: 'Client', key: `app-${id}` }) }
  }
  // The newer view has the input layer; the older one is drawn, view only.
  const older = await clientOf(ROW, TOOL_USE_ID)
  expect(older.client).toBeUndefined()
  const newer = await clientOf(second, SECOND)
  expect(newer.client).toBeDefined()
  await newer.ui.unmount()
  // Choosing the older one moves the input layer there.
  await older.ui.press({ key: `use-${TOOL_USE_ID}` })
  await older.ui.unmount()
  expect((await clientOf(ROW, TOOL_USE_ID)).client).toBeDefined()
  expect((await clientOf(second, SECOND)).client).toBeUndefined()
  finish()
})

// Claude writing the call that opens a view: the model's response streams
// through turn.step, the call's arguments in pieces of JSON.
const STEP = { turnId: 'turn-1', index: 0, model: 'test', messageCount: 1 }

// Real time between pieces (the mod sends a copy every 100 ms at most).
const wait = (ms: number) =>
  new Promise<void>((resolve) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(resolve, ms))

function writes(on: On, pieces: string[], pause = 0) {
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'Getting the time.' } as never
    yield { kind: 'tool', index: 1, id: TOOL_USE_ID, name: 'mcp__vanilla__get-time' } as never
    for (const json of pieces) {
      if (pause) await wait(pause)
      yield { kind: 'input', index: 1, json } as never
    }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null } as never
    return { turnId: STEP.turnId, index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Read to the end, as the engine does.
  }
}

const argsSent = (sent: Sent[]) =>
  sent
    .filter((s) => s.route === '/args')
    .map((s) => ({ ...(s.body.arguments as Record<string, unknown>), partial: s.body.partial }) as Record<string, unknown>)

test('a call Claude is still writing opens its view, the arguments follow as written, then whole', async ($, on) => {
  const { sent, mcpCalls, finish } = standIns(on, { earlyDecision: 'allow' })
  // A cut-off string, a member cut off before its value, then whole.
  writes(on, ['{"tz": "Eur', 'ope/Pa', 'ris", "fmt": tr', 'ue, "note": "a \\u00e9', '9 b"}'], 120)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  await settle(() => sent.some((s) => s.route === '/open'))
  const open = sent.find((s) => s.route === '/open')!
  // Opened before the call ran: no arguments yet, and none taken as whole.
  expect(open.body.streaming).toBe(true)
  expect(open.body.toolInput).toBeUndefined()
  const partial = { tz: 'Europe/Paris', fmt: true, note: 'a é9 b' }
  await settle(() => argsSent(sent).some((a) => a.note === partial.note))
  const partials = argsSent(sent)
  expect(partials.every((a) => a.partial === true)).toBe(true)
  // Each copy is valid as far as it goes: the cut-off string closed, the
  // member with no value yet left out, the cut-off escape dropped.
  for (const a of partials) {
    expect(typeof a.tz).toBe('string')
    expect(partial.tz.startsWith(a.tz as string)).toBe(true)
    if ('fmt' in a) expect(a.fmt).toBe(true)
  }
  // What the app asks waits for the call to be allowed.
  expect(mcpCalls).toEqual([])
  expect(sent.some((s) => s.route === '/reply')).toBe(false)
  // Claude Code runs it: the whole arguments, then the result, in that order.
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID, ...partial } as never)
  await settle(() => sent.some((s) => s.route === '/result'))
  const whole = sent.findIndex((s) => s.route === '/args' && s.body.partial === false)
  expect(whole).toBeGreaterThan(-1)
  expect(sent[whole]!.body.arguments).toEqual(partial)
  expect(whole).toBeLessThan(sent.findIndex((s) => s.route === '/result'))
  expect(sent.filter((s) => s.route === '/open').length).toBe(1)
  // And the app's own request goes through now.
  await settle(() => mcpCalls.length > 0)
  finish()
})

test('a call that would ask first: its app loads early, but gets no arguments until the call is allowed', async ($, on) => {
  const { sent, mcpCalls, finish } = standIns(on, { earlyDecision: 'ask' })
  writes(on, ['{"tz": "Eur', 'ope/Paris"}'], 120)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  await settle(() => sent.some((s) => s.route === '/open'))
  const open = sent.find((s) => s.route === '/open')!
  expect(open.body.streaming).toBe(true)
  expect(open.body.partialInput).toBeUndefined()
  for (let i = 0; i < 200; i++) await Promise.resolve()
  // Nothing of what Claude wrote, and nothing it asks of the host goes through.
  expect(sent.some((s) => s.route === '/args')).toBe(false)
  expect(mcpCalls).toEqual([])
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID, tz: 'Europe/Paris' } as never)
  await settle(() => sent.some((s) => s.route === '/result'))
  // Allowed: all the arguments at once (never a partial copy), then the result.
  expect(argsSent(sent)).toEqual([{ tz: 'Europe/Paris', partial: false }])
  await settle(() => mcpCalls.length > 0)
  finish()
})

test('a call that would ask, then denied: its early view goes, and keeps nothing', async ($, on) => {
  const { sent, mcpCalls, finish } = standIns(on, { earlyDecision: 'ask', callDecision: 'deny' })
  writes(on, ['{"tz": "UTC"}'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  await settle(() => sent.some((s) => s.route === '/open'))
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID, tz: 'UTC' } as never)
  await settle(() => sent.some((s) => s.route === '/close'))
  expect(sent.find((s) => s.route === '/close')!.body.discard).toBe(true)
  expect(sent.some((s) => s.route === '/args' || s.route === '/cancel')).toBe(false)
  await settle(() => sent.some((s) => s.route === '/reply'))
  expect(mcpCalls).toEqual([])
  finish()
})

test("a call its rules deny opens nothing early", async ($, on) => {
  const { sent, finish } = standIns(on, { earlyDecision: 'deny' })
  writes(on, ['{"tz": "UTC"}'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(sent.some((s) => s.route === '/open')).toBe(false)
  // Chrome starts all the same; with no tab readied, as the server isn't
  // known yet to have apps.
  expect(sent.some((s) => s.route === '/prewarm')).toBe(true)
  expect(sent.find((s) => s.route === '/prewarm')!.body).toEqual({})
  finish()
})

test('the helper starts with the first MCP call, not with the session', async ($, on) => {
  const { sent, finish, spawns } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(spawns()).toBe(0)
  expect(sent.length).toBe(0)
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/discover'))
  expect(spawns()).toBe(1)
  finish()
})

// The security review's A1: the helper hears nothing of a server Claude Code
// doesn't use in this session under that very name, so it can't start,
// connect to or send anything to it: not as Claude writes the call, not when
// ToolSearch loads its tool, not when the call runs.
for (const [what, answer] of [
  ['not approved (a repository server)', { isConnected: false, reason: 'unapproved', message: 'Not approved' }],
  ['switched off', { isConnected: false, reason: 'disabled', message: 'Disabled' }],
  ['refused by policy', { isConnected: false, reason: 'policy', message: 'Policy' }],
  ['unknown to the session', { isConnected: false, reason: 'unlisted', message: 'Unlisted' }],
  ['waiting for a sign-in', { isConnected: false, reason: 'auth', message: 'Needs sign-in' }],
  ['running under another name (a claude.ai connector)', { isConnected: true, server: 'claude.ai Vanilla' }],
] as const) {
  test(`a server Claude Code reports as ${what}: the helper hears nothing of it, and nothing opens`, async ($, on) => {
    const { sent, connects, spawns, finish } = standIns(on, { connect: () => answer, searchMatches: ['mcp__vanilla__get-time'] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'ToolSearch', query: 'select:mcp__vanilla__get-time', max_results: 1 } as never)
    const ran = await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    // Claude's own call is untouched, and the model isn't told of an app.
    expect(ran.result).toEqual(RESULT)
    expect(ran.context?.some((note) => note.includes('MCP App')) ?? false).toBe(false)
    for (let i = 0; i < 500; i++) await Promise.resolve()
    expect(connects).toContain('vanilla')
    expect(sent).toEqual([])
    expect(spawns()).toBe(0)
    finish()
  })
}

test('a server Claude Code reports as connected under its own name gets its discovery and view', async ($, on) => {
  const { sent, connects, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  expect(connects.every((name) => name === 'vanilla')).toBe(true)
  // Asked before the helper heard the name.
  expect(sent.find((s) => s.body.server === 'vanilla')).toBeDefined()
  finish()
})

test('a view whose Chrome stopped says so, and can be opened again', async ($, on) => {
  const { sent, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'closed', viewId: TOOL_USE_ID, reason: 'Chrome stopped' }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  let said = false
  for (let i = 0; i < 60 && !said; i++) {
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    said = (await ui.find({ type: 'Text', text: /closed: Chrome stopped/ })) !== undefined
    if (said) {
      expect(await ui.find({ type: 'Button', key: `reopen-${TOOL_USE_ID}` })).toBeDefined()
      const opens = sent.filter((s) => s.route === '/open').length
      await ui.press({ key: `reopen-${TOOL_USE_ID}` })
      await settle(() => sent.filter((s) => s.route === '/open').length > opens)
    }
    await ui.unmount()
  }
  expect(said).toBe(true)
  finish()
})

test('a view opened early whose call is denied is cancelled, and what it asked is refused', async ($, on) => {
  const { sent, mcpCalls, finish } = standIns(on, { earlyDecision: 'allow', callDecision: 'deny' })
  writes(on, ['{"tz": "UTC"}'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  await settle(() => sent.some((s) => s.route === '/open'))
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID, tz: 'UTC' } as never)
  await settle(() => sent.some((s) => s.route === '/cancel'))
  expect(String(sent.find((s) => s.route === '/cancel')!.body.reason)).toContain('The user denied it')
  await settle(() => sent.some((s) => s.route === '/reply'))
  expect(String(sent.find((s) => s.route === '/reply')!.body.error)).toContain('did not run')
  expect(mcpCalls).toEqual([])
  finish()
})

test('a call Claude never finished: its view goes when the turn ends', async ($, on) => {
  const { sent, finish } = standIns(on, { earlyDecision: 'allow' })
  writes(on, ['{"tz": "Eu'])
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(STEP))
  await settle(() => sent.some((s) => s.route === '/open'))
  await $.turn.complete({ turnId: STEP.turnId, answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  // Never drawn in the transcript (no row for it): closed outright.
  await settle(() => sent.some((s) => s.route === '/close'))
  finish()
})

test('a theme change in Claude Code reaches open views', async ($, on) => {
  const { sent, finish } = standIns(on)
  on('config.set', (_$, e) => ({ value: e.value }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  await $.config.set({ key: 'theme', value: 'light-daltonized', previous: 'dark' } as never)
  await settle(() => sent.some((s) => s.route === '/theme'))
  expect(sent.find((s) => s.route === '/theme')!.body).toEqual({ viewId: TOOL_USE_ID, theme: 'light', gen: sent.find((s) => s.route === '/open')!.body.gen })
  // Another setting changes nothing.
  await $.config.set({ key: 'verbose', value: true, previous: false } as never)
  for (let i = 0; i < 100; i++) await Promise.resolve()
  expect(sent.filter((s) => s.route === '/theme').length).toBe(1)
  finish()
})

test('the app gets Escape from ctrl+] and from the esc control (Claude Code keeps Escape itself)', async ($, on) => {
  const { sent, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  }
  await ui.resize({ columns: 80, rows: 10 })
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left' })
  await ui.key({ key: ']', ctrl: true })
  await ui.key({ key: 'x' })
  await until(() => sent.filter((s) => s.route === '/input').length >= 3, () => ui.advance(150))
  const keys = sent
    .filter((s) => s.route === '/input')
    .map((s) => s.body.event as Record<string, unknown>)
    .filter((e) => e.kind === 'key')
  expect(keys.map((e) => e.key)).toEqual(['escape', 'x'])
  await ui.press({ key: `esc-${TOOL_USE_ID}` })
  await settle(() => sent.filter((s) => s.route === '/input' && (s.body.event as { key?: string }).key === 'escape').length === 2)
  await ui.unmount()
  finish()
})

test("a picture's alt says what the app shows, for a screen reader, with no control characters", async ($, on) => {
  const { sent, finish } = standIns(on, {
    images: true,
    script: async function* () {
      yield { type: 'describe', viewId: TOOL_USE_ID, text: 'System Monitor. Stop (button)\u001b]0;owned\u0007 ‮CPU' }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  let alt = ''
  for (let i = 0; i < 40 && !alt.includes('System Monitor'); i++) {
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
    alt = String((await ui.find({ type: 'Image' }))?.props.alt ?? '')
    await ui.unmount()
  }
  expect(alt).toContain('MCP App get-time: System Monitor. Stop (button)')
  expect(alt).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/)
  finish()
})

test("a deny rule outranks an app's tool allowed for the session earlier", { options: { appToolCalls: 'rules' } }, async ($, on) => {
  const request = (id: number) => appRequest(id, 'ui/allow-tool', { name: 'get-weather', arguments: { city: 'Paris' } })
  let allowNext!: () => void
  const granted = new Promise<void>((resolve) => (allowNext = resolve))
  const opts: { decision: 'ask' | 'deny'; answer: string; script: () => AsyncIterable<unknown> } = {
    decision: 'ask',
    answer: 'Allow get-weather this session',
    script: async function* () {
      yield request(61)
      await granted
      yield request(62)
    },
  }
  const { sent, finish } = standIns(on, opts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 61))
  // The person's rules now deny it: the session's grant doesn't stand over that.
  opts.decision = 'deny'
  allowNext()
  await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 62))
  const allow = (id: number) => (sent.find((s) => s.route === '/reply' && s.body.id === id)!.body.result as { allow: boolean }).allow
  expect([allow(61), allow(62)]).toEqual([true, false])
  finish()
})

test('pictures of a new size, before it is drawn, are drawn anew, not swapped and refused', async ($, on) => {
  let mounted!: () => void
  const isMounted = new Promise<void>((resolve) => (mounted = resolve))
  const swaps: Array<{ columns: number }> = []
  on('ui.blit', (_$, e) => {
    swaps.push(e as unknown as { columns: number })
    return { value: {} }
  })
  const { sent, finish } = standIns(on, {
    images: true,
    swapEveryDraw: true,
    script: async function* () {
      await isMounted
      // Resized (the real width): three pictures at 30 columns, none drawn yet.
      for (let v = 2; v <= 4; v++) yield { type: 'frame', viewId: TOOL_USE_ID, v, image: { png: PNG, cols: 30, rows: 2 } }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Image' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  }
  // Drawn at 20 columns; no redraw happens until the test draws again.
  mounted()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(swaps.filter((swap) => swap.columns === 30)).toEqual([])
  // Drawn at the new size: the next picture is swapped in.
  await ui.unmount()
  ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props.columns).toBe(30)
  await ui.unmount()
  finish()
})

test('a view out of sight gets no fresh copies (they would wake its paused page); back in sight, one at once', { timeoutMs: 15000 }, async ($, on) => {
  const { sent, finish } = standIns(on, { images: true, timers: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/open'))
  const at = (onScreen: { first: number; last: number; of: number } | null) => ({ ...ROW, props: { ...ROW.props, onScreen }, surface: 'terminal' as const })
  const refreshes = () => sent.filter((s) => s.route === '/refresh').length
  for (let i = 0; i < 20; i++) {
    const ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
    const drawn = await ui.find({ type: 'Image' })
    await ui.unmount()
    if (drawn) break
  }
  // Out of sight, drawn again and again (as the transcript redraws).
  let ui = await $.ui.mount(at({ first: 0, last: 1, of: 4 }))
  await settle(() => sent.some((s) => s.route === '/shown' && s.body.shown === false))
  await ui.unmount()
  for (let i = 0; i < 200; i++) await Promise.resolve()
  const before = refreshes()
  for (let n = 0; n < 2; n++) {
    ui = await $.ui.mount(at(null))
    for (let i = 0; i < 50; i++) await Promise.resolve()
    await ui.unmount()
  }
  expect(refreshes()).toBe(before)
  // Back in sight: a fresh copy on that drawing.
  ui = await $.ui.mount(at({ first: 3, last: 3, of: 4 }))
  await settle(() => refreshes() > before)
  await ui.unmount()
  finish()
})

// An app-only tool (`visibility: ["app"]`) isn't registered with Claude Code,
// so its permission check has nothing to go on and fails. A check that fails
// is no verdict: the person is asked, whatever the setting (security review, A2).
for (const [setting, appOnly, expected, asks] of [
  [undefined, true, false, 1],
  [undefined, false, false, 1],
  ['rules', true, false, 1],
  ['allow', true, false, 1],
  ['allow', false, false, 1],
] as const) {
  const options: Record<string, string> = setting ? { appToolCalls: setting } : {}
  test(`a tool the check can't judge, setting ${setting ?? 'default'}, ${appOnly ? 'app-only' : 'one of Claude\'s'}: ${expected ? 'runs' : 'asked'}`, { options }, async ($, on) => {
    on('tool.check', { tool: 'mcp__vanilla__poll-stats' }, () => {
      throw new Error('no such tool')
    })
    const { sent, asked, finish } = standIns(on, {
      answer: 'Deny',
      script: async function* () {
        yield { type: 'request', id: 71, viewId: TOOL_USE_ID, method: 'ui/allow-tool', params: { name: 'poll-stats', arguments: {}, appOnly } }
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 71))
    expect((sent.find((s) => s.route === '/reply' && s.body.id === 71)!.body.result as { allow: boolean }).allow).toBe(expected)
    expect(asked.length).toBe(asks)
    finish()
  })
}

// The helper the plugin carries for this machine (helper/bin/<os>-<arch>/):
// Windows by its environment even where a Unix uname answers (Git for
// Windows'), the rest by uname. A machine it carries none for: no helper
// runs, nothing is fetched, and one toast says why.
const CARRIED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']
function helperStandIns(
  on: On,
  opts: {
    uname?: string
    env?: Record<string, string>
    /** What `test -x` answers per path ending (the default: executable). */
    executable?: (path: string) => boolean
    /** The stats of the plugin's binary and of a copy made before, by path ending. */
    stats?: Record<string, { size: number; mtimeMs: number }>
    /** Whether `cmp` finds the copy made before the same as the plugin's binary (the default: yes). */
    identical?: boolean
    /** Which commands fail (exit 1). */
    failing?: (argv: string[]) => boolean
    /** The helper exits before it's ready. */
    exitsEarly?: boolean
  } = {},
) {
  const argvs: string[][] = []
  const runs: string[][] = []
  const toasts: string[] = []
  let end!: () => void
  const ended = new Promise<void>((resolve) => (end = resolve))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined }
  })
  on('tool.call', () => ({ result: RESULT }))
  // The server is one Claude Code uses (see the A1 tests).
  on('mcp.connect', (_$, e) => ({ value: { isConnected: true, server: e.server } as never }))
  on('process.hookEnv', () => ({ value: (opts.env ?? {}) as never }))
  on('process.run', (_$, e) => {
    const argv = [...(e as unknown as { argv: string[] }).argv]
    runs.push(argv)
    if (argv[0] === 'uname') {
      if (opts.uname === undefined) throw new Error('no such command')
      return { value: { exitCode: 0, stdout: `${opts.uname}\n`, stderr: '' } as never }
    }
    if (argv[0] === 'test') return { value: { exitCode: (opts.executable ?? (() => true))(argv[2]!) ? 0 : 1, stdout: '', stderr: '' } as never }
    if (argv[0] === 'cmp') return { value: { exitCode: opts.identical === false ? 1 : 0, stdout: '', stderr: '' } as never }
    if (opts.failing?.(argv)) return { value: { exitCode: 1, stdout: '', stderr: 'No space left on device' } as never }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('fs.exists', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return { value: CARRIED.some((key) => path.endsWith(`/helper/bin/${key}/mcp-apps-cli-helper${key.startsWith('win32') ? '.exe' : ''}`)) }
  })
  on('fs.stat', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    const found = Object.entries(opts.stats ?? {}).find(([ending]) => path.endsWith(ending))
    if (!found) throw new Error('no such file')
    return { value: { kind: 'file', isLink: false, ...found[1] } as never }
  })
  on('process.spawn', async function* (_$, e) {
    argvs.push([...(e as unknown as { argv: string[] }).argv])
    if (opts.exitsEarly) return { value: { code: 1, signal: null } }
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'ready', socket: '/tmp/test.sock', token: 't' })}\n` }
    await ended
    return { value: { code: 0, signal: null } }
  })
  const routes: string[] = []
  on('http.fetch', (_$, e) => {
    routes.push(new URL(String((e as unknown as { url: string }).url)).pathname)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, tools: {} }) } }
  })
  return { argvs, runs, toasts, routes, end }
}

for (const [uname, env, expected] of [
  ['Darwin arm64', {}, 'darwin-arm64/mcp-apps-cli-helper'],
  ['Darwin x86_64', {}, 'darwin-x64/mcp-apps-cli-helper'],
  ['Linux aarch64', {}, 'linux-arm64/mcp-apps-cli-helper'],
  ['Linux x86_64', {}, 'linux-x64/mcp-apps-cli-helper'],
  ['MINGW64_NT-10.0-26100 x86_64', { OS: 'Windows_NT' }, 'win32-x64/mcp-apps-cli-helper.exe'],
  [undefined, { OS: 'Windows_NT' }, 'win32-x64/mcp-apps-cli-helper.exe'],
  ['MSYS_NT-10.0-26100 x86_64', {}, 'win32-x64/mcp-apps-cli-helper.exe'],
] as const) {
  test(`helper: uname ${uname ?? 'missing'}${env.OS ? ', OS=Windows_NT' : ''} → ${expected}`, async ($, on) => {
    const { argvs, runs, toasts, end } = helperStandIns(on, { uname, env })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => argvs.length > 0)
    expect(argvs[0]!.length).toBe(1)
    expect(argvs[0]![0]!.endsWith(`/helper/bin/${expected}`)).toBe(true)
    // Runnable as installed: nothing copied; on Windows nothing checked.
    expect(runs.some((argv) => argv[0] === 'cp')).toBe(false)
    if (expected.startsWith('win32')) expect(runs.some((argv) => argv[0] === 'test')).toBe(false)
    expect(toasts).toEqual([])
    end()
  })
}

for (const uname of ['Linux armv7l', 'FreeBSD amd64', undefined] as const) {
  test(`helper: none carried for ${uname ?? 'a machine with no uname'} → no helper, nothing fetched, one toast says so`, async ($, on) => {
    const { argvs, runs, toasts } = helperStandIns(on, { uname })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => toasts.length > 0)
    // Another MCP call later: no second toast.
    void $.tool.call({ tool: TOOL, tool_use_id: `${TOOL_USE_ID}-2` })
    for (let i = 0; i < 300; i++) await Promise.resolve()
    expect(argvs).toEqual([])
    expect(runs.every((argv) => argv[0] === 'uname')).toBe(true)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('no helper for this machine')
  })
}

test('helper: it exits before it is ready → one toast with the reason, no other helper runs', async ($, on) => {
  const { argvs, toasts } = helperStandIns(on, { uname: 'Darwin arm64', exitsEarly: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => toasts.length > 0)
  void $.tool.call({ tool: TOOL, tool_use_id: `${TOOL_USE_ID}-2` })
  for (let i = 0; i < 300; i++) await Promise.resolve()
  expect(argvs.every((argv) => argv.length === 1 && argv[0]!.endsWith('/helper/bin/darwin-arm64/mcp-apps-cli-helper'))).toBe(true)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain("helper didn't start")
})

// A binary that lost its executable bit on the way (an archive keeping no
// modes): copied into the plugin's data folder, marked executable, run from
// there; copied once, not again while the copy is the plugin's binary byte
// for byte. An earlier release's copy (same size and time: every release's
// files have the same time) is replaced, never run.
const BIN = '/helper/bin/darwin-arm64/mcp-apps-cli-helper'
const COPY = '/data/helper-bin/darwin-arm64/mcp-apps-cli-helper'
const READS = ['uname', 'test', 'cmp']
for (const [label, copiedBefore, identical] of [
  ['not copied before → copied, made executable, run from the data folder', false, true],
  ['copied before, the same bytes → run from there, nothing copied', true, true],
  ["copied before by an earlier release (same size and time, other bytes) → copied again", true, false],
] as const) {
  test(`helper: the plugin's binary isn't executable; ${label}`, async ($, on) => {
    const { argvs, runs, toasts, end } = helperStandIns(on, {
      uname: 'Darwin arm64',
      env: { CLAUDE_PLUGIN_DATA: '/data' },
      executable: (path) => path === COPY && copiedBefore,
      stats: { [BIN]: { size: 8, mtimeMs: 5 }, ...(copiedBefore ? { [COPY]: { size: 8, mtimeMs: 5 } } : {}) },
      identical,
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => argvs.length > 0)
    expect(argvs[0]).toEqual([COPY])
    const compared = runs.find((argv) => argv[0] === 'cmp')
    if (copiedBefore) {
      expect(compared![1]).toBe('-s')
      expect(compared![2]!.endsWith(BIN)).toBe(true)
      expect(compared![3]).toBe(COPY)
    }
    const changes = runs.filter((argv) => !READS.includes(argv[0]!))
    if (copiedBefore && identical) expect(changes).toEqual([])
    else {
      expect(changes.map((argv) => argv[0])).toEqual(['mkdir', 'chmod', 'cp', 'chmod', 'mv'])
      expect(changes[1]).toEqual(['chmod', '700', '/data', '/data/helper-bin', '/data/helper-bin/darwin-arm64'])
      const temporary = changes[2]![3]!
      expect(changes[2]!.slice(0, 2)).toEqual(['cp', '-p'])
      expect(changes[2]![2]!.endsWith(BIN)).toBe(true)
      // A name of its own: not just the moment (two sessions copying at once).
      expect(/^\/data\/helper-bin\/darwin-arm64\/\.copy-[0-9a-f-]{36}$/.test(temporary)).toBe(true)
      expect(changes[3]).toEqual(['chmod', '755', temporary])
      expect(changes[4]).toEqual(['mv', '-f', temporary, COPY])
    }
    expect(toasts).toEqual([])
    end()
  })
}

const FAILING = {
  cp: (argv: string[]) => argv[0] === 'cp',
  chmod: (argv: string[]) => argv[0] === 'chmod' && argv[1] === '755',
  mv: (argv: string[]) => argv[0] === 'mv',
}
for (const failing of ['cp', 'chmod', 'mv'] as const) {
  test(`helper: making the copy fails at ${failing} → its temporary removed, no helper, one toast`, async ($, on) => {
    const { argvs, runs, toasts } = helperStandIns(on, {
      uname: 'Darwin arm64',
      env: { CLAUDE_PLUGIN_DATA: '/data' },
      executable: () => false,
      stats: { [BIN]: { size: 8, mtimeMs: 5 } },
      failing: FAILING[failing],
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => toasts.length > 0)
    expect(argvs).toEqual([])
    const temporary = runs.find((argv) => argv[0] === 'cp')![3]!
    expect(runs.at(-1)).toEqual(['rm', '-f', temporary])
    expect(toasts[0]).toContain('making the helper executable')
  })
}

test("helper: the plugin's binary isn't executable and there's no data folder → no helper, one toast", async ($, on) => {
  const { argvs, toasts } = helperStandIns(on, { uname: 'Linux x86_64', executable: () => false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  void $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => toasts.length > 0)
  expect(argvs).toEqual([])
  expect(toasts[0]).toContain("isn't executable")
})

// A view long out of sight (here at once: timers fire at once) that the
// person never used sleeps: it closes, its picture kept; back in sight it
// opens again from the same call, its old picture drawn until the new one.
// One they clicked into stays open.
for (const used of [false, true]) {
  test(`a view out of sight ${used ? 'that the person used stays open' : 'sleeps, and wakes when back in sight'}`, async ($, on) => {
    const { sent, finish } = standIns(on, { timers: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
    const at = (onScreen: { first: number; last: number; of: number } | null) => ({ ...ROW, props: { ...ROW.props, onScreen }, surface: 'terminal' as const })
    let ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
    for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
      await ui.unmount()
      ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
    }
    if (used) {
      await ui.resize({ columns: 80, rows: 10 })
      await ui.key({ key: 'a' })
      await until(() => sent.some((s) => s.route === '/input'), () => ui.advance(150))
    }
    await ui.unmount()
    // Out of sight.
    ui = await $.ui.mount(at(null))
    await settle(() => sent.some((s) => s.route === '/shown' && s.body.shown === false))
    for (let i = 0; i < 300; i++) await Promise.resolve()
    await ui.unmount()
    const closes = () => sent.filter((s) => s.route === '/close' && s.body.viewId === TOOL_USE_ID).length
    const opens = () => sent.filter((s) => s.route === '/open' && s.body.viewId === TOOL_USE_ID).length
    if (used) {
      expect(closes()).toBe(0)
      finish()
      return
    }
    await settle(() => closes() === 1)
    expect(sent.find((s) => s.route === '/close')!.body.discard).toBeUndefined()
    // Back in sight: opened again, the old picture shown meanwhile.
    ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    await ui.unmount()
    await settle(() => opens() === 2)
    finish()
  })
}

// F11: a view out of sight while its app waits on an answer (its own tool
// call here, or a question to the person) doesn't sleep under it, where the
// answer would be refused; once it's in, the view sleeps as any other.
test('a view out of sight sleeps only once its app has its answers', async ($, on) => {
  let answer!: () => void
  const held = new Promise<void>((resolve) => (answer = resolve))
  const { sent, finish } = standIns(on, { timers: true, holdAppCall: held })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const at = (onScreen: { first: number; last: number; of: number } | null) => ({ ...ROW, props: { ...ROW.props, onScreen }, surface: 'terminal' as const })
  let ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount(at({ first: 0, last: 3, of: 4 }))
  }
  await ui.unmount()
  ui = await $.ui.mount(at(null))
  await settle(() => sent.some((s) => s.route === '/shown' && s.body.shown === false))
  await ui.unmount()
  const closes = () => sent.filter((s) => s.route === '/close' && s.body.viewId === TOOL_USE_ID).length
  // Its timer has fired (timers fire at once here) with the app's call open.
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(closes()).toBe(0)
  answer()
  await settle(() => sent.some((s) => s.route === '/reply'))
  await settle(() => closes() === 1)
  finish()
})

// Claude loads a deferred MCP tool through ToolSearch just before it calls
// it: one with an app gets discovery and Chrome started then; one without
// gets discovery alone, and a tool that isn't an MCP tool gets nothing.
for (const [what, matches, prewarm] of [
  ['an MCP tool with an app', ['mcp__vanilla__get-time'], true],
  ['an MCP tool without one', ['mcp__vanilla__get-weather'], false],
  ['a tool that is not an MCP tool', ['WebFetch'], false],
] as const) {
  test(`ToolSearch loading ${what} starts ${prewarm ? 'discovery and Chrome' : what.startsWith('a tool') ? 'nothing' : 'discovery alone'}`, async ($, on) => {
    const { sent, finish } = standIns(on, { searchMatches: [...matches] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'ToolSearch', query: `select:${matches[0]}`, max_results: 1 } as never)
    const routes = () => sent.map((s) => s.route)
    if (what.startsWith('a tool')) {
      for (let i = 0; i < 300; i++) await Promise.resolve()
      expect(routes()).toEqual([])
    } else {
      await settle(() => routes().includes('/discover'))
      expect(sent.find((s) => s.route === '/discover')!.body.server).toBe('vanilla')
      if (prewarm) {
        await settle(() => routes().includes('/prewarm'))
        // The names alone, for the helper to ready a tab and read the UI ahead.
        const body = sent.find((s) => s.route === '/prewarm')!.body
        expect(body.server).toBe('vanilla')
        expect(body.tool).toBe('get-time')
        expect(Object.keys(body).sort()).toEqual(['server', 'theme', 'tool'])
      } else {
        for (let i = 0; i < 300; i++) await Promise.resolve()
        expect(routes()).not.toContain('/prewarm')
      }
    }
    // Nothing opened: no call was made yet.
    expect(routes()).not.toContain('/open')
    finish()
  })
}

// An app that asks the same thing twice as it loads: for a tool that only
// reads, the two calls in flight share one; any other tool runs each time.
for (const readOnly of [true, false]) {
  test(`an app's identical calls in flight ${readOnly ? 'to a read-only tool share one' : 'to any other tool each run'}`, async ($, on) => {
    let answer!: () => void
    const held = new Promise<void>((resolve) => (answer = resolve))
    const { sent, mcpCalls, finish } = standIns(on, {
      holdAppCall: held,
      readOnly,
      script: async function* () {
        yield { type: 'request', id: 8, viewId: TOOL_USE_ID, method: 'tools/call', params: { name: 'get-time', arguments: {} } }
      },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => mcpCalls.length >= 1)
    for (let i = 0; i < 1000; i++) await Promise.resolve()
    expect(mcpCalls.length).toBe(readOnly ? 1 : 2)
    answer()
    // Both get the answer.
    await settle(() => sent.filter((s) => s.route === '/reply' && (s.body.id === 7 || s.body.id === 8)).length === 2)
    finish()
  })
}

/** As in hooks/consent.ts. */
const MODEL_CONTEXT_CHARS = 100_000
const MODEL_CONTEXT_TOTAL_CHARS = 200_000

// Model context rides along with the next prompt, one block per view, at
// most what Claude Code shows the model inline (100,000 characters a block,
// 200,000 together), cut past that and saying so, and with no control
// characters: beside a typed prompt, or as a note with an app's message.
test('model context is cut to its limits and cleaned of control characters', { options: { appMessages: 'allow' } }, async ($, on) => {
  const SECOND = 'toolu_test_2'
  const large = `\u001b[31mred‮${'x'.repeat(150_000)}`
  const session = mock.session(on)
  let sentSoFar: Sent[] = []
  const { sent, submitted, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: large }] } }
      yield appRequest(61, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'go' }] })
      await settle(() => sentSoFar.filter((s) => s.route === '/open').length >= 2)
      yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'a'.repeat(120_000) }] } }
      yield { type: 'notify', viewId: SECOND, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'b'.repeat(120_000) }] } }
      yield appRequest(62, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'ready' }] })
    },
  })
  sentSoFar = sent
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 61))
  // The visible message is the app's alone; its context is a note, cut to a block.
  expect(submitted[0]).toBe('Message from the vanilla/get-time app:\ngo')
  const [note] = notesOf(session)
  expect(notesOf(session)).toHaveLength(1)
  expect(note).not.toMatch(/[\u001b‮]/)
  expect(note).toContain('x'.repeat(90_000))
  expect(note).toContain('(cut: the app sent 150009 characters)')
  expect(note!.length).toBeLessThanOrEqual(MODEL_CONTEXT_CHARS)
  // Two views' context: each its own block, the first cut to a block, the
  // second to what's left of the prompt's.
  await $.tool.call({ tool: TOOL, tool_use_id: SECOND })
  await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 62))
  const later = notesOf(session).slice(1)
  expect(later).toHaveLength(2)
  expect(later[0]!.length).toBeLessThanOrEqual(MODEL_CONTEXT_CHARS)
  expect(later[0]).toContain('(cut: the app sent 120000 characters)')
  expect(later.join('').length).toBeLessThanOrEqual(MODEL_CONTEXT_TOTAL_CHARS)
  expect(later[1]).toContain('bbbb')
  finish()
})

// Beside a typed prompt, model context is prompt context the person doesn't see.
test('model context rides beside the next typed prompt', async ($, on) => {
  const { sent, submitted, contexts, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'notify', viewId: TOOL_USE_ID, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'week view' }] } }
      yield appRequest(63, 'ui/request-display-mode', { mode: 'inline' })
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/reply' && s.body.id === 63))
  await $.prompt.submit({ text: 'typed', wait: false, origin: { kind: 'composer' } })
  expect(submitted).toEqual(['typed'])
  expect(contexts[0]).toContain('Context the vanilla/get-time MCP App view set (ui/update-model-context), its latest:\nweek view')
  // Taken once: the next prompt carries none of it again.
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  expect(contexts[1]?.some((block) => block.includes('week view')) ?? false).toBe(false)
  finish()
})


test("a view is named by its page's title once the helper reads it", async ($, on) => {
  const { sent, finish } = standIns(on, {
    script: async function* () {
      yield { type: 'describe', viewId: TOOL_USE_ID, title: 'Get Time App\u001b[31m' }
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  await settle(() => true)
  for (let i = 0; i < 50 && !(await ui.find({ type: 'Text', text: /^Get Time App/ })); i++) await Promise.resolve()
  const name = await ui.find({ type: 'Text', text: /^Get Time App/ })
  // No control characters reach the terminal.
  expect(name?.text).toBe('Get Time App [31m')
  await ui.unmount()
  finish()
})

test('after a reload of the plugin, its views are back: a live one asleep, opening again once in sight', async ($, on) => {
  const { sent, finish } = standIns(on, {
    saved: {
      version: 1,
      views: [
        {
          id: TOOL_USE_ID,
          server: 'vanilla',
          tool: 'get-time',
          mode: 'cells',
          status: 'live',
          call: { id: TOOL_USE_ID, server: 'vanilla', tool: 'get-time', input: {}, result: RESULT, theme: 'dark' },
          title: 'Get Time App',
        },
      ],
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle(() => true)
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, onScreen: { first: 0, last: 5, of: 6 } }, surface: 'terminal' } as never)
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const open = sent.find((s) => s.route === '/open')!
  expect(open.body.viewId).toBe(TOOL_USE_ID)
  expect(open.body.toolResult).toEqual(RESULT)
  await ui.unmount()
  finish()
})

test('the views are kept in session state as they open and get their result', async ($, on) => {
  const { sent, stateWrites, finish } = standIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  await settle(() => stateWrites.length > 0)
  const last = stateWrites.at(-1) as { version: number; views: Array<{ id: string; status: string; call?: { result?: unknown } }> }
  expect(last.version).toBe(1)
  expect(last.views[0]!.id).toBe(TOOL_USE_ID)
  expect(last.views[0]!.status).toBe('live')
  finish()
})

test('the width the input layer reports while the view loads applies with its first picture', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const { sent, finish } = standIns(on, { holdFrame: held })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  expect(await ui.find({ type: 'Client', key: `app-${TOOL_USE_ID}` })).toBeDefined()
  await ui.resize({ columns: 150, rows: 10 })
  await ui.advance(200)
  release()
  await until(() => sent.some((s) => s.route === '/resize'), () => ui.advance(100))
  expect(sent.find((s) => s.route === '/resize')!.body.cols).toBe(149)
  await ui.unmount()
  finish()
})

test('after a reload, a view whose call was never allowed stays closed and is not opened again', async ($, on) => {
  const { sent, finish } = standIns(on, {
    saved: {
      version: 1,
      views: [{ id: TOOL_USE_ID, server: 'vanilla', tool: 'get-time', mode: 'cells', status: 'live', call: { id: TOOL_USE_ID, server: 'vanilla', tool: 'get-time', input: {}, theme: 'dark' } }],
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle(() => true)
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, onScreen: { first: 0, last: 5, of: 6 } }, surface: 'terminal' } as never)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(sent.some((s) => s.route === '/open')).toBe(false)
  await ui.unmount()
  finish()
})


test('a view whose tool is still being looked up when the session ends never opens, in that session or the next', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const { sent, finish } = standIns(on, { holdDiscover: held })
  on('session.end', () => ({ sessionId: 'test' }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const call = $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await settle(() => sent.some((s) => s.route === '/discover'))
  await $.session.end({ reason: 'clear' } as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  release()
  await call
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(sent.some((s) => s.route === '/open')).toBe(false)
  finish()
})

for (const isFullscreen of [false, true]) {
  test(`a still view ${isFullscreen ? 'in fullscreen keeps its page' : 'on the main screen rests: its page goes, its picture stays'}`, { options: {} }, async ($, on) => {
    const { sent, finish } = standIns(on, { timers: true, appCall: false })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === "/result"))
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen } } as never)
    for (let i = 0; i < 300; i++) await Promise.resolve()
    expect(sent.some((s) => s.route === '/close')).toBe(!isFullscreen)
    await ui.unmount()
    if (!isFullscreen) {
      const again = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen } } as never)
      expect(await again.find({ type: 'Raster' })).toBeDefined()
      expect(await again.find({ type: 'Text', text: /view only outside fullscreen/ })).toBeDefined()
      await again.unmount()
    }
    finish()
  })
}

// A still view that reaches other sites (its CSP names them) rests only when
// its own network is quiet too: never with a socket open or a request in
// flight, nor right after its network moved.
for (const [what, activity, rests] of [
  ['quiet', { ok: true, sockets: 0, inflight: 0, quietMs: 600_000 }, true],
  ['with a socket open', { ok: true, sockets: 1, inflight: 0, quietMs: 600_000 }, false],
  ['with a request in flight', { ok: true, sockets: 0, inflight: 1, quietMs: 600_000 }, false],
  ['busy a moment ago', { ok: true, sockets: 0, inflight: 0, quietMs: 1_000 }, false],
  ['unknown (the helper says nothing)', { ok: false }, false],
] as const) {
  test(`a still view that reaches other sites, its network ${what}, ${rests ? 'rests' : 'keeps its page'}`, async ($, on) => {
    const { sent, finish } = standIns(on, {
      timers: true,
      appCall: false,
      answers: { '/open': { ok: true, mode: 'cells', domains: ['api.example.com'] }, '/activity': activity },
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === "/result"))
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
    await settle(() => sent.some((s) => s.route === '/activity'))
    for (let i = 0; i < 300; i++) await Promise.resolve()
    expect(sent.some((s) => s.route === '/close')).toBe(rests)
    await ui.unmount()
    finish()
  })
}

// No browser installed: the first view that can't open for that reason
// brings one question, ever: fetch Chrome for Testing's headless shell? On
// yes it's fetched and the view opens again; "Not now" fetches nothing; with
// a browser found, or asked before, nothing is asked.
const NO_BROWSER = 'app views need Google Chrome or another Chromium-based browser, and none was found'
for (const [what, answer, browser, before, fetched] of [
  ['answered "Download it"', 'Download it', { ok: true, found: false, fetchable: true }, undefined, true],
  ['answered "Not now"', 'Not now', { ok: true, found: false, fetchable: true }, undefined, false],
  ['with a browser found', 'Download it', { ok: true, found: true, path: '/Applications/Chrome' }, undefined, false],
  ['asked before', 'Download it', { ok: true, found: false, fetchable: true }, 'asked', false],
] as const) {
  test(`a view that can't open for want of a browser, ${what}: ${fetched ? 'one is fetched and the view opens again' : 'nothing is fetched'}`, async ($, on) => {
    const { sent, asked, finish } = standIns(on, {
      answer,
      answers: { '/open': { ok: false, error: NO_BROWSER }, '/browser': browser, '/fetch-browser': { ok: true, version: '158.0.8127.36' } },
    })
    const { store } = offerStandIns(on, new Map(before === undefined ? [] : [['browserOffer', before]]))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await settle(() => sent.some((s) => s.route === '/browser'))
    for (let i = 0; i < 2000; i++) await Promise.resolve()
    const offered = asked.some((q) => q.includes('need a browser'))
    expect(offered).toBe(browser.found === false && before === undefined)
    const opens = () => sent.filter((s) => s.route === '/open').length
    if (fetched) {
      await settle(() => opens() === 2)
      expect(store.get('browserOffer')).toBe('fetched')
    } else {
      expect(sent.some((s) => s.route === '/fetch-browser')).toBe(false)
      expect(opens()).toBe(1)
    }
    finish()
  })
}

/** The plugin's store, Claude Code's commands and the session's id, stood in for the fullscreen offer. */
/** `runFails`: true makes /tui reject; a string is the text it answers with (Claude Code's refusal). */
function offerStandIns(on: On, store = new Map<string, unknown>(), runFails: boolean | string = false) {
  const runs: Array<{ command: string; args?: string }> = []
  on('store.get', (_$, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    store.delete((e as { key: string }).key)
    return { value: undefined } as never
  })
  on('command.list', () => ({ value: [{ name: 'tui', description: 'layout', source: 'builtin' }] }) as never)
  on('command.run', (_$, e) => {
    if (runFails === true) throw new Error('no tui here')
    runs.push({ command: e.command, args: e.args })
    return { text: typeof runFails === 'string' ? runFails : '' }
  })
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('process.hookEnv', () => ({ value: {} }) as never)
  on('turn.complete', () => ({ text: '' }))
  return { store, runs }
}

const MAIN_SCREEN = { columns: 120, rows: 40, isFullscreen: false }

for (const answer of ['Switch to fullscreen', 'Keep this layout']) {
  test(`a view on the main screen: after the turn, fullscreen is offered once ("${answer}")`, async ($, on) => {
    const { sent, asked, finish } = standIns(on, { answer })
    const { store, runs } = offerStandIns(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
    let ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
    for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
      await ui.unmount()
      ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
    }
    await ui.unmount()
    await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
    await settle(() => asked.some((q) => q.includes('fullscreen layout')))
    const offers = () => asked.filter((q) => q.includes('fullscreen layout')).length
    expect(store.get('fullscreenOffer')).toBe('asked')
    if (answer === 'Switch to fullscreen') {
      await settle(() => runs.length > 0)
      // Past the run's answer: an answer that isn't a refusal keeps the copy.
      for (let i = 0; i < 300; i++) await Promise.resolve()
      expect(runs).toEqual([{ command: 'tui', args: 'fullscreen' }])
      // The views are kept for the restart, under the session's id.
      expect((store.get('restart') as { sessionId: string; views: Array<{ id: string }> }).views[0]!.id).toBe(TOOL_USE_ID)
      expect((store.get('restart') as { sessionId: string }).sessionId).toBe('session-1')
    } else {
      // Long enough for a switch (it waits on the session's id and the store) to have run, had it been wrong.
      for (let i = 0; i < 2000; i++) await Promise.resolve()
      expect(runs).toEqual([])
      expect(store.has('restart')).toBe(false)
    }
    // Once: not again at the next turn.
    await $.turn.complete({ turnId: 'turn-2', answer: '', durationMs: 1 } as never)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    expect(offers()).toBe(1)
    finish()
  })
}

test('fullscreen is never offered again in a later session, nor in fullscreen', async ($, on) => {
  const { sent, asked, finish } = standIns(on, { answer: 'Switch to fullscreen' })
  const { runs } = offerStandIns(on, new Map([['fullscreenOffer', 'asked']]))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  await ui.unmount()
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(asked.some((q) => q.includes('fullscreen layout'))).toBe(false)
  expect(runs).toEqual([])
  finish()
})

test('after a restart that resumes the session, its views are back from the store, and the copy is dropped', async ($, on) => {
  const kept = new Map<string, unknown>([
    ['restart', { version: 1, sessionId: 'session-1', at: Date.now(), views: [{ id: TOOL_USE_ID, server: 'vanilla', tool: 'get-time', mode: 'cells', status: 'live', call: { id: TOOL_USE_ID, server: 'vanilla', tool: 'get-time', input: {}, result: RESULT, theme: 'dark' } }] }],
  ])
  const { sent, finish } = standIns(on)
  const { store } = offerStandIns(on, kept)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle(() => !store.has('restart'))
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, onScreen: { first: 0, last: 5, of: 6 } }, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: true } } as never)
  await until(() => sent.some((s) => s.route === '/open'), () => Promise.resolve())
  expect(sent.find((s) => s.route === '/open')!.body.toolResult).toEqual(RESULT)
  await ui.unmount()
  finish()
})

test('fullscreen is not offered to someone who chose the main screen (CLAUDE_CODE_NO_FLICKER=0)', async ($, on) => {
  const { sent, asked, finish } = standIns(on, { answer: 'Switch to fullscreen', readyEnv: { CLAUDE_CODE_NO_FLICKER: '0' } })
  const { runs } = offerStandIns(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  await ui.unmount()
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(asked.some((q) => q.includes('fullscreen layout'))).toBe(false)
  expect(runs).toEqual([])
  finish()
})

test("a restart copy that's stale, or left by a switch that failed, is gone", async ($, on) => {
  const store = new Map<string, unknown>([['restart', { version: 1, sessionId: 'other', at: Date.now() - 11 * 60_000, views: [] }]])
  const { finish } = standIns(on)
  offerStandIns(on, store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle(() => !store.has('restart'))
  finish()
})

test('a switch to fullscreen that fails drops the copy it kept', async ($, on) => {
  const { sent, asked, finish } = standIns(on, { answer: 'Switch to fullscreen' })
  const { store } = offerStandIns(on, new Map(), true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  }
  await ui.unmount()
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
  await settle(() => asked.some((q) => q.includes('fullscreen layout')))
  for (let i = 0; i < 300; i++) await Promise.resolve()
  expect(store.has('restart')).toBe(false)
  finish()
})

test('a switch Claude Code refuses drops the copy it kept', async ($, on) => {
  const { sent, asked, finish } = standIns(on, { answer: 'Switch to fullscreen' })
  // Records each key written, so the copy is seen kept before it goes.
  const wrote: string[] = []
  const kept = new (class extends Map<string, unknown> {
    override set(key: string, value: unknown) {
      wrote.push(key)
      return super.set(key, value)
    }
  })()
  const { store, runs } = offerStandIns(
    on,
    kept,
    "Cannot switch renderers in this session \u2014 it has restrictions a restart can't carry over (launch flags: a custom system prompt, a tool allowlist, or restricted settings). Nothing was changed.",
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
  await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
  let ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
    await ui.unmount()
    ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
  }
  await ui.unmount()
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
  await settle(() => asked.some((q) => q.includes('fullscreen layout')))
  await settle(() => runs.length === 1)
  await settle(() => !store.has('restart'))
  expect(wrote).toContain('restart')
  expect(store.has('restart')).toBe(false)
  // They chose it: a later session asks once more.
  await settle(() => store.get('fullscreenOffer') === 'refused')
  finish()
})

// Refused once, asked once more; refused again, never asked again.
for (const [before, asks, after] of [['refused', true, 'refused again'], ['refused again', false, 'refused again']] as const) {
  test(`after a refused switch ("${before}"), fullscreen is ${asks ? 'offered once more' : 'not offered again'}`, async ($, on) => {
    const { sent, asked, finish } = standIns(on, { answer: 'Switch to fullscreen' })
    const { store, runs } = offerStandIns(on, new Map([['fullscreenOffer', before]]), "Cannot switch renderers in this session \u2014 it has restrictions a restart can't carry over. Nothing was changed.")
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, tool_use_id: TOOL_USE_ID })
    await until(() => sent.some((s) => s.route === '/result'), () => Promise.resolve())
    let ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
    for (let i = 0; i < 20 && !(await ui.find({ type: 'Raster' })); i++) {
      await ui.unmount()
      ui = await $.ui.mount({ ...ROW, surface: 'terminal', viewport: MAIN_SCREEN } as never)
    }
    await ui.unmount()
    await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1 } as never)
    if (asks) {
      await settle(() => asked.some((q) => q.includes('fullscreen layout')))
      await settle(() => runs.length === 1)
      await settle(() => store.get('fullscreenOffer') === after)
    } else {
      for (let i = 0; i < 2000; i++) await Promise.resolve()
      expect(asked.some((q) => q.includes('fullscreen layout'))).toBe(false)
      expect(store.get('fullscreenOffer')).toBe(after)
    }
    finish()
  })
}
