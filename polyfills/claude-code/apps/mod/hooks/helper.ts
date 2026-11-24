// Helper process lifecycle, discovery, HTTP transport, and incoming messages.

import type { EngineInterface, On } from 'claude-code'
import type { HelperEndpoint, HelperMessage, UiTool, View } from './state'
import { allowDownload, allowTool, appMessage, onNotify, openLink, plainText } from './consent'
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
    verdicts.clear()
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
      Promise.all(open.map((view) => helper($, '/close', { viewId: view.id }).catch(() => {}))),
      $.clock.sleep(1500).catch(() => {}),
    ])
    return next(e)
  })
}

/** A view's app calls in flight to read-only tools, by view, tool and arguments (see case 'request'). */
const appCalls = new Map<string, Promise<Awaited<ReturnType<EngineInterface['mcp']['call']>>>>()

/** Claude Code's verdicts on servers, each kept a moment (several hooks ask in a row). */
const verdicts = new Map<string, { epoch: number; at: number; answer: Promise<boolean> }>()
const VERDICT_MS = 5000

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
  const now = Date.now()
  const kept = verdicts.get(server)
  if (kept && kept.epoch === state.epoch && now - kept.at < VERDICT_MS) return kept.answer
  const answer = $.mcp.connect(server).then(
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
  verdicts.set(server, { epoch: state.epoch, at: now, answer })
  return answer
}

/** The routes that name a server, and so wait for Claude Code's verdict on it. */
const SERVER_ROUTES = new Set(['/discover', '/prewarm', '/open'])

export function discover($: EngineInterface, server: string) {
  let found = discovered.get(server)
  if (!found) {
    found = helper($, '/discover', { server }).then((answer) => {
      if (!answer.ok) throw new Error(String(answer.error))
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

/** Queue a request per view so pointer and key events keep their order. */
export function send($: EngineInterface, view: View, route: string, body: unknown) {
  // Input from the person: what the view shows now is theirs (see sleepLater).
  if (route === '/input') view.touched = true
  view.chain = view.chain
    .then(() => helper($, route, body))
    .catch((error) => $.ui.log(`mcp-apps-cli: ${route} failed: ${String(error)}`, { to: 'debug' }))
}

export async function helper($: EngineInterface, route: string, body: unknown) {
  // Nothing about a server Claude Code doesn't use goes to the helper, nor
  // starts it.
  const server = SERVER_ROUTES.has(route) ? (body as { server?: unknown } | undefined)?.server : undefined
  if (server !== undefined && !(typeof server === 'string' && (await usedByClaudeCode($, server)))) {
    throw new Error(`Claude Code is not using an MCP server named ${JSON.stringify(plainText(server))} in this session`)
  }
  const where = await startHelper($)
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

async function onHelperMessage($: EngineInterface, message: HelperMessage) {
  switch (message.type) {
    case 'frame': {
      const view = views.get(message.viewId)
      if (!view) return
      view.v = message.v
      if (message.frame) return showPicture($, view, { frame: message.frame })
      if (message.image) return showPicture($, view, { image: message.image })
      return
    }
    case 'request': {
      const view = views.get(message.viewId)
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
        if (view && message.method === 'ui/allow-tool') {
          const name = String(message.params.name ?? '')
          const args = (message.params.arguments ?? {}) as Record<string, unknown>
          const verdict = await allowTool($, view, name, args, message.params.appOnly === true)
          // Closed while it was decided (the rules, the question, its turn): refused.
          reply = { id: message.id, result: verdict.allow && !isLive(view) ? { allow: false, reason: `the ${view.server} app closed` } : verdict }
          await helper($, '/reply', reply).catch(() => {})
          return
        }
        if (view && message.method === 'ui/message') {
          reply = { id: message.id, result: await appMessage($, view, message.params) }
          await helper($, '/reply', reply).catch(() => {})
          return
        }
        if (view && message.method === 'ui/open-link') {
          reply = { id: message.id, result: await openLink($, view, String(message.params.url ?? '')) }
          await helper($, '/reply', reply).catch(() => {})
          return
        }
        if (view && message.method === 'ui/allow-download') {
          reply = { id: message.id, result: await allowDownload($, view, message.params.files) }
          await helper($, '/reply', reply).catch(() => {})
          return
        }
        if (view && message.method === 'ui/request-display-mode') {
          reply = { id: message.id, result: { mode: await setDisplay($, view, String(message.params.mode ?? '')) } }
          await helper($, '/reply', reply).catch(() => {})
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
        reply = { id: message.id, result }
      } catch (error) {
        reply = { id: message.id, error: String(error) }
      }
      await helper($, '/reply', reply).catch(() => {})
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
      return onNotify($, message.viewId, message.method, message.params)
    case 'closed': {
      // Chrome stopped, or the app's page crashed: the view can be opened again.
      const view = views.get(message.viewId)
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
      const view = views.get(message.viewId)
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
