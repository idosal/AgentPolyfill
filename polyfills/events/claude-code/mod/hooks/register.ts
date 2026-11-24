// mcp-events: MCP Events (SEP-3415) for Claude Code, as a mod.
//
// Claude Code has no Events support of its own. This hooks module is the part
// of the mod that runs inside Claude Code; it has no network or process of its
// own, so the Events client is a helper process it starts (dist/helper.js in this folder,
// built from src/). What this module does:
//
//   - registers the six tools ($.tool.register) and passes each call to the helper;
//   - asks Claude Code for its own verdict on every server the helper would
//     connect to ($.mcp.connect), so the helper uses only servers Claude Code uses;
//   - adds the catalog of event types to the session's instructions (prompt.compose);
//   - when the helper says events wait, submits them as a prompt ($.prompt.submit),
//     which starts a turn once the session is idle;
//   - tells the helper when the person sends a message of their own (prompt.submit),
//     which is what restarts waking after its hourly limit was reached;
//   - `/mcp-events setup`: on a machine with no Node and no Bun, fetches a copy of Bun for the
//     helper alone, on the person's own command and yes (runtime.ts).
//
// The model reads such a prompt as "The mcp-events plugin sent a message: …",
// never as the person's own words, and what it does next goes through Claude
// Code's permissions like anything else.

import type { EngineInterface, Register } from 'claude-code'
import { BUN, SetupError, install, pinned, platformOf, remove } from './runtime'
import { isThePersons, PLUGIN, TOOLS } from './tools'

type Endpoint = { url: string; token: string }
type Catalog = { text: string; eventTypes: number; watches: number }
type HelperMessage = { t?: string; url?: string; token?: string; names?: unknown; text?: string; eventTypes?: number; watches?: number }

const state: {
  /** The running helper, once it has said where it listens. */
  helper?: Promise<Endpoint>
  catalog?: Catalog
  /** The helper said it has nothing to do and is exiting; a tool call starts it again. */
  isStandingBy: boolean
  isEnded: boolean
  isDelivering: boolean
  isMoreWaiting: boolean
  /** Whether watch_event is in the model's tool list from the start (it is once a server offers events). */
  isWatchLoaded: boolean
  /** When the helper was started again after it stopped by itself, to bound that. */
  restarts: number[]
  problemShown: boolean
  /**
   * The last batch submitted and not known to be acknowledged, and whose spool it came from. A
   * helper that restarted between the submit and the ack never heard the ack, and would hand the
   * same lines over again: it is told before the next take. Kept here, where it outlives the helper.
   */
  submitted?: { spool: string; upto: number }
  /** The fetch of the mod's own runtime, while one is under way. */
  setup?: Promise<void>
  /** What the helper runs on, for /mcp-events: set where it is the mod's own copy of Bun. */
  ownRuntime?: string
} = { isStandingBy: false, isEnded: false, isDelivering: false, isMoreWaiting: false, isWatchLoaded: false, restarts: [], problemShown: false }

const debug = ($: EngineInterface, text: string) => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' })
const plain = (text: unknown) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300)
const quoted = (text: string) => JSON.stringify(plain(text))

/** Why there is no helper on this machine, in words for the person and for Claude; `short` is the one-line notice. */
class NoHelper extends Error {
  constructor(
    message: string,
    readonly short = message,
  ) {
    super(message)
  }
}
/** The plugin's own data folder: Claude Code makes it, and keeps it across updates. */
const dataFolder = async ($: EngineInterface) => (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA

/**
 * What runs the helper: Node 20 or newer, or Bun. Claude Code itself needs neither, so a machine may
 * have none. And a Claude Code that was not started from a shell (the desktop app, an editor) may not
 * have the PATH a terminal has, so a runtime that is installed is looked for where it usually is.
 * (The same order as the mcp-skills mod's.)
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
    // Bun answers with a bare version, Node with a v before it.
    if (/^\d+\.\d+\.\d+/.test(found)) return [command]
    if (Number(/^v(\d+)\./.exec(found)?.[1]) >= 20) return [command, '--no-warnings']
    old ??= found
    return undefined
  }
  let old: string | undefined
  state.ownRuntime = undefined
  // The person's own choice, where they made one: a path (run as it is, through no shell), or
  // `private` for nothing but the copy of Bun this mod fetched for itself.
  const named = String((await $.env.get('MCP_EVENTS_RUNTIME').catch(() => undefined)) ?? '').trim()
  if (named && named !== 'private') {
    const argv = await usable(named)
    if (argv) return argv
    throw new NoHelper(`MCP_EVENTS_RUNTIME names ${quoted(named)}, which is not a Node 20 or newer, or a Bun, that runs${old ? ` (it is Node ${plain(old)})` : ''}. Name one by its full path, or unset the variable, then start a new session.`, 'MCP Events: MCP_EVENTS_RUNTIME does not name a runtime that runs. Type /mcp-events for more.')
  }
  const own = async (): Promise<string[] | undefined> => {
    const data = await dataFolder($).catch(() => undefined)
    // Only the release this version of the mod pins, checked when it was fetched: a copy of any
    // other version in that folder, whoever put it there, is never run.
    const copy = data ? await pinned($, data) : undefined
    if (!copy) return undefined
    state.ownRuntime = `its own copy of Bun ${copy.version}`
    return [copy.path]
  }
  const offer = async () =>
    (await platformOf($).then((platform) => platform !== undefined && platform in BUN.assets, () => false))
      ? `Type /mcp-events setup to have this mod download Bun ${BUN.version} for its own use (the official release from github.com/oven-sh/bun, about 40 MB, checked against the SHA-256 pinned in the mod; nothing else on your machine changes). Or install`
      : 'Install'
  if (named === 'private') {
    const argv = await own()
    if (argv) return argv
    throw new NoHelper(`MCP_EVENTS_RUNTIME=private says to run the helper only on this mod's own copy of Bun, and there is none yet. ${await offer()} Node from https://nodejs.org or Bun from https://bun.sh and unset the variable.`, 'MCP Events has no runtime of its own yet. Type /mcp-events setup to fetch one.')
  }
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
      candidates.push(...stdout.split('\n').map((line) => line.trim()).filter((line) => /^\/[^\n]*\/(node|bun)$/.test(line)))
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
  // 4. The copy of Bun this mod fetched for itself, where the person had it do that.
  const argv = await own()
  if (argv) return argv
  const found = old ? `only Node ${plain(old)}` : 'neither'
  throw new NoHelper(
    `MCP Events needs Node 20 or newer, or Bun, to run its helper, and found ${found} on this machine. ` +
      `${await offer()} Node from https://nodejs.org or Bun from https://bun.sh, then start a new session. Until then no events are watched.`,
    `MCP Events needs Node 20 or newer, or Bun, and found ${found}. Type /mcp-events for what to do.`,
  )
}

/**
 * `/mcp-events setup`: fetches the mod's own copy of Bun, for a machine with no Node and no Bun.
 * Only on the person's own command (not the model's, a script's, another session's or an
 * unattended run's), and only after they answer yes in Claude Code's own question dialog, which
 * names what is downloaded and from where: a download that is then run is theirs to agree to. The
 * question comes once this command has answered (a dialog opened from inside the command would wait
 * on it), and the fetch after that; a notice says how it ended. (As the mcp-skills mod does.)
 */
async function setup($: EngineInterface, what: string, origin: { kind?: string } | undefined): Promise<string> {
  if (origin?.kind !== 'composer' && origin?.kind !== 'bridge') return 'This downloads a program and runs it, so it is done only when you type it yourself: /mcp-events setup, at the prompt of a `claude` session.'
  if (state.setup) return 'The download is already under way. A notice says when it is done.'
  let data: string | undefined
  try {
    data = await dataFolder($)
  } catch {
    // answered below
  }
  if (!data) return 'This session has no data folder for the plugin, so there is nowhere to put a runtime. Install Node from https://nodejs.org or Bun from https://bun.sh instead.'
  if (what === 'remove') {
    const { removed, left } = await remove($, data)
    const inUse = state.ownRuntime !== undefined
    if (left.length) return `${removed ? `Deleted ${removed} cop${removed > 1 ? 'ies' : 'y'} of Bun, but ` : ''}${removed ? (left.length > 1 ? 'these could' : 'this could') : left.length > 1 ? 'These could' : 'This could'} not be deleted, and ${left.length > 1 ? 'are' : 'is'} left not runnable: ${left.map(plain).join(', ')}. Delete ${left.length > 1 ? 'them' : 'it'} by hand.`
    return removed ? `Deleted this mod's own copy of Bun${removed > 1 ? ` (${removed} versions)` : ''}.${inUse ? ' The helper of this session keeps running on it until the session ends.' : ''}` : 'This mod has no copy of Bun of its own.'
  }
  if (what) return 'Usage: /mcp-events setup (fetch Bun for this mod), or /mcp-events setup remove (delete it).'
  // With a Node or Bun of the person's own that runs the helper, there is nothing to fetch.
  if ((await ensureHelper($).then(() => true, () => false)) && state.ownRuntime === undefined) return 'The helper already runs on a Node or Bun found on this machine, so there is nothing to set up. (To have this mod use a copy of Bun of its own instead, set MCP_EVENTS_RUNTIME=private and run this again.)'
  const where = data
  const question = `Download Bun ${BUN.version} for MCP Events? It is the official release from github.com/oven-sh/bun (about 40 MB), checked against the SHA-256 pinned in the mod before it is run, kept in the plugin's data folder and used only for this mod's helper.`
  state.setup = (async () => {
    try {
      await new Promise<void>((resolve) => $.clock.after(50, resolve))
      // "Not now" first: a dialog left unanswered must not come out as a yes.
      const answer = await $.ui.ask(question, { options: ['Not now', 'Download'], header: 'Runtime' }).catch((error: unknown) => {
        debug($, `setup: the question was not answered (${plain(error instanceof Error ? error.message : error)})`)
        return undefined
      })
      if (answer !== 'Download') {
        $.ui.toast('MCP Events: nothing was downloaded. /mcp-events setup asks again.', { timeoutMs: 10000 })
        return
      }
      const got = await install($, where)
      state.problemShown = false
      const helper = await ensureHelper($).then(() => true, () => false)
      $.ui.toast(got.isNew ? `MCP Events: Bun ${got.version} is in place${helper ? ' and the helper is running.' : ', but the helper did not start. Type /mcp-events.'}` : `MCP Events: Bun ${got.version} was already in place.`, { timeoutMs: 15000 })
      debug($, `setup: Bun ${got.version} at ${got.path} (${got.bytes} bytes, new: ${got.isNew})`)
    } catch (error) {
      const why = error instanceof SetupError ? error.message : `The setup failed (${plain(error instanceof Error ? error.message : error)}).`
      $.ui.toast(`MCP Events: ${plain(why)}`, { timeoutMs: 20000 })
      debug($, `setup failed: ${plain(why)}`)
    } finally {
      state.setup = undefined
    }
  })()
  return `MCP Events can download Bun ${BUN.version} for its own use, from github.com/oven-sh/bun, into the plugin's data folder (${plain(where)}/runtime). A question follows; nothing is downloaded unless you answer Download. It is checked against the SHA-256 pinned in the mod before anything is run, a notice says when it is done, and /mcp-events setup remove deletes it.`
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

/**
 * The helper, started if it is not running. Rejects with the reason where it cannot run.
 * `isAsked`: Claude called a tool, so the helper looks again at servers it had found without events.
 */
function ensureHelper($: EngineInterface, isAsked = false): Promise<Endpoint> {
  if (state.helper) return state.helper
  state.isStandingBy = false
  const starting = new Promise<Endpoint>((resolve, reject) => {
    void (async () => {
      let ready = false
      let failure: unknown = new Error('the helper exited before it was ready')
      try {
        const [argv, env] = await Promise.all([runtime($), $.process.hookEnv()])
        const child = $.process.spawn({ argv: [...argv, `${$.plugin.root}/dist/helper.js`], env: isAsked ? { ...env, MCP_EVENTS_PROBE: 'fresh' } : env })
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
              const where = { url: message.url, token: message.token }
              resolve(where)
            } else if (ready) {
              // Noted at once: the helper exits right after saying it, and that exit is no failure.
              if (message.t === 'standby') state.isStandingBy = true
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
          $.ui.toast(plain(failure.short))
        }
        reject(failure instanceof NoHelper ? failure : new Error(`the MCP Events helper did not start (${plain(why)})`))
        return
      }
      // It stopped. By its own choice (nothing to do) or with the session: nothing more. Otherwise
      // watches may be running, so it is started again, a few times at most.
      if (state.isEnded || state.isStandingBy) return
      const now = await $.clock.now()
      state.restarts = state.restarts.filter((at) => now - at < 10 * 60 * 1000)
      if (state.restarts.length >= 5) return debug($, 'the helper keeps stopping; not starting it again until a tool is called')
      state.restarts.push(now)
      // After a moment: at exit Claude Code stops the helper before it says the session has ended.
      $.clock.after(1000 * 2 ** (state.restarts.length - 1), () => {
        if (state.isEnded) return
        debug($, 'the helper stopped by itself; starting it again')
        void ensureHelper($).catch(() => {})
      })
    })()
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
      state.catalog = { text: String(message.text ?? ''), eventTypes: Number(message.eventTypes) || 0, watches: Number(message.watches) || 0 }
      // Once a server offers events, Claude has watch_event from the start instead of through ToolSearch.
      if (state.catalog.eventTypes > 0 && !state.isWatchLoaded) {
        state.isWatchLoaded = true
        const spec = TOOLS.find((tool) => tool.name === 'watch_event')
        if (spec) await $.tool.register({ ...spec, isDeferred: false })
      }
      return
    }
    case 'pending':
      return deliver($, where)
    case 'standby':
      state.isStandingBy = true
      return
  }
}

/**
 * Hands waiting events to Claude Code, one batch at a time: take, submit, acknowledge. A batch is
 * marked as shown only once Claude Code has started its turn, so one that never got that far is
 * handed over again. One that was submitted and whose ack was lost is acknowledged again before
 * the next take, so it is not. Events that arrive meanwhile are in the next batch.
 */
async function deliver($: EngineInterface, where: Endpoint): Promise<void> {
  if (state.isDelivering) {
    state.isMoreWaiting = true
    return
  }
  state.isDelivering = true
  try {
    do {
      state.isMoreWaiting = false
      if (state.submitted) {
        await post($, where, '/ack', state.submitted)
        state.submitted = undefined
      }
      const batch = await post($, where, '/take', {})
      const lines = Array.isArray(batch.lines) ? batch.lines.filter((l): l is string => typeof l === 'string') : []
      if (typeof batch.upto !== 'number') break
      const spool = typeof batch.spool === 'string' ? batch.spool : undefined
      if (lines.length) await $.prompt.submit({ text: lines.join('\n') })
      if (spool) state.submitted = { spool, upto: batch.upto }
      await post($, where, '/ack', { upto: batch.upto, ...(spool ? { spool } : {}) })
      state.submitted = undefined
      state.isMoreWaiting = true // look once more: the spool may hold more than one batch
    } while (state.isMoreWaiting && !state.isEnded)
  } catch (error) {
    debug($, `events could not be shown now: ${plain(error)}`)
  } finally {
    state.isDelivering = false
  }
}

/** Serves one of the mod's tools: the call goes to the helper, and its answer back to Claude. */
async function serve($: EngineInterface, name: string, e: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
    // The call's own arguments sit beside the engine's keys for it.
    const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...input } = e
    try {
      const where = await ensureHelper($, true)
      const answer = await post($, where, '/tool', { name, input })
      const text = typeof answer.text === 'string' ? answer.text : 'The MCP Events helper gave no answer.'
      return answer.isError === true ? { deny: text } : { result: text }
    } catch (error) {
      return { deny: error instanceof NoHelper ? error.message : `MCP Events could not answer: ${plain(error instanceof Error ? error.message : error)}` }
    }
}
const UNANSWERED = { deny: 'MCP Events could not answer.' }

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // MCP_EVENTS_OFF=1: installed, and doing nothing (for when Claude Code handles Events itself).
    if ((await $.env.get('MCP_EVENTS_OFF')) === '1') return started
    state.isEnded = false
    // With a person at the session (a terminal, or an app hosting it), the helper starts now, so
    // this project's saved watches resume. An unattended run (`claude -p` in a script) starts it
    // only if it calls one of the tools: it could not be woken by an event anyway.
    const env = await $.process.hookEnv().catch(() => ({}) as Record<string, string>)
    if (e.isInteractive || env.CLAUDE_CODE_SESSION_ATTENDED === '1') void ensureHelper($).catch(() => {})
    // Awaited, so the tools are listed by the first turn.
    await Promise.all([
      ...TOOLS.map((spec) => $.tool.register({ ...spec })),
      $.command.register({ name: 'mcp-events', description: 'MCP Events: what runs its helper; setup fetches Bun for a machine with no Node or Bun', argumentHint: '[setup [remove]]' }),
    ])
    return started
  })

  // /mcp-events                 what runs the helper, or why nothing does and what to do
  // /mcp-events setup           fetch the mod's own Bun (a machine with no Node and no Bun)
  // /mcp-events setup remove    delete it
  on('command.run', { command: 'mcp-events' }, async ($, e) => {
    const [verb = '', what = ''] = String(e.args ?? '').trim().split(/\s+/)
    if (verb === 'setup') return { text: await setup($, what, e.origin as { kind?: string } | undefined) }
    if (verb) return { text: 'Usage: /mcp-events, /mcp-events setup (fetch Bun for this mod, on a machine with no Node and no Bun), /mcp-events setup remove (delete it).' }
    try {
      await ensureHelper($)
      return { text: `The MCP Events helper runs on ${state.ownRuntime ?? 'the Node or Bun found on this machine'}.${state.ownRuntime ? ' /mcp-events setup remove deletes it.' : ''} Watches are Claude's to set: ask it to watch an event of one of your MCP servers.` }
    } catch (error) {
      return { text: error instanceof NoHelper ? error.message : `MCP Events could not start its helper: ${plain(error instanceof Error ? error.message : error)}` }
    }
  })

  // Each tool is hooked by its exact name, written out so `claude plugin validate` can read it.
  on('tool.run', { tool: 'mcp__mcp-events__list_event_types' }, ($, e) => serve($, 'list_event_types', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-events__watch_event' }, ($, e) => serve($, 'watch_event', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-events__unwatch_event' }, ($, e) => serve($, 'unwatch_event', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-events__list_watches' }, ($, e) => serve($, 'list_watches', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-events__get_event' }, ($, e) => serve($, 'get_event', e)).catch(() => UNANSWERED)
  on('tool.run', { tool: 'mcp__mcp-events__recent_events' }, ($, e) => serve($, 'recent_events', e)).catch(() => UNANSWERED)

  // What can be watched, where Claude reads it with every request: only while there is something to say.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const catalog = state.catalog
    if (!catalog || (catalog.eventTypes === 0 && catalog.watches === 0)) return composed
    return { sections: [...composed.sections, { id: `${PLUGIN}:catalog`, text: catalog.text, scope: 'session' as const }] }
  })

  // Events wake a session only so often (the helper counts). When the hour's wakes are spent it
  // stops until the person says something: this tells the helper that they have. Only where the
  // prompt came from is looked at, never what it says, and it goes on unchanged whatever happens here.
  on('prompt.submit', ($, e, next) => {
    if (isThePersons(e.origin?.kind) && state.helper && !state.isStandingBy && !state.isEnded) {
      void state.helper.then((where) => post($, where, '/spoke', {})).catch(() => {})
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After a /clear the process, and the helper with its watches, goes on.
    if (e.reason !== 'clear') {
      state.isEnded = true
      const where = await Promise.race([state.helper?.catch(() => undefined), $.clock.sleep(200).then(() => undefined, () => undefined)])
      if (where) await Promise.race([post($, where, '/stop', {}).catch(() => {}), $.clock.sleep(1500).catch(() => {})])
    }
    return next(e)
  })
}
