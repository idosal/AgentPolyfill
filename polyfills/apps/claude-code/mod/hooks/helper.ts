// Helper process lifecycle, discovery, HTTP transport, and incoming messages.

import type { EngineInterface, On } from 'claude-code'
import type { HelperEndpoint, HelperMessage, UiTool, View } from './state'
import { allowDownload, allowTool, appMessage, onNotify, openLink, plainText } from './consent'
import { ownSignIn } from './settings'
import { allowedForSession, discovered, earlyCalls, isLive, linksAllowed, messagesAllowed, modelContext, ranCalls, seenCalls, state, views } from './state'
import { loadRowsSeen, paneId, restoreViews, saveViews, setDisplay, showPicture, sleepWhenAnswered, trimClosed } from './views'

/**
 * The helper (helper-rs) is a binary per platform, all carried by the
 * plugin in helper/bin/<os>-<arch>/ (package/package.sh builds the package):
 * the one for this machine runs. Nothing is downloaded or installed for it.
 * A machine it has none for, or whose binary can't start, gets one toast
 * saying so (and each view the reason), and no views.
 */
const BINARY = 'mcp-apps-cli-helper'

export function registerHelperHooks(on: On) {
  on('session.start', async ($, e, next) => {
    state.isActive = e.isInteractive && e.surface === 'terminal'
    // The helper (10–40 MB) starts with the first MCP call, as Claude
    // starts writing it (see the turn.step hook): a session that calls no
    // MCP tool never runs it. Learning whether the tool has an app then
    // happens while Claude is still writing the call.
    if (state.isActive) {
      void loadRowsSeen($)
      // After a reload of this code (an update mid-session): the views it had.
      void restoreViews($)
    }
    return next(e)
  })

  // The session ends, or /clear starts a new one: apps get their teardown.
  on('session.end', async ($, e, next) => {
    // What the person allowed for the session ends with it (and with /clear),
    // and so does an answer still to come (see askPerson).
    state.epoch++
    allowedForSession.clear()
    messagesAllowed.clear()
    linksAllowed.clear()
    // No app's context crosses into the next conversation, whatever its view;
    // nor what the calls of this one were (see stream.ts).
    modelContext.clear()
    ranCalls.clear()
    seenCalls.clear()
    earlyCalls.clear()
    const open = [...views.values()].filter((v) => v.status === 'live' || v.status === 'opening')
    for (const view of open) view.status = 'closed'
    saveViews($)
    await Promise.race([
      Promise.all(open.map((view) => helper($, '/close', { viewId: view.id, gen: view.gen }).catch(() => {}))),
      $.clock.sleep(1500).catch(() => {}),
    ])
    return next(e)
  })
}

/** A view's app calls in flight to read-only tools, by view, tool and arguments (see case 'request'). */
const appCalls = new Map<string, Promise<Awaited<ReturnType<EngineInterface['mcp']['call']>>>>()

/**
 * Claude Code's verdicts on servers. None is kept: each request that names a
 * server, and each request the helper writes to one, asks afresh (0.1.2 reused
 * a yes for 5 s for discovery and opening). `revocations` counts, per server,
 * the noes heard; a yes carries the count as it was when it was asked (its
 * epoch), and the helper refuses one older than the last /revoke it was sent,
 * so a yes that crossed a no on the way never sends anything. `admitted`: the
 * servers given a yes since the helper was last told no, the ones it may hold
 * a connection to (model/AppsViews.tla, FixAtSend and FixRevoke).
 */
const revocations = new Map<string, number>()
const admitted = new Set<string>()

/** Claude Code's verdict on `server`, asked now; a no tells the helper (/revoke). */
export async function verdict($: EngineInterface, server: string): Promise<{ used: boolean; epoch: number }> {
  const epoch = revocations.get(server) ?? 0
  const used = await $.mcp.connect(server).then(
    (found) => {
      const used = found.isConnected && found.server === server
      if (!used) {
        const why = found.isConnected ? `Claude Code runs it as ${JSON.stringify(plainText(found.server))}` : plainText(found.reason)
        $.ui.log(`mcp-apps-cli: no app views for ${plainText(server)}: ${why}`, { to: 'debug' })
      }
      return used
    },
    (error: unknown) => {
      $.ui.log(`mcp-apps-cli: no app views for ${plainText(server)}: ${plainText(String(error))}`, { to: 'debug' })
      return false
    },
  )
  if (!used) {
    revoke($, server)
    return { used: false, epoch }
  }
  // A no heard while this was asked outranks it.
  if ((revocations.get(server) ?? 0) !== epoch) return { used: false, epoch }
  admitted.add(server)
  return { used: true, epoch }
}

/**
 * Whether Claude Code itself uses `server` in this session, under exactly
 * that name: `$.mcp.connect` says it is connected and lists it so. Asked
 * before the helper hears the name at all: it is never asked to start,
 * connect to or read from a server that Claude Code has not approved, has
 * switched off, refuses by policy or doesn't know. A server Claude Code runs
 * under another name (a claude.ai connector, a plugin's server) is not one
 * the helper could find in a config file, so it gets no app either. The
 * helper checks the config files on its own as well (see helper-rs/src/config.rs).
 */
export function usedByClaudeCode($: EngineInterface, server: string): Promise<boolean> {
  return verdict($, server).then((found) => found.used)
}

/**
 * Claude Code stopped using `server`: the helper cancels what it has in
 * flight to it, closes its connection (a stdio server it started stops) and
 * sends it nothing on a yes given before this. Not sent to a helper that
 * holds nothing of the server's, nor does it start one.
 */
function revoke($: EngineInterface, server: string) {
  const epoch = (revocations.get(server) ?? 0) + 1
  revocations.set(server, epoch)
  if (!admitted.delete(server) || !state.helperSocket) return
  void request($, '/revoke', { server, epoch }).catch((error) =>
    $.ui.log(`mcp-apps-cli: /revoke failed: ${String(error)}`, { to: 'debug' }),
  )
}

/**
 * While the helper waits on a server (it says so: 'busy'), Claude Code is
 * asked again every WATCH_MS, so a server switched off meanwhile has what is
 * in flight to it cancelled within about that long, not at the next request.
 */
const WATCH_MS = 500
const waitingOn = new Map<string, boolean>()
const watching = new Set<string>()

async function watchServer($: EngineInterface, server: string) {
  if (watching.has(server)) return
  watching.add(server)
  try {
    while (waitingOn.get(server)) {
      // A timer that failed (a reload of the code mid-wait) ends the watch.
      if (!(await $.clock.sleep(WATCH_MS).then(() => true, () => false))) return
      if (!waitingOn.get(server)) return
      if (!(await verdict($, server)).used) return
    }
  } finally {
    watching.delete(server)
  }
}

/** The routes that name a server, and so wait for Claude Code's verdict on it. */
const SERVER_ROUTES = new Set(['/discover', '/prewarm', '/open'])

export function discover($: EngineInterface, server: string) {
  let found = discovered.get(server)
  if (!found) {
    found = helper($, '/discover', { server }).then((answer) => {
      if (!answer.ok) throw new Error(String(answer.error))
      // Once a session for each server, as the relay is announced.
      if (answer.ownSignIn === true) {
        $.ui.log(
          `mcp-apps-cli: ${server}: using the helper's own sign-in (not Claude Code's). Sign out: mcp-apps-cli-helper signout ${server}`,
          { to: 'debug' },
        )
      }
      const tools = (answer.tools ?? {}) as Record<string, UiTool>
      state.serversWithApps.set(server, Object.keys(tools).length > 0)
      const definitions = (answer.definitions ?? {}) as Record<string, { annotations?: { readOnlyHint?: unknown } }>
      state.readOnlyTools.set(
        server,
        new Set(Object.keys(definitions).filter((name) => definitions[name]?.annotations?.readOnlyHint === true)),
      )
      state.toolNames.set(server, new Set(Object.keys(definitions)))
      return tools
    })
    found.catch(() => discovered.delete(server))
    discovered.set(server, found)
  }
  return found
}

/**
 * Queue a request per view so pointer and key events keep their order. Each
 * carries the view's generation: the helper does it only for that open's page.
 */
export function send($: EngineInterface, view: View, route: string, body: unknown) {
  // Input from the person: what the view shows now is theirs (see sleepLater).
  if (route === '/input') view.touched = true
  const sent = body && typeof body === 'object' ? { ...body, gen: view.gen } : body
  view.chain = view.chain
    .then(() => helper($, route, sent))
    .catch((error) => $.ui.log(`mcp-apps-cli: ${route} failed: ${String(error)}`, { to: 'debug' }))
}

/**
 * A view's /open and /close go to the helper one at a time, each once the one
 * before it is answered. They are separate requests, and the helper matches
 * them by view id: taken out of order, a close meant for an earlier open of
 * the id could undo a reopen, or come before the page it was for and leave
 * that page running unseen (found by the model, model/AppsViews.tla).
 */
const VIEW_TURN_ROUTES = new Set(['/open', '/close'])
const viewTurns = new Map<string, Promise<unknown>>()
/** How long a view's request waits for the one before it at most (an open that never answers). */
const VIEW_TURN_MS = 60_000

export function helper($: EngineInterface, route: string, body: unknown): Promise<Record<string, unknown> & { ok?: boolean; error?: unknown }> {
  const viewId = VIEW_TURN_ROUTES.has(route) ? (body as { viewId?: unknown } | undefined)?.viewId : undefined
  if (typeof viewId !== 'string') return request($, route, body)
  const before = viewTurns.get(viewId)
  const waited = before
    ? Promise.race([before, $.clock.sleep(VIEW_TURN_MS).then(undefined, () => new Promise<void>(() => {}))])
    : Promise.resolve()
  const turn = waited.then(() => request($, route, body))
  const done = turn.then(() => undefined, () => undefined)
  viewTurns.set(viewId, done)
  void done.then(() => {
    if (viewTurns.get(viewId) === done) viewTurns.delete(viewId)
  })
  return turn
}

async function request($: EngineInterface, route: string, body: unknown) {
  // Nothing about a server Claude Code doesn't use goes to the helper, nor
  // starts it.
  const server = SERVER_ROUTES.has(route) ? (body as { server?: unknown } | undefined)?.server : undefined
  if (server !== undefined && !(typeof server === 'string' && (await usedByClaudeCode($, server)))) {
    throw new Error(`Claude Code is not using an MCP server named ${JSON.stringify(plainText(server))} in this session`)
  }
  const where = await startHelper($)
  // Whether the person listed the server under "Own sign-in (OAuth)": the
  // helper uses its own sign-in for it only then.
  if (typeof server === 'string') body = { ...(body as object), ownSignIn: ownSignIn(server) }
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-mcp-apps-cli-token': where.token }
  const init =
    'socketPath' in where
      ? { method: 'POST', headers, body: JSON.stringify(body), socketPath: where.socketPath }
      : { method: 'POST', headers, body: JSON.stringify(body) }
  const response = await $.http.fetch('socketPath' in where ? `http://localhost${route}` : `${where.url}${route}`, init)
  return JSON.parse(response.text) as Record<string, unknown> & { ok?: boolean; error?: unknown }
}

/** This machine, as the binaries are named: darwin-arm64, linux-x64, win32-x64… */
export async function platformKey($: EngineInterface, env: Record<string, string>): Promise<string> {
  // Windows says so in its environment, whatever a Unix toolkit on the PATH
  // answers to uname (Git for Windows' says MINGW64_NT-…). Windows on Arm
  // runs the x64 binary, emulated.
  if (env.OS === 'Windows_NT') return 'win32-x64'
  let system = ''
  try {
    system = (await $.process.run(['uname', '-sm'])).stdout.trim()
  } catch {
    // No uname, and not Windows: a machine there's no binary for.
  }
  const [os = '', machine = ''] = system.split(/\s+/)
  if (/^(mingw|msys|cygwin)/i.test(os)) return 'win32-x64'
  const arch = /^(arm64|aarch64)$/i.test(machine) ? 'arm64' : /^(x86_64|amd64)$/i.test(machine) ? 'x64' : machine.toLowerCase() || 'unknown'
  if (/^darwin$/i.test(os)) return `darwin-${arch}`
  if (/^linux$/i.test(os)) return `linux-${arch}`
  return `${os.toLowerCase() || 'unknown'}-${arch}`
}

/** Why there are no views on this machine: said once a session, as a toast (each view says it too). */
class NoHelper extends Error {}

/**
 * The helper to run: the plugin's binary for this machine. On macOS and
 * Linux one that lost its executable bit on the way (an archive that keeps
 * no file modes) is copied into the plugin's data folder and marked
 * executable there, once per binary: the plugin's own copy stays as it was
 * installed.
 */
async function helperArgv($: EngineInterface, env: Record<string, string>): Promise<string[]> {
  const key = await platformKey($, env)
  const windows = key.startsWith('win32')
  const carried = `${$.plugin.root}/helper/bin/${key}/${BINARY}${windows ? '.exe' : ''}`
  if (!(await $.fs.exists(carried).catch(() => false))) {
    throw new NoHelper(`this plugin has no helper for this machine (${key})`)
  }
  if (windows || (await runnable($, carried))) return [carried]
  const data = env.CLAUDE_PLUGIN_DATA
  if (!data) throw new NoHelper("the plugin's helper isn't executable, and there's no plugin data folder to fix that in")
  const folder = `${data}/helper-bin/${key}`
  const copy = `${folder}/${BINARY}`
  const [from, to] = await Promise.all([$.fs.stat(carried).catch(() => undefined), $.fs.stat(copy).catch(() => undefined)])
  // Copied before: reused only if it is this plugin's binary byte for byte
  // (every release's files have the same time, and a new one may have the
  // old one's size: an earlier release's copy is never run), and runnable.
  const identical = () => $.process.run(['cmp', '-s', carried, copy]).then((result) => result.exitCode === 0, () => false)
  if (from && to && to.size === from.size && (await identical()) && (await runnable($, copy))) return [copy]
  const run = async (argv: string[]) => {
    const { exitCode, stderr } = await $.process.run(argv)
    if (exitCode !== 0) throw new NoHelper(`making the helper executable: ${argv[0]} failed (${plainText(stderr).trim()})`)
  }
  // Written under a temporary name of its own (two sessions copying at once
  // never share one) and renamed once whole and executable, in folders only
  // the person can open. A step that fails leaves no temporary behind.
  const temporary = `${folder}/.copy-${crypto.randomUUID()}`
  await run(['mkdir', '-p', folder])
  await run(['chmod', '700', data, `${data}/helper-bin`, folder])
  try {
    await run(['cp', '-p', carried, temporary])
    await run(['chmod', '755', temporary])
    await run(['mv', '-f', temporary, copy])
  } catch (error) {
    await $.process.run(['rm', '-f', temporary]).catch(() => undefined)
    throw error
  }
  return [copy]
}

/** A file this user may run (macOS and Linux). */
const runnable = ($: EngineInterface, path: string) =>
  $.process.run(['test', '-x', path]).then(
    (result) => result.exitCode === 0,
    () => false,
  )

function startHelper($: EngineInterface): Promise<HelperEndpoint> {
  if (state.helperSocket) return state.helperSocket
  state.helperSocket = new Promise<HelperEndpoint>((resolve, reject) => {
    void (async () => {
      let ready = false
      try {
        // CLAUDE_PLUGIN_DATA among them: where the helper keeps view stores.
        const env = await $.process.hookEnv().catch(() => ({}) as Record<string, string>)
        let failure: unknown
        try {
          const argv = await helperArgv($, env)
          failure = await runHelper($, argv, env, (endpoint) => {
            ready = true
            resolve(endpoint)
          })
        } catch (error) {
          failure = error
        }
        // No helper for this machine, or it couldn't start: said once a session.
        if (!ready && !state.helperProblemShown) {
          state.helperProblemShown = true
          const why = plainText(failure instanceof Error ? failure.message : String(failure))
          $.ui.log(`mcp-apps-cli: the helper didn't start: ${why}`, { to: 'debug' })
          $.ui.toast(`MCP App views can't open: ${failure instanceof NoHelper ? why : `the plugin's helper didn't start (${why.slice(0, 120)})`}`)
        }
        if (!ready) reject(failure instanceof Error ? failure : new Error(String(failure)))
      } catch (error) {
        if (!ready) reject(error instanceof Error ? error : new Error(String(error)))
      }
      state.helperSocket = undefined
      discovered.clear()
      // A new helper holds no connection, and waits on nothing.
      admitted.clear()
      waitingOn.clear()
      for (const view of views.values()) {
        if (view.status === 'live' || view.status === 'opening') view.status = 'closed'
      }
      // The views are closed: their context goes with them.
      modelContext.clear()
      $.ui.invalidate('ui.render')
    })()
  })
  return state.helperSocket
}

/**
 * Runs one helper until it exits, passing its messages on; `onReady` gets
 * where it listens. Resolves once it has exited: undefined if it was ready
 * first, else why it never was.
 */
async function runHelper(
  $: EngineInterface,
  argv: string[],
  env: Record<string, string>,
  onReady: (endpoint: HelperEndpoint) => void,
): Promise<unknown> {
  let buffer = ''
  let ready = false
  let failure: unknown = new Error('the helper exited before it was ready')
  try {
    const child = $.process.spawn({ argv, env })
    for await (const piece of child) {
      if (piece.stream === 'stderr') {
        // Lines may carry an app's console text: no control characters.
        $.ui.log(piece.text.trimEnd().replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' '), { to: 'debug' })
        continue
      }
      buffer += piece.text
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        let message: HelperMessage
        try {
          message = JSON.parse(line) as HelperMessage
        } catch {
          continue
        }
        if (message.type === 'ready') {
          state.terminalShowsImages = message.images === true
          state.swapEveryDraw = message.swapEveryDraw !== false
          // The person's environment, as the helper (not a hook) sees it.
          const vars = message.env ?? {}
          state.noFlicker = typeof vars.CLAUDE_CODE_NO_FLICKER === 'string' ? vars.CLAUDE_CODE_NO_FLICKER : undefined
          state.tmux = typeof vars.TMUX === 'string' && vars.TMUX !== ''
          const sleep = Number(vars.MCP_APPS_CLI_SLEEP_S)
          if (typeof vars.MCP_APPS_CLI_SLEEP_S === 'string' && Number.isFinite(sleep) && sleep >= 0) state.sleepAfterMs = sleep * 1000
          if (message.socket) onReady({ socketPath: message.socket, token: message.token ?? '' })
          else if (message.url && message.token) onReady({ url: message.url, token: message.token })
          else {
            failure = new Error('the helper said where it listens in a way this mod does not know')
            continue
          }
          ready = true
        } else {
          if (message.type === 'fatal' && !ready) failure = new Error(plainText(message.text))
          void onHelperMessage($, message)
        }
      }
    }
  } catch (error) {
    failure = error
  }
  return ready ? undefined : failure
}

/**
 * The view an id names now, if what the helper says is of that view's own
 * open: a message from the page of an earlier open of the id (closed, or
 * replaced by a reopen) is none of this one's.
 */
function viewOf(message: { viewId: string; gen?: string }): View | undefined {
  const view = views.get(message.viewId)
  return view && view.gen === message.gen ? view : undefined
}

async function onHelperMessage($: EngineInterface, message: HelperMessage) {
  switch (message.type) {
    case 'check': {
      // The helper is about to write a request to this server: Claude Code's
      // verdict, asked for that request, with the epoch it was given in.
      const server = String(message.server ?? '')
      const found = await verdict($, server)
      const result = found.used
        ? { allow: true, epoch: found.epoch }
        : { allow: false, reason: `Claude Code is not using the ${plainText(server)} server now` }
      await request($, '/reply', { id: message.id, result }).catch(() => {})
      return
    }
    case 'busy': {
      waitingOn.set(message.server, message.busy === true)
      if (message.busy === true) void watchServer($, message.server)
      return
    }
    case 'frame': {
      const view = viewOf(message)
      if (!view) return
      view.v = message.v
      if (message.frame) return showPicture($, view, { frame: message.frame })
      if (message.image) return showPicture($, view, { image: message.image })
      return
    }
    case 'request': {
      const current = views.get(message.viewId)
      // Asked by the page of an earlier open of this id: refused, whatever it
      // is, and nothing of it is done for the view that stands now.
      if (current && current.gen !== message.gen) {
        await helper($, '/reply', { id: message.id, gen: message.gen, error: 'this view was opened again' }).catch(() => {})
        return
      }
      const view = current
      // Every answer names the open it is for.
      const answer = (body: Record<string, unknown>) => helper($, '/reply', { id: message.id, gen: message.gen, ...body }).catch(() => {})
      // Asked and not yet answered (a long tool call, a question to the
      // person): such a view isn't still (see restWhenStill).
      if (view) view.asked = (view.asked ?? 0) + 1
      try {
      let reply: Record<string, unknown>
      try {
        // A view opened while Claude wrote its call: what it asks waits
        // until the call is allowed, and is refused if it never runs.
        if (view && message.method !== 'ui/request-display-mode' && !(await view.approval)) {
          throw new Error("this view's tool call did not run")
        }
        // A view closed (or evicted) asks nothing more.
        if (view && !isLive(view)) throw new Error('this view is closed')
        // An app's own traffic to its server (a call of its tools, a read of
        // its resources) goes only while Claude Code still uses that server
        // under that name, asked afresh each time: one switched off or
        // disconnected after the view opened gets nothing more from its app
        // (found by the model, model/AppsViews.tla). For a tool, asked again
        // right before the yes goes back, so the yes is as new as it can be: a
        // question to the person may have taken minutes. The yes carries its
        // epoch (see verdict).
        const notUsed = { allow: false, reason: `Claude Code is not using the ${view?.server} server now` }
        if (view && message.method === 'ui/allow-tool' && !(await usedByClaudeCode($, view.server))) {
          await answer({ result: notUsed })
          return
        }
        if (view && message.method === 'ui/allow-read') {
          const found = isLive(view) ? await verdict($, view.server) : undefined
          await answer({
            result: !found ? { allow: false, reason: `the ${view.server} app closed` } : found.used ? { allow: true, epoch: found.epoch } : notUsed,
          })
          return
        }
        if (view && message.method === 'ui/allow-tool') {
          const name = String(message.params.name ?? '')
          const args = (message.params.arguments ?? {}) as Record<string, unknown>
          const consent = await allowTool($, view, name, args, message.params.appOnly === true)
          // Closed while it was decided (the rules, the question, its turn): refused.
          if (consent.allow && !isLive(view)) {
            await answer({ result: { allow: false, reason: `the ${view.server} app closed` } })
            return
          }
          if (!consent.allow) {
            await answer({ result: consent })
            return
          }
          const found = await verdict($, view.server)
          await answer({ result: found.used && isLive(view) ? { ...consent, epoch: found.epoch } : notUsed })
          return
        }
        if (view && message.method === 'ui/message') {
          await answer({ result: await appMessage($, view, message.params) })
          return
        }
        if (view && message.method === 'ui/open-link') {
          await answer({ result: await openLink($, view, String(message.params.url ?? '')) })
          return
        }
        if (view && message.method === 'ui/allow-download') {
          await answer({ result: await allowDownload($, view, message.params.files) })
          return
        }
        if (view && message.method === 'ui/request-display-mode') {
          await answer({ result: { mode: await setDisplay($, view, String(message.params.mode ?? '')) } })
          return
        }
        if (!view || message.method !== 'tools/call') throw new Error(`unsupported ${message.method}`)
        view.appCallAt = Date.now()
        const name = String(message.params.name ?? '')
        const args = (message.params.arguments ?? {}) as Record<string, unknown>
        // A view's identical calls in flight to a tool that only reads (its
        // annotations say so) share one: apps often ask twice as they load.
        // Any other tool is called each time, as it may not answer the same.
        const key = state.readOnlyTools.get(view.server)?.has(name) ? `${view.id}\n${name}\n${JSON.stringify(args)}` : undefined
        let call = key ? appCalls.get(key) : undefined
        if (!call) {
          call = $.mcp.call(view.server, name, args)
          if (key) {
            appCalls.set(key, call)
            void call.then(() => appCalls.delete(key), () => appCalls.delete(key))
          }
        }
        const result = await call
        reply = { result }
      } catch (error) {
        reply = { error: String(error) }
      }
      await answer(reply)
      return
      } finally {
        if (view) {
          view.asked = Math.max(0, (view.asked ?? 1) - 1)
          if (message.method === 'tools/call') view.appCallAt = Date.now()
          sleepWhenAnswered($, view)
        }
      }
    }
    case 'notify':
      // What an earlier open's page says (its context for the model, a copy)
      // is none of the view that stands now.
      if (views.has(message.viewId) && !viewOf(message)) return
      return onNotify($, message.viewId, message.method, message.params)
    case 'closed': {
      // Chrome stopped, or the app's page crashed: the view can be opened again.
      const view = viewOf(message)
      if (!view || view.status === 'closed') return
      if (view.display === 'pip') void $.ui.close({ id: paneId(view) }).catch(() => undefined)
      view.display = 'inline'
      view.status = 'closed'
      view.closedWhy = plainText(message.reason).slice(0, 80)
      modelContext.delete(view.id)
      trimClosed()
      saveViews($)
      $.ui.invalidate('ui.render')
      return
    }
    case 'describe': {
      // What the app shows, as text: a picture's alt (see pictureBlock), and
      // its page's title, which names it in its header.
      const view = viewOf(message)
      if (!view) return
      let redraw = false
      if (message.text !== undefined) {
        const text = plainText(message.text).slice(0, 300)
        if (text && text !== view.alt) {
          view.alt = text
          redraw ||= view.mode === 'image'
        }
      }
      if (message.title !== undefined) {
        const title = plainText(message.title).slice(0, 60)
        if (title !== (view.title ?? '')) {
          view.title = title || undefined
          redraw = true
        }
      }
      if (redraw) {
        $.ui.invalidate('ui.render')
        saveViews($)
      }
      return
    }
    case 'log':
      $.ui.log(`mcp-apps-cli: ${plainText(message.text)}`, { to: 'debug' })
      return
    case 'status':
      $.ui.status(plainText(message.text) || undefined)
      return
    case 'fatal':
      $.ui.status(undefined)
      $.ui.toast(plainText(message.text))
      for (const view of views.values()) {
        if (view.status === 'opening') {
          view.status = 'error'
          view.error = plainText(message.text)
        }
      }
      $.ui.invalidate('ui.render')
      return
  }
}
