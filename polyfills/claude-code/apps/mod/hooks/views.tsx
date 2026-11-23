// View lifecycle, terminal rendering, input, sizing, and picture updates.

import type { Elements, EngineInterface, On } from 'claude-code'
import type { SavedJson, SavedView } from '../types'
import type { ClientPost, Display, Frame, ImageFrame, Run, UiTool, View, ViewCall } from './state'
import { discover, helper, send } from './helper'
import { isLive, modelContext, openings, partialArgs, state, views, withheldCalls } from './state'
import { plainText } from './consent'
import { noteOpenFailed } from './browser'
import { noteMainScreenView } from './fullscreen'
import { sendPartial } from './stream'
import { userAgent } from './settings'

/** Escape for the app. Claude Code never hands a Client Escape: it takes the keyboard back. */
const ESCAPE = { kind: 'key', key: 'escape' } as const

const LIVE_VIEWS = 3
const DEFAULT_COLS = 100
const MAX_ROWS = 36
const MIN_ROWS = 8

/**
 * Rows a fullscreen view leaves for its header, a short reply under it, the
 * prompt and the footer: its header (and the control back) stays on screen.
 */
const FULLSCREEN_SPARE = 12

const PANE_PREFIX = 'mcp-app-'

/** How often the input layer gets new props at most (see the ui.message hook). */
const PROPS_MS = 150

/** How long after a picture is drawn its fresh copy is swapped in (see refreshSoon). */
const REFRESH_DELAY_MS = 80

/** The header line and the Client region that draws one view's frames. */
type ViewElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Client' | 'Image' | 'Raster' | 'Button'>

// Run flags from the renderer.
const BOLD = 1
const INVERSE = 2
const DIM = 4

export function registerViewHooks(on: On) {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    noteScreenRows($, e.viewport?.rows)
    const view = views.get(e.props.tool_use_id)
    if (!view || e.surface !== 'terminal') return next(e)
    const elements = $.ui.resolve(e)
    const fullscreen = e.viewport?.isFullscreen !== false
    if (e.viewport?.isFullscreen !== undefined) state.layoutFullscreen = e.viewport.isFullscreen
    if (e.viewport?.isFullscreen === false && view.status === 'live' && (view.image || view.frame)) noteMainScreenView()
    view.sites.add(e.requestId)
    // Whether it's in sight first: a view out of sight gets no fresh copy,
    // and one coming back gets it on this drawing.
    noteScrolledOff([view], e.props.onScreen, e.requestId)
    syncShown($, view)
    wakeIfSeen($, view)
    watchStill($, view)
    refreshSoon($, view)
    return elements.Box({
      flexDirection: 'column',
      children: [await next(e), viewBlock($, elements, view, fullscreen)],
    })
  })

  // The transcript folds runs of calls into one line ("Called cohort").
  // Keep that line and draw the run's app views under it; the ctrl+o
  // transcript draws each call as a ToolUse row instead, handled above.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    noteScreenRows($, e.viewport?.rows)
    const inGroup = e.props.calls
      .map((call) => (call.tool_use_id ? views.get(call.tool_use_id) : undefined))
      .filter((view): view is View => view !== undefined)
    if (inGroup.length === 0 || e.props.isExpanded || e.surface !== 'terminal') return next(e)
    const elements = $.ui.resolve(e)
    const fullscreen = e.viewport?.isFullscreen !== false
    if (e.viewport?.isFullscreen !== undefined) state.layoutFullscreen = e.viewport.isFullscreen
    if (e.viewport?.isFullscreen === false && inGroup.some((v) => v.status === 'live' && (v.image || v.frame))) noteMainScreenView()
    for (const view of inGroup) view.sites.add(e.requestId)
    noteScrolledOff(inGroup, e.props.onScreen, e.requestId)
    for (const view of inGroup) {
      syncShown($, view)
      wakeIfSeen($, view)
      watchStill($, view)
      refreshSoon($, view)
    }
    const held = heldBack(inGroup)
    return elements.Box({
      flexDirection: 'column',
      children: [await next(e), ...inGroup.map((view) => viewBlock($, elements, view, fullscreen, held.has(view.id)))],
    })
  })

  // The wheel over a view in a pane: the app scrolls (or zooms) under the
  // pointer, the pane itself stays put. Claude Code reports no wheel over
  // views inline in the transcript.
  on('ui.scroll', { component: 'Pane' }, async ($, e, next) => {
    const view = [...views.values()].find((v) => paneId(v) === e.requestId)
    if (!view || view.status !== 'live') return next(e)
    send($, view, '/input', { viewId: view.id, event: { kind: 'wheel', by: e.by } })
    return {}
  })

  // A view the app (or the person) moved into a pane: drawn at the pane's size.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const view = [...views.values()].find((v) => paneId(v) === e.requestId)
    if (!view || e.surface !== 'terminal') return next(e)
    const elements = $.ui.resolve(e)
    const pane = { cols: Math.max(20, e.props.bodyColumns - 1), rows: Math.max(MIN_ROWS, e.props.scroll.bodyRows - 1) }
    if (pane.cols !== view.pane?.cols || pane.rows !== view.pane?.rows) {
      view.pane = pane
      if (view.display === 'pip') applySize($, view)
    }
    view.sites.add(e.requestId)
    refreshSoon($, view)
    return pictureBlock(elements, view, 'pane') ?? elements.Text({ dimColor: true, children: ['Starting the app view…'] })
  })

  // The person closed the pane (or it was dropped): the view goes back under its call.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    const view = [...views.values()].find((v) => paneId(v) === e.id)
    if (view && view.display === 'pip' && e.origin.kind !== 'plugin') {
      view.sites.delete(e.id)
      view.display = 'inline'
      applySize($, view)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (!e.element.startsWith('app-')) return next(e)
    const data = e.data as ClientPost
    const view = views.get(data.id)
    if (!view) return {}
    for (const event of data.events ?? []) {
      if (event.seq <= view.ack) continue
      view.ack = event.seq
      if (view.status !== 'live') continue
      const { seq: _seq, ...rest } = event
      // Claude Code pins a Client scrolled partly off the top to the top row,
      // so its rows read that many too few: add back what is hidden.
      const hidden = e.element.startsWith('app-pane-') ? 0 : view.hidden ?? 0
      if (hidden && rest.kind === 'pointer') {
        const pointer = rest as unknown as { y: number; fine?: { x: number; y: number } }
        pointer.y += hidden
        if (pointer.fine) pointer.fine = { ...pointer.fine, y: pointer.fine.y + hidden }
      }
      // The helper takes input as a sign it's in sight, and draws it again.
      view.paused = false
      send($, view, '/input', { viewId: view.id, event: isEscapeAlias(rest) ? ESCAPE : rest })
    }
    // The width under the call (a pane's comes from its props).
    // Taken once a picture is in: the input layer goes in before it (see
    // viewBlock), and the first picture still comes at the guessed width.
    const drawn = view.mode === 'image' ? view.image : view.frame
    if (data.cols > 0 && !e.element.startsWith('app-pane-')) {
      // Kept until a picture is in: the input layer reports a width only
      // when it changes (see view.tsx), and the first picture applies it.
      view.clientCols = data.cols
      if (drawn && data.cols !== view.inlineCols) {
        view.inlineCols = data.cols
        applySize($, view)
      }
    }
    // New props re-render the input layer, and Claude Code paints less of the
    // picture meanwhile: a drag (a post per move, each acknowledged) dropped
    // a quarter of the frames. They only acknowledge events (the layer resends
    // the rest; seen ones are skipped above) and report status, so at most
    // every PROPS_MS will do.
    const now = Date.now()
    if ((data.v !== view.v || data.ack !== view.ack) && now - (view.propsAt ?? 0) >= PROPS_MS) {
      view.propsAt = now
      return { props: snapshot(view) }
    }
    return {}
  })
}

/** ctrl+], which the app gets as Escape: as a key with ctrl, or as the control character itself. */
function isEscapeAlias(event: Record<string, unknown>) {
  return event.kind === 'key' && ((event.key === ']' && event.ctrl === true) || event.key === '\u001d')
}

/**
 * Claude Code draws no tree with more than 2 MiB of Image source, and a run
 * of calls is one tree: the newest pictures that fit, the older ones held
 * back (their alt text instead).
 */
const MAX_TREE_IMAGE_CHARS = 2_000_000

function heldBack(group: View[]): Set<string> {
  const held = new Set<string>()
  let room = MAX_TREE_IMAGE_CHARS
  for (const view of [...group].reverse()) {
    const size =
      view.mode === 'image' ? (view.strips ?? []).reduce((n, strip) => n + (strip?.png.length ?? 0), 0) + (view.image?.png?.length ?? 0) : 0
    if (size > room) held.add(view.id)
    else room -= size
  }
  return held
}

/**
 * Whether a call's view may open again: its call was allowed or denied (it
 * opens as it was decided), or ran. One still waiting on the person when it
 * closed would open as allowed, so it isn't offered.
 */
function decided(call: ViewCall) {
  return call.allowed !== undefined || call.result !== undefined
}

function viewBlock($: EngineInterface, elements: ViewElements, view: View, fullscreen: boolean, held = false) {
  const { Box, Text, Button, Client } = elements
  const active = view.id === state.activeId
  const hint =
    view.status === 'closed' && view.asleep
      ? view.resting && !fullscreen
        ? ' · view only outside fullscreen'
        : ' · waking up'
      : view.status === 'closed'
      ? view.closedWhy
        ? ` · closed: ${view.closedWhy}`
        : ' · closed'
      : view.display === 'pip'
        ? ' · in the pane'
        : !fullscreen
          ? ' · view only outside fullscreen'
          : active
            ? ' · click to use · Esc leaves'
            : ' · view only'
  // The spec asks hosts to say when an app may reach other sites.
  const reach = view.domains?.length
    ? ` · reaches ${view.domains.slice(0, 2).join(', ')}${view.domains.length > 2 ? ` +${view.domains.length - 2}` : ''}`
    : ''
  // A blank that alternates with each cell picture (see showPicture).
  const tick = (view.mode === 'cells' || !state.swapEveryDraw) && view.v % 2 === 1 ? '\u2800' : ' '
  // Named by its page's title once the helper has read it, else its tool.
  const name = view.title || view.tool
  const rest =
    view.status === 'error' ? ` · could not open: ${view.error ?? 'unknown error'}` : `${reach}${hint}${tick}`
  // Display modes the person can switch to, among those the app handles.
  const offers = (mode: Display) => view.status === 'live' && view.display !== mode && (!view.modes || view.modes.includes(mode))
  const control = (mode: Display, label: string) =>
    Button({
      key: `${mode}-${view.id}`,
      label,
      plain: true,
      dimColor: true,
      onPress: () => void setDisplay($, view, mode),
    })
  const use =
    fullscreen && !active && view.status === 'live' && view.display !== 'pip'
      ? Button({
          key: `use-${view.id}`,
          label: 'use it',
          plain: true,
          dimColor: true,
          onPress: () => {
            state.activeId = view.id
            $.ui.invalidate('ui.render')
          },
        })
      : null
  const reopen =
    fullscreen &&
    view.status === 'closed' &&
    view.call &&
    decided(view.call) &&
    (view.call.result !== undefined || view.call.cancelled !== undefined || view.closedWhy !== undefined)
      ? Button({
          key: `reopen-${view.id}`,
          label: 'reopen',
          plain: true,
          dimColor: true,
          onPress: () => void reopenView($, view),
        })
      : null
  // Claude Code keeps Escape (it hands the keyboard back), so the app gets
  // one from here, or from ctrl+] (see the ui.message hook).
  const esc =
    fullscreen && active && view.status === 'live' && view.display !== 'pip'
      ? Button({
          key: `esc-${view.id}`,
          label: 'esc',
          plain: true,
          dimColor: true,
          onPress: () => send($, view, '/input', { viewId: view.id, event: ESCAPE }),
        })
      : null
  const controls = fullscreen
    ? [
        use,
        reopen,
        esc,
        view.display !== 'inline' && view.status === 'live' ? control('inline', 'back to the chat') : null,
        offers('fullscreen') ? control('fullscreen', 'fullscreen') : null,
        offers('pip') ? control('pip', 'pane') : null,
      ].filter((c) => c !== null)
    : []
  const header = Box({
    flexDirection: 'row',
    gap: 2,
    children: [
      // The title is the page's own: the server it comes from is always said beside it.
      Text({
        children: [
          Text({ dimColor: true, children: ['MCP App · '] }),
          Text({ bold: true, children: [name] }),
          Text({ dimColor: true, children: [`${view.title ? ` · ${view.server}` : ''}${rest}`] }),
        ],
      }),
      ...controls,
    ],
  })
  if (held) {
    return Box({
      flexDirection: 'column',
      marginLeft: 2,
      children: [header, Text({ dimColor: true, children: [`${view.alt ? `${view.alt} · ` : ''}held back: too big to draw beside the views after it`] })],
    })
  }
  const picture = view.display === 'pip' ? null : pictureBlock(elements, view, 'inline', active)
  if (!picture && view.status === 'closed' && !view.asleep) {
    // Closed with no picture kept (see trimClosed), or none ever drawn: what it showed, as text.
    return Box({
      flexDirection: 'column',
      marginLeft: 2,
      children: [header, Text({ dimColor: true, children: [view.alt ?? 'no picture kept'] })],
    })
  }
  if (!picture) {
    const waiting =
      view.status === 'error' || view.display === 'pip' ? null : Text({ dimColor: true, children: ['Starting the app view…'] })
    // The input layer goes in now, under the key it keeps over the picture:
    // Claude Code paints a new Client's region blank once, and over a first
    // picture that blanked the whole view for a paint (cells: a blink).
    const early =
      waiting && active
        ? Box({
            position: 'relative',
            width: '100%',
            height: 1,
            children: [
              waiting,
              Box({
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: 1,
                children: [Client({ key: `app-${view.id}`, module: './view.tsx', width: '100%', height: 1, props: snapshot(view) })],
              }),
            ],
          })
        : waiting
    // As tall as this tool's view was last time: the picture then lands in
    // room kept for it, rather than pushing everything under it down (in
    // iTerm2 each such move sends the whole picture again).
    const room = waiting ? waitingRows(view) : 1
    const kept = room > 1 ? Box({ flexDirection: 'column', height: room, children: [early] }) : early
    return Box({ flexDirection: 'column', marginLeft: 2, children: [header, kept] })
  }
  return Box({ flexDirection: 'column', marginLeft: 2, children: [header, picture] })
}

/**
 * The picture (real pixels, or cells) with the Client laid over it: the
 * Client draws nothing, so the picture shows through, and it takes the
 * pointer and keys. Under the tool call, or in a pane.
 */
function pictureBlock({ Box, Text, Client, Image, Raster }: ViewElements, view: View, site: 'inline' | 'pane', interactive = true) {
  const picture = view.mode === 'image' ? view.image : view.frame
  if (!picture || view.status === 'error') return null
  const { cols, rows, scroll } = picture
  const below = scroll ? scroll.total - scroll.top - scroll.rows : 0
  const scrollHint = scroll
    ? [scroll.top > 0 ? `↑ ${scroll.top} rows above` : '', below > 0 ? `↓ ${below} more rows` : '', 'PgUp/PgDn to scroll']
        .filter(Boolean)
        .join(' · ')
    : ''
  // Read to a screen reader, and drawn where the terminal can't show the
  // picture: what the app shows, once the helper has read it. Once per view:
  // the bands after the first say nothing more.
  const alt = `MCP App ${view.tool}: ${view.alt ?? "this terminal can't show images"}`
  if (view.mode === 'image') view.drawnShape = shapeOf(view.image, view.strips)
  const drawn =
    view.mode === 'image' && view.image && view.strips?.length
      ? // Bands of rows, one Image each, stacked without a gap (see the helper's stripsOf).
        Box({
          flexDirection: 'column',
          children: view.strips.map((strip, i) =>
            Image({ key: `${pictureKey(view, site)}-${i}`, source: { png: strip.png }, columns: cols, rows: strip.rows, alt: i === 0 ? alt : ' ' }),
          ),
        })
      : view.mode === 'image' && view.image
      ? Image({
          key: pictureKey(view, site),
          source: imageSource(view.image),
          columns: cols,
          rows,
          alt,
        })
      : (picture as Frame).styled
        ? styledRows(Box, Text, (picture as Frame).styled!, cols)
        : Raster({ key: pictureKey(view, site), columns: cols, rows, cells: (picture as Frame).cells ?? '' })
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        position: 'relative',
        width: '100%',
        height: rows,
        children: [
          drawn,
          // As wide as the room, not the picture: the width it reports is
          // what the picture is sized to, so tying it to the picture would
          // shrink it a column per frame. Only the active view has one.
          !interactive ? null : Box({
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: rows,
            children: [
              Client({
                key: site === 'pane' ? `app-pane-${view.id}` : `app-${view.id}`,
                module: './view.tsx',
                width: '100%',
                height: rows,
                props: snapshot(view),
              }),
            ],
          }),
        ],
      }),
      scrollHint ? Text({ dimColor: true, children: [scrollHint] }) : null,
    ],
  })
}

/** A full-colour frame: one Text per row, a nested Text per run of one style. */
function styledRows(Box: ViewElements['Box'], Text: ViewElements['Text'], styled: Run[][], cols: number) {
  return Box({
    flexDirection: 'column',
    width: cols,
    children: styled.map((runs) =>
      Text({
        wrap: 'truncate-end',
        children: runs.map(([text, fg, bg, flags]) =>
          Text({
            ...(fg ? { color: fg } : {}),
            ...(bg ? { backgroundColor: bg } : {}),
            ...(flags & BOLD ? { bold: true } : {}),
            ...(flags & DIM ? { dimColor: true } : {}),
            ...(flags & INVERSE ? { inverse: true } : {}),
            children: [text],
          }),
        ),
      }),
    ),
  })
}

/** The pane a view is moved into: one per view. */
export function paneId(view: View) {
  return PANE_PREFIX + view.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-50)
}

/** How tall the helper may draw a view, for where it is shown now. */
function rowsFor(view: View) {
  if (view.display === 'fullscreen') {
    return state.screenRows ? Math.max(MIN_ROWS, Math.min(80, state.screenRows - FULLSCREEN_SPARE)) : MAX_ROWS
  }
  if (view.display === 'pip' && view.pane) return view.pane.rows
  return maxRowsFor(view.mode)
}

/** Resizes a live view to where it is shown, if that changed. */
function applySize($: EngineInterface, view: View) {
  syncShown($, view)
  const cols = view.display === 'pip' && view.pane ? view.pane.cols : view.inlineCols
  const maxRows = rowsFor(view)
  if (view.status !== 'live' || (cols === view.cols && maxRows === view.maxRows && view.sizedFor === view.display)) return
  view.cols = cols
  view.maxRows = maxRows
  view.sizedFor = view.display
  send($, view, '/resize', { viewId: view.id, cols, maxRows, display: view.display })
}

/**
 * Moves a view to a display mode (the app asked, or the person pressed a
 * control) and answers with the mode now in use. A pane needs room: unasked
 * by the person, Claude Code places one only from 144 columns.
 */
export async function setDisplay($: EngineInterface, view: View, mode: string): Promise<Display> {
  const wanted = mode === 'fullscreen' || mode === 'pip' ? mode : 'inline'
  if (view.status !== 'live' || wanted === view.display) return view.display
  if (wanted !== 'inline' && view.modes && !view.modes.includes(wanted)) return view.display
  if (wanted === 'pip') {
    const opened = await $.ui
      .open({ id: paneId(view), title: `MCP App · ${view.tool}` })
      .catch((error: unknown) => ({ isPlaced: false as const, reason: String(error) }))
    if (!opened.isPlaced) {
      $.ui.log(`mcp-apps-cli: no pane for ${view.tool}: ${'reason' in opened ? opened.reason : ''}`, { to: 'debug' })
      await $.ui.close({ id: paneId(view) }).catch(() => undefined)
      return view.display
    }
  } else if (view.display === 'pip') {
    view.display = wanted
    view.sites.delete(paneId(view))
    await $.ui.close({ id: paneId(view) }).catch(() => undefined)
  }
  view.display = wanted
  if (wanted !== 'pip') state.activeId = view.id
  applySize($, view)
  $.ui.invalidate('ui.render')
  return wanted
}

/**
 * How tall a view may be drawn. It fits on the screen, so the whole view can
 * be seen at once. A picture also leaves room for Claude's reply under it:
 * iTerm2 shows a picture only while all of it is on screen, so a reply that
 * pushed its top off would blank it, and elsewhere it would take the app's
 * own controls (at its top) off screen.
 */
function maxRowsFor(mode: View['mode']) {
  if (!state.screenRows) return MAX_ROWS
  // A picture keeps room for a short reply too, so the app's own controls
  // stay on screen with it; an app taller than that is shrunk to fit.
  // What sits around a view takes about 12 rows even for a one-line reply
  // (tool line, header, reply, prompt box, footer): less pushed the header,
  // and in iTerm2 the whole picture, off a small screen.
  const spare = mode === 'image' ? 14 : 8
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, state.screenRows - spare))
}

/**
 * After a picture is drawn, swap in a fresh copy of it: in iTerm2, Claude
 * Code clears an Image's cells when it first draws it and shows the picture
 * only once a swap brings new bytes. The swap also finds out a terminal with
 * no images, as Claude Code refuses it where the alt text is drawn. kitty and
 * Ghostty show a picture at once, so there a view gets the one swap only.
 */
function refreshSoon($: EngineInterface, view: View) {
  // Out of sight (paused): no fresh copy, which would wake its page for
  // nothing; it gets one as it comes back (the render hook runs again).
  if (view.mode !== 'image' || view.status !== 'live' || view.refreshing || view.paused) return
  if (view.swapped && !state.swapEveryDraw) return
  view.refreshing = true
  view.swapped = true
  // Soon: in iTerm2 the picture is blank until this swap, so a redraw (new
  // text arriving under it moves it) flashed for as long as this wait.
  void $.clock
    .sleep(REFRESH_DELAY_MS)
    .then(() => {
      view.refreshing = false
      if (view.mode === 'image' && view.status === 'live') send($, view, '/refresh', { viewId: view.id })
    })
    .catch(() => {
      view.refreshing = false
    })
}

/** What Claude Code's Image draws: the file the terminal reads, or the PNG itself. */
function imageSource(image: ImageFrame) {
  return image.file
    ? { file: image.file, format: 'png' as const, ...(image.generation === undefined ? {} : { generation: image.generation }) }
    : { png: image.png ?? '' }
}

/** A new terminal height: live views are resized to fit it. */
function noteScreenRows($: EngineInterface, rows: number | undefined) {
  if (!rows || rows === state.screenRows) return
  state.screenRows = rows
  for (const view of views.values()) applySize($, view)
}

function pictureKey(view: View, site: 'inline' | 'pane' = view.display === 'pip' ? 'pane' : 'inline') {
  return `${view.mode === 'image' ? 'img' : 'cells'}-${site}-${view.id}`
}

/**
 * How many rows of each view's picture are scrolled off the top, from what
 * the transcript says of the row they are drawn under (`onScreen`: its top
 * `first` rows are away, of `of`). Claude Code keeps such a Client's height
 * but pins it to the top row, so pointer rows come that many too low; the
 * ui.message hook adds them back. Counted from the bottom of the row, which
 * is all this mod's drawing: a view's scroll hint, then the views after it.
 */
function noteScrolledOff(
  drawn: View[],
  onScreen: { first: number; last: number; of: number } | null | undefined,
  site: string,
) {
  let below = 0
  for (const view of [...drawn].reverse()) {
    view.unseen ??= new Map()
    const picture = view.mode === 'image' ? view.image : view.frame
    if (!picture || view.display === 'pip' || view.status === 'error') {
      view.hidden = 0
      const body = view.status === 'error' || view.display === 'pip' ? 0 : view.status === 'closed' && !view.asleep ? 1 : waitingRows(view)
      // Asleep with no picture kept (after a reload of this code, or trimmed):
      // in sight when its lines are, so it wakes as a picture would; where
      // the surface doesn't say, drawn counts as seen.
      if (!picture && view.asleep) {
        const above = onScreen ? onScreen.of - below - body : 0
        view.unseen.set(site, onScreen === null || (onScreen !== undefined && (onScreen.last < above || onScreen.first >= above + body)))
      } else view.unseen.delete(site)
      below += 1 + body
      continue
    }
    const hint = picture.scroll ? 1 : 0
    const above = onScreen ? onScreen.of - below - hint - picture.rows : 0
    view.hidden = onScreen ? Math.max(0, Math.min(picture.rows, onScreen.first - above)) : 0
    // `null`: the row is drawn outside the viewport. Absent: the surface doesn't say.
    if (onScreen === undefined) view.unseen.delete(site)
    else view.unseen.set(site, onScreen === null || onScreen.last < above || onScreen.first >= above + picture.rows)
    below += 1 + picture.rows + hint
  }
}

/**
 * A live inline view with none of its picture on screen, wherever it's drawn,
 * is paused: the helper stops capturing it and Chrome stops drawing the app
 * (an animated app off screen cost as much as one on it). It resumes as soon
 * as a row of it scrolls back, or the person points at it. Panes and
 * fullscreen views are always in sight.
 */
function syncShown($: EngineInterface, view: View) {
  const paused =
    view.status === 'live' &&
    view.display === 'inline' &&
    view.sites.size > 0 &&
    [...view.sites].every((site) => view.unseen?.get(site) === true)
  if (paused === Boolean(view.paused)) return
  view.paused = paused
  send($, view, '/shown', { viewId: view.id, shown: !paused })
  if (paused) void sleepLater($, view, (view.pausedAt = Date.now()))
}

/**
 * A view out of sight for a while (state.sleepAfterMs) goes to sleep: it
 * closes, keeping its last picture and its store, and its page leaves Chrome
 * (Chrome itself closes once no view is left, see the helper's idle wait).
 * Only one the person never used, whose call has run: what it shows comes
 * from its call (and its store), so opening it again shows the same. One
 * they clicked into or typed in may hold what they did, and stays.
 */
async function sleepLater($: EngineInterface, view: View, pausedAt: number) {
  if (!state.sleepAfterMs) return
  // A timer that failed (a reload of the code mid-wait) is no verdict.
  if (!(await $.clock.sleep(state.sleepAfterMs).then(() => true, () => false))) return
  if (
    views.get(view.id) !== view ||
    view.status !== 'live' ||
    !view.paused ||
    view.pausedAt !== pausedAt ||
    view.touched ||
    view.display !== 'inline' ||
    view.call?.result === undefined
  ) {
    return
  }
  // Its app waits on an answer (a tool call of its, a question to the
  // person): asleep, that answer would be refused. It waits again once
  // answered (see sleepWhenAnswered).
  if ((view.asked ?? 0) > 0) {
    view.sleepDue = pausedAt
    return
  }
  view.status = 'closed'
  view.asleep = true
  view.paused = false
  void helper($, '/close', { viewId: view.id }).catch(() => {})
  trimClosed()
  saveViews($)
  $.ui.invalidate('ui.render')
}

/** A view whose sleep waited on its app's answers: once they're in, still out of sight, its timer starts again. */
export function sleepWhenAnswered($: EngineInterface, view: View) {
  if (view.sleepDue === undefined || (view.asked ?? 0) > 0) return
  const pausedAt = view.sleepDue
  view.sleepDue = undefined
  if (view.status === 'live' && view.paused && view.pausedAt === pausedAt) void sleepLater($, view, pausedAt)
}

/** A sleeping view with any of it back in sight opens again, its last picture shown until the new one. */
function wakeIfSeen($: EngineInterface, view: View) {
  if (view.status !== 'closed' || !view.asleep || waking.has(view.id)) return
  // Resting on the main screen (see restWhenStill): nothing there could use
  // it, so being seen doesn't wake it; in fullscreen, where it takes input, it does.
  if (view.resting && state.layoutFullscreen !== true) return
  if (![...view.sites].some((site) => view.unseen?.get(site) === false)) return
  waking.add(view.id)
  void reopenView($, view).finally(() => waking.delete(view.id))
}
const waking = new Set<string>()

/**
 * On Claude Code's main screen a view takes no input (no mouse reaches a
 * Client there), so one that has stopped changing has no use for its page: it
 * rests, keeping its last picture, and its share of Chrome goes (Chrome
 * itself closes once no view is left). Only one with its result, the person
 * never touched, unchanged for REST_MS, whose app hasn't called a tool for
 * APP_POLL_MS (a dashboard polling its server isn't still, only slow; one
 * that fetched once as it opened is), with nothing of its asked and still
 * unanswered (a long tool call, a question to the person), and that reaches
 * no site beyond itself (it may update over its own connection).
 */
const REST_MS = 120_000
const APP_POLL_MS = 180_000

function noteStill($: EngineInterface, view: View) {
  view.pictureAt = Date.now()
  watchStill($, view)
}

/** Starts the wait for a view to be still, on the main screen, once. */
function watchStill($: EngineInterface, view: View) {
  if (view.restWatch || state.layoutFullscreen !== false || view.status !== 'live') return
  view.restWatch = true
  void restWhenStill($, view).finally(() => (view.restWatch = false))
}

async function restWhenStill($: EngineInterface, view: View) {
  // A whole REST_MS with no new picture, and no tool call of its app's for
  // APP_POLL_MS: waited out, however long the app stays busy.
  for (let at = view.pictureAt; ; at = view.pictureAt) {
    // A timer that failed (a reload of the code mid-wait) is no verdict.
    if (!(await $.clock.sleep(REST_MS).then(() => true, () => false))) return
    if (views.get(view.id) !== view || view.status !== 'live') return
    if (view.pictureAt === at && Date.now() - (view.appCallAt ?? 0) >= APP_POLL_MS && !view.asked) break
  }
  // One that reaches other sites (its CSP names them) rests only when its own
  // network is quiet too: no socket open, nothing in flight (a stream, a long
  // poll), nothing for APP_POLL_MS. A live feed keeps its page.
  if ((view.domains?.length ?? 0) > 0 && !(await networkQuiet($, view))) return
  if (
    !isLive(view) ||
    state.layoutFullscreen !== false ||
    view.touched ||
    view.display !== 'inline' ||
    view.call?.result === undefined
  ) {
    return
  }
  view.status = 'closed'
  view.asleep = true
  view.resting = true
  view.paused = false
  // Its model context stays: it still describes the picture on screen.
  void helper($, '/close', { viewId: view.id }).catch(() => {})
  trimClosed()
  saveViews($)
  $.ui.invalidate('ui.render')
}

/** Whether the helper says the view's network is quiet (see restWhenStill); not when it can't say. */
async function networkQuiet($: EngineInterface, view: View) {
  const answer = (await helper($, '/activity', { viewId: view.id }).catch(() => undefined)) as
    | { ok?: unknown; sockets?: unknown; inflight?: unknown; quietMs?: unknown }
    | undefined
  return answer?.ok === true && answer.sockets === 0 && answer.inflight === 0 && Number(answer.quietMs) >= APP_POLL_MS
}

function snapshot(view: View) {
  // The Client only takes input; the picture is drawn beneath it.
  return { id: view.id, v: view.v, ack: view.ack, status: view.status }
}

/**
 * Opens the view of a call once: a call opened while Claude wrote it (see the
 * turn.step hook) and again as it runs gets one view, the second open waiting
 * on the first.
 */
export function openView($: EngineInterface, call: ViewCall, early = false, previous?: View): Promise<void> {
  let opening = openings.get(call.id)
  if (!opening) {
    opening = openViewNow($, call, early, previous)
    openings.set(call.id, opening)
  }
  return opening
}

async function openViewNow($: EngineInterface, call: ViewCall, early: boolean, previous?: View) {
  if (!call.id || views.has(call.id)) return
  const epoch = call.epoch ?? state.epoch
  let ui: UiTool | undefined
  try {
    ui = (await discover($, call.server))[call.tool]
  } catch (error) {
    $.ui.log(`mcp-apps-cli: no UI discovery for ${call.server}: ${String(error)}`, { to: 'debug' })
    return
  }
  if (!ui) return
  // The session ended while the tool was looked up (a slow first discovery,
  // then /clear): no view, in this session or the next.
  if (state.epoch !== epoch || views.has(call.id)) return

  state.activeId = call.id
  let approve!: (allowed: boolean) => void
  const approval = new Promise<boolean>((resolve) => (approve = resolve))
  const view: View = {
    approval,
    // Decided once: a second decision (a call settled twice) changes nothing.
    approve: (allowed) => {
      if (view.approved !== undefined) return
      view.approved = allowed
      approve(allowed)
    },
    early: early && call.input === undefined,
    withheld: early && call.input === undefined && withheldCalls.has(call.id),
    id: call.id,
    epoch,
    server: call.server,
    tool: call.tool,
    status: 'opening',
    // Opened again (woken): its last picture stays until the new one comes.
    frame: previous?.frame ?? null,
    mode: previous?.mode ?? 'cells',
    image: previous?.image ?? null,
    strips: previous?.strips,
    sites: new Set(),
    v: 0,
    ack: 0,
    cols: DEFAULT_COLS,
    maxRows: maxRowsFor(state.terminalShowsImages ? 'image' : 'cells'),
    inlineCols: DEFAULT_COLS,
    display: 'inline',
    sizedFor: 'inline',
    modes: null,
    chain: Promise.resolve(),
    call,
  }
  // A call opened as it runs was allowed already; one opened again (reopen)
  // keeps what was decided.
  if (call.allowed === false) view.approve(false)
  else if (!view.early) view.approve(true)
  views.set(view.id, view)
  $.ui.invalidate('ui.render')
  saveViews($)

  // Keep the newest few views live; older ones keep their last frame.
  const live = [...views.values()].filter((v) => v.status === 'live' || v.status === 'opening')
  for (const old of live.slice(0, Math.max(0, live.length - LIVE_VIEWS))) {
    if (old.display === 'pip') void $.ui.close({ id: paneId(old) }).catch(() => undefined)
    old.display = 'inline'
    old.status = 'closed'
    modelContext.delete(old.id)
    void helper($, '/close', { viewId: old.id }).catch(() => {})
  }
  trimClosed()
  saveViews($)

  try {
    // The arguments as far as they're known now; the rest follows (/args).
    const partial = call.input === undefined && !view.withheld ? partialArgs.get(call.id) : undefined
    if (call.input !== undefined) view.inputSent = 'final'
    else if (partial) {
      view.inputSent = 'partial'
      view.partialSent = JSON.stringify(partial)
    }
    const opened = await helper($, '/open', {
      viewId: view.id,
      server: call.server,
      toolName: call.tool,
      toolInput: call.input,
      streaming: call.input === undefined,
      partialInput: partial,
      toolResult: call.result,
      cols: view.cols,
      maxRows: view.maxRows,
      theme: call.theme,
      mode: state.terminalShowsImages ? 'image' : 'cells',
      userAgent: await userAgent($),
    })
    // Closed while it opened (the session ended, a newer view took its
    // place, the helper stopped): it stays closed, and the helper is told
    // again, as a close it got before the page existed did nothing.
    if (views.get(view.id) !== view || view.status !== 'opening') {
      // Unless another view of the id is on its way (reopened meanwhile):
      // the helper's view is that one's now, not this one's.
      const successor = views.has(view.id) ? views.get(view.id) !== view : openings.has(view.id)
      if (opened.ok && !successor) void helper($, '/close', { viewId: view.id }).catch(() => {})
      return
    }
    if (opened.ok) {
      view.status = 'live'
      view.mode = opened.mode === 'image' ? 'image' : 'cells'
      view.domains = Array.isArray(opened.domains) ? opened.domains.map(plainText) : []
      // Claude wrote more of the call while the view opened.
      sendPartial($, view)
    }
    else {
      view.status = 'error'
      view.error = plainText(opened.error ?? 'the helper refused')
      noteOpenFailed($)
    }
  } catch (error) {
    if (views.get(view.id) !== view || view.status !== 'opening') return
    view.status = 'error'
    view.error = plainText(error)
    noteOpenFailed($)
  }
  $.ui.invalidate('ui.render')
}

/**
 * Opens a closed view again (older views close as new ones open; a helper
 * that stopped closes all): its app starts afresh with the same call, and
 * with what it stored before (the helper keeps each view's store).
 */
export async function reopenView($: EngineInterface, view: View) {
  const call = view.call
  if (!call || view.status !== 'closed') return
  if (!decided(call)) return
  views.delete(view.id)
  openings.delete(view.id)
  await openView($, { ...call, epoch: state.epoch }, false, view.asleep ? view : undefined)
  const again = views.get(call.id)
  if (again?.status === 'live' && call.cancelled !== undefined) {
    send($, again, '/cancel', { viewId: call.id, reason: call.cancelled })
  }
}

/**
 * A view whose call never ran and that shows nothing worth keeping: one whose
 * call never reached the transcript (a response that was retried), or one that
 * loaded while its call waited to be allowed and was denied. `discard`: its
 * store goes too.
 */
export function dropView($: EngineInterface, view: View, discard = false) {
  view.approve(false)
  partialArgs.delete(view.id)
  modelContext.delete(view.id)
  views.delete(view.id)
  openings.delete(view.id)
  if (state.activeId === view.id) state.activeId = [...views.values()].filter((v) => v.status === 'live').pop()?.id ?? ''
  withheldCalls.delete(view.id)
  void helper($, '/close', { viewId: view.id, discard }).catch(() => {})
  saveViews($)
  $.ui.invalidate('ui.render')
}

/**
 * The views, kept in the session's state ($.state) so a reload of the
 * plugin's code (an update mid-session) doesn't blank them: the reloaded code
 * draws their headers, and those that were live open again from their call
 * (and store) as soon as they're in sight. No pictures: those come anew.
 */
const SAVED = { plugin: 'mcp-apps-cli', key: 'views' } as const
/** A tool result kept only up to this size (JSON); a bigger one isn't, and its view opens with the input alone. */
const MAX_SAVED_RESULT = 256 * 1024
/** At most this many views kept, and tool results for the newest few of them (the ones that wake). */
const SAVED_VIEWS = 50
const SAVED_RESULTS = 6
let saveQueued = false

/** Writes the views' lasting facts, once for any number of changes in a tick. */
export function saveViews($: EngineInterface) {
  if (saveQueued || !state.isActive) return
  saveQueued = true
  void Promise.resolve().then(() => {
    saveQueued = false
    void $.state.set(SAVED, { version: 1, views: savedViews() }).catch((error: unknown) => $.ui.log(`mcp-apps-cli: views not kept: ${String(error)}`, { to: 'debug' }))
  })
}

/** The newest SAVED_VIEWS, tool results for the newest SAVED_RESULTS only. */
function savedViews(): SavedView[] {
  const kept = [...views.values()].filter((v) => v.status !== 'error').slice(-SAVED_VIEWS)
  const withResults = new Set(kept.filter((v) => v.call?.result !== undefined).slice(-SAVED_RESULTS).map((v) => v.id))
  return kept.map((v) => toSaved(v, withResults.has(v.id)))
}

/**
 * The views kept across a restart of Claude Code that resumes this session
 * (the switch to fullscreen makes one): session state ends with the process,
 * the plugin's store doesn't. One copy, of this conversation's views, read
 * back and dropped by restoreViews; dropped too when the switch fails, and by
 * any session start once older than RESTART_MS, so no call's data stays on
 * disk past its use.
 */
const RESTART_KEY = 'restart'
const RESTART_MS = 10 * 60_000
/** A call's arguments kept for the restart only up to this size (JSON). */
const MAX_RESTART_INPUT = 64 * 1024

export async function keepForRestart($: EngineInterface): Promise<boolean> {
  const sessionId = await $.session.id().catch(() => '')
  if (!sessionId) return false
  const kept = savedViews()
    .filter((saved) => views.get(saved.id)?.epoch === state.epoch)
    .map((saved) =>
      saved.call?.input !== undefined && JSON.stringify(saved.call.input).length > MAX_RESTART_INPUT
        ? { ...saved, call: { ...saved.call, input: undefined } }
        : saved,
    )
  return $.store.set(RESTART_KEY, { version: 1, sessionId, at: Date.now(), views: kept }).then(
    () => true,
    () => false,
  )
}

export async function dropRestartCopy($: EngineInterface) {
  await $.store.delete(RESTART_KEY).catch(() => {})
}

function toSaved(view: View, withResult: boolean): SavedView {
  const call = view.call
  let result: SavedJson | undefined
  if (withResult && call?.result !== undefined) {
    const json = JSON.stringify(call.result)
    if (json !== undefined && json.length <= MAX_SAVED_RESULT) result = JSON.parse(json) as SavedJson
  }
  return {
    id: view.id,
    server: view.server,
    tool: view.tool,
    mode: view.mode,
    status: view.status === 'live' || view.status === 'opening' || view.asleep ? 'live' : 'closed',
    ...(call
      ? {
          call: {
            id: call.id,
            server: call.server,
            tool: call.tool,
            ...(call.input ? { input: JSON.parse(JSON.stringify(call.input)) as { [key: string]: SavedJson } } : {}),
            ...(result !== undefined ? { result } : {}),
            ...(call.cancelled !== undefined ? { cancelled: call.cancelled } : {}),
            ...(call.allowed !== undefined ? { allowed: call.allowed } : {}),
            theme: call.theme,
          },
        }
      : {}),
    ...(view.alt ? { alt: view.alt } : {}),
    ...(view.title ? { title: view.title } : {}),
    ...(view.touched ? { touched: true } : {}),
  }
}

/**
 * After a reload of the plugin's code: the views as they were, closed, those
 * that were live asleep (they open again once in sight, see wakeIfSeen).
 */
export async function restoreViews($: EngineInterface) {
  if (views.size > 0) return
  let { value } = await $.state.get(SAVED).catch(() => ({ value: undefined }))
  // Or after a restart that resumed this session (the switch to fullscreen).
  const kept = (await $.store.get(RESTART_KEY).catch(() => undefined)) as
    | { version?: number; sessionId?: string; at?: number; views?: SavedView[] }
    | undefined
  if (kept) {
    const id = await $.session.id().catch(() => '')
    const fresh = typeof kept.at === 'number' && Date.now() - kept.at < RESTART_MS
    // Ours, or stale (whosever): dropped. Another session's fresh copy waits for its own restart.
    if (kept.sessionId === id || !fresh) await dropRestartCopy($)
    if (!value && kept.sessionId === id && fresh && kept.version === 1 && Array.isArray(kept.views)) {
      value = { version: 1, views: kept.views }
    }
  }
  if (!value || value.version !== 1) return
  // Only the newest few wake by themselves, as only that many stay live.
  const waking = new Set(
    value.views
      .filter((v) => v.status === 'live' && v.call?.result !== undefined && v.call.allowed !== false)
      .slice(-LIVE_VIEWS)
      .map((v) => v.id),
  )
  for (const saved of value.views) {
    if (views.has(saved.id)) continue
    const call: ViewCall | undefined = saved.call ? { ...saved.call } : undefined
    // Allowed only where its call ran (it has a result) or was allowed: an
    // early view still waiting on the person when the code reloaded never is.
    const allowed = call !== undefined && call.allowed !== false && (call.allowed === true || call.result !== undefined)
    const view: View = {
      approval: Promise.resolve(allowed),
      approve: () => {},
      approved: allowed,
      id: saved.id,
      epoch: state.epoch,
      server: saved.server,
      tool: saved.tool,
      status: 'closed',
      frame: null,
      mode: saved.mode,
      image: null,
      sites: new Set(),
      v: 0,
      ack: 0,
      cols: DEFAULT_COLS,
      maxRows: maxRowsFor(saved.mode),
      inlineCols: DEFAULT_COLS,
      display: 'inline',
      sizedFor: 'inline',
      modes: null,
      chain: Promise.resolve(),
      ...(call ? { call } : {}),
      ...(saved.alt ? { alt: saved.alt } : {}),
      ...(saved.title ? { title: saved.title } : {}),
      ...(saved.touched ? { touched: true } : {}),
      asleep: allowed && waking.has(saved.id),
      ...(saved.status === 'live' && !waking.has(saved.id) ? { closedWhy: 'the plugin reloaded' } : {}),
    }
    views.set(view.id, view)
  }
  if (views.size > 0) $.ui.invalidate('ui.render')
}

/**
 * Closed views keep their last picture for the transcript, the newest
 * KEEP_CLOSED_PICTURES of them: an iTerm2 picture is up to about 2 MB, held
 * for the session. Older ones keep their alt text and their call (the
 * header's reopen shows them again).
 */
const KEEP_CLOSED_PICTURES = 12

export function trimClosed() {
  const closed = [...views.values()].filter((v) => v.status === 'closed' && (v.image || v.frame || v.strips))
  for (const view of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED_PICTURES))) {
    view.image = null
    view.frame = null
    view.strips = undefined
    // A resting one can't wake where it rests (nothing reaches it there): with
    // its picture gone, it's closed, and says what it showed.
    if (view.resting) {
      view.asleep = false
      view.resting = false
    }
  }
}

/**
 * How tall each tool's view was last drawn, by server, tool and mode: room
 * kept for it while the next one loads. Kept across sessions ($.store), a
 * few hundred tools at most.
 */
const rowsSeen = new Map<string, number>()
const ROWS_SEEN_KEY = 'rowsSeen'
const ROWS_SEEN_MAX = 300

function rowsKey(view: View) {
  return `${view.server}/${view.tool}/${view.mode}`
}

/** The rows kept for a view while its picture loads: as tall as its tool's last one. */
function waitingRows(view: View) {
  return Math.max(1, Math.min(rowsSeen.get(rowsKey(view)) ?? 1, view.maxRows + 1))
}

/** The heights kept from earlier sessions, at session start. */
export async function loadRowsSeen($: EngineInterface) {
  const kept = (await $.store.get(ROWS_SEEN_KEY).catch(() => undefined)) as Record<string, unknown> | undefined
  for (const [key, rows] of Object.entries(kept ?? {})) {
    if (typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 && !rowsSeen.has(key)) rowsSeen.set(key, Math.min(200, Math.round(rows)))
  }
}

function noteRows($: EngineInterface, view: View, rows: number) {
  const key = rowsKey(view)
  if (rowsSeen.get(key) === rows) return
  rowsSeen.delete(key)
  rowsSeen.set(key, rows)
  while (rowsSeen.size > ROWS_SEEN_MAX) rowsSeen.delete(rowsSeen.keys().next().value!)
  // Written at most every 2 s: an app that grows as it loads changes it per frame.
  if (rowsSaving) return
  rowsSaving = true
  void $.clock
    .sleep(2000)
    .then(() => $.store.set(ROWS_SEEN_KEY, Object.fromEntries(rowsSeen)))
    .catch(() => {})
    .finally(() => (rowsSaving = false))
}
let rowsSaving = false

/**
 * A new picture. Cells are drawn anew; an image is swapped in place where
 * it's drawn (no re-render), or drawn anew when its size or scroll changed.
 * A refused image swap because the terminal drew the alt text means no
 * images here: back to cells.
 */
export async function showPicture($: EngineInterface, view: View, next: { frame?: Frame; image?: ImageFrame }) {
  const previous = next.image ? view.image : view.frame
  const picture = (next.image ?? next.frame)!
  noteRows($, view, picture.rows + (picture.scroll ? 1 : 0))
  noteStill($, view)
  // The first picture: the width the input layer reported while it loaded.
  if (!previous && view.clientCols && view.clientCols !== view.inlineCols && view.display === 'inline') {
    view.inlineCols = view.clientCols
    applySize($, view)
  }
  if (next.image) view.image = next.image
  else view.frame = next.frame ?? null
  if (next.image?.strips) {
    const count = next.image.stripCount ?? next.image.strips.length
    const sameBands = previous && previous.cols === picture.cols && previous.rows === picture.rows && view.strips?.length === count
    if (!sameBands) view.strips = []
    for (const strip of next.image.strips) view.strips![strip.i] = { png: strip.png, rows: strip.rows }
  } else if (next.image) view.strips = undefined
  // Cells are redrawn, not swapped. An idle session paints only when a
  // drawing changes its text, and neither a swap nor new Raster cells count:
  // a swapped or redrawn animation stood still. So each new frame redraws
  // the view (ten a second at most; sooner ones fold) with the header line
  // ending in one of two blank characters, alternating: a change of text,
  // so the frame is painted. The redraw also keeps the drawn tree current,
  // so scrolling repaints the latest frame.
  if (next.frame) {
    $.ui.invalidate('ui.render')
    return
  }
  // As drawn, not as last received: pictures that come while a new size is
  // still being drawn (a view opening at a guessed width) were swapped, and
  // each band refused.
  const sameSize =
    previous && previous.cols === picture.cols && previous.rows === picture.rows && view.drawnShape === shapeOf(next.image, view.strips)
  const sameScroll = previous?.scroll?.top === picture.scroll?.top && previous?.scroll?.total === picture.scroll?.total
  // kitty and Ghostty: after the first swap (which finds out a terminal
  // drawing the alt text), each picture is drawn anew. An idle session paints
  // a swap only once something else on screen changes, so a hover showed up
  // to a second late; a redraw, its header's blank flipped, is painted now.
  // (iTerm2 keeps to swaps: a picture drawn anew there shows only after its
  // next swap.)
  const redraw = !state.swapEveryDraw && view.blitted
  if (!sameSize || !sameScroll || view.sites.size === 0 || redraw) {
    // Drawn anew; the render hook then has a fresh copy swapped in.
    $.ui.invalidate('ui.render')
    return
  }
  view.blitted = true
  // A picture in strips swaps only the bands that changed.
  const swaps = next.image?.strips
    ? next.image.strips.map((strip) => ({ key: `${pictureKey(view)}-${strip.i}`, source: { png: strip.png }, rows: strip.rows }))
    : [{ key: pictureKey(view), source: imageSource(next.image!), rows: picture.rows }]
  for (const requestId of view.sites) for (const band of swaps) {
    const swap = { requestId, key: band.key, source: band.source, columns: picture.cols, rows: band.rows }
    const answer = await $.ui.blit(swap).catch((error: unknown) => ({ deny: String(error) }))
    if (answer && 'deny' in answer && answer.deny) {
      const deny = String(answer.deny)
      $.ui.log(`mcp-apps-cli: swap refused at ${requestId}: ${deny}`, { to: 'debug' })
      if (next.image?.file && /not yet/i.test(deny)) {
        // Claude Code is still asking the terminal whether it reads files:
        // draw the picture anew, which waits for the answer itself.
        view.blitted = true
        $.ui.invalidate('ui.render')
        return
      }
      if (next.image?.file && /file|read/i.test(deny)) {
        // This terminal can't read the file (it runs elsewhere): PNG bytes.
        view.blitted = false
        send($, view, '/inline-png', { viewId: view.id })
        return
      }
      if (next.image && /alt|placeholder|cannot read/i.test(deny)) {
        $.ui.log(`mcp-apps-cli: no images in this terminal (${deny}); drawing cells`, { to: 'debug' })
        state.terminalShowsImages = false
        view.mode = 'cells'
        send($, view, '/mode', { viewId: view.id, mode: 'cells' })
        view.sizedFor = undefined
        applySize($, view)
        $.ui.invalidate('ui.render')
        return
      }
      if (/not mounted/i.test(deny)) view.sites.delete(requestId)
      // The site is there but not this band's Image yet (it is being drawn
      // anew, with other strips): draw it anew, current strips and all, and
      // send no more of this picture's bands, which would be refused too.
      else if (/size|no image/i.test(deny)) {
        view.drawnShape = undefined
        $.ui.invalidate('ui.render')
        return
      }
    }
  }
  // The first swap is painted now too.
  if (!state.swapEveryDraw) $.ui.invalidate('ui.render')
}

/** A picture's size and band layout, to tell whether a swap fits what's drawn. */
function shapeOf(image: ImageFrame | null | undefined, strips: View['strips']) {
  if (!image) return undefined
  return `${image.cols}x${image.rows}:${strips?.map((strip) => strip?.rows ?? 0).join(',') ?? ''}`
}
