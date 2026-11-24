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
//     which is what restarts waking after its hourly limit was reached.
//
// The model reads such a prompt as "The mcp-events plugin sent a message: …",
// never as the person's own words, and what it does next goes through Claude
// Code's permissions like anything else.

import type { EngineInterface, Register } from 'claude-code'
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
} = { isStandingBy: false, isEnded: false, isDelivering: false, isMoreWaiting: false, isWatchLoaded: false, restarts: [], problemShown: false }

const debug = ($: EngineInterface, text: string) => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' })
const plain = (text: unknown) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300)

/** Why there is no helper on this machine, in words for the person and for Claude. */
class NoHelper extends Error {}

/**
 * What runs the helper: Node 20 or newer, or Bun. Claude Code itself needs neither, so a machine
 * may have none; then the tools say so, and nothing else happens.
 */
async function runtime($: EngineInterface): Promise<string[]> {
  const version = async (argv: string[]) => {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 10000 })
      return exitCode === 0 ? stdout.trim() : undefined
    } catch {
      return undefined
    }
  }
  const node = await version(['node', '--version'])
  const major = Number(/^v(\d+)\./.exec(node ?? '')?.[1])
  if (major >= 20) return ['node', '--no-warnings']
  if (await version(['bun', '--version'])) return ['bun']
  throw new NoHelper(
    node
      ? `MCP Events needs Node 20 or newer (or Bun) on your PATH to run its helper; this machine has Node ${plain(node)}.`
      : 'MCP Events needs Node 20 or newer (or Bun) on your PATH to run its helper, and found neither.',
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
          $.ui.toast(plain(why))
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
 * handed over again. Events that arrive meanwhile are in the next batch.
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
      const batch = await post($, where, '/take', {})
      const lines = Array.isArray(batch.lines) ? batch.lines.filter((l): l is string => typeof l === 'string') : []
      if (typeof batch.upto !== 'number') break
      if (lines.length) await $.prompt.submit({ text: lines.join('\n') })
      await post($, where, '/ack', { upto: batch.upto })
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
    await Promise.all(TOOLS.map((spec) => $.tool.register({ ...spec })))
    return started
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
