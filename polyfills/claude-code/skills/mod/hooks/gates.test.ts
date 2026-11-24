// The part of SEP-2640 only Claude Code can enforce, checked in Claude Code's
// own test kit (`claude plugin test mod`): the hooks module runs as it does in a
// session, and the hooks registered here stand for the engine beneath it and
// for the helper process (which is not started).
//
// Rule ids are those of docs/conformance.md.

import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import { BUN, SetupError, fetched, install, type Pin } from './runtime'

// A timer exists where a hooks module runs; the typings for one just do not name it.
declare const setTimeout: (run: (value?: unknown) => void, ms: number) => unknown
declare const btoa: (text: string) => string
declare const crypto: { subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } }

const SKILL = { server: 'acme', uri: 'skill://release-notes/SKILL.md', name: 'release-notes', root: 'skill://release-notes' }
const FACTS = { ...SKILL, files: 4, bytes: 1299, isDynamic: false, hash: 'sha256:aaaa', fingerprint: 'fp-acme' }
const CATALOG = 'The following skills are served by MCP servers connected to this session (MCP Skills extension).\n\n- release-notes (MCP server "acme", uri skill://release-notes/SKILL.md): Write release notes.'
const LOADED = 'Loaded the skill "release-notes" from the MCP server "acme" (skill://release-notes/SKILL.md).'
const APPROVED = 'Approval: the user approved this skill as the server serves it now.'
const UNAPPROVED = "Approval: none, because nobody could be asked. While it is loaded, every tool call but reading and searching needs the user's approval each time."
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const LOAD = 'mcp__mcp-skills__load_skill'

type Facts = Partial<typeof FACTS> & { error?: string; declined?: string }
type World = {
  /** What the helper was sent. */
  posts: { route: string; body: Record<string, unknown> }[]
  /** How often the helper was started. */
  spawns: number
  registered: string[]
  /** The command lines the helper was started with. */
  spawned: string[][]
  toasts: string[]
  submitted: string[]
  /** What the helper says of the skill's entry now: a test changes it as a server would change the skill. */
  facts: Facts
  /** The mod's own store, as Claude Code keeps it between sessions. */
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  exit: () => void
  /** The questions put in Claude Code's dialog. */
  asked: string[]
  /** What the mod wrote to the debug log. */
  logs: string[]
  /** Every program the mod ran, as its argument list. */
  ran: string[][]
  /** Each list of disabled skills the helper was sent, and how many it has been sent (the helper's rev). */
  told: { server: string; uri: string }[][]
  rev: number
  /** Runs while the helper answers a tool call: a test changes the world there, as another session would. */
  duringTool?: () => void
  /** The files and folders of the machine, as far as the mod's own runtime is concerned. */
  disk: Record<string, { kind: 'file' | 'dir'; bytes?: Uint8Array; isLink?: boolean; mtimeMs?: number }>
}
/** What the machine is like for a fetch of the mod's own runtime. */
type Machine = {
  /** What `uname -sm` answers. Default: a Mac with Apple silicon. */
  uname?: string
  ldd?: string
  /** Programs that are not installed. */
  missing?: string[]
  /** What the download holds. */
  zip?: Uint8Array
  curlFails?: string
  /** What the archive's named file turns out to be. */
  member?: 'file' | 'link' | 'none'
  /** What a fetched copy answers to --version, where not its own. */
  says?: string
  /** The exit code of a fetched copy's --version. Default 0. */
  saysExit?: number
  /** Paths `rm` cannot delete (and what is under them). */
  stuck?: string[]
  chmodFails?: true
  disk?: World['disk']
}
const DATA = '/plugin-data'

/** The engine beneath the mod, and a helper that answers as the real one does. */
/**
 * The machine beneath the mod: the programs it can run and the files it sees. Used under the hooks
 * (world), and by itself, as the engine, where a test calls the fetch directly.
 */
function machineOf(m: Machine, runtimesGiven?: Record<string, string>, shellFinds?: string) {
  const ran: string[][] = []
  const disk: World['disk'] = { ...(m.disk ?? {}) }
  const runtimes = runtimesGiven ?? { node: 'v22.18.0' }
  const under = (path: string) => Object.keys(disk).filter((key) => key === path || key.startsWith(`${path}/`))
  const done = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  const failed = (exitCode: number, stderr: string) => ({ exitCode, stdout: '', stderr })
  const run = (argv: readonly string[]) => {
    ran.push([...argv])
    const [program = '', flag] = argv
    if (m.missing?.includes(program)) return failed(127, `${program}: command not found`)
    if (program === 'uname') return done(`${m.uname ?? 'Darwin arm64'}\n`)
    if (program === 'ldd') return done(m.ldd ?? '')
    if (program === 'chmod') return m.chmodFails && argv[1] === '755' ? failed(1, 'Operation not permitted') : done()
    if (program === 'mkdir') {
      const path = String(argv.at(-1))
      // Without -p, a folder that is there already is a failure: that is what makes it a lock.
      if (argv[1] !== '-p' && disk[path]) return failed(1, `mkdir: ${path}: File exists`)
      disk[path] = { kind: 'dir', mtimeMs: 10_000_000 }
      return done()
    }
    if (program === 'rm') {
      const path = String(argv[2])
      if (m.stuck?.some((stuck) => path === stuck || path.startsWith(`${stuck}/`) || path.startsWith(stuck))) return failed(1, 'Permission denied')
      for (const key of under(path)) delete disk[key]
      return done()
    }
    if (program === 'mv') {
      const [from, to] = [String(argv[1]), String(argv[2])]
      for (const key of under(from)) {
        disk[`${to}${key.slice(from.length)}`] = disk[key]!
        delete disk[key]
      }
      return done()
    }
    if (program === 'curl') {
      if (m.curlFails) return failed(22, m.curlFails)
      disk[String(argv[argv.indexOf('--output') + 1])] = { kind: 'file', bytes: m.zip ?? new Uint8Array([80, 75, 3, 4]) }
      return done()
    }
    if (program === 'unzip') {
      if (m.member === 'none') return failed(11, 'filename not matched')
      const dest = String(argv[argv.indexOf('-d') + 1])
      disk[dest] = { kind: 'dir' }
      disk[`${dest}/bun`] = { kind: 'file', bytes: new Uint8Array(64), ...(m.member === 'link' ? { isLink: true } : {}) }
      return done()
    }
    // A copy of Bun the mod fetched answers with the version its folder is named for.
    const fetchedCopy = /\/bun-(\d+\.\d+\.\d+)\/bun$/.exec(program)
    if (fetchedCopy && disk[program]) return { exitCode: m.saysExit ?? 0, stdout: `${m.says ?? fetchedCopy[1]}\n`, stderr: '' }
    // The person's login shell, asked where node and bun are.
    if (flag === '-lic') return done(shellFinds ?? '')
    const answer = runtimes[program]
    return answer === undefined ? failed(127, 'not found') : done(`${answer}\n`)
  }
  const exists = (path: string) => disk[path] !== undefined
  const stat = (path: string) => {
    const entry = disk[path]
    if (!entry) throw new Error(`ENOENT: ${path}`)
    return { kind: entry.kind, size: entry.bytes?.length ?? 0, mtimeMs: entry.mtimeMs ?? 0, isLink: entry.isLink === true }
  }
  const list = (path: string) => {
    const names = [...new Set(Object.keys(disk).filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1).split('/')[0]!))]
    return names.map((name) => ({ name, kind: disk[`${path}/${name}`]?.kind ?? 'dir', size: 0, mtimeMs: 0, isLink: false }))
  }
  const read = (path: string, offset = 0, length?: number) => {
    const bytes = disk[path]?.bytes
    if (!bytes) throw new Error(`ENOENT: ${path}`)
    const part = bytes.slice(offset, offset + (length ?? bytes.length))
    let text = ''
    for (let at = 0; at < part.length; at += 8192) text += String.fromCharCode(...part.subarray(at, at + 8192))
    return { base64: btoa(text) }
  }
  // As a hooks module calls them.
  const engine = {
    process: { run: async (argv: string[]) => run(argv) },
    fs: { exists: async (path: string) => exists(path), stat: async (path: string) => stat(path), list: async (path: string) => list(path), read: async (path: string, o: { offset?: number; length?: number }) => read(path, o.offset, o.length) },
    clock: { now: async () => 10_000_000 },
  } as unknown as EngineInterface
  return { ran, disk, run, exists, stat, list, read, engine }
}

function world(on: On, o: { /** What the person answers to a question in Claude Code's dialog; absent, they dismiss it. */ answer?: string; machine?: Machine; tools?: string[]; env?: Record<string, string>; /** What each command answers to --version; a missing one is not installed. Default: node on the PATH. */ runtimes?: Record<string, string>; shellFinds?: string; names?: string[]; commands?: string[]; /** The helper's first listing is not yet complete: a server is still being looked at. */ partial?: true; /** Claude Code refuses to keep more in the mod's store (it holds at most 4 MiB). */ storeFull?: true; /** The conversation so far; an Error stands for one that cannot be read. */ rows?: unknown[] | Error; verdict?: Record<string, unknown>; connect?: Record<string, unknown>; servers?: string[]; catalog?: string | null; expects?: number; store?: Record<string, unknown>; facts?: Facts; found?: unknown[]; /** The helper's first listing was made before it was told which skills are disabled. */ staleCatalog?: true; /** The mod's store cannot be read (its list of disabled skills). */ storeBroken?: true } = {}): World {
  // A wait ends only when a test moves the clock: nothing here times out by itself.
  const w: World = { posts: [], spawns: 0, registered: [], spawned: [], toasts: [], submitted: [], facts: o.facts ?? FACTS, store: { ...(o.store ?? {}) }, clock: mock.clock(on), exit: () => {}, ran: [], disk: {}, asked: [], logs: [], told: [], rev: 0 }
  const ready = JSON.stringify({ t: 'ready', url: 'http://127.0.0.1:9', token: 'secret', expects: o.expects ?? 1 })
  const lines = [ready, ...(o.servers ? [JSON.stringify({ t: 'servers', names: o.servers })] : []), ...(o.catalog === null ? [] : [JSON.stringify({ t: 'catalog', text: o.catalog ?? CATALOG, skills: 1, servers: 1, rev: o.staleCatalog ? 0 : 1, ...(o.partial ? { complete: false } : {}) })])]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.messages', () => {
    if (o.rows instanceof Error) throw o.rows
    return { value: (o.rows ?? []) as never }
  })
  const box = machineOf(o.machine ?? {}, o.runtimes, o.shellFinds)
  w.ran = box.ran
  w.disk = box.disk
  on('process.run', (_, e) => ({ value: box.run(e.argv) as never }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: DATA } }))
  on('fs.exists', (_, e) => ({ value: box.exists(e.path) }))
  on('fs.stat', (_, e) => ({ value: box.stat(e.path) as never }))
  on('fs.list', (_, e) => ({ value: box.list(e.path) as never }))
  on('fs.read', (_, e) => ({ value: box.read(e.path, e.offset, e.length) as never }))
  on('process.spawn', async function* (_, e) {
    w.spawns++
    w.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: lines.join('\n') + '\n' }
    // The helper runs for as long as the session does.
    await new Promise<void>((exit) => (w.exit = exit))
    return { value: { exitCode: 0 } } as never
  })
  on('http.fetch', (_, e) => {
    const route = new URL(e.url).pathname
    const body = JSON.parse(String(e.init?.body ?? '{}')) as Record<string, unknown>
    w.posts.push({ route, body })
    const answers: Record<string, () => unknown> = {
      '/tool': () => (w.duringTool?.(), body.name === 'load_skill' ? { text: LOADED, acting: { ...SKILL, server: String((body.input as { server?: unknown } | undefined)?.server ?? SKILL.server), hash: w.facts.hash, fingerprint: w.facts.fingerprint } } : { text: 'ok' }),
      '/entry': () => w.facts,
      // As the helper does: the listing without the skills it was told are disabled, and the count of lists it was sent.
      '/disabled': () => {
        const skills = (body.skills ?? []) as { server: string; uri: string }[]
        w.told.push(skills)
        const isOff = skills.some((s) => s.server === SKILL.server && s.uri === SKILL.uri)
        return { rev: ++w.rev, text: o.catalog === null || isOff ? '' : (o.catalog ?? CATALOG), skills: o.catalog === null || isOff ? 0 : 1, servers: o.catalog === null ? 0 : 1, complete: !o.partial }
      },
      '/status': () => ({ text: 'MCP server "acme": 1 skill.', names: o.names ?? ['release-notes'], servers: ['acme', 'my.docs'] }),
      '/find': () => ({ found: o.found ?? [SKILL] }),
      '/preview': () => (o.found ? { candidates: o.found } : { ...SKILL, description: 'Write release notes.', body: '# Release notes\n\nRead `references/codenames.md`.\n', isVerified: true, isDisabled: w.told.at(-1)?.some((s) => s.uri === SKILL.uri) ?? false, files: ['references/codenames.md'] }),
    }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(answers[route]?.() ?? {}) } as never }
  })
  on('tool.register', (_, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__mcp-skills__${e.name}` } as never }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } as never }))
  on('tool.list', () => ({ value: (o.tools ?? []).map((name) => ({ name })) as never }))
  on('command.list', () => ({ value: (o.commands ?? []).map((name) => ({ name, description: '', source: 'user' })) as never }))
  on('prompt.submit', (_, e) => {
    w.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('store.get', (_, e) => {
    if (o.storeBroken && e.key === 'disabled') throw new Error('the store could not be read')
    return { value: w.store[e.key] }
  })
  on('store.set', (_, e) => {
    if (o.storeFull) throw new Error('the store would hold more than 4 MiB')
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: (o.env ?? {})[e.name] }))
  on('ui.log', (_, e) => {
    w.logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  // $.ui.ask is Claude Code's AskUserQuestion dialog: the person's answer, by the question's text.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions = [] } = e as unknown as { questions?: { question: string; options: { label: string }[] }[] }
    w.asked.push(...questions.map((q) => `${q.question} [${q.options.map((option) => option.label).join(' | ')}]`))
    if (o.answer === undefined) return { deny: 'The user dismissed the question.' } as never
    return { result: { questions, answers: Object.fromEntries(questions.map((q) => [q.question, o.answer])) } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('mcp.connect', (_, e) => ({ value: (o.connect?.[e.server] ?? { isConnected: true, server: e.server }) as never }))
  // What Claude Code itself decides: by default an ask with nothing behind it, as for any MCP tool.
  on('tool.check', (_, e) => (e.tool === 'AskUserQuestion' ? { decision: 'allow' } : (o.verdict ?? { decision: 'ask' })) as never)
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  return w
}

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
let calls = 0
/** A load as the model's call goes: the permission check with a person to ask, then (their yes given) the run. */
async function load($: Engine, o: { approver?: 'person' | null; uri?: string; server?: string } = {}) {
  const id = `t${++calls}`
  const input = { server: o.server ?? SKILL.server, uri: o.uri ?? SKILL.uri }
  const verdict = await $.tool.check({ tool: LOAD, input, tool_use_id: id, ...(o.approver === null ? {} : { approver: 'person' }) } as never)
  const ran = await $.tool.run({ tool: LOAD, tool_use_id: id, ...input } as never)
  return { verdict, ran: ran as { result?: string; deny?: string } }
}
const bash = { tool: 'Bash', input: { command: 'python3 scripts/extract.py' } }
/** A permission check with a person at the session to ask. Without this, a check is one with nobody to ask (`claude -p`). */
const present = (call: { tool: string; input: unknown }) => ({ ...call, approver: 'person' }) as never
const NOBODY = 'Nobody can be asked in this session, so the call is refused.'
const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
}
const listing = { type: 'skill_listing', text: 'The following skills are available for use with the Skill tool:\n\n- commit: Make a commit.', origin: { kind: 'engine' } } as const
const approvals = (w: World) => (w.store.approvals ?? {}) as Record<string, { hash: string; fingerprint: string; name: string }>

test('X5: a skill is put to the person before it is loaded, once, with what it is and where it comes from', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const first = await load($)
  expect(first.verdict.decision).toBe('ask')
  // The ask is the mod's own, so Claude Code puts it to a person: no rule, mode or classifier settles it.
  expect(first.verdict.plugin).toBe('mcp-skills')
  expect(first.verdict.reason).toContain('Load the skill "release-notes" from the MCP server "acme"?')
  expect(first.verdict.reason).toContain('4 files (1 KB) written by that server')
  expect(first.verdict.reason).toContain('/mcp-skills show release-notes')
  expect(first.ran.result).toBe(`${APPROVED}\n${LOADED}`)
  // The skill is loaded as it was put to the person: the helper is told which content was approved.
  expect((w.posts.find((p) => p.route === '/tool')!.body.input as Record<string, unknown>).expect).toBe('sha256:aaaa')
})

test('X14: the yes is kept bound to the skill\'s content and its server, and the same skill is not asked about again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await load($)
  expect(approvals(w)).toEqual({ 'acme\nskill://release-notes/SKILL.md': { hash: 'sha256:aaaa', fingerprint: 'fp-acme', name: 'release-notes', at: 0 } })
  const again = await load($)
  expect(again.verdict.decision).toBe('allow')
  expect(again.ran.result).toBe(`${APPROVED}\n${LOADED}`)
})

test('X14: a yes that cannot be kept (the store is full) still loads the skill it was given for; it is asked about again next time', async ($, on) => {
  const w = world(on, { storeFull: true })
  await $.session.start(START)
  const first = await load($)
  expect(first.ran.result).toBe(`${APPROVED}\n${LOADED}`)
  expect(w.logs.some((l) => l.includes('could not be kept'))).toBe(true)
  expect((await load($)).verdict.decision).toBe('ask')
})

test('X14: the approvals kept are bounded: past 2,000, the oldest are dropped, so the store never fills', async ($, on) => {
  const old = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`acme\nskill://s${i}/SKILL.md`, { hash: 'sha256:x', fingerprint: 'fp-acme', name: `s${i}`, at: 1000 + i }]))
  const w = world(on, { store: { approvals: old } })
  await $.session.start(START)
  await load($)
  const kept = approvals(w)
  expect(Object.keys(kept).length).toBe(2000)
  expect(kept['acme\nskill://s0/SKILL.md']).toBeUndefined()
  expect(kept['acme\nskill://s1/SKILL.md']).toBeDefined()
  expect(kept[`${SKILL.server}\n${SKILL.uri}`]!.hash).toBe(FACTS.hash)
})

test('X14: approvals kept in a shape this version does not know are no approval: the skill is asked about', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const kept of ['not an object', [1, 2], { [`${SKILL.server}\n${SKILL.uri}`]: 'sha256:aaaa' }, { [`${SKILL.server}\n${SKILL.uri}`]: { hash: 7, fingerprint: 'fp-acme' } }]) {
    w.store.approvals = kept
    expect([kept, (await load($)).verdict.decision]).toEqual([kept, 'ask'])
  }
})

test('X14: an approval from an earlier session stands for the same content', async ($, on) => {
  world(on, { store: { approvals: { 'acme\nskill://release-notes/SKILL.md': { hash: 'sha256:aaaa', fingerprint: 'fp-acme', name: 'release-notes', at: 1 } } } })
  await $.session.start(START)
  expect((await load($)).verdict.decision).toBe('allow')
})

test('X14: a skill the server changed since is asked about again, as a skill that changed, and the new yes replaces the old', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await load($)
  w.facts = { ...FACTS, hash: 'sha256:bbbb', files: 5 }
  const changed = await load($)
  expect(changed.verdict.decision).toBe('ask')
  expect(changed.verdict.reason).toContain('The skill "release-notes" from the MCP server "acme" has changed since you approved it. Load it as it is now?')
  expect((approvals(w))['acme\nskill://release-notes/SKILL.md']!.hash).toBe('sha256:bbbb')
})

test('X14: a server of the same name at another address is another server: its skill is asked about', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await load($)
  w.facts = { ...FACTS, fingerprint: 'fp-elsewhere' }
  const moved = await load($)
  expect(moved.verdict.decision).toBe('ask')
  expect(moved.verdict.reason).toContain('from a server at another address')
})

test('X14: a generated skill cannot be bound to content: it is asked about at every load, and no approval is kept', async ($, on) => {
  const w = world(on, { facts: { ...FACTS, isDynamic: true, hash: undefined, files: 0, bytes: 0 } })
  await $.session.start(START)
  for (const _ of [1, 2]) {
    const each = await load($)
    expect(each.verdict.decision).toBe('ask')
    expect(each.verdict.reason).toContain('cannot be checked, and your yes is for this one load')
  }
  expect(approvals(w)).toEqual({})
})

test('X5: once the person approved a skill, a command runs under their usual permissions', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  await load($)
  expect((await $.tool.check(bash)).decision).toBe('allow')
})

test('X5: where nobody can be asked, a skill loads unapproved, and every tool that runs code is refused while it is loaded', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  const headless = await load($, { approver: null })
  expect(headless.verdict.decision).toBe('allow')
  expect(headless.ran.result).toBe(`${UNAPPROVED}\n${LOADED}`)
  expect(approvals(w)).toEqual({})
  for (const tool of ['Bash', 'PowerShell', 'Monitor', 'REPL']) {
    // The refusal is the mod's own: it does not wait on what a mode does with a question nobody can answer.
    const verdict = await $.tool.check({ tool, input: { command: 'ls' } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('nobody was asked about ("release-notes" from the MCP server "acme")')
    expect(verdict.reason).toContain(NOBODY)
    expect(verdict.reason).toContain('approve it once in an interactive session')
  }
})

test('X5: a skill that was loaded unapproved, with a person now at the session: each such call is put to them', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  await load($, { approver: null })
  for (const tool of ['Bash', 'Write', 'Agent', 'mcp__shell__run']) {
    const verdict = await $.tool.check(present({ tool, input: {} }))
    expect([tool, verdict.decision]).toEqual([tool, 'ask'])
    expect(verdict.plugin).toBe('mcp-skills')
    expect(verdict.reason).not.toContain(NOBODY)
  }
})

// A file written now is code run later: a hook in .claude/settings.json, a git hook, a package.json
// script. So the gate is not a list of tools that run code, which a new tool would slip past.
test('X5: with a skill loaded that nobody approved, a write, a subagent, another server\'s tool and a tool this mod has never heard of are refused too', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  await load($, { approver: null })
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'Skill', 'Workflow', 'WebFetch', 'CronCreate', 'mcp__filesystem__write_file', 'mcp__shell__run', 'ATool_OfALaterClaudeCode']) {
    const verdict = await $.tool.check({ tool, input: { file_path: '.claude/settings.json', content: '{"hooks":{}}' } })
    expect([tool, verdict.decision]).toEqual([tool, 'deny'])
    expect(verdict.reason).toContain('nobody was asked about ("release-notes" from the MCP server "acme")')
  }
})

test('X5: with a skill loaded that nobody approved, reading and searching go ahead, and so do the mod\'s own reads and loads', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  await load($, { approver: null })
  for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch', 'ListMcpResourcesTool', 'mcp__mcp-skills__read_skill_file', 'mcp__mcp-skills__list_skill_directory', 'mcp__mcp-skills__list_skills']) {
    expect([tool, (await $.tool.check({ tool, input: {} })).decision]).toEqual([tool, 'allow'])
  }
  expect((await load($, { approver: null, uri: 'skill://incident-review/SKILL.md' })).verdict.decision).toBe('allow')
  expect((await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'acme', uri: 'db://x' } })).decision).toBe('allow')
})

test('X5: a skill the person approved, or no skill at all, changes nothing for a write or for another server\'s tool', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  const write = { tool: 'Write', input: { file_path: 'notes.md', content: 'x' } }
  expect((await $.tool.check(write)).decision).toBe('allow')
  await load($)
  expect((await $.tool.check(write)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Agent', input: {} })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__shell__run', input: {} })).decision).toBe('allow')
})

test('X5: when the mod cannot tell whether such a skill is loaded, a call that could change something is put to the person, or refused with nobody to ask; a read is not', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' }, rows: new Error('the conversation could not be read') })
  await $.session.start(START)
  for (const tool of ['Bash', 'Write', 'Agent', 'mcp__shell__run']) {
    expect([tool, (await $.tool.check(present({ tool, input: {} }))).decision]).toEqual([tool, 'ask'])
    expect([tool, (await $.tool.check({ tool, input: {} })).decision]).toEqual([tool, 'deny'])
  }
  expect((await $.tool.check({ tool: 'Read', input: {} })).decision).toBe('allow')
})

test('X5: a call that reached the tool with no permission check (another mod\'s) was approved by nobody', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  const ran = (await $.tool.run({ tool: LOAD, tool_use_id: 'unchecked', server: SKILL.server, uri: SKILL.uri } as never)) as { result?: string }
  expect(ran.result).toBe(`${UNAPPROVED}\n${LOADED}`)
  expect((await $.tool.check(present(bash))).decision).toBe('ask')
  expect((await $.tool.check(bash)).decision).toBe('deny')
})

test('X5: a command Claude Code refuses stays refused, and with no skill loaded a command is decided as it always was', async ($, on) => {
  world(on, { verdict: { decision: 'deny' } })
  await $.session.start(START)
  expect((await $.tool.check(bash)).decision).toBe('deny')
  expect((await $.tool.check({ tool: LOAD, input: SKILL, tool_use_id: 'x', approver: 'person' } as never)).decision).toBe('deny')
})

test('a load that will fail is no question for anyone: it goes ahead and fails with the reason', async ($, on) => {
  world(on, { facts: { error: 'the MCP server "acme" serves no skill at that URI' } })
  await $.session.start(START)
  expect((await $.tool.check({ tool: LOAD, input: SKILL, tool_use_id: 'x', approver: 'person' } as never)).decision).toBe('allow')
})

test('the mod\'s reads raise no question, as Claude Code\'s own resource read raises none; a rule of yours or your organisation\'s still decides', async ($, on) => {
  world(on)
  await $.session.start(START)
  for (const tool of ['mcp__mcp-skills__read_skill_file', 'mcp__mcp-skills__list_skill_directory', 'mcp__mcp-skills__list_skills']) {
    expect((await $.tool.check({ tool, input: {} })).decision).toBe('allow')
    expect((await $.tool.check({ tool, input: {}, ceiling: 'ask' } as never)).decision).toBe('ask')
  }
})

test('a rule of yours that asks about the mod\'s reads is kept', async ($, on) => {
  world(on, { verdict: { decision: 'ask', rule: 'mcp__mcp-skills__read_skill_file' } })
  await $.session.start(START)
  expect((await $.tool.check({ tool: 'mcp__mcp-skills__read_skill_file', input: {} })).decision).toBe('ask')
})

test('W1: a skill loaded before a resume or a reload is still being acted on: it is read back from the conversation, with whether it was approved', async ($, on) => {
  const row = (text: string, uri: string) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: uri, tool: LOAD, input: { server: 'acme', uri }, text }] })
  world(on, { verdict: { decision: 'allow', rule: 'Bash' }, rows: [row(`${APPROVED}\n${LOADED}`, SKILL.uri)] })
  await $.session.start(START)
  expect((await $.tool.check(bash)).decision).toBe('allow')
  expect((await $.tool.check(present({ tool: 'ReadMcpResourceTool', input: { server: 'billing', uri: 'db://x' } }))).decision).toBe('ask')
})

test('W1: after a resume, a skill that was loaded unapproved still has its commands asked about; a failed load opened nothing', async ($, on) => {
  const use = (text: string, uri: string, isError?: true) => ({ tool_use_id: uri, tool: LOAD, input: { server: 'acme', uri }, text, ...(isError ? { isError } : {}) })
  world(on, { verdict: { decision: 'allow', rule: 'Bash' }, rows: [{ role: 'assistant', text: '', toolUses: [use('The MCP server "acme" serves no skill at that URI.', 'skill://nope/SKILL.md', true), use(`${UNAPPROVED}\n${LOADED}`, SKILL.uri)] }] })
  await $.session.start(START)
  const verdict = await $.tool.check(present(bash))
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('"release-notes"')
  expect(verdict.reason).not.toContain('"nope"')
  expect((await $.tool.check(present({ tool: 'Edit', input: { file_path: 'package.json' } }))).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: 'package.json' } })).decision).toBe('deny')
})

test('W1: after a resume, loading an approved skill before anything else does not hide one loaded unapproved earlier', async ($, on) => {
  const other = { server: 'acme', uri: 'skill://incident-review/SKILL.md' }
  const w = world(on, { verdict: { decision: 'allow', rule: 'allowed' }, rows: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old', tool: LOAD, input: other, text: `${UNAPPROVED}\nLoaded the skill "incident-review" from the MCP server "acme" (${other.uri}).` }] }] })
  w.store.approvals = { [`${SKILL.server}\n${SKILL.uri}`]: { hash: FACTS.hash, fingerprint: FACTS.fingerprint, name: SKILL.name, at: 1 } }
  await $.session.start(START)
  expect((await load($)).ran.result).toBe(`${APPROVED}\n${LOADED}`)
  const verdict = await $.tool.check(present({ tool: 'Write', input: { file_path: '.git/hooks/pre-commit' } }))
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('"incident-review"')
})

// Found by the model (verification/model.ts, "Gate"): the unapproved text is still in the
// conversation after a later load of the same skill, so a later yes does not lift the gate for it.
test('X5, W1: a skill loaded unapproved stays unapproved until the conversation is cleared, though it is loaded again with a yes', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  await load($, { approver: null })
  // Approved meanwhile (in another session on this machine), possibly as the server serves it now.
  w.store.approvals = { [`${SKILL.server}\n${SKILL.uri}`]: { hash: FACTS.hash, fingerprint: FACTS.fingerprint, name: SKILL.name, at: 1 } }
  expect((await load($, { approver: null })).ran.result).toBe(`${APPROVED}\n${LOADED}`)
  expect((await $.tool.check(bash)).decision).toBe('deny')
  expect((await $.tool.check(present(bash))).decision).toBe('ask')
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
  await load($, { approver: null })
  expect((await $.tool.check(bash)).decision).toBe('allow')
})

test('W1: after a resume, a skill loaded unapproved and later with a yes is still read back as unapproved', async ($, on) => {
  const use = (id: string, text: string) => ({ tool_use_id: id, tool: LOAD, input: { server: SKILL.server, uri: SKILL.uri }, text })
  world(on, { verdict: { decision: 'allow', rule: 'Bash' }, rows: [{ role: 'assistant', text: '', toolUses: [use('first', `${UNAPPROVED}\n${LOADED}`)] }, { role: 'assistant', text: '', toolUses: [use('second', `${APPROVED}\n${LOADED}`)] }] })
  await $.session.start(START)
  expect((await $.tool.check(bash)).decision).toBe('deny')
  expect((await $.tool.check(present(bash))).decision).toBe('ask')
})

test('X6: two servers whose names differ only in punctuation are two servers: a read from the other one is asked about', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'x' }, facts: { ...FACTS, server: 'acme.prod' } })
  await $.session.start(START)
  await load($, { server: 'acme.prod' })
  const verdict = await $.tool.check(present({ tool: 'ReadMcpResourceTool', input: { server: 'acme_prod', uri: 'db://secrets' } }))
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('another MCP server, "acme_prod"')
})

test('W1: clearing the conversation ends it: the skill\'s text is gone, and the helper is told to drop its entry', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  await load($, { approver: null })
  expect((await $.tool.check(bash)).decision).toBe('deny')
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
  expect((await $.tool.check(bash)).decision).toBe('allow')
  await settle(() => w.posts.some((p) => p.route === '/release'))
  expect(w.posts.some((p) => p.route === '/release')).toBe(true)
})

test('R4, X12: a skill nested inside a loaded skill has a yes of its own: approving the outer one did not approve it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await load($)
  w.facts = { ...FACTS, uri: `${SKILL.root}/advanced/SKILL.md`, name: 'advanced', hash: 'sha256:cccc' }
  const nested = await load($, { uri: `${SKILL.root}/advanced/SKILL.md` })
  expect(nested.verdict.decision).toBe('ask')
  expect(nested.verdict.plugin).toBe('mcp-skills')
  expect(nested.verdict.reason).toContain('nested inside the loaded skill "release-notes"; approving that one did not approve this one')
})

test('X6, X8: a resource read from another MCP server is put to the person, naming both servers', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'x' } })
  await $.session.start(START)
  await load($)
  for (const tool of ['ReadMcpResourceTool', 'ReadMcpResourceDirTool']) {
    const verdict = await $.tool.check(present({ tool, input: { server: 'billing', uri: 'db://customers/42' } }))
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('the MCP server "acme"')
    expect(verdict.reason).toContain('another MCP server, "billing"')
    expect(verdict.plugin).toBe('mcp-skills')
    // With nobody to ask, it is refused.
    const alone = await $.tool.check({ tool, input: { server: 'billing', uri: 'db://customers/42' } })
    expect(alone.decision).toBe('deny')
    expect(alone.reason).toContain(NOBODY)
  }
  // The skill's own server, outside the skill: Claude Code's own decision stands.
  expect((await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'acme', uri: 'doc://handbook' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'ListMcpResourcesTool', input: {} })).decision).toBe('allow')
})

test('V4: a loaded skill\'s own files are read only through the path that verifies them', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'x' } })
  await $.session.start(START)
  await load($)
  for (const uri of [SKILL.uri, `${SKILL.root}/templates/customer.md`, SKILL.root]) {
    const verdict = await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'acme', uri } })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('mcp__mcp-skills__read_skill_file')
  }
  // Another skill of the same name prefix is not this skill.
  expect((await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'acme', uri: 'skill://release-notes-old/SKILL.md' } })).decision).toBe('allow')
})

test('D1: reading a SKILL.md with Claude Code\'s own resource tool is no load: nothing is asked or refused for it afterwards', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'x' } })
  await $.session.start(START)
  expect((await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'acme', uri: SKILL.uri } })).decision).toBe('allow')
  expect((await $.tool.check(bash)).decision).toBe('allow')
})

test('X3, X4: the MCP-served skills are added to the session\'s skill listing, after Claude Code\'s own and under their own heading', async ($, on) => {
  world(on)
  await $.session.start(START)
  const { text } = await $.prompt.attachment(listing)
  expect(text).toBe(`${listing.text}\n\n${CATALOG}`)
})

test('X13: /mcp-skills show opens a skill\'s SKILL.md in a panel for the person, with where it comes from; it is not loaded', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const { text } = await $.command.run({ command: 'mcp-skills', args: 'show release-notes' } as never)
  expect(text).toContain('is open in a panel for you to read. It is not loaded.')
  expect(w.posts.some((p) => p.route === '/tool')).toBe(false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mcp-skills', surface, component: 'Pane', requestId: 'mcp-skills-preview', props: { title: 'release-notes', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
    expect((await ui.find({ type: 'Text', text: /Served by the MCP server "acme"/ }))?.text).toContain('Not loaded: Claude has not read this.')
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Release notes')
    await ui.unmount()
  }
  // Nothing was approved or opened by looking.
  expect(approvals(w)).toEqual({})
  expect((await $.tool.check(bash)).decision).toBe('ask')
})

test('/mcp-skills use hands the skill to Claude by its server and URI; a name two servers serve is asked about', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const { text } = await $.command.run({ command: 'mcp-skills', args: 'use release-notes notes for 4.2' } as never)
  expect(text).toContain('Asked Claude to load "release-notes" from the MCP server "acme".')
  // The prompt goes in once the command has answered.
  await w.clock.advance(100)
  expect(w.submitted[0]).toContain('uri "skill://release-notes/SKILL.md"')
  expect(w.submitted[0]).toContain('notes for 4.2')
})

test('/mcp-skills use and show ask which, when a name is served twice', async ($, on) => {
  const w = world(on, { found: [SKILL, { ...SKILL, server: 'other' }] })
  await $.session.start(START)
  for (const verb of ['use', 'show']) {
    const { text } = await $.command.run({ command: 'mcp-skills', args: `${verb} release-notes` } as never)
    expect(text).toContain('Say which: acme:release-notes, other:release-notes.')
  }
  expect(w.submitted).toEqual([])
})

test('/mcp-skills forget drops what was approved, so the skill is asked about again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await load($)
  expect((await $.command.run({ command: 'mcp-skills', args: 'forget release-notes' } as never)).text).toContain('Forgot 1 approval.')
  expect(approvals(w)).toEqual({})
  expect((await load($)).verdict.decision).toBe('ask')
})

test('/mcp-skills shows what is served, what is loaded, what you approved, and names that collide with your own', async ($, on) => {
  world(on, { names: ['release-notes', 'commit', 'unique-one'], commands: ['commit', 'team:release-notes'] })
  await $.session.start(START)
  await load($)
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain('MCP server "acme": 1 skill.')
  expect(text).toContain('Loaded in this conversation: "release-notes" from the MCP server "acme"')
  expect(text).toContain('Approved by you, each as it was when you approved it: "release-notes"')
  // X9
  expect(text).toContain('Also the name of a skill or command you already have: "release-notes", "commit".')
  expect(text).not.toContain('unique-one"')
})

test('/mcp-skills names the servers it cannot look at: a plugin\'s, a claude.ai connector', async ($, on) => {
  world(on, { tools: ['Bash', 'mcp__acme__search', 'mcp__my_docs__read', 'mcp__mcp-skills__load_skill', 'mcp__claude_ai_Gmail__send', 'mcp__plugin_figma_figma__get_design'] })
  await $.session.start(START)
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain('Not looked at, because they are not in your MCP configuration files (a plugin\'s servers, claude.ai connectors): "claude_ai_Gmail", "plugin_figma_figma".')
})

test('the tools are in Claude\'s list from the start once a server serves skills', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.registered.sort()).toEqual(['list_skill_directory', 'list_skill_directory', 'list_skills', 'list_skills', 'load_skill', 'load_skill', 'read_skill_file', 'read_skill_file'])
})

// A server that hangs used to hold back every other server's skills until its connection timed out
// (10 seconds, past the session's wait): the helper now sends what it has as each server is done.
test('a listing that is not complete yet does not end the wait for the first one; at the end of the wait, what has arrived is listed', async ($, on) => {
  const w = world(on, { partial: true })
  let started = false
  const start = $.session.start(START).then(() => (started = true))
  await w.clock.settle()
  expect(started).toBe(false)
  await w.clock.advance(4000)
  await start
  expect((await $.prompt.attachment(listing)).text).toBe(`${listing.text}\n\n${CATALOG}`)
})

test('with no server known to serve skills, the session starts without waiting for any', async ($, on) => {
  const w = world(on, { expects: 0, catalog: null })
  // The clock is not moved: a start that waited would never finish.
  await $.session.start(START)
  expect(w.spawns).toBe(1)
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
})

test('the helper runs on the Node or Bun the machine has: on the PATH first', async ($, on) => {
  const w = world(on, { runtimes: { bun: '1.3.2' } })
  await $.session.start(START)
  expect(w.spawned[0]![0]).toBe('bun')
})

test('a runtime that is installed but not on Claude Code\'s PATH is found through the login shell, or where installers put it', async ($, on) => {
  const nvm = '/Users/someone/.nvm/versions/node/v22.11.0/bin/node'
  const w = world(on, { env: { SHELL: '/bin/zsh', HOME: '/Users/someone' }, runtimes: { [nvm]: 'v22.11.0' }, shellFinds: `Welcome back!\n${nvm}\n` })
  await $.session.start(START)
  expect(w.spawned[0]!.slice(0, 2)).toEqual([nvm, '--no-warnings'])
})

test('a Bun in its usual folder is found with no shell to ask', async ($, on) => {
  const w = world(on, { env: { HOME: '/Users/someone' }, runtimes: { '/Users/someone/.bun/bin/bun': '1.3.2' } })
  await $.session.start(START)
  expect(w.spawned[0]).toEqual(['/Users/someone/.bun/bin/bun', expect.stringContaining('dist/helper.js') as never])
})

test('with no Node 20 and no Bun anywhere, the person is told in a line, and every way in says what to do', async ($, on) => {
  const w = world(on, { runtimes: { node: 'v18.19.0' } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
  await settle(() => w.toasts.length > 0)
  expect(w.toasts).toEqual(['MCP Skills needs Node 20 or newer, or Bun, and found only Node v18.19.0. Type /mcp-skills for what to do.'])
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain('needs Node 20 or newer, or Bun, to run its helper, and found only Node v18.19.0 on this machine.')
  expect(text).toContain(`Type /mcp-skills setup to have this mod download Bun ${BUN.version} for its own use`)
  expect(text).toContain('Or install Node from https://nodejs.org or Bun from https://bun.sh, then start a new session.')
  const answer = (await $.tool.run({ tool: LOAD, tool_use_id: 'x', server: SKILL.server, uri: SKILL.uri } as never)) as { deny?: string }
  expect(answer.deny).toContain('needs Node 20 or newer, or Bun')
  expect(w.toasts.length).toBe(1)
  // Nothing was fetched: that waits for the person's own command.
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
  // Nothing else is disturbed: Claude Code's own skill listing is as it was.
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
})

test('the notice about a missing runtime opens a few sessions, not every session from then on', async ($, on) => {
  const w = world(on, { runtimes: {}, store: { toldNoRuntime: 3 } })
  await $.session.start(START)
  await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(w.toasts).toEqual([])
})

test('where the mod fetches no runtime (Windows, another system), it does not offer to', async ($, on) => {
  world(on, { runtimes: {}, machine: { uname: 'MINGW64_NT-10.0 x86_64' } })
  await $.session.start(START)
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain('found neither on this machine. Install Node from https://nodejs.org or Bun from https://bun.sh')
  expect(text).not.toContain('/mcp-skills setup')
})

const typed = (args: string) => ({ command: 'mcp-skills', args, origin: { kind: 'composer' } }) as never

test('/mcp-skills setup fetches a runtime only when the person types it: not for the model, a script or an unattended run', async ($, on) => {
  const w = world(on, { runtimes: {} })
  await $.session.start(START)
  for (const origin of [undefined, { kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'scheduled-trigger' }, { kind: 'channel', server: 'x' }]) {
    const { text } = await $.command.run({ command: 'mcp-skills', args: 'setup', ...(origin ? { origin } : {}) } as never)
    expect(text).toContain('it is done only when you type it yourself')
  }
  expect(w.ran.some(([program]) => program === 'curl' || program === 'mkdir')).toBe(false)
})

test('/mcp-skills setup: a download that does not match the pinned checksum is deleted, and nothing of it is run', async ($, on) => {
  const w = world(on, { runtimes: {}, answer: 'Download', machine: { zip: new Uint8Array([1, 2, 3, 4, 5]) } })
  await $.session.start(START)
  const { text } = await $.command.run(typed('setup'))
  expect(text).toContain(`MCP Skills can download Bun ${BUN.version} for its own use, from github.com/oven-sh/bun`)
  expect(text).toContain('nothing is downloaded unless you answer Download')
  await w.clock.settle()
  await w.clock.advance(100)
  await settle(() => w.toasts.some((toast) => toast.includes('does not match')))
  expect(w.asked).toEqual([expect.stringContaining(`Download Bun ${BUN.version} for MCP Skills? It is the official release from github.com/oven-sh/bun`) as never])
  expect(w.toasts.at(-1)).toContain(`does not match the checksum pinned in this mod for Bun ${BUN.version} (bun-darwin-aarch64.zip), so nothing of it was run. If this repeats, please report it. The download was deleted.`)
  const curl = w.ran.find(([program]) => program === 'curl')!
  expect(curl.at(-1)).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/bun-darwin-aarch64.zip`)
  expect(curl.join(' ')).toContain('--proto =https --proto-redir =https')
  expect(w.ran.some(([program]) => program === 'unzip' || program === 'mv' || String(program).startsWith(DATA))).toBe(false)
  expect(Object.keys(w.disk)).toEqual([`${DATA}/runtime`])
  expect(w.spawns).toBe(0)
})

for (const [answer, what] of [[undefined, 'dismisses it'], ['Not now', 'answers Not now'], ['download it please', 'types something else']] as const) {
  test(`/mcp-skills setup downloads nothing when the person ${what} in Claude Code's dialog`, async ($, on) => {
    const w = world(on, { runtimes: {}, ...(answer === undefined ? {} : { answer }) })
    await $.session.start(START)
    await $.command.run(typed('setup'))
    await w.clock.settle()
    await w.clock.advance(100)
    await settle(() => w.toasts.length > 1)
    // The safe answer is the first one offered: a dialog left to itself does not come out as a yes.
    expect(w.asked).toEqual([expect.stringMatching(/^Download Bun .* \[Not now \| Download\]$/) as never])
    expect(w.toasts.at(-1)).toBe('MCP Skills: nothing was downloaded. /mcp-skills setup asks again.')
    expect(w.ran.some(([program]) => program === 'curl' || program === 'mkdir')).toBe(false)
  })
}

test('the pinned release names an https file and a SHA-256 for each platform it is offered on', () => {
  expect(BUN.base).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/`)
  expect(Object.keys(BUN.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl'])
  for (const asset of Object.values(BUN.assets)) {
    expect(asset.name).toMatch(/^bun-(darwin|linux)-(aarch64|x64)(-musl)?(-baseline)?$/)
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(new Set(Object.values(BUN.assets).map((asset) => asset.sha256)).size).toBe(6)
})

// The steps of the fetch, with a release pinned to bytes the test holds (the real one is pinned to the real archive).
const ZIP = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => (i * 31 + 7) % 251)
const pinFor = async (bytes: Uint8Array, platform = 'darwin-arm64', name = 'bun-darwin-aarch64'): Promise<Pin> => ({
  version: '9.8.7',
  base: 'https://example.test/releases/',
  assets: { [platform]: { name, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('') } },
})

test('a fetch that matches is unpacked (one named file), checked to run, and moved into place; the download is deleted', async () => {
  const w = machineOf({ zip: ZIP }, {})
  const got = await install(w.engine, DATA, await pinFor(ZIP))
  expect(got).toEqual({ path: `${DATA}/runtime/bun-9.8.7/bun`, version: '9.8.7', bytes: 64, isNew: true })
  const unzip = w.ran.find(([program]) => program === 'unzip')!
  expect(unzip.slice(1, 4)).toEqual(['-q', '-o', '-j'])
  expect(unzip.slice(5, 7)).toEqual(['bun-darwin-aarch64/bun', '-d'])
  expect(Object.keys(w.disk).sort()).toEqual([`${DATA}/runtime`, `${DATA}/runtime/bun-9.8.7`, `${DATA}/runtime/bun-9.8.7/bun`])
  expect(await fetched(w.engine, DATA)).toEqual([{ path: `${DATA}/runtime/bun-9.8.7/bun`, version: '9.8.7' }])
  // Asked for again, nothing is downloaded.
  const again = await install(w.engine, DATA, await pinFor(ZIP))
  expect(again.isNew).toBe(false)
  expect(w.ran.filter(([program]) => program === 'curl').length).toBe(1)
})

test('a fetch picks the archive for the machine: Linux on x64 gets the build for any x64 processor, and musl its own', async () => {
  const w = machineOf({ zip: ZIP, uname: 'Linux x86_64', ldd: 'musl libc (x86_64)\nVersion 1.2.5' }, {})
  await install(w.engine, DATA, await pinFor(ZIP, 'linux-x64-musl', 'bun-linux-x64-musl-baseline'))
  expect(w.ran.find(([program]) => program === 'curl')!.at(-1)).toBe('https://example.test/releases/bun-linux-x64-musl-baseline.zip')
  expect(BUN.assets['linux-x64']!.name).toBe('bun-linux-x64-baseline')
  expect(BUN.assets['darwin-x64']!.name).toBe('bun-darwin-x64-baseline')
})

test('a fetch that goes wrong leaves nothing behind that could run, and says why', async () => {
  const cases: [Machine, RegExp][] = [
    [{ zip: ZIP, missing: ['curl'] }, /`curl` is needed for the download and was not found/],
    [{ zip: ZIP, curlFails: 'curl: (6) Could not resolve host: example.test' }, /The download did not finish \(curl: \(6\) Could not resolve host: example\.test\)\. Nothing was installed; run \/mcp-skills setup to try again/],
    [{ zip: ZIP, missing: ['unzip'] }, /`unzip` is needed to unpack the download and was not found/],
    [{ zip: ZIP, member: 'none' }, /could not be unpacked/],
    [{ zip: ZIP, member: 'link' }, /The archive did not hold the program expected/],
    [{ zip: ZIP, says: '0.0.1' }, /did not start on this machine \(it answered 0\.0\.1\)/],
    [{ zip: new Uint8Array(0) }, /not the archive that was asked for/],
    [{ zip: ZIP, uname: 'FreeBSD amd64' }, /fetches a runtime only on macOS and Linux/],
  ]
  const pin = await pinFor(ZIP)
  for (const [machine, why] of cases) {
    const w = machineOf(machine, {})
    const error = await install(w.engine, DATA, pin).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(SetupError)
    expect((error as Error).message).toMatch(why)
    expect(Object.keys(w.disk).filter((key) => key !== `${DATA}/runtime`)).toEqual([])
    expect(w.ran.some(([program]) => program === 'mv')).toBe(false)
  }
})

test('a step that does not exit cleanly stops the fetch: a program that cannot be made runnable, a version check that fails', async () => {
  const pin = await pinFor(ZIP)
  const cases: [Machine, RegExp][] = [[{ zip: ZIP, chmodFails: true }, /could not be made runnable/], [{ zip: ZIP, saysExit: 1 }, /did not start on this machine \(it answered 9\.8\.7\)/]]
  for (const [machine, why] of cases) {
    const w = machineOf(machine, {})
    const error = (await install(w.engine, DATA, pin).then(() => undefined, (e: unknown) => e)) as Error
    expect(error.message).toMatch(why)
    // A program that could not be made runnable is never started.
    if (machine.chmodFails) expect(w.ran.some(([program, flag]) => /\/bun$/.test(String(program)) && flag === '--version')).toBe(false)
    expect(Object.keys(w.disk)).toEqual([`${DATA}/runtime`])
  }
})

test('a fetch whose download cannot be deleted says where it is, and leaves nothing in it runnable', async () => {
  const w = machineOf({ zip: new Uint8Array([9, 9, 9]), stuck: [`${DATA}/runtime/incoming-`] }, {})
  const error = (await install(w.engine, DATA, await pinFor(ZIP)).then(() => undefined, (e: unknown) => e)) as Error
  expect(error.message).toMatch(/so nothing of it was run\..*Its folder could not be deleted, and nothing in it is left runnable: \/plugin-data\/runtime\/incoming-/)
  expect(w.ran.some(([program, flag, mode]) => program === 'chmod' && flag === '-R' && mode === 'a-x')).toBe(true)
})

test('a damaged copy of the same version is replaced, not reported as installed', async () => {
  const w = machineOf({ zip: ZIP, disk: { [`${DATA}/runtime/bun-9.8.7`]: { kind: 'dir' } } }, {})
  const got = await install(w.engine, DATA, await pinFor(ZIP))
  expect(got.isNew).toBe(true)
  expect(w.disk[`${DATA}/runtime/bun-9.8.7/bun`]).toBeDefined()
  expect(Object.keys(w.disk).filter((key) => key.includes('bun-9.8.7/bun-9.8.7'))).toEqual([])
})

test('two sessions setting up at once: the second waits its turn instead of putting a copy inside the first\'s', async () => {
  const w = machineOf({ zip: ZIP, disk: { [`${DATA}/runtime`]: { kind: 'dir' }, [`${DATA}/runtime/.lock`]: { kind: 'dir', mtimeMs: 10_000_000 - 60_000 } } }, {})
  const error = (await install(w.engine, DATA, await pinFor(ZIP)).then(() => undefined, (e: unknown) => e)) as Error
  expect(error.message).toContain('Another Claude Code session is setting up this runtime right now')
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
  expect(w.disk[`${DATA}/runtime/.lock`]).toBeDefined()
  // A lock left long ago by a session that ended under it is taken over, and removed when done.
  w.disk[`${DATA}/runtime/.lock`]!.mtimeMs = 0
  expect((await install(w.engine, DATA, await pinFor(ZIP))).isNew).toBe(true)
  expect(w.disk[`${DATA}/runtime/.lock`]).toBeUndefined()
})

test('a Linux whose ldd says nothing is still known to be musl, by its loader', async () => {
  const w = machineOf({ zip: ZIP, uname: 'Linux aarch64', missing: ['ldd'], disk: { '/lib/ld-musl-aarch64.so.1': { kind: 'file' } } }, {})
  await install(w.engine, DATA, await pinFor(ZIP, 'linux-arm64-musl', 'bun-linux-aarch64-musl'))
  expect(w.ran.find(([program]) => program === 'curl')!.at(-1)).toBe('https://example.test/releases/bun-linux-aarch64-musl.zip')
})

test('a fetched copy whose version check exits with an error is not used', async () => {
  const w = machineOf({ saysExit: 1, disk: { [`${DATA}/runtime/bun-9.8.7`]: { kind: 'dir' }, [`${DATA}/runtime/bun-9.8.7/bun`]: { kind: 'file' } } }, {})
  expect(await fetched(w.engine, DATA)).toEqual([])
})

test('an earlier version, and what a fetch that was cut short left behind, are cleared away', async () => {
  const w = machineOf({ zip: ZIP, disk: { [`${DATA}/runtime/bun-9.0.0`]: { kind: 'dir' }, [`${DATA}/runtime/bun-9.0.0/bun`]: { kind: 'file' }, [`${DATA}/runtime/incoming-1-abc`]: { kind: 'dir' }, [`${DATA}/runtime/incoming-1-abc/half.zip`]: { kind: 'file' } } }, {})
  await install(w.engine, DATA, await pinFor(ZIP))
  expect(Object.keys(w.disk).sort()).toEqual([`${DATA}/runtime`, `${DATA}/runtime/bun-9.8.7`, `${DATA}/runtime/bun-9.8.7/bun`])
})

test('the helper runs on the mod\'s own copy of Bun where the machine has no other, and /mcp-skills says so', async ($, on) => {
  const own = `${DATA}/runtime/bun-${BUN.version}/bun`
  const w = world(on, { runtimes: {}, machine: { disk: { [`${DATA}/runtime/bun-${BUN.version}`]: { kind: 'dir' }, [own]: { kind: 'file' } } } })
  await $.session.start(START)
  expect(w.spawned[0]).toEqual([own, expect.stringContaining('dist/helper.js') as never])
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain(`The helper runs on its own copy of Bun ${BUN.version}. /mcp-skills setup remove deletes it.`)
  expect(w.toasts).toEqual([])
})

const OWN = `${DATA}/runtime/bun-${BUN.version}`
const OWN_DISK = { [OWN]: { kind: 'dir' as const }, [`${OWN}/bun`]: { kind: 'file' as const } }

test('a Node or Bun of the person\'s own is used before the mod\'s copy', async ($, on) => {
  const w = world(on, { machine: { disk: OWN_DISK } })
  await $.session.start(START)
  expect(w.spawned[0]![0]).toBe('node')
})

test('a fetched copy that no longer answers as itself is not used', async ($, on) => {
  const w = world(on, { runtimes: {}, machine: { disk: OWN_DISK, says: '' } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
})

test('MCP_SKILLS_RUNTIME names the runtime to use, and nothing else is tried', async ($, on) => {
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: '/opt/tools/node22/bin/node' }, runtimes: { node: 'v22.18.0', '/opt/tools/node22/bin/node': 'v22.9.0' } })
  await $.session.start(START)
  expect(w.spawned[0]).toEqual(['/opt/tools/node22/bin/node', '--no-warnings', expect.stringContaining('dist/helper.js') as never])
  expect(w.ran.some(([program]) => program === 'node')).toBe(false)
})

test('MCP_SKILLS_RUNTIME naming something that does not run is said, and nothing else is tried in its place', async ($, on) => {
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: '/nowhere/bun' }, runtimes: { node: 'v22.18.0' }, machine: { disk: OWN_DISK } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
  expect((await $.command.run({ command: 'mcp-skills', args: '' } as never)).text).toContain('MCP_SKILLS_RUNTIME names "/nowhere/bun", which is not a Node 20 or newer, or a Bun, that runs.')
})

test('MCP_SKILLS_RUNTIME=private means only the mod\'s own copy: with none yet, the person is told how to fetch it', async ($, on) => {
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
  expect((await $.command.run({ command: 'mcp-skills', args: '' } as never)).text).toContain('MCP_SKILLS_RUNTIME=private says to run the helper only on this mod\'s own copy of Bun, and there is none yet. Type /mcp-skills setup')
})

test('MCP_SKILLS_RUNTIME=private with a copy fetched: the helper runs on it though the machine has Node', async ($, on) => {
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' }, machine: { disk: OWN_DISK } })
  await $.session.start(START)
  expect(w.spawned[0]![0]).toBe(`${OWN}/bun`)
})

test('MCP_SKILLS_RUNTIME=private runs only the pinned version: a newer-looking copy put beside it is never run', async ($, on) => {
  const planted = `${DATA}/runtime/bun-99.0.0`
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' }, machine: { disk: { ...OWN_DISK, [planted]: { kind: 'dir' }, [`${planted}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  expect(w.spawned[0]![0]).toBe(`${OWN}/bun`)
  expect(w.spawned.some(([program]) => program === `${planted}/bun`)).toBe(false)
})

test('MCP_SKILLS_RUNTIME=private with only a copy of another version: nothing is run', async ($, on) => {
  const other = `${DATA}/runtime/bun-1.0.0`
  const w = world(on, { env: { MCP_SKILLS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' }, machine: { disk: { [other]: { kind: 'dir' }, [`${other}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
})

test('/mcp-skills setup on a machine whose own Node already runs the helper fetches nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await $.command.run(typed('setup'))).text).toContain('already runs on a Node or Bun found on this machine, so there is nothing to set up')
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
})

test('/mcp-skills setup remove says which copies could not be deleted, instead of claiming they were', async ($, on) => {
  const own = `${DATA}/runtime/bun-${BUN.version}`
  world(on, { machine: { stuck: [own], disk: { [own]: { kind: 'dir' }, [`${own}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  expect((await $.command.run(typed('setup remove'))).text).toBe(`This could not be deleted, and is left not runnable: ${own}. Delete it by hand.`)
})

test('/mcp-skills setup remove deletes the mod\'s own copy', async ($, on) => {
  const own = `${DATA}/runtime/bun-${BUN.version}`
  const w = world(on, { machine: { disk: { [own]: { kind: 'dir' }, [`${own}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  expect((await $.command.run(typed('setup remove'))).text).toContain('Deleted this mod\'s own copy of Bun.')
  expect(Object.keys(w.disk)).toEqual([])
  expect((await $.command.run(typed('setup remove'))).text).toBe('This mod has no copy of Bun of its own.')
})

test('the helper uses only servers Claude Code itself uses: each is asked about, and the verdict passed on', async ($, on) => {
  const w = world(on, { servers: ['acme', 'off', 'signin', 'down'], connect: { off: { isConnected: false, reason: 'disabled', message: '' }, signin: { isConnected: false, reason: 'auth', message: '' }, down: { isConnected: false, reason: 'failed', message: '' } } })
  await $.session.start(START)
  await settle(() => w.posts.filter((p) => p.route === '/verdict').length >= 4)
  const verdicts = Object.fromEntries(w.posts.filter((p) => p.route === '/verdict').map((p) => [p.body.name, p.body.ok === true ? 'used' : p.body.reason]))
  expect(verdicts).toEqual({ acme: 'used', off: 'disabled', signin: 'auth', down: 'used' })
})

test('stand-down: with MCP_SKILLS_OFF=1 the mod starts nothing, lists nothing and serves nothing', async ($, on) => {
  const w = world(on, { env: { MCP_SKILLS_OFF: '1' } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
  expect(w.registered).toEqual([])
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
  const answer = (await $.tool.run({ tool: LOAD, tool_use_id: 'x', server: SKILL.server, uri: SKILL.uri } as never)) as { deny?: string }
  expect(answer.deny).toContain('MCP Skills is off in this session')
})

test('stand-down: once Claude Code itself expands a skill whose words are an MCP server\'s, the mod is off for the session', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await $.prompt.attachment(listing)).text).toContain('MCP Skills extension')
  // A local skill changes nothing.
  await $.skill.prompt({ skill: 'commit', text: 'Commit.', frontmatter: {}, source: 'userSettings' })
  expect((await $.prompt.attachment(listing)).text).toContain('MCP Skills extension')
  await $.skill.prompt({ skill: 'acme:release-notes', text: 'Write release notes.', frontmatter: {}, source: 'mcp' })
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
  const answer = (await $.tool.run({ tool: LOAD, tool_use_id: 'x', server: SKILL.server, uri: SKILL.uri } as never)) as { deny?: string }
  expect(answer.deny).toContain('Claude Code loaded a skill from an MCP server itself')
  await settle(() => w.posts.some((p) => p.route === '/stop'))
  expect(w.posts.some((p) => p.route === '/stop')).toBe(true)
})

test('stand-down does not end a window: a skill this mod loaded unapproved earlier still has its commands asked about, or refused', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  await load($, { approver: null })
  await $.skill.prompt({ skill: 'acme:other', text: 'x', frontmatter: {}, source: 'mcp' })
  expect((await $.tool.check(present(bash))).decision).toBe('ask')
  expect((await $.tool.check(bash)).decision).toBe('deny')
})

// ---- H1: per-skill enable and disable (SEP-2640's host guidance: the model's context holds each
// enabled skill; the person's list offers per-skill enable/disable, with provenance).

const KEY = `${SKILL.server}\n${SKILL.uri}`
const disabledIn = (w: World) => (w.store.disabled ?? {}) as Record<string, { name: string; at: number }>
const OFF = { disabled: { [KEY]: { name: SKILL.name, at: 1 } } }
const loadsAsked = (w: World) => w.posts.filter((p) => (p.route === '/tool' && (p.body as { name?: unknown }).name === 'load_skill') || p.route === '/entry').length

test('H1: /mcp-skills disable keeps the skill by its identity, and from then on it is refused at the permission check and when it runs, whatever a rule says', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'mcp__mcp-skills__load_skill' } })
  await $.session.start(START)
  const { text } = await $.command.run(typed('disable release-notes'))
  expect(text).toContain('Disabled "release-notes" from the MCP server "acme" (skill://release-notes/SKILL.md). Claude is not offered it from now on')
  expect(Object.keys(disabledIn(w))).toEqual([KEY])
  // The helper is told, by identity.
  expect(w.told.at(-1)).toEqual([{ server: SKILL.server, uri: SKILL.uri }])
  const before = loadsAsked(w)
  const { verdict, ran } = await load($)
  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toContain('You disabled the skill "release-notes" from the MCP server "acme"')
  expect(ran.deny).toContain('You disabled the skill "release-notes"')
  // A call that reached the tool with no permission check (another mod's) is refused too.
  const unchecked = (await $.tool.run({ tool: LOAD, tool_use_id: 'u1', server: SKILL.server, uri: SKILL.uri } as never)) as { deny?: string }
  expect(unchecked.deny).toContain('You disabled the skill')
  expect(loadsAsked(w)).toBe(before)
  // The same URI on another server is another skill.
  expect((await load($, { server: 'other' })).ran.result).toContain(LOADED)
})

test('H1: a disabled skill is not in the listing Claude reads: the listing is composed again without it', async ($, on) => {
  world(on)
  await $.session.start(START)
  expect((await $.prompt.attachment(listing)).text).toBe(`${listing.text}\n\n${CATALOG}`)
  await $.command.run(typed('disable release-notes'))
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
})

test('H1: a listing the helper made before it was told which skills are disabled is not used', async ($, on) => {
  world(on, { staleCatalog: true, store: OFF })
  await $.session.start(START)
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
})

test('H1: a skill disabled in another session is refused here, and the helper is told before its listing is used again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await $.prompt.attachment(listing)).text).toContain(CATALOG)
  // Another session on this machine writes the store.
  w.store.disabled = OFF.disabled
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
  expect(w.told.at(-1)).toEqual([{ server: SKILL.server, uri: SKILL.uri }])
  expect((await load($)).ran.deny).toContain('You disabled the skill')
})

test('H1: a skill disabled while its load waits for the person, or while the helper fetches it, is not handed to Claude', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const id = 'late-1'
  const input = { server: SKILL.server, uri: SKILL.uri }
  expect((await $.tool.check({ tool: LOAD, input, tool_use_id: id, approver: 'person' } as never)).decision).toBe('ask')
  await $.command.run(typed('disable release-notes'))
  expect(((await $.tool.run({ tool: LOAD, tool_use_id: id, ...input } as never)) as { deny?: string }).deny).toContain('You disabled the skill')
  await $.command.run(typed('enable release-notes'))
  // Disabled in another session while the helper fetched the skill: the text it fetched is dropped, and the helper lets go of it.
  w.duringTool = () => (w.store.disabled = OFF.disabled)
  const { ran } = await load($)
  expect(ran.deny).toContain('You disabled the skill')
  expect(ran.result).toBeUndefined()
  await settle(() => w.posts.some((p) => p.route === '/release'))
  expect(w.posts.find((p) => p.route === '/release')?.body).toEqual({ server: SKILL.server, uri: SKILL.uri })
})

test('H1: disabling a loaded skill takes nothing back: its files are not read, and the gate of an unapproved one stays until the conversation is cleared', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  await load($, { approver: null })
  const { text } = await $.command.run(typed('disable release-notes'))
  expect(text).toContain('It was loaded in this conversation already')
  for (const tool of ['read_skill_file', 'list_skill_directory']) {
    const ran = (await $.tool.run({ tool: `mcp__mcp-skills__${tool}`, tool_use_id: `r-${tool}`, server: SKILL.server, skill: SKILL.uri, path: 'references/codenames.md' } as never)) as { deny?: string }
    expect(ran.deny).toContain('You disabled the skill')
  }
  expect((await $.tool.check(bash)).decision).toBe('deny')
})

test('H1: only the person enables a skill again, and enabling approves nothing: a yes given before stands as it did', async ($, on) => {
  const w = world(on, { store: { ...OFF, approvals: { [KEY]: { hash: FACTS.hash, fingerprint: FACTS.fingerprint, name: SKILL.name, at: 1 } } } })
  await $.session.start(START)
  for (const origin of [undefined, { kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }]) {
    const { text } = await $.command.run({ command: 'mcp-skills', args: 'enable release-notes', ...(origin ? { origin } : {}) } as never)
    expect(text).toContain('Only you can enable a skill you disabled')
  }
  expect(Object.keys(disabledIn(w))).toEqual([KEY])
  expect((await $.command.run(typed('enable release-notes'))).text).toContain('Enabled "release-notes" from the MCP server "acme".')
  expect(disabledIn(w)).toEqual({})
  expect(w.told.at(-1)).toEqual([])
  const again = await load($)
  expect(again.verdict.decision).toBe('allow')
  expect(again.ran.result).toBe(`${APPROVED}\n${LOADED}`)
  // Enabled once with no approval kept: the load is put to the person.
  delete w.store.approvals
  expect((await load($)).verdict.decision).toBe('ask')
})

test('H1: a skill its server no longer lists can still be enabled, by name, server:name or URI', async ($, on) => {
  const w = world(on, { store: OFF, found: [] })
  await $.session.start(START)
  for (const what of ['release-notes', 'acme:release-notes', SKILL.uri, `acme:${SKILL.uri}`]) {
    w.store.disabled = OFF.disabled
    expect([what, (await $.command.run(typed(`enable ${what}`))).text]).toEqual([what, expect.stringContaining('Enabled "release-notes"')])
  }
  expect((await $.command.run(typed('enable nothing-here'))).text).toContain('No skill you disabled is named "nothing-here"')
})

test('H1: at most 2,000 skills are kept disabled: past that a disable is refused, and none is dropped to make room', async ($, on) => {
  const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`acme\nskill://s${i}/SKILL.md`, { name: `s${i}`, at: i }]))
  const w = world(on, { store: { disabled: many } })
  await $.session.start(START)
  expect((await $.command.run(typed('disable release-notes'))).text).toContain('2000 skills are disabled, the most this mod keeps')
  expect(Object.keys(disabledIn(w)).length).toBe(2000)
  expect(disabledIn(w)[KEY]).toBeUndefined()
  expect(disabledIn(w)['acme\nskill://s0/SKILL.md']).toBeDefined()
})

test('H1: a disable the store cannot keep holds in this session all the same, and says so', async ($, on) => {
  world(on, { storeFull: true })
  await $.session.start(START)
  expect((await $.command.run(typed('disable release-notes'))).text).toContain('in this session only, until Claude Code is restarted')
  expect((await load($)).ran.deny).toContain('You disabled the skill')
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
})

test('H1: where the store of disabled skills cannot be read, nothing served is listed or loaded', async ($, on) => {
  world(on, { storeBroken: true })
  await $.session.start(START)
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
  const { verdict, ran } = await load($)
  expect(verdict.decision).toBe('ask')
  expect(ran.deny).toContain('could not read which skills you disabled')
})

test('H1: /mcp-skills names the skills you disabled, with their servers; use refuses one; show still lets you read it', async ($, on) => {
  const w = world(on, { store: OFF })
  await $.session.start(START)
  const { text } = await $.command.run(typed(''))
  expect(text).toContain('Disabled by you, so Claude is not offered them and cannot load or read them: "release-notes" from the MCP server "acme". /mcp-skills enable <skill> turns one back on.')
  expect((await $.command.run(typed('use release-notes'))).text).toContain('You disabled "release-notes" from the MCP server "acme", so Claude cannot load it.')
  await w.clock.advance(100)
  expect(w.submitted).toEqual([])
  expect((await $.command.run(typed('show release-notes'))).text).toContain('is open in a panel for you to read')
  const ui = await $.ui.mount({ plugin: 'mcp-skills', surface: 'terminal', component: 'Pane', requestId: 'mcp-skills-preview', props: { title: 'release-notes', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
  expect((await ui.find({ type: 'Text', text: /Served by the MCP server "acme"/ }))?.text).toContain('You disabled it: Claude is not offered it.')
  await ui.unmount()
})
