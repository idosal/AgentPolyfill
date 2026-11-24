// The part of SEP-2640 only Claude Code can enforce, checked in Claude Code's
// own test kit (`claude plugin test mod`): the hooks module runs as it does in a
// session, and the hooks registered here stand for the engine beneath it and
// for the helper process (which is not started).
//
// Rule ids are those of docs/conformance.md.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A timer exists where a hooks module runs; the typings for one just do not name it.
declare const setTimeout: (run: (value?: unknown) => void, ms: number) => unknown

const SKILL = { server: 'acme', uri: 'skill://release-notes/SKILL.md', name: 'release-notes', root: 'skill://release-notes' }
const FACTS = { ...SKILL, files: 4, bytes: 1299, isDynamic: false, hash: 'sha256:aaaa', fingerprint: 'fp-acme' }
const CATALOG = 'The following skills are served by MCP servers connected to this session (MCP Skills extension).\n\n- release-notes (MCP server "acme", uri skill://release-notes/SKILL.md): Write release notes.'
const LOADED = 'Loaded the skill "release-notes" from the MCP server "acme" (skill://release-notes/SKILL.md).'
const APPROVED = 'Approval: the user approved this skill as the server serves it now.'
const UNAPPROVED = "Approval: none, because nobody could be asked. While it is loaded, running a command needs the user's approval each time."
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
}

/** The engine beneath the mod, and a helper that answers as the real one does. */
function world(on: On, o: { tools?: string[]; env?: Record<string, string>; /** What each command answers to --version; a missing one is not installed. Default: node on the PATH. */ runtimes?: Record<string, string>; shellFinds?: string; names?: string[]; commands?: string[]; rows?: unknown[]; verdict?: Record<string, unknown>; connect?: Record<string, unknown>; servers?: string[]; catalog?: string | null; expects?: number; store?: Record<string, unknown>; facts?: Facts; found?: unknown[] } = {}): World {
  // A wait ends only when a test moves the clock: nothing here times out by itself.
  const w: World = { posts: [], spawns: 0, registered: [], spawned: [], toasts: [], submitted: [], facts: o.facts ?? FACTS, store: { ...(o.store ?? {}) }, clock: mock.clock(on), exit: () => {} }
  const ready = JSON.stringify({ t: 'ready', url: 'http://127.0.0.1:9', token: 'secret', expects: o.expects ?? 1 })
  const lines = [ready, ...(o.servers ? [JSON.stringify({ t: 'servers', names: o.servers })] : []), ...(o.catalog === null ? [] : [JSON.stringify({ t: 'catalog', text: o.catalog ?? CATALOG, skills: 1, servers: 1 })])]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.messages', () => ({ value: (o.rows ?? []) as never }))
  on('process.run', (_, e) => {
    const runtimes = o.runtimes ?? { node: 'v22.18.0' }
    const [command, flag] = e.argv
    // The person's login shell, asked where node and bun are.
    if (flag === '-lic') return { value: { exitCode: 0, stdout: o.shellFinds ?? '', stderr: '' } as never }
    const answer = runtimes[String(command)]
    return { value: (answer === undefined ? { exitCode: 127, stdout: '', stderr: 'not found' } : { exitCode: 0, stdout: `${answer}\n`, stderr: '' }) as never }
  })
  on('process.hookEnv', () => ({ value: {} }))
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
      '/tool': () => (body.name === 'load_skill' ? { text: LOADED, acting: { ...SKILL, hash: w.facts.hash, fingerprint: w.facts.fingerprint } } : { text: 'ok' }),
      '/entry': () => w.facts,
      '/status': () => ({ text: 'MCP server "acme": 1 skill.', names: o.names ?? ['release-notes'], servers: ['acme', 'my.docs'] }),
      '/find': () => ({ found: o.found ?? [SKILL] }),
      '/preview': () => (o.found ? { candidates: o.found } : { ...SKILL, description: 'Write release notes.', body: '# Release notes\n\nRead `references/codenames.md`.\n', isVerified: true, files: ['references/codenames.md'] }),
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
  on('store.get', (_, e) => ({ value: w.store[e.key] }))
  on('store.set', (_, e) => {
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: (o.env ?? {})[e.name] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('mcp.connect', (_, e) => ({ value: (o.connect?.[e.server] ?? { isConnected: true, server: e.server }) as never }))
  // What Claude Code itself decides: by default an ask with nothing behind it, as for any MCP tool.
  on('tool.check', () => (o.verdict ?? { decision: 'ask' }) as never)
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  return w
}

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
let calls = 0
/** A load as the model's call goes: the permission check with a person to ask, then (their yes given) the run. */
async function load($: Engine, o: { approver?: 'person' | null; uri?: string } = {}) {
  const id = `t${++calls}`
  const input = { server: SKILL.server, uri: o.uri ?? SKILL.uri }
  const verdict = await $.tool.check({ tool: LOAD, input, tool_use_id: id, ...(o.approver === null ? {} : { approver: 'person' }) } as never)
  const ran = await $.tool.run({ tool: LOAD, tool_use_id: id, ...input } as never)
  return { verdict, ran: ran as { result?: string; deny?: string } }
}
const bash = { tool: 'Bash', input: { command: 'python3 scripts/extract.py' } }
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

test('X5: where nobody can be asked, a skill loads unapproved, and every tool that runs code is put to the person instead', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'allowed' } })
  await $.session.start(START)
  const headless = await load($, { approver: null })
  expect(headless.verdict.decision).toBe('allow')
  expect(headless.ran.result).toBe(`${UNAPPROVED}\n${LOADED}`)
  expect(approvals(w)).toEqual({})
  for (const tool of ['Bash', 'PowerShell', 'Monitor', 'REPL']) {
    const verdict = await $.tool.check({ tool, input: { command: 'ls' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.plugin).toBe('mcp-skills')
    expect(verdict.reason).toContain('nobody was asked about ("release-notes" from the MCP server "acme")')
  }
  expect((await $.tool.check({ tool: 'Read', input: { file_path: 'a.md' } })).decision).toBe('allow')
})

test('X5: a call that reached the tool with no permission check (another mod\'s) was approved by nobody', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  const ran = (await $.tool.run({ tool: LOAD, tool_use_id: 'unchecked', server: SKILL.server, uri: SKILL.uri } as never)) as { result?: string }
  expect(ran.result).toBe(`${UNAPPROVED}\n${LOADED}`)
  expect((await $.tool.check(bash)).decision).toBe('ask')
})

test('X5: a command Claude Code refuses stays refused, and with no skill loaded a command is decided as it always was', async ($, on) => {
  world(on, { verdict: { decision: 'deny' } })
  await $.session.start(START)
  expect((await $.tool.check(bash)).decision).toBe('deny')
  expect((await $.tool.check({ tool: LOAD, input: SKILL, tool_use_id: 'x', approver: 'person' } as never)).decision).toBe('deny')
})

test('X5: the tools you name as running code are covered too', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'x' }, env: { MCP_SKILLS_EXECUTION_TOOLS: 'mcp__ide__executeCode, mcp__shell__run' } })
  await $.session.start(START)
  await load($, { approver: null })
  expect((await $.tool.check({ tool: 'mcp__ide__executeCode', input: {} })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'mcp__shell__run', input: {} })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'mcp__shell__status', input: {} })).decision).toBe('allow')
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
  expect((await $.tool.check({ tool: 'ReadMcpResourceTool', input: { server: 'billing', uri: 'db://x' } })).decision).toBe('ask')
})

test('W1: after a resume, a skill that was loaded unapproved still has its commands asked about; a failed load opened nothing', async ($, on) => {
  const use = (text: string, uri: string, isError?: true) => ({ tool_use_id: uri, tool: LOAD, input: { server: 'acme', uri }, text, ...(isError ? { isError } : {}) })
  world(on, { verdict: { decision: 'allow', rule: 'Bash' }, rows: [{ role: 'assistant', text: '', toolUses: [use('The MCP server "acme" serves no skill at that URI.', 'skill://nope/SKILL.md', true), use(`${UNAPPROVED}\n${LOADED}`, SKILL.uri)] }] })
  await $.session.start(START)
  const verdict = await $.tool.check(bash)
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('"release-notes"')
  expect(verdict.reason).not.toContain('"nope"')
})

test('W1: clearing the conversation ends it: the skill\'s text is gone, and the helper is told to drop its entry', async ($, on) => {
  const w = world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  await load($, { approver: null })
  expect((await $.tool.check(bash)).decision).toBe('ask')
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
    const verdict = await $.tool.check({ tool, input: { server: 'billing', uri: 'db://customers/42' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('the MCP server "acme"')
    expect(verdict.reason).toContain('another MCP server, "billing"')
    expect(verdict.plugin).toBe('mcp-skills')
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

test('with no Node 20 and no Bun anywhere, the person is told once what to install, and every way in says the same', async ($, on) => {
  const w = world(on, { runtimes: { node: 'v18.19.0' } })
  await $.session.start(START)
  expect(w.spawns).toBe(0)
  await settle(() => w.toasts.length > 0)
  expect(w.toasts).toEqual([expect.stringContaining('needs Node 20 or newer, or Bun, to run its helper, and found only Node v18.19.0') as never])
  const { text } = await $.command.run({ command: 'mcp-skills', args: '' } as never)
  expect(text).toContain('Install Node from https://nodejs.org or Bun from https://bun.sh, then start a new session.')
  const answer = (await $.tool.run({ tool: LOAD, tool_use_id: 'x', server: SKILL.server, uri: SKILL.uri } as never)) as { deny?: string }
  expect(answer.deny).toContain('needs Node 20 or newer, or Bun')
  expect(w.toasts.length).toBe(1)
  // Nothing else is disturbed: Claude Code's own skill listing is as it was.
  expect((await $.prompt.attachment(listing)).text).toBe(listing.text)
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

test('stand-down does not end a window: a skill this mod loaded unapproved earlier still has its commands asked about', async ($, on) => {
  world(on, { verdict: { decision: 'allow', rule: 'Bash' } })
  await $.session.start(START)
  await load($, { approver: null })
  await $.skill.prompt({ skill: 'acme:other', text: 'x', frontmatter: {}, source: 'mcp' })
  expect((await $.tool.check(bash)).decision).toBe('ask')
})
