// What runs the helper, and `/mcp-events setup`, the mod's own copy of Bun for a machine with no
// Node and no Bun: run by `claude plugin test mod` against the engine itself, with stand-ins for the
// machine beneath it (the programs it can run, the files it sees) and for the helper. Adapted from
// the tests of the same mechanism in the mcp-skills mod for Claude Code (its mod/hooks/gates.test.ts;
// that mod has been removed from this repository and is in its history).

import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import { BUN, SetupError, install, pinned, type Pin } from './runtime'

declare const setTimeout: (run: (value?: unknown) => void, ms: number) => unknown
declare const btoa: (text: string) => string
declare const crypto: { subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } }

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const DATA = '/plugin-data'
const READY = JSON.stringify({ t: 'ready', url: 'http://127.0.0.1:9', token: 'tok' })

type Disk = Record<string, { kind: 'file' | 'dir'; bytes?: Uint8Array; isLink?: boolean; mtimeMs?: number }>
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
  disk?: Disk
}

/** The machine beneath the mod: used under the hooks (world), and by itself, as the engine, where a test calls the fetch directly. */
function machineOf(m: Machine, runtimesGiven?: Record<string, string>, shellFinds?: string) {
  const ran: string[][] = []
  const disk: Disk = { ...(m.disk ?? {}) }
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
    // A copy of Bun in the mod's folder answers with the version its folder is named for.
    const copy = /\/bun-(\d+\.\d+\.\d+)\/bun$/.exec(program)
    if (copy && disk[program]) return { exitCode: m.saysExit ?? 0, stdout: `${m.says ?? copy[1]}\n`, stderr: '' }
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
  const engine = {
    process: { run: async (argv: string[]) => run(argv) },
    fs: { exists: async (path: string) => exists(path), stat: async (path: string) => stat(path), list: async (path: string) => list(path), read: async (path: string, o: { offset?: number; length?: number }) => read(path, o.offset, o.length) },
    clock: { now: async () => 10_000_000 },
  } as unknown as EngineInterface
  return { ran, disk, run, exists, stat, list, read, engine }
}

/** The engine beneath the mod, and a helper that says it is ready and then runs for the session. */
function world(on: On, o: { /** The person's answer in Claude Code's dialog; absent, they dismiss it. */ answer?: string; machine?: Machine; env?: Record<string, string>; /** What each command answers to --version. Default: node on the PATH. */ runtimes?: Record<string, string>; shellFinds?: string } = {}) {
  const w = { spawned: [] as string[][], toasts: [] as string[], asked: [] as string[], clock: mock.clock(on), ran: [] as string[][], disk: {} as Disk }
  const box = machineOf(o.machine ?? {}, o.runtimes, o.shellFinds)
  w.ran = box.ran
  w.disk = box.disk
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: (o.env ?? {})[e.name] }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: DATA, CLAUDE_CODE_SESSION_ATTENDED: '1' } }))
  on('process.run', (_, e) => ({ value: box.run(e.argv) as never }))
  on('fs.exists', (_, e) => ({ value: box.exists(e.path) }))
  on('fs.stat', (_, e) => ({ value: box.stat(e.path) as never }))
  on('fs.list', (_, e) => ({ value: box.list(e.path) as never }))
  on('fs.read', (_, e) => ({ value: box.read(e.path, e.offset, e.length) as never }))
  on('process.spawn', async function* (_, e) {
    w.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: `${READY}\n` }
    await new Promise<void>(() => {})
    return { value: { exitCode: 0 } } as never
  })
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: '{}' } as never }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-events__${e.name}` } as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } as never }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  // $.ui.ask is Claude Code's AskUserQuestion dialog: the person's answer, by the question's text.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions = [] } = e as unknown as { questions?: { question: string; options: { label: string }[] }[] }
    w.asked.push(...questions.map((q) => `${q.question} [${q.options.map((option) => option.label).join(' | ')}]`))
    if (o.answer === undefined) return { deny: 'The user dismissed the question.' } as never
    return { result: { questions, answers: Object.fromEntries(questions.map((q) => [q.question, o.answer])) } } as never
  })
  on('tool.check', (_, e) => (e.tool === 'AskUserQuestion' ? { decision: 'allow' } : { decision: 'ask' }) as never)
  return w
}

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
}
const typed = (args: string) => ({ command: 'mcp-events', args, origin: { kind: 'composer' } }) as never
const status = (args = '') => ({ command: 'mcp-events', args }) as never
const OWN = `${DATA}/runtime/bun-${BUN.version}`
const OWN_DISK: Disk = { [OWN]: { kind: 'dir' }, [`${OWN}/bun`]: { kind: 'file' } }

// ---- What runs the helper.

test('the helper runs on the Node or Bun the machine has: on the PATH first', async ($, on) => {
  const w = world(on, { runtimes: { bun: '1.3.2' } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]![0]).toBe('bun')
})

test("a runtime that is installed but not on Claude Code's PATH is found through the login shell, or where installers put it", async ($, on) => {
  const nvm = '/Users/someone/.nvm/versions/node/v22.11.0/bin/node'
  const w = world(on, { env: { SHELL: '/bin/zsh', HOME: '/Users/someone' }, runtimes: { [nvm]: 'v22.11.0' }, shellFinds: `Welcome back!\n${nvm}\n` })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]!.slice(0, 2)).toEqual([nvm, '--no-warnings'])
})

test('a Bun in its usual folder is found with no shell to ask', async ($, on) => {
  const w = world(on, { env: { HOME: '/Users/someone' }, runtimes: { '/Users/someone/.bun/bin/bun': '1.3.2' } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]).toEqual(['/Users/someone/.bun/bin/bun', expect.stringContaining('dist/helper.js') as never])
})

test('with no Node 20 and no Bun anywhere, the person is told in a line, and /mcp-events and the tools say what to do', async ($, on) => {
  const w = world(on, { runtimes: { node: 'v18.19.0' } })
  await $.session.start(START)
  await settle(() => w.toasts.length > 0)
  expect(w.spawned.length).toBe(0)
  expect(w.toasts).toEqual(['MCP Events needs Node 20 or newer, or Bun, and found only Node v18.19.0. Type /mcp-events for what to do.'])
  const { text } = await $.command.run(status())
  expect(text).toContain('needs Node 20 or newer, or Bun, to run its helper, and found only Node v18.19.0 on this machine.')
  expect(text).toContain(`Type /mcp-events setup to have this mod download Bun ${BUN.version} for its own use`)
  expect(text).toContain('Or install Node from https://nodejs.org or Bun from https://bun.sh, then start a new session.')
  const answer = (await $.tool.run({ tool: 'mcp__mcp-events__list_watches', tool_use_id: 'x' } as never)) as { deny?: string }
  expect(String(answer.deny)).toContain('needs Node 20 or newer, or Bun')
  // Nothing was fetched: that waits for the person's own command.
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
})

test('where the mod fetches no runtime (Windows, another system), it does not offer to', async ($, on) => {
  world(on, { runtimes: {}, machine: { uname: 'MINGW64_NT-10.0 x86_64' } })
  await $.session.start(START)
  const { text } = await $.command.run(status())
  expect(text).toContain('found neither on this machine. Install Node from https://nodejs.org or Bun from https://bun.sh')
  expect(text).not.toContain('/mcp-events setup')
})

test("the helper runs on the mod's own copy of Bun where the machine has no other, and /mcp-events says so", async ($, on) => {
  const w = world(on, { runtimes: {}, machine: { disk: OWN_DISK } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]).toEqual([`${OWN}/bun`, expect.stringContaining('dist/helper.js') as never])
  expect((await $.command.run(status())).text).toContain(`The MCP Events helper runs on its own copy of Bun ${BUN.version}. /mcp-events setup remove deletes it.`)
  expect(w.toasts).toEqual([])
})

test("a Node or Bun of the person's own is used before the mod's copy", async ($, on) => {
  const w = world(on, { machine: { disk: OWN_DISK } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]![0]).toBe('node')
})

test('a fetched copy that no longer answers as itself is not used', async ($, on) => {
  const w = world(on, { runtimes: {}, machine: { disk: OWN_DISK, says: '' } })
  await $.session.start(START)
  await settle(() => w.toasts.length > 0)
  expect(w.spawned.length).toBe(0)
})

test('only the pinned version is ever run: a copy of another version beside it is not run, not even for its version', async ($, on) => {
  const planted = `${DATA}/runtime/bun-99.0.0`
  const w = world(on, { runtimes: {}, machine: { disk: { ...OWN_DISK, [planted]: { kind: 'dir' }, [`${planted}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]![0]).toBe(`${OWN}/bun`)
  expect(w.ran.some(([program]) => program === `${planted}/bun`)).toBe(false)
})

test('with only a copy of another version, nothing of it is run', async ($, on) => {
  const other = `${DATA}/runtime/bun-1.0.0`
  const w = world(on, { runtimes: {}, machine: { disk: { [other]: { kind: 'dir' }, [`${other}/bun`]: { kind: 'file' } } } })
  await $.session.start(START)
  await settle(() => w.toasts.length > 0)
  expect(w.spawned.length).toBe(0)
  expect(w.ran.some(([program]) => program === `${other}/bun`)).toBe(false)
})

test('MCP_EVENTS_RUNTIME names the runtime to use, and nothing else is tried', async ($, on) => {
  const w = world(on, { env: { MCP_EVENTS_RUNTIME: '/opt/tools/node22/bin/node' }, runtimes: { node: 'v22.18.0', '/opt/tools/node22/bin/node': 'v22.9.0' } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]).toEqual(['/opt/tools/node22/bin/node', '--no-warnings', expect.stringContaining('dist/helper.js') as never])
  expect(w.ran.some(([program]) => program === 'node')).toBe(false)
})

test('MCP_EVENTS_RUNTIME naming something that does not run is said, and nothing else is tried in its place', async ($, on) => {
  const w = world(on, { env: { MCP_EVENTS_RUNTIME: '/nowhere/bun' }, runtimes: { node: 'v22.18.0' }, machine: { disk: OWN_DISK } })
  await $.session.start(START)
  await settle(() => w.toasts.length > 0)
  expect(w.spawned.length).toBe(0)
  expect((await $.command.run(status())).text).toContain('MCP_EVENTS_RUNTIME names "/nowhere/bun", which is not a Node 20 or newer, or a Bun, that runs.')
})

test("MCP_EVENTS_RUNTIME=private means only the mod's own copy: with none yet, the person is told how to fetch it", async ($, on) => {
  const w = world(on, { env: { MCP_EVENTS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' } })
  await $.session.start(START)
  await settle(() => w.toasts.length > 0)
  expect(w.spawned.length).toBe(0)
  expect((await $.command.run(status())).text).toContain("MCP_EVENTS_RUNTIME=private says to run the helper only on this mod's own copy of Bun, and there is none yet. Type /mcp-events setup")
})

test('MCP_EVENTS_RUNTIME=private with a copy fetched: the helper runs on it though the machine has Node', async ($, on) => {
  const w = world(on, { env: { MCP_EVENTS_RUNTIME: 'private' }, runtimes: { node: 'v22.18.0' }, machine: { disk: OWN_DISK } })
  await $.session.start(START)
  await settle(() => w.spawned.length > 0)
  expect(w.spawned[0]![0]).toBe(`${OWN}/bun`)
})

// ---- /mcp-events setup.

test('/mcp-events setup fetches a runtime only when the person types it: not for the model, a script, another session or an unattended run', async ($, on) => {
  const w = world(on, { runtimes: {} })
  await $.session.start(START)
  for (const origin of [undefined, { kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'scheduled-trigger' }, { kind: 'channel', server: 'x' }]) {
    const { text } = await $.command.run({ command: 'mcp-events', args: 'setup', ...(origin ? { origin } : {}) } as never)
    expect(text).toContain('it is done only when you type it yourself')
  }
  expect(w.ran.some(([program]) => program === 'curl' || program === 'mkdir')).toBe(false)
})

test('/mcp-events setup: a download that does not match the pinned checksum is deleted, and nothing of it is run', async ($, on) => {
  const w = world(on, { runtimes: {}, answer: 'Download', machine: { zip: new Uint8Array([1, 2, 3, 4, 5]) } })
  await $.session.start(START)
  const { text } = await $.command.run(typed('setup'))
  expect(text).toContain(`MCP Events can download Bun ${BUN.version} for its own use, from github.com/oven-sh/bun`)
  expect(text).toContain('nothing is downloaded unless you answer Download')
  await w.clock.settle()
  await w.clock.advance(100)
  await settle(() => w.toasts.some((toast) => toast.includes('does not match')))
  expect(w.asked).toEqual([expect.stringContaining(`Download Bun ${BUN.version} for MCP Events? It is the official release from github.com/oven-sh/bun`) as never])
  expect(w.toasts.at(-1)).toContain(`does not match the checksum pinned in this mod for Bun ${BUN.version} (bun-darwin-aarch64.zip), so nothing of it was run. If this repeats, please report it. The download was deleted.`)
  const curl = w.ran.find(([program]) => program === 'curl')!
  expect(curl.at(-1)).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/bun-darwin-aarch64.zip`)
  expect(curl.join(' ')).toContain('--proto =https --proto-redir =https')
  expect(w.ran.some(([program]) => program === 'unzip' || program === 'mv' || String(program).startsWith(DATA))).toBe(false)
  expect(Object.keys(w.disk)).toEqual([`${DATA}/runtime`])
  expect(w.spawned.length).toBe(0)
})

for (const [answer, what] of [[undefined, 'dismisses it'], ['Not now', 'answers Not now'], ['download it please', 'types something else']] as const) {
  test(`/mcp-events setup downloads nothing when the person ${what} in Claude Code's dialog`, async ($, on) => {
    const w = world(on, { runtimes: {}, ...(answer === undefined ? {} : { answer }) })
    await $.session.start(START)
    await $.command.run(typed('setup'))
    await w.clock.settle()
    await w.clock.advance(100)
    await settle(() => w.toasts.length > 1)
    // The safe answer is the first one offered: a dialog left to itself does not come out as a yes.
    expect(w.asked).toEqual([expect.stringMatching(/^Download Bun .* \[Not now \| Download\]$/) as never])
    expect(w.toasts.at(-1)).toBe('MCP Events: nothing was downloaded. /mcp-events setup asks again.')
    expect(w.ran.some(([program]) => program === 'curl' || program === 'mkdir')).toBe(false)
  })
}

test('/mcp-events setup on a machine whose own Node already runs the helper fetches nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await $.command.run(typed('setup'))).text).toContain('already runs on a Node or Bun found on this machine, so there is nothing to set up')
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
})

test('/mcp-events setup remove says which copies could not be deleted, instead of claiming they were', async ($, on) => {
  world(on, { machine: { stuck: [OWN], disk: OWN_DISK } })
  await $.session.start(START)
  expect((await $.command.run(typed('setup remove'))).text).toBe(`This could not be deleted, and is left not runnable: ${OWN}. Delete it by hand.`)
})

test("/mcp-events setup remove deletes the mod's own copy", async ($, on) => {
  const w = world(on, { machine: { disk: OWN_DISK } })
  await $.session.start(START)
  expect((await $.command.run(typed('setup remove'))).text).toContain("Deleted this mod's own copy of Bun.")
  expect(Object.keys(w.disk)).toEqual([])
  expect((await $.command.run(typed('setup remove'))).text).toBe('This mod has no copy of Bun of its own.')
})

// ---- The fetch itself, with a release pinned to bytes the test holds (the real one is pinned to the real archive).

test('the pinned release names an https file and a SHA-256 for each platform it is offered on, the same as the mcp-skills mod pins', () => {
  expect(BUN.base).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/`)
  expect(Object.keys(BUN.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl'])
  for (const asset of Object.values(BUN.assets)) {
    expect(asset.name).toMatch(/^bun-(darwin|linux)-(aarch64|x64)(-musl)?(-baseline)?$/)
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(new Set(Object.values(BUN.assets).map((asset) => asset.sha256)).size).toBe(6)
})

const ZIP = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => (i * 31 + 7) % 251)
const pinFor = async (bytes: Uint8Array, platform = 'darwin-arm64', name = 'bun-darwin-aarch64'): Promise<Pin> => ({
  version: '9.8.7',
  base: 'https://example.test/releases/',
  assets: { [platform]: { name, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('') } },
})

test('a fetch that matches is unpacked (one named file), checked to run, and moved into place; the download is deleted', async () => {
  const w = machineOf({ zip: ZIP }, {})
  const pin = await pinFor(ZIP)
  const got = await install(w.engine, DATA, pin)
  expect(got).toEqual({ path: `${DATA}/runtime/bun-9.8.7/bun`, version: '9.8.7', bytes: 64, isNew: true })
  const unzip = w.ran.find(([program]) => program === 'unzip')!
  expect(unzip.slice(1, 4)).toEqual(['-q', '-o', '-j'])
  expect(unzip.slice(5, 7)).toEqual(['bun-darwin-aarch64/bun', '-d'])
  expect(Object.keys(w.disk).sort()).toEqual([`${DATA}/runtime`, `${DATA}/runtime/bun-9.8.7`, `${DATA}/runtime/bun-9.8.7/bun`])
  expect(await pinned(w.engine, DATA, pin)).toEqual({ path: `${DATA}/runtime/bun-9.8.7/bun`, version: '9.8.7' })
  // Asked for again, nothing is downloaded.
  expect((await install(w.engine, DATA, pin)).isNew).toBe(false)
  expect(w.ran.filter(([program]) => program === 'curl').length).toBe(1)
})

test('a fetch picks the archive for the machine: Linux on x64 gets the build for any x64 processor, and musl its own', async () => {
  const w = machineOf({ zip: ZIP, uname: 'Linux x86_64', ldd: 'musl libc (x86_64)\nVersion 1.2.5' }, {})
  await install(w.engine, DATA, await pinFor(ZIP, 'linux-x64-musl', 'bun-linux-x64-musl-baseline'))
  expect(w.ran.find(([program]) => program === 'curl')!.at(-1)).toBe('https://example.test/releases/bun-linux-x64-musl-baseline.zip')
})

test('a Linux whose ldd says nothing is still known to be musl, by its loader', async () => {
  const w = machineOf({ zip: ZIP, uname: 'Linux aarch64', missing: ['ldd'], disk: { '/lib/ld-musl-aarch64.so.1': { kind: 'file' } } }, {})
  await install(w.engine, DATA, await pinFor(ZIP, 'linux-arm64-musl', 'bun-linux-aarch64-musl'))
  expect(w.ran.find(([program]) => program === 'curl')!.at(-1)).toBe('https://example.test/releases/bun-linux-aarch64-musl.zip')
})

test('a fetch that goes wrong leaves nothing behind that could run, and says why', async () => {
  const cases: [Machine, RegExp][] = [
    [{ zip: ZIP, missing: ['curl'] }, /`curl` is needed for the download and was not found/],
    [{ zip: ZIP, curlFails: 'curl: (6) Could not resolve host: example.test' }, /The download did not finish \(curl: \(6\) Could not resolve host: example\.test\)\. Nothing was installed; run \/mcp-events setup to try again/],
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

test("two sessions setting up at once: the second waits its turn instead of putting a copy inside the first's", async () => {
  const w = machineOf({ zip: ZIP, disk: { [`${DATA}/runtime`]: { kind: 'dir' }, [`${DATA}/runtime/.lock`]: { kind: 'dir', mtimeMs: 10_000_000 - 60_000 } } }, {})
  const error = (await install(w.engine, DATA, await pinFor(ZIP)).then(() => undefined, (e: unknown) => e)) as Error
  expect(error.message).toContain('Another Claude Code session is setting up this runtime right now')
  expect(w.ran.some(([program]) => program === 'curl')).toBe(false)
  // A lock left long ago by a session that ended under it is taken over, and removed when done.
  w.disk[`${DATA}/runtime/.lock`]!.mtimeMs = 0
  expect((await install(w.engine, DATA, await pinFor(ZIP))).isNew).toBe(true)
  expect(w.disk[`${DATA}/runtime/.lock`]).toBeUndefined()
})

test('a fetched copy whose version check exits with an error is not used', async () => {
  const w = machineOf({ saysExit: 1, disk: { [`${DATA}/runtime/bun-9.8.7`]: { kind: 'dir' }, [`${DATA}/runtime/bun-9.8.7/bun`]: { kind: 'file' } } }, {})
  expect(await pinned(w.engine, DATA, await pinFor(ZIP))).toBeUndefined()
})

test('an earlier version, and what a fetch that was cut short left behind, are cleared away; the earlier version is never run', async () => {
  const w = machineOf({ zip: ZIP, disk: { [`${DATA}/runtime/bun-9.0.0`]: { kind: 'dir' }, [`${DATA}/runtime/bun-9.0.0/bun`]: { kind: 'file' }, [`${DATA}/runtime/incoming-1-abc`]: { kind: 'dir' }, [`${DATA}/runtime/incoming-1-abc/half.zip`]: { kind: 'file' } } }, {})
  await install(w.engine, DATA, await pinFor(ZIP))
  expect(Object.keys(w.disk).sort()).toEqual([`${DATA}/runtime`, `${DATA}/runtime/bun-9.8.7`, `${DATA}/runtime/bun-9.8.7/bun`])
  expect(w.ran.some(([program]) => program === `${DATA}/runtime/bun-9.0.0/bun`)).toBe(false)
})
