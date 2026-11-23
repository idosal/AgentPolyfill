// MCP tool calls and streamed arguments, including early-view approval and cancellation.

import type { EngineInterface, On } from 'claude-code'
import type { View } from './state'
import { discover, helper, send } from './helper'
import { dropView, openView, saveViews } from './views'
import { earlyCalls, ENGINE, modelContext, openings, partialArgs, ranCalls, seenCalls, state, views, withheldCalls } from './state'
import { offerFullscreenSoon } from './fullscreen'
import { terminalTheme } from './settings'

const MCP_TOOL = /^mcp__(.+?)__(.+)$/

// The keys a tool call carries beside the tool's own arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

/** How often a call's arguments go to its app at most while Claude writes them. */
const PARTIAL_MS = 100

/** One MCP call Claude is writing: its arguments' JSON so far. */
type Writing = { id: string; json: string; sentAt: number; dirty: boolean }

export function registerToolHooks(on: On) {
  // Where MCP tools are deferred, Claude loads one through ToolSearch a
  // moment before it calls it. A loaded tool with an app gets the helper,
  // its server's discovery and Chrome started now, so its view's first
  // picture doesn't wait on them; Chrome only for a tool that has an app.
  // ToolSearch itself runs and answers as it would.
  on('tool.run', { tool: 'ToolSearch' }, async ($, e, next) => {
    const ran = await next(e)
    if (state.isActive && next.origin.plugin === ENGINE && 'result' in ran) {
      const matches = (ran.result as { matches?: unknown } | undefined)?.matches
      if (Array.isArray(matches)) warmFor($, matches)
    }
    return ran
  })

  // Watches each MCP call after it ran. The result is never changed; for a
  // tool with an app, the model is told (in context the user doesn't see)
  // that the app is on screen, so it doesn't rebuild it as text.
  // Once a call to an MCP tool is allowed, as it starts to run: a tool with
  // an app gets its view now, with the input, and the result when it comes
  // (the app shows its own loading state meanwhile; Chrome starts while the
  // tool runs). A call that fails to run is cancelled in the app. Only MCP
  // tools: a hook here would keep any tool it may match out of the
  // background.
  on('tool.run', { tool: /^mcp__/ }, async ($, e, next) => {
    const match = MCP_TOOL.exec(e.tool)
    // A plugin's call ($.mcp.call: an app's own, through this plugin, or
    // another plugin's) comes back through these hooks too. It has no row of
    // its own and opens nothing: a view for it ran a hidden copy of the app,
    // approved, and took the input from the one on screen. Only the
    // engine's calls (the model's) open views.
    if (!state.isActive || !match || !e.tool_use_id || next.origin.plugin !== ENGINE) return next(e)
    const [, server = '', tool = ''] = match
    const id = e.tool_use_id
    // The session it runs in, before anything is awaited (see openViewNow).
    const epoch = state.epoch
    // Taken up here, at once: tool.call's handler leaves this call's view alone.
    ranCalls.add(id)
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))
    // Chrome starts while the tool runs, before we know it has an app;
    // not for a server known to have none (it'd start Chrome for nothing).
    if (state.serversWithApps.get(server) !== false) void prewarm($, server, tool, state.serversWithApps.get(server) === true)
    // The view opened while Claude wrote the call, or opens now.
    const opening = openView($, { id, server, tool, input, theme: await terminalTheme($), epoch }).catch((error) =>
      $.ui.log(`mcp-apps-cli: open failed: ${String(error)}`, { to: 'debug' }),
    )
    // Allowed: the app gets all the arguments now, and may ask things of the host.
    void opening.then(() => {
      const view = views.get(id)
      if (view) allowCall($, view, input)
    })
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      // The tool didn't run to an outcome: the app hears so, rather than nothing.
      void opening.then(() => {
        const view = views.get(id)
        if (view?.call) view.call.cancelled = String(error)
        if (view?.status === 'live') send($, view, '/cancel', { viewId: id, reason: String(error) })
      })
      throw error
    }
    void opening.then(() => {
      const view = views.get(id)
      if (view?.call) {
        if (ran.deny !== undefined) view.call.cancelled = String(ran.deny)
        else view.call.result = ran.result
        saveViews($)
      }
      if (!view || view.status !== 'live') return
      if (ran.deny !== undefined) send($, view, '/cancel', { viewId: id, reason: String(ran.deny) })
      else send($, view, '/result', { viewId: id, result: ran.result })
    })
    return ran
  })

  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    // A plugin's call (see tool.run): nothing to track or tell the model.
    if (next.origin.plugin !== ENGINE) return next(e)
    if (e.tool_use_id) seenCalls.add(e.tool_use_id)
    const ran = await next(e)
    if (!state.isActive) return ran
    // A view opened while Claude wrote the call, whose call never ran
    // (tool.run never came): denied, which reads as a refusal or an error,
    // or answered by a hook in its place. The app learns how it ended.
    const id = e.tool_use_id
    const early = id ? openings.get(id) : undefined
    if (id && early && earlyCalls.has(id) && !ranCalls.has(id)) {
      const input = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))
      void early.then(() => {
        const view = views.get(id)
        if (!view || view.approved !== undefined) return
        if (ran.deny !== undefined) return refuseCall($, view, input, ran.deny)
        if (ran.isError) return refuseCall($, view, input, ran.text ?? String(ran.result ?? 'the call did not run'))
        allowCall($, view, input)
        if (view.call) view.call.result = ran.result
        saveViews($)
        if (view.status === 'live') send($, view, '/result', { viewId: id, result: ran.result })
      })
    }
    try {
      const match = MCP_TOOL.exec(e.tool)
      if (!match || ran.deny !== undefined || ran.isError) return ran
      const [, server = '', tool = ''] = match
      const hasApp = await Promise.race([
        discover($, server).then((tools) => tool in tools, () => false),
        // A timer that can't run must not decide the race on its own.
        $.clock.sleep(3000).then(
          () => false,
          () => new Promise<boolean>(() => {}),
        ),
      ])
      if (hasApp) {
        return {
          ...ran,
          context: [
            ...(ran.context ?? []),
            `The user is seeing this tool's interactive UI (an MCP App) inline in the terminal right now, ` +
              `drawn from this result, and can click and type in it. Don't recreate it as text or tables.`,
          ],
        }
      }
    } catch (error) {
      $.ui.log(`mcp-apps-cli: ${String(error)}`, { to: 'debug' })
    }
    return ran
  })
}

export function registerStreamHooks(on: On) {
  // Claude writing a call to an MCP tool. A tool with an app gets its view
  // now, before the call is whole, and the arguments as they're written
  // (tool-input-partial): an app that draws them (a 3D scene, a shader)
  // builds up while Claude writes instead of after. Chrome starts now too.
  // What the app asks of the host waits until Claude Code lets the call run.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (!state.isActive || e.agentId) return yield* stream
    // The MCP calls of this step being written, by content block.
    const writing = new Map<number, Writing>()
    const flushAll = () => {
      for (const call of writing.values()) if (call.dirty) notePartial($, call)
    }
    for await (const chunk of stream) {
      try {
        if (chunk.kind === 'tool') {
          // A new block: the ones before it are whole.
          flushAll()
          const match = MCP_TOOL.exec(chunk.name)
          if (match && chunk.id) {
            writing.set(chunk.index, { id: chunk.id, json: '', sentAt: 0, dirty: false })
            void openEarly($, chunk.id, match[1] ?? '', match[2] ?? '')
          }
        } else if (chunk.kind === 'input') {
          const call = writing.get(chunk.index)
          if (call) {
            call.json += chunk.json
            call.dirty = true
            if (Date.now() - call.sentAt >= PARTIAL_MS) notePartial($, call)
          }
        } else if (chunk.kind === 'stop' || chunk.kind === 'text') {
          flushAll()
        }
      } catch (error) {
        $.ui.log(`mcp-apps-cli: reading the streamed call: ${String(error)}`, { to: 'debug' })
      }
      yield chunk
    }
    flushAll()
  })

  // The turn is over: a view opened for a call Claude never finished (the
  // turn was stopped, or the response cut off) is told so, or closed if its
  // call never reached the transcript.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    // A view drawn on the main screen this turn: the offer to switch, once.
    offerFullscreenSoon($)
    for (const id of [...earlyCalls]) {
      if (seenCalls.has(id)) continue
      earlyCalls.delete(id)
      void openings.get(id)?.then(() => {
        const view = views.get(id)
        if (!view || view.approved !== undefined) return
        if (view.sites.size === 0 || view.withheld) return dropView($, view, view.withheld)
        refuseCall($, view, undefined, e.reason === 'aborted' ? 'interrupted' : 'Claude did not finish the call')
      })
    }
    return result
  })
}

/** The helper, discovery and Chrome, started for the MCP tools ToolSearch loaded that have an app. */
function warmFor($: EngineInterface, names: readonly unknown[]) {
  const byServer = new Map<string, string[]>()
  for (const name of names) {
    const match = typeof name === 'string' ? MCP_TOOL.exec(name) : null
    const [, server = '', tool = ''] = match ?? []
    if (!server || state.serversWithApps.get(server) === false) continue
    byServer.set(server, [...(byServer.get(server) ?? []), tool])
  }
  for (const [server, tools] of byServer) {
    void discover($, server)
      .then((found) => {
        const tool = tools.find((name) => name in found)
        if (tool) return prewarm($, server, tool, true)
      })
      .catch(() => {})
  }
}

/**
 * Chrome started ahead of a view of `server`'s `tool`. Where a view is
 * likely (`likely`: the tool, or its server, is known to have an app), a tab
 * is made ready for it in the terminal's theme and the tool's UI read ahead
 * too (see the helper's /prewarm), so its first picture waits on none of
 * them; a server not known to have apps gets Chrome alone, not a tab (about
 * 30 MB) for a view that may never come. Only names go, never arguments.
 */
function prewarm($: EngineInterface, server: string, tool: string, likely: boolean) {
  if (!likely) return helper($, '/prewarm', {}).catch(() => {})
  return terminalTheme($)
    .then((theme) => helper($, '/prewarm', { server, tool, theme }))
    .catch(() => {})
}

/**
 * Claude started writing a call: its view opens now if the tool has an app.
 * The arguments are the person's to release. Where Claude Code would run the
 * call without asking, the app gets them as they're written. Where it would
 * ask (the person, or auto mode's classifier), the app loads meanwhile but
 * gets none of them until the call is allowed, and goes, keeping nothing, if
 * it isn't: the server's code never sees what's denied. A call its rules deny
 * opens nothing. (A rule for an MCP tool names the tool, not its arguments;
 * a PreToolUse hook that denies by them still gets the call cancelled.)
 */
async function openEarly($: EngineInterface, id: string, server: string, tool: string) {
  const epoch = state.epoch
  // Chrome starts as Claude writes, before we know the tool has an app
  // (not for a server known to have none).
  if (state.serversWithApps.get(server) !== false) void prewarm($, server, tool, state.serversWithApps.get(server) === true)
  let withheld = false
  try {
    if (!(tool in (await discover($, server)))) return
    const verdict = await $.tool
      .check({ tool: `mcp__${server}__${tool}`, input: {} })
      .catch(() => ({ decision: 'ask' as const }))
    $.ui.log(`mcp-apps-cli: ${server}/${tool} as Claude writes it: ${verdict.decision}`, { to: 'debug' })
    if (verdict.decision === 'deny') return
    withheld = verdict.decision !== 'allow'
  } catch {
    return
  }
  earlyCalls.add(id)
  if (withheld) withheldCalls.add(id)
  await openView($, { id, server, tool, theme: await terminalTheme($), epoch }, true).catch((error) =>
    $.ui.log(`mcp-apps-cli: open failed: ${String(error)}`, { to: 'debug' }),
  )
}

/** The arguments written so far, closed into an object, go to the call's app. */
function notePartial($: EngineInterface, call: Writing) {
  call.dirty = false
  call.sentAt = Date.now()
  const args = healJson(call.json)
  if (!args) return
  partialArgs.set(call.id, args)
  const view = views.get(call.id)
  if (view) sendPartial($, view)
}

/**
 * The latest partial arguments to the app, if they changed. One is in flight
 * at a time: those written meanwhile are taken together after it, so a slow
 * app isn't sent every one in turn.
 */
export function sendPartial($: EngineInterface, view: View) {
  const args = partialArgs.get(view.id)
  if (!args || view.withheld || view.status !== 'live' || view.inputSent === 'final') return
  if (view.partialBusy) {
    view.partialAgain = true
    return
  }
  const json = JSON.stringify(args)
  if (json === view.partialSent) return
  view.partialSent = json
  view.inputSent = 'partial'
  view.partialBusy = true
  view.chain = view.chain
    .then(() => helper($, '/args', { viewId: view.id, arguments: args, partial: true }))
    .catch((error) => $.ui.log(`mcp-apps-cli: /args failed: ${String(error)}`, { to: 'debug' }))
    .finally(() => {
      view.partialBusy = false
      if (view.partialAgain) {
        view.partialAgain = false
        sendPartial($, view)
      }
    })
}

/** Claude Code lets the call run: the app gets all its arguments, and may ask the host for things. */
function allowCall($: EngineInterface, view: View, input: Record<string, unknown>) {
  view.withheld = false
  withheldCalls.delete(view.id)
  if (view.call) {
    view.call.input = input
    view.call.allowed = true
  }
  partialArgs.delete(view.id)
  if (view.status === 'live' && view.inputSent !== 'final') {
    view.inputSent = 'final'
    send($, view, '/args', { viewId: view.id, arguments: input, partial: false })
  }
  view.approve(true)
}

/**
 * The call a view opened early for never ran: denied, stopped, or not
 * finished. The app is told (tool-cancelled), what it asked waits no more,
 * and context it set doesn't reach the model.
 */
function refuseCall($: EngineInterface, view: View, input: Record<string, unknown> | undefined, reason: string) {
  // It never had the arguments: it goes, and what it stored with it.
  if (view.withheld) return dropView($, view, true)
  if (view.call) {
    if (input) view.call.input = input
    view.call.allowed = false
    view.call.cancelled = reason
  }
  partialArgs.delete(view.id)
  modelContext.delete(view.id)
  if (view.status === 'live') {
    if (input && view.inputSent !== 'final') {
      view.inputSent = 'final'
      send($, view, '/args', { viewId: view.id, arguments: input, partial: false })
    }
    send($, view, '/cancel', { viewId: view.id, reason })
  }
  view.approve(false)
}

/**
 * Arguments Claude is part way through writing, as an object: a string cut
 * off is closed, then the open arrays and objects; a member cut off before
 * its value is whole is left out. Undefined until there's an object.
 */
function healJson(text: string): Record<string, unknown> | undefined {
  let t = text
  for (let tries = 0; tries < 16; tries++) {
    const s = scanJson(t)
    const body = s.inString ? `${t.slice(0, t.length - s.dangling)}"` : t
    try {
      const value = JSON.parse(body + s.closers.reverse().join('')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
    } catch {
      // Back to the last member's end, and again.
    }
    const cut = s.cuts.filter((at) => at < t.length).pop()
    if (cut === undefined) return undefined
    t = t.slice(0, cut)
  }
  return undefined
}

/** Where a JSON prefix stands: open containers, an open string, and where members end. */
function scanJson(text: string) {
  const closers: string[] = []
  const cuts: number[] = []
  let inString = false
  let escape = false
  let unicode = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (unicode > 0) unicode--
      else if (escape) {
        escape = false
        if (c === 'u') unicode = 4
      } else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') {
      closers.push(c === '{' ? '}' : ']')
      cuts.push(i + 1)
    } else if (c === '}' || c === ']') closers.pop()
    else if (c === ',') cuts.push(i)
  }
  // An escape cut off at the end of a string: left out.
  const dangling = !inString ? 0 : escape ? 1 : unicode > 0 ? 6 - unicode : 0
  return { closers, cuts, inString, dangling }
}
