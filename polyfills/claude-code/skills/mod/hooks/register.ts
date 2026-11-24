// mcp-skills: MCP Skills (SEP-2640) for Claude Code, as a mod.
//
// Claude Code does not load skills from MCP servers. This hooks module is the
// part of the mod that runs inside Claude Code; it has no network or process of
// its own, so the Skills client is a helper process it starts (dist/helper.js,
// built from the repository's src/). What this module does:
//
//   - asks Claude Code for its own verdict on every server the helper would
//     connect to ($.mcp.connect), so the helper uses only servers Claude Code uses;
//   - adds the skills the helper found to the session's skill listing
//     (prompt.attachment, type skill_listing), each named with its server;
//   - registers the four tools ($.tool.register) and passes each call to the helper;
//   - has Claude Code ask the person once about each skill before it is loaded
//     (tool.check), and remembers the yes bound to the skill's content: every
//     file's address and digest. A skill the server has changed since is asked
//     about again. The asking and the answer are Claude Code's own permission
//     flow; what this module keeps is that a yes was given, and for what;
//   - while a skill is loaded that nobody could be asked about, has Claude Code
//     ask before every tool call but reading and searching (a command, and also
//     a write, a subagent, another server's tool); and for any loaded skill,
//     before a resource read from another MCP server;
//   - stands down when Claude Code serves MCP skills itself.

import type { EngineInterface, Register } from 'claude-code'
import { INERT_TOOLS, PLUGIN, RESOURCE_TOOLS, TOOLS } from './tools'

type Endpoint = { url: string; token: string }
type Catalog = { text: string; skills: number; servers: number }
type HelperMessage = { t?: string; url?: string; token?: string; names?: unknown; text?: string; skills?: number; servers?: number; expects?: number }
/** A skill this conversation loaded: the session is acting on it until the conversation is cleared. */
type Acting = { server: string; uri: string; name: string; root: string; isApproved: boolean }
/** A person's yes to a skill, bound to what the skill was: which server (by where it is), and every file's address and digest. */
type Approval = { hash: string; fingerprint: string; name: string; at: number }
/** What the helper says of a skill's current entry. */
type Facts = { server: string; uri: string; name: string; files: number; bytes: number; isDynamic: boolean; hash?: string; fingerprint: string; declined?: string; error?: string }
type Preview = { server: string; uri: string; name: string; description: string; body: string; isVerified: boolean; files: string[] }

const LOAD = `mcp__${PLUGIN}__load_skill`
/** The mod's tools that only read: a listing, a verified file of a loaded skill, a directory of one. */
const READS = [`mcp__${PLUGIN}__read_skill_file`, `mcp__${PLUGIN}__list_skill_directory`, `mcp__${PLUGIN}__list_skills`]
const APPROVALS = 'approvals'
const PREVIEW = 'mcp-skills-preview'
const APPROVED = 'Approval: the user approved this skill as the server serves it now.'
const UNAPPROVED = 'Approval: none, because nobody could be asked. While it is loaded, every tool call but reading and searching needs the user\'s approval each time.'

const state: {
  /** The running helper, once it has said where it listens. */
  helper?: Promise<Endpoint>
  catalog?: Catalog
  /** Resolved when the helper has looked at every server once. */
  firstCatalog?: Promise<void>
  gotCatalog?: () => void
  /** Undefined until read back from the conversation (after a start, a resume or a reload). */
  acting?: Acting[]
  /** Load calls whose permission check has run: what was decided there, for when the call runs. */
  pending: Map<string, { hash?: string; isApproved: boolean; isNew: boolean; facts: Facts }>
  /** What the preview pane shows. */
  preview?: Preview
  /** Why the mod does nothing in this session, when it does nothing. */
  off?: string
  isEnded: boolean
  areToolsLoaded: boolean
  restarts: number[]
  problemShown: boolean
} = { isEnded: false, areToolsLoaded: false, restarts: [], problemShown: false, pending: new Map() }

const debug = ($: EngineInterface, text: string) => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' })
const plain = (text: unknown) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300)
const quoted = (text: string) => JSON.stringify(plain(text))

/** Why there is no helper on this machine, in words for the person and for Claude. */
class NoHelper extends Error {}

/**
 * What runs the helper: Node 20 or newer, or Bun. Claude Code itself needs neither, so a machine may
 * have none. And a Claude Code that was not started from a shell (the desktop app, an editor) may not
 * have the PATH a terminal has, so a runtime that is installed is looked for where it usually is.
 */
async function runtime($: EngineInterface): Promise<string[]> {
  const version = async (command: string) => {
    try {
      const { exitCode, stdout } = await $.process.run([command, '--version'], { timeoutMs: 10000 })
      return exitCode === 0 ? stdout.trim() : undefined
    } catch {
      return undefined
    }
  }
  const usable = async (command: string): Promise<string[] | undefined> => {
    const found = await version(command)
    if (found === undefined) return undefined
    if (/(^|[\\/])bun(\.exe)?$/.test(command)) return [command]
    if (Number(/^v(\d+)\./.exec(found)?.[1]) >= 20) return [command, '--no-warnings']
    old ??= found
    return undefined
  }
  let old: string | undefined
  // 1. As Claude Code itself would find them.
  for (const command of ['node', 'bun']) {
    const argv = await usable(command)
    if (argv) return argv
  }
  // 2. As the person's own login shell finds them (version managers set the PATH there).
  const candidates: string[] = []
  const shell = await $.env.get('SHELL').catch(() => undefined)
  if (shell) {
    try {
      const { stdout } = await $.process.run([shell, '-lic', 'command -v node; command -v bun'], { timeoutMs: 10000 })
      candidates.push(...stdout.split('\n').map((line) => line.trim()).filter((line) => /^\/[^\s]*\/(node|bun)$/.test(line)))
    } catch {
      // no answer from the shell
    }
  }
  // 3. Where installers usually put them.
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home) candidates.push(`${home}/.bun/bin/bun`, `${home}/.volta/bin/node`, `${home}/.local/bin/node`)
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/bun', '/usr/local/bin/bun')
  for (const command of [...new Set(candidates)]) {
    const argv = await usable(command)
    if (argv) return argv
  }
  throw new NoHelper(
    `MCP Skills needs Node 20 or newer, or Bun, to run its helper, and found ${old ? `only Node ${plain(old)}` : 'neither'} on this machine. ` +
      'Install Node from https://nodejs.org or Bun from https://bun.sh, then start a new session. Until then no skills from your MCP servers are listed.',
  )
}

async function post($: EngineInterface, where: Endpoint, route: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await $.http.fetch(`${where.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${where.token}` },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`the helper answered ${response.status}`)
  return JSON.parse(response.text) as Record<string, unknown>
}

/** The helper, started if it is not running. Rejects with the reason where it cannot run. */
function ensureHelper($: EngineInterface): Promise<Endpoint> {
  if (state.helper) return state.helper
  const starting = new Promise<Endpoint>((resolve, reject) => {
    void (async () => {
      let ready = false
      let failure: unknown = new Error('the helper exited before it was ready')
      try {
        const [argv, env] = await Promise.all([runtime($), $.process.hookEnv()])
        const child = $.process.spawn({ argv: [...argv, `${$.plugin.root}/dist/helper.js`], env })
        let buffer = ''
        for await (const piece of child) {
          if (!('text' in piece)) continue
          if (piece.stream === 'stderr') {
            debug($, `helper: ${plain(piece.text.trimEnd())}`)
            continue
          }
          buffer += piece.text
          for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end)
            buffer = buffer.slice(end + 1)
            let message: HelperMessage
            try {
              message = JSON.parse(line) as HelperMessage
            } catch {
              continue
            }
            if (message.t === 'ready' && typeof message.url === 'string' && typeof message.token === 'string') {
              ready = true
              // No server is known to serve skills, and none is new: the session does not wait for a first listing.
              if (!(Number(message.expects) > 0)) state.gotCatalog?.()
              resolve({ url: message.url, token: message.token })
            } else if (ready) {
              void onMessage($, message).catch((error: unknown) => debug($, `a helper message failed: ${plain(error)}`))
            }
          }
        }
      } catch (error) {
        failure = error
      }
      if (state.helper === starting) state.helper = undefined
      if (!ready) {
        const why = failure instanceof Error ? failure.message : String(failure)
        debug($, `the helper did not start: ${plain(why)}`)
        if (failure instanceof NoHelper && !state.problemShown) {
          state.problemShown = true
          $.ui.toast(plain(why))
        }
        state.gotCatalog?.()
        reject(failure instanceof NoHelper ? failure : new Error(`the MCP Skills helper did not start (${plain(why)})`))
        return
      }
      // It stopped while the session goes on: it is started again, a few times at most. What it
      // held (the entries of loaded skills) is gone, so a loaded skill's files need the skill
      // loaded again; that the session is acting on those skills is kept here, not there.
      if (state.isEnded || state.off) return
      const now = await $.clock.now()
      state.restarts = state.restarts.filter((at) => now - at < 10 * 60 * 1000)
      if (state.restarts.length >= 5) return debug($, 'the helper keeps stopping; not starting it again until a tool is called')
      state.restarts.push(now)
      debug($, 'the helper stopped; starting it again')
      $.clock.after(1000 * 2 ** (state.restarts.length - 1), () => {
        if (!state.isEnded && !state.off) void ensureHelper($).catch(() => {})
      })
      // The session may be gone by the time the helper is: then there is nothing to start it for.
    })().catch(() => {})
  })
  state.helper = starting
  // A helper that never became ready is forgotten, so the next call tries again.
  starting.catch(() => {})
  return starting
}

async function onMessage($: EngineInterface, message: HelperMessage): Promise<void> {
  const where = await state.helper
  if (!where) return
  switch (message.t) {
    case 'servers': {
      // The helper opens a connection of its own to each MCP server. It may use only those Claude
      // Code itself uses in this session: connected, or tried and failed. Not one that is switched
      // off, unapproved, refused by policy, unknown to the session, or waiting for a sign-in.
      const names = Array.isArray(message.names) ? message.names.filter((n): n is string => typeof n === 'string') : []
      await Promise.all(
        names.map(async (name) => {
          let verdict: { ok: boolean; reason?: string }
          try {
            const answer = await $.mcp.connect(name)
            verdict = answer.isConnected || answer.reason === 'failed' ? { ok: true } : { ok: false, reason: answer.reason }
          } catch {
            verdict = { ok: false, reason: 'unanswered' }
          }
          await post($, where, '/verdict', { name, ...verdict }).catch(() => {})
        }),
      )
      return
    }
    case 'catalog': {
      const before = state.catalog?.text
      state.catalog = { text: String(message.text ?? ''), skills: Number(message.skills) || 0, servers: Number(message.servers) || 0 }
      // Once a server serves skills, Claude has the tools from the start instead of through ToolSearch.
      if (state.catalog.servers > 0 && !state.areToolsLoaded) {
        state.areToolsLoaded = true
        await Promise.all(TOOLS.map((spec) => $.tool.register({ ...spec, isDeferred: false }))).catch(() => {})
      }
      state.gotCatalog?.()
      // A listing that arrived or changed after the session's skill listing was composed: compose it again.
      if (before !== undefined ? before !== state.catalog.text : state.catalog.text !== '') $.ui.invalidate('prompt.attachment')
      return
    }
  }
}

const normal = (server: unknown) => String(server ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The MCP-served skills this conversation is acting on. Read back from the conversation itself (its
 * answered load_skill calls), so it is right after a resume or a reload of this module too, then kept
 * up as skills are loaded. A window is never closed early: only a cleared conversation ends it.
 */
async function actingSkills($: EngineInterface): Promise<Acting[]> {
  if (state.acting) return state.acting
  const found: Acting[] = []
  const rows = await $.session.messages()
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const use of row.toolUses ?? []) {
      // The first line is this module's own, the second the helper's: neither is a server's text.
      const said = /^(Approval: [^\n]*)\nLoaded the skill /.exec(use.text ?? '')
      if (use.tool !== LOAD || use.isError || !said) continue
      const input = use.input as { server?: unknown; uri?: unknown }
      if (typeof input.server === 'string' && typeof input.uri === 'string') note(found, { server: input.server, uri: input.uri, isApproved: said[1] === APPROVED })
    }
  }
  // A skill loaded while the conversation was being read is kept.
  for (const a of state.acting ?? []) note(found, a)
  state.acting = found
  return found
}

/** Records a loaded skill. Loading it again replaces what was known of it: the later load is the one in force. */
function note(list: Acting[], a: { server: string; uri: string; isApproved: boolean }): void {
  if (!a.uri.endsWith('/SKILL.md')) return
  const root = a.uri.slice(0, -'/SKILL.md'.length)
  const at = list.findIndex((x) => x.server === a.server && x.uri === a.uri)
  const entry = { server: a.server, uri: a.uri, name: root.slice(root.lastIndexOf('/') + 1), root, isApproved: a.isApproved }
  if (at >= 0) list[at] = entry
  else list.push(entry)
}

const approvalKey = (server: string, uri: string) => `${server}\n${uri}`
async function approvals($: EngineInterface): Promise<Record<string, Approval>> {
  const stored = await $.store.get(APPROVALS)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, Approval>) : {}
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/**
 * A call this mod will not let through on a rule or a mode: put to the person where one can be
 * asked, and refused outright where nobody can be. The refusal is this hook's own, so it does not
 * rest on what a mode does with a question it has nobody to put to.
 */
const hold = (e: { approver?: unknown }, reason: string) =>
  e.approver === undefined
    ? { decision: 'deny' as const, reason: `${reason} Nobody can be asked in this session, so the call is refused.` }
    : { decision: 'ask' as const, reason }

/** A call that changes nothing: Claude Code's reading and searching, and this mod's own reads. No skill, approved or not, makes it a question. */
const isInert = (tool: string) => INERT_TOOLS.includes(tool) || READS.includes(tool)
const named = (skills: Acting[]) =>
  skills
    .slice(0, 3)
    .map((a) => `${quoted(a.name)} from the MCP server ${quoted(a.server)}`)
    .join(', ') + (skills.length > 3 ? ` and ${skills.length - 3} more` : '')

/** Serves one of the mod's tools: the call goes to the helper, and its answer back to Claude. */
async function serve($: EngineInterface, name: string, e: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  if (state.off) return { deny: `MCP Skills is off in this session: ${state.off}` }
  // The call's own arguments sit beside the engine's keys for it.
  const { tool: _tool, tool_use_id: id, agentId: _agent, requestMeta: _meta, ...input } = e
  // What the permission check settled for this call. A call that reached here with no check (another
  // mod's own call of the tool) was approved by nobody.
  const decided = typeof id === 'string' ? state.pending.get(id) : undefined
  if (typeof id === 'string') state.pending.delete(id)
  try {
    const where = await ensureHelper($)
    // The skill is loaded as it was put to the person, or not at all.
    const answer = await post($, where, '/tool', { name, input: name === 'load_skill' && decided?.hash ? { ...input, expect: decided.hash } : input })
    const text = typeof answer.text === 'string' ? answer.text : 'The MCP Skills helper gave no answer.'
    if (answer.isError === true) return { deny: text }
    if (name !== 'load_skill') return { result: text }
    const acting = answer.acting as { server?: unknown; uri?: unknown; name?: unknown; hash?: unknown; fingerprint?: unknown } | undefined
    if (typeof acting?.server !== 'string' || typeof acting.uri !== 'string') return { result: text }
    const isApproved = decided?.isApproved === true
    // A yes just given is kept, bound to the content it was given for. A skill with no manifest
    // ("dynamic") cannot be bound to anything, so a yes to it is for this load alone.
    if (isApproved && decided?.isNew && typeof acting.hash === 'string' && acting.hash === decided.hash) {
      const all = await approvals($)
      all[approvalKey(acting.server, acting.uri)] = { hash: acting.hash, fingerprint: String(acting.fingerprint ?? ''), name: String(acting.name ?? ''), at: await $.clock.now() }
      await $.store.set(APPROVALS, all)
    }
    // From here on the session is acting on this skill.
    note((state.acting ??= []), { server: acting.server, uri: acting.uri, isApproved })
    return { result: `${isApproved ? APPROVED : UNAPPROVED}\n${text}` }
  } catch (error) {
    return { deny: error instanceof NoHelper ? error.message : `MCP Skills could not answer: ${plain(error instanceof Error ? error.message : error)}` }
  }
}
const UNANSWERED = { deny: 'MCP Skills could not answer.' }

function standDown($: EngineInterface, why: string): void {
  if (state.off) return
  state.off = why
  $.ui.invalidate('prompt.attachment')
  void state.helper?.then((where) => post($, where, '/stop', {})).catch(() => {})
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    state.isEnded = false
    state.acting = undefined
    state.off = undefined
    state.areToolsLoaded = false
    state.pending.clear()
    // Installed and doing nothing, for when Claude Code serves MCP skills itself: MCP_SKILLS_OFF=1.
    // (Disabling the plugin does the same, and needs nothing from here.)
    if ((await $.env.get('MCP_SKILLS_OFF').catch(() => undefined)) === '1') state.off = 'MCP_SKILLS_OFF=1 is set.'
    if (state.off) return started
    state.firstCatalog = new Promise<void>((resolve) => (state.gotCatalog = resolve))
    void ensureHelper($).catch(() => {})
    await Promise.all([
      ...TOOLS.map((spec) => $.tool.register({ ...spec })),
      $.command.register({ name: 'mcp-skills', description: 'Skills your MCP servers serve: list them, read one (show), have Claude use one (use)', argumentHint: '[show|use|refresh|forget] [skill]' }),
    ])
    // The first request of a session carries its skill listing. Where a server is known to serve
    // skills, wait a little for it, so its skills are in that listing; a slower server's skills are
    // added when they arrive. Where none is known (the helper says so at once), nothing waits.
    await Promise.race([state.firstCatalog, $.clock.sleep(4000).catch(() => {})])
    return started
  })

  // The session's skill listing, with the MCP-served skills added under their own heading.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const listing = await next(e)
    const mine = state.off ? '' : (state.catalog?.text ?? '')
    if (!mine || listing.text == null) return listing
    return { ...listing, text: `${listing.text}\n\n${mine}` }
  })

  // Each tool is hooked by its exact name, written out so `claude plugin validate` can read it.
  on('tool.run', { tool: 'mcp__mcp-skills__load_skill' }, ($, e) => serve($, 'load_skill', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-skills__read_skill_file' }, ($, e) => serve($, 'read_skill_file', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-skills__list_skill_directory' }, ($, e) => serve($, 'list_skill_directory', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-skills__list_skills' }, ($, e) => serve($, 'list_skills', e)).catch(() => UNANSWERED)

  // SEP-2640, Security Considerations.
  //
  // "No implicit local execution": nothing a served skill says may run code without the person's
  // approval of that skill. So a skill is put to the person before it is loaded, once: the yes is
  // kept, bound to the skill's content, and a skill the server changed since is asked about again
  // ("Content-bound approval"). A skill nested in another has its own yes ("Nested skill consent").
  // Where nobody can be asked, the skill loads unapproved, and while it is loaded every tool call
  // but reading and searching is put to the person instead (with nobody to ask: refused here). Not
  // only the tools that run a command: a file written now is code run later, and a subagent or
  // another server's tool can do what a shell does.
  //
  // "Origin-scoped resource reads": while a skill is loaded, a resource read from another server
  // is put to the person, naming both servers, and a read of the skill's own files goes only
  // through the path that verifies it.
  //
  // An ask made here is this hook's, so Claude Code puts it to a person: no rule, auto mode or
  // classifier settles it. Where nobody can be asked the hook refuses the call itself (hold).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict
    // The mod's reads go through as Claude Code's own resource read does: with nobody asked, unless
    // something of the person's or their organisation's stands behind the ask.
    const isPlainAsk = verdict.decision === 'ask' && !verdict.rule && !verdict.hook && !verdict.setting && !verdict.plugin && e.ceiling === undefined
    if (READS.includes(e.tool)) return isPlainAsk && !state.off ? { decision: 'allow' as const, reason: 'A read by the MCP Skills mod: a listing, or a verified file of a skill that is loaded, from the skill\'s own server.' } : verdict
    if (e.tool === LOAD) {
      if (state.off) return verdict
      const asked = (e.input ?? {}) as { server?: unknown; uri?: unknown }
      if (typeof asked.server !== 'string' || typeof asked.uri !== 'string') return verdict
      let facts: Facts
      try {
        facts = (await post($, await ensureHelper($), '/entry', { server: asked.server, uri: asked.uri })) as Facts
      } catch {
        return verdict
      }
      // A load that will fail (no such skill, a skill past the limits) is no question for anyone:
      // it goes ahead, and fails with the reason.
      if (facts.error || facts.declined || typeof facts.name !== 'string') return isPlainAsk ? { decision: 'allow' as const } : verdict
      const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
      const remember = (isApproved: boolean, isNew: boolean) => {
        if (id === undefined) return
        if (state.pending.size > 200) state.pending.delete(state.pending.keys().next().value as string)
        state.pending.set(id, { hash: facts.hash, isApproved, isNew, facts })
      }
      const before = (await approvals($))[approvalKey(asked.server, asked.uri)]
      // The same skill, on the same server, with the same files: the yes given before stands.
      if (facts.hash && before?.hash === facts.hash && before.fingerprint === facts.fingerprint) {
        remember(true, false)
        return isPlainAsk ? { decision: 'allow' as const, reason: `You approved the skill ${quoted(facts.name)} from the MCP server ${quoted(facts.server)}, and it has not changed since.` } : verdict
      }
      if (e.approver === undefined) {
        // Nobody can be asked. It loads if Claude Code's own rules let the tool run, unapproved.
        remember(false, false)
        return verdict
      }
      remember(true, true)
      const acting = await actingSkills($)
      const outer = acting.find((a) => a.server === asked.server && asked.uri !== a.uri && (asked.uri as string).startsWith(`${a.root}/`))
      const what = `the skill ${quoted(facts.name)} from the MCP server ${quoted(facts.server)}`
      const opening = before === undefined ? `Load ${what}?` : before.fingerprint !== facts.fingerprint ? `Load ${what}? You approved a skill of this name before, from a server at another address.` : `${what[0]!.toUpperCase()}${what.slice(1)} has changed since you approved it. Load it as it is now?`
      const content = facts.isDynamic
        ? 'The server generates its content and publishes no digests for it, so it cannot be checked, and your yes is for this one load.'
        : `It is ${facts.files} file${facts.files === 1 ? '' : 's'} (${size(facts.bytes)}) written by that server. Your yes is remembered for the skill as it is now; if the server changes it, you are asked again.`
      return {
        decision: 'ask' as const,
        reason: [
          opening,
          outer ? `It is nested inside the loaded skill ${quoted(outer.name)}; approving that one did not approve this one.` : '',
          content,
          'Once it is loaded Claude may follow its instructions, and any command it runs goes through your usual permissions.',
          `To read it first, answer no and run /mcp-skills show ${facts.name}`,
        ]
          .filter(Boolean)
          .join(' '),
      }
    }
    // From here on: a call made while a served skill is loaded. Not switched off with the rest of
    // the mod: a skill this mod loaded earlier is still in the conversation.
    if (isInert(e.tool)) return verdict
    const acting = await actingSkills($)
    if (!acting.length) return verdict
    if (!RESOURCE_TOOLS.includes(e.tool)) {
      const unapproved = acting.filter((a) => !a.isApproved)
      if (!unapproved.length) return verdict
      const reason = `A skill served by an MCP server is loaded that nobody was asked about (${named(unapproved)}). Its text comes from that server, so while it is loaded anything but reading and searching needs your approval.`
      return e.approver === undefined ? hold(e, `${reason} To use the skill with nobody present, approve it once in an interactive session on this machine: the yes is kept until the server changes the skill.`) : hold(e, reason)
    }
    const input = (e.input ?? {}) as { server?: unknown; uri?: unknown }
    const own = acting.filter((a) => normal(a.server) === normal(input.server))
    const uri = typeof input.uri === 'string' ? input.uri : ''
    const inside = own.find((a) => uri === a.uri || uri === a.root || uri.startsWith(`${a.root}/`))
    if (inside) {
      return { decision: 'deny' as const, reason: `That is a file of the skill ${quoted(inside.name)}, which is loaded. Read it with mcp__mcp-skills__read_skill_file (server ${quoted(inside.server)}, skill ${quoted(inside.uri)}), which checks it against the skill's manifest.` }
    }
    const others = acting.filter((a) => normal(a.server) !== normal(input.server))
    if (!others.length) return verdict
    return hold(e, `A skill served by an MCP server is loaded (${named(others)}), and this reads a resource from another MCP server, ${quoted(String(input.server ?? ''))}. A skill from one server may not cause a read from another without your approval.`)
  }).catch(($, e, next) => (isInert(e.tool) ? next(e) : hold(e, 'MCP Skills could not check whether a skill from an MCP server is loaded, so this needs your approval.')))

  // Claude Code expanding a skill whose words are an MCP server's means it serves MCP skills
  // itself. Then this mod has nothing to add, and two listings of the same skills would confuse.
  on('skill.prompt', async ($, e, next) => {
    if (e.source === 'mcp' && !state.off) {
      standDown($, 'Claude Code loaded a skill from an MCP server itself, so it serves them without this mod.')
      $.ui.toast('MCP Skills: Claude Code serves MCP skills itself now. This mod is off for the session; disable the plugin to keep it off.')
    }
    return next(e)
  })

  // /mcp-skills                     what is served, what is loaded, what was left alone
  // /mcp-skills show <skill>        the skill's SKILL.md in a panel, for the person; Claude does not read it
  // /mcp-skills use <skill> [what]  ask Claude to load the skill and use it
  // /mcp-skills refresh             look at every server again
  // /mcp-skills forget [<skill>]    drop the approvals kept (all, or one skill's)
  // <skill> is a name, server:name, or the URI of a SKILL.md.
  on('command.run', { command: 'mcp-skills' }, async ($, e) => {
    if (state.off) return { text: `MCP Skills is off in this session: ${state.off}` }
    const [verb = '', what = '', ...rest] = String(e.args ?? '').trim().split(/\s+/)
    const several = (found: { server: string; uri: string; name: string }[]) =>
      found.length ? `That names more than one skill. Say which: ${found.slice(0, 10).map((f) => `${f.server}:${f.name}`).join(', ')}.` : `No served skill is named ${quoted(what)}. Run /mcp-skills to see them.`
    try {
      const where = await ensureHelper($)
      if (verb === 'show') {
        if (!what) return { text: 'Which skill? /mcp-skills show <name>' }
        const shown = (await post($, where, '/preview', { what })) as Partial<Preview> & { error?: string; candidates?: { server: string; uri: string; name: string }[] }
        if (shown.error) return { text: `That skill could not be shown: ${plain(shown.error)}.` }
        if (shown.candidates || typeof shown.body !== 'string') return { text: several(shown.candidates ?? []) }
        state.preview = shown as Preview
        $.ui.invalidate('ui.render')
        const opened = await $.ui.open({ id: PREVIEW, title: `${shown.name} (MCP server ${shown.server})`, focus: true, closeOnEscape: true })
        return { text: opened.isPlaced ? `The SKILL.md of ${quoted(String(shown.name))} from the MCP server ${quoted(String(shown.server))} is open in a panel for you to read. It is not loaded.` : 'This session has nowhere to show a panel.' }
      }
      if (verb === 'use') {
        if (!what) return { text: 'Which skill? /mcp-skills use <name> [what to do with it]' }
        const { found } = (await post($, where, '/find', { what })) as { found: { server: string; uri: string; name: string }[] }
        if (found.length !== 1) return { text: several(found) }
        const [skill] = found as [{ server: string; uri: string; name: string }]
        const request = rest.join(' ')
        const text = `The user asked to use the skill ${quoted(skill.name)} served by the MCP server ${quoted(skill.server)}. Load it with mcp__mcp-skills__load_skill (server ${quoted(skill.server)}, uri ${quoted(skill.uri)})${request ? `, then use it for this request of theirs: ${request}` : ', then ask them what they want done with it'}.`
        // Submitted once this command has answered: a prompt submitted from inside it would wait on itself.
        $.clock.after(50, () => void $.prompt.submit({ text }).catch((error: unknown) => debug($, `the request to use a skill was not submitted: ${plain(error)}`)))
        return { text: `Asked Claude to load ${quoted(skill.name)} from the MCP server ${quoted(skill.server)}.` }
      }
      if (verb === 'forget') {
        const all = await approvals($)
        const keys = Object.keys(all).filter((key) => !what || all[key]!.name === what || key.endsWith(`\n${what}`))
        for (const key of keys) delete all[key]
        await $.store.set(APPROVALS, all)
        return { text: keys.length ? `Forgot ${keys.length} approval${keys.length === 1 ? '' : 's'}. ${keys.length === 1 ? 'That skill is' : 'Those skills are'} asked about again before loading.` : 'No approval to forget.' }
      }
      if (verb === 'refresh') await post($, where, '/refresh', {})
      else if (verb) return { text: 'Usage: /mcp-skills, /mcp-skills show <skill>, /mcp-skills use <skill> [what to do], /mcp-skills refresh, /mcp-skills forget [<skill>]' }
      const status = await post($, where, '/status', { compact: true, columns: e.presentation?.columns })
      const acting = await actingSkills($)
      const lines = [typeof status.text === 'string' ? status.text : 'The MCP Skills helper gave no answer.']
      // "Hosts SHOULD surface collisions to the user": a served skill named like a skill or command
      // this session already has. Neither stands in for the other: the Skill tool and /name run the
      // local one, and the served one is loaded only by its server and uri.
      const served = Array.isArray(status.names) ? status.names.filter((n): n is string => typeof n === 'string') : []
      const local = await $.command.list().catch(() => [])
      const same = served.filter((name) => local.some((c) => c.name === name || c.name.endsWith(`:${name}`)))
      if (same.length) lines.push(`Also the name of a skill or command you already have: ${same.slice(0, 20).map(quoted).join(', ')}. The local one is what the Skill tool and /name run; the served one is loaded only by its server and URI.`)
      // Servers this session has that the mod cannot look at: they are not in the MCP configuration
      // files it reads (a plugin brought them, or they are claude.ai connectors). Said, so that
      // their absence above is not a puzzle.
      const mine = new Set((Array.isArray(status.servers) ? status.servers : []).map(normal))
      const others = new Set<string>()
      for (const tool of await $.tool.list().catch(() => [])) {
        const server = /^mcp__(.+?)__/.exec(tool.name)?.[1]
        if (server && server !== normal(PLUGIN) && !mine.has(server)) others.add(server)
      }
      if (others.size) lines.push(`Not looked at, because they are not in your MCP configuration files (a plugin's servers, claude.ai connectors): ${[...others].slice(0, 12).map(quoted).join(', ')}${others.size > 12 ? ` and ${others.size - 12} more` : ''}.`)
      const kept = Object.values(await approvals($))
      if (kept.length) lines.push(`Approved by you, each as it was when you approved it: ${kept.slice(0, 30).map((a) => quoted(a.name)).join(', ')}${kept.length > 30 ? ` and ${kept.length - 30} more` : ''}. /mcp-skills forget drops them.`)
      if (acting.length) lines.push(`Loaded in this conversation: ${named(acting)}. Until the conversation is cleared, Claude Code asks you before a resource read from any other MCP server${acting.some((a) => !a.isApproved) ? ', and before each command, since a skill is loaded that nobody was asked about' : ''}.`)
      lines.push('Read one before it is loaded: /mcp-skills show <name>. Have Claude use one: /mcp-skills use <name> [what to do].')
      return { text: lines.join('\n') }
    } catch (error) {
      return { text: error instanceof NoHelper ? error.message : `MCP Skills could not answer: ${plain(error instanceof Error ? error.message : error)}` }
    }
  })

  // The panel /mcp-skills show opens: a skill's SKILL.md for the person to read before deciding
  // about it. What is drawn here is not in the conversation, and Claude does not read it.
  on('ui.render', { component: 'Pane', requestId: PREVIEW }, ($, e, next) => {
    const shown = state.preview
    if (!shown) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const files = shown.files.length ? `Other files: ${shown.files.slice(0, 40).join(', ')}${shown.files.length > 40 ? ', …' : ''}` : 'No other files.'
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { dimColor: true }, `Served by the MCP server ${quoted(shown.server)} at ${plain(shown.uri)}. ${shown.isVerified ? 'It matches the digest the server published for it.' : 'The server publishes no digest for it.'} Not loaded: Claude has not read this.`),
      h(Text, { dimColor: true }, plain(files)),
      h(Text, {}, ' '),
      h(Markdown, { text: shown.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ') }),
    ) as never
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // The conversation is gone, and every loaded skill's text with it: nothing is being acted on.
      state.acting = []
      void state.helper?.then((where) => post($, where, '/release', {})).catch(() => {})
    } else {
      state.isEnded = true
      const where = await Promise.race([state.helper?.catch(() => undefined), $.clock.sleep(200).then(() => undefined, () => undefined)])
      if (where) await Promise.race([post($, where, '/stop', {}).catch(() => {}), $.clock.sleep(1500).catch(() => {})])
    }
    return next(e)
  })
}
