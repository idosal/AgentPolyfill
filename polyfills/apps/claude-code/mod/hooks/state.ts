// Shared view/protocol types and the single instances of plugin state.

export type Scroll = { top: number; rows: number; total: number }

/**
 * Cells as a Raster (base64 little-endian u32 [code point, fg, bg] each) or,
 * in full colour, as rows of styled runs ([text, fg, bg, flags], colours as
 * hex, "" for the terminal's own).
 */
export type Run = [string, string, string, number]

export type Frame = { cols: number; rows: number; cells?: string; styled?: Run[][]; scroll?: Scroll }

/** A picture: inline PNG bytes, or (kitty, Ghostty) a PNG file the terminal reads itself. */
export type ImageFrame = {
  png?: string
  file?: string
  generation?: number
  /** Inline pictures (iTerm2) in bands of rows: the ones that changed, of `stripCount`. */
  strips?: Array<{ i: number; rows: number; png: string }>
  stripCount?: number
  cols: number
  rows: number
  scroll?: Scroll
}

export type UiTool = { resourceUri: string; visibility?: string[] }

export type View = {
  id: string
  /**
   * This open's generation: a nonce of its own, sent with its /open and every
   * request about it, and carried by everything the helper says of its page.
   * A reopened view (a new View for the same id) has a new one, so what an
   * earlier open's page asked or said is never taken as this one's
   * (model/AppsViews.tla, SameInstance).
   */
  gen: string
  /** The session it opened in (state.epoch): live only while that one lasts. */
  epoch: number
  server: string
  tool: string
  status: 'opening' | 'live' | 'error' | 'closed'
  error?: string
  frame: Frame | null
  /** Real pixels, where the terminal shows Claude Code's Image element. */
  mode: 'cells' | 'image'
  image: ImageFrame | null
  /** The render sites (requestIds) the view is drawn at, for image swaps. */
  sites: Set<string>
  /** Whether a fresh copy of the picture is due to be swapped in. */
  refreshing?: boolean
  /** Whether a fresh copy has been swapped in once. */
  swapped?: boolean
  /** Whether a picture has been swapped in place (`$.ui.blit`) once. */
  blitted?: boolean
  /** Counts a view's swapped pictures: the latest one's trailing redraw is the one that runs (see redrawWhenStill). */
  swapSeq?: number
  /** The latest PNG and rows of each band of a picture sent in strips. */
  strips?: Array<{ png: string; rows: number }>
  /** Rows of its picture scrolled off the top of the transcript (see `noteScrolledOff`). */
  hidden?: number
  /** Per place it's drawn (requestId): whether none of its picture is in the viewport. */
  unseen?: Map<string, boolean>
  /** Out of sight everywhere it's drawn: the helper stops drawing it (see `syncShown`). */
  paused?: boolean
  /** When the input layer last got new props (see the ui.message hook). */
  propsAt?: number

  v: number
  ack: number
  /** The width the helper draws it at, and the tallest (`rowsFor`). */
  cols: number
  maxRows: number
  /** The width it has under its tool call. */
  inlineCols: number
  /** The width its input layer last reported (see the ui.message hook). */
  clientCols?: number
  /** Inline under the call, filling the terminal, or in a pane beside the chat. */
  display: Display
  /** The display modes the app says it handles; null when it doesn't say. */
  modes: string[] | null
  /** Domains beyond the view itself its CSP lets it reach (shown in the header). */
  domains?: string[]
  /** The pane's body, while it is in one. */
  pane?: { cols: number; rows: number }
  /** The display mode the helper last sized it for. */
  sizedFor?: Display
  chain: Promise<unknown>
  /** The call it shows, kept so a closed view can be opened again (see reopenView). */
  call?: ViewCall
  /**
   * What the app has of the call's arguments: none yet, a partial copy as
   * Claude writes them (tool-input-partial), or all of them (tool-input).
   */
  inputSent?: 'partial' | 'final'
  /** The partial arguments last sent, as JSON, so an unchanged copy isn't sent again. */
  partialSent?: string
  /** A partial copy is on its way to the helper; another was written meanwhile. */
  partialBusy?: boolean
  partialAgain?: boolean
  /**
   * Whether the call was allowed to run. A view opened while Claude was still
   * writing the call (see the turn.step hook) can draw, but what it asks of
   * the host waits for this, and is refused if the call never runs.
   */
  approval: Promise<boolean>
  approve: (allowed: boolean) => void
  approved?: boolean
  /** Opened from the streamed call, before Claude Code ran it. */
  early?: boolean
  /** Claude Code took the call up (`tool.call`): it runs, or is denied, from here. */
  callSeen?: boolean
  /** What the app shows, as text, for a screen reader and where no picture can be drawn. */
  alt?: string
  /** The app page's own title (document.title), named in its header. */
  title?: string
  /** When its last picture came; whether a wait for it to be still runs (see restWhenStill). */
  pictureAt?: number
  restWatch?: boolean
  /** Closed while still on the main screen, its picture kept: woken only where it could take input. */
  resting?: boolean
  /** When its app last called one of its server's tools. */
  appCallAt?: number
  /** How many of its app's requests are still being answered. */
  asked?: number
  /**
   * The picture's size (and bands) as last drawn: a swap fits only that, so
   * one of another size is drawn anew instead of being sent and refused.
   */
  drawnShape?: string
  /** Why it closed, when it didn't close by turn (Chrome stopped, its page crashed). */
  closedWhy?: string
  /** The person sent it input (a click, a key, the wheel): it holds what they did. */
  touched?: boolean
  /** When it was last paused (out of sight); see `sleepLater`. */
  pausedAt?: number
  /** The `pausedAt` whose sleep waited on its app's answers; see `sleepWhenAnswered`. */
  sleepDue?: number
  /**
   * Closed while long out of sight, to free its share of Chrome (and let
   * Chrome close when none is left): it opens again by itself, from the same
   * call and its store, as soon as any of it is back in sight.
   */
  asleep?: boolean
  /**
   * Opened early for a call the person (or auto mode) still has to allow:
   * the app loads, but gets none of the arguments until the call is allowed,
   * and goes, keeping nothing, if it isn't.
   */
  withheld?: boolean
}

export type Display = 'inline' | 'fullscreen' | 'pip'

export type ClientEvent =
  | ({ seq: number; kind: 'pointer' } & Record<string, unknown>)
  | ({ seq: number; kind: 'key' } & Record<string, unknown>)

export type ClientPost = {
  id: string
  v: number
  ack: number
  cols: number
  events: ClientEvent[]
}

export type HelperMessage =
  | {
      type: 'ready'
      socket?: string
      url?: string
      token?: string
      images?: boolean
      swapEveryDraw?: boolean
      /** The person's environment variables the mod reads (a hook sees only the session's own). */
      env?: Record<string, string | null | undefined>
    }
  | { type: 'frame'; viewId: string; gen?: string; v: number; frame?: Frame; image?: ImageFrame }
  | { type: 'request'; id: number; viewId: string; gen?: string; method: string; params: Record<string, unknown> }
  | { type: 'notify'; viewId: string; gen?: string; method: string; params: Record<string, unknown> }
  | { type: 'log'; text: string }
  | { type: 'describe'; viewId: string; gen?: string; text?: string; title?: string }
  | { type: 'closed'; viewId: string; gen?: string; reason: string }
  /** The helper is about to write a request to `server`: Claude Code's verdict, asked for it. */
  | { type: 'check'; id: number; server: string }
  /** The helper has requests in flight to `server` (true), or none any more (false). */
  | { type: 'busy'; server: string; busy: boolean }
  | { type: 'status'; text: string }
  | { type: 'fatal'; text: string }

/**
 * Where the helper listens: its Unix socket, or on Windows loopback TCP; and
 * the token every request must carry, given on the helper's stdout.
 */
export type HelperEndpoint = { socketPath: string; token: string } | { url: string; token: string }

export type Theme = 'light' | 'dark' | 'auto'

export type ViewCall = {
  id: string
  server: string
  tool: string
  /** The session it was made in (state.epoch): a view for it opens in that one only. */
  epoch?: number
  /** Absent while Claude is still writing the call (the view opened early). */
  input?: Record<string, unknown>
  /** Absent while the tool runs: the helper sends it later (`/result`). */
  result?: unknown
  /** Why the tool didn't run to a result, once known. */
  cancelled?: string
  /** Whether Claude Code let the call run; absent while that's not known. */
  allowed?: boolean
  theme: string
}

export const views = new Map<string, View>()

export const discovered = new Map<string, Promise<Record<string, UiTool>>>()

/** Each view's latest ui/update-model-context, by view id, until a prompt takes it. */
export const modelContext = new Map<string, { label: string; text: string; sent: number }>()

/** Each call's open, under way or done, by tool_use_id (see openView). */
export const openings = new Map<string, Promise<void>>()

/** Calls Claude is writing or wrote: their arguments so far, closed into an object. */
export const partialArgs = new Map<string, Record<string, unknown>>()

/** Calls opened while Claude wrote them, and calls Claude Code took up (tool.call). */
export const earlyCalls = new Set<string>()

export const seenCalls = new Set<string>()
/** Calls tool.run took up: their view's outcome is tool.run's to send, not tool.call's (F1). */
export const ranCalls = new Set<string>()

/** Early calls whose arguments wait for the call to be allowed (see openEarly). */
export const withheldCalls = new Set<string>()

/** Tools the person let an app run for the rest of the session, as `server/tool`. */
export const allowedForSession = new Set<string>()

/** Apps whose messages the person agreed to for this session, by server. */
export const messagesAllowed = new Set<string>()

/** Links an app may open without asking again this session, by server. */
export const linksAllowed = new Set<string>()

/** `next.origin.plugin` on a dispatch the engine raised (the model's calls), not a plugin. */
export const ENGINE = 'engine'

export const state = {
  helperSocket: undefined as Promise<HelperEndpoint> | undefined,
  terminalShowsImages: false,
  /** iTerm2 shows a picture only after a swap, each time it is drawn anew. */
  swapEveryDraw: true,
  /** The terminal's height in rows, from the latest drawing; 0 until known. */
  screenRows: 0,
  /**
   * The one view in the transcript that takes clicks and keys: the newest, or
   * the one the person last chose. Claude Code clamps a Client's region to the
   * top of the screen without shortening it, so an older view scrolled partly
   * off the top would cover the views under it and take their clicks.
   */
  activeId: '',
  // Only an interactive terminal session draws views. The desktop app renders
  // MCP Apps itself, and `claude -p` or the Agent SDK has no one to click.
  isActive: false,
  /** The person's choices for consent (plugin.json userConfig), defaults as Claude Desktop. */
  settings: {} as { appToolCalls?: string; appMessages?: string; offerFullscreen?: string; offerBrowser?: string; structuredFromText?: string },
  /** The no-browser offer this session: being checked, or done (see browser.ts). */
  browserOffer: undefined as 'checking' | 'done' | undefined,
  /** The offer to switch to fullscreen (see fullscreen.ts): due after this turn, or done for the session. */
  offer: undefined as 'due' | 'done' | undefined,
  /** One question at a time: calls made together wait for the answer before them. */
  asking: Promise.resolve() as Promise<unknown>,
  agent: undefined as Promise<string> | undefined,
  /** The helper couldn't start (none for this machine, say), and a toast said so: not again this session. */
  helperProblemShown: false,
  /** CLAUDE_CODE_NO_FLICKER as the person set it, if they did (the helper reports it). */
  noFlicker: undefined as string | undefined,
  /** Whether Claude Code runs in tmux (the helper reports it). */
  tmux: false,
  /** Per server, once discovered, whether it has any tool with an app: Chrome starts ahead only for those. */
  serversWithApps: new Map<string, boolean>(),
  /** Each server's tools whose annotations say they only read (readOnlyHint). */
  readOnlyTools: new Map<string, Set<string>>(),
  /** Each server's tools, as it lists them: an app may ask to run only one of these. */
  toolNames: new Map<string, Set<string>>(),
  /** Whether Claude Code draws fullscreen (input reaches views) or on the main screen; undefined until a drawing says. */
  layoutFullscreen: undefined as boolean | undefined,
  /** Which session this is, counted up as one ends: an answer from an earlier one grants nothing (F5). */
  epoch: 0,
  /** How long a view stays out of sight before it sleeps (MCP_APPS_CLI_SLEEP_S; 0: never). */
  sleepAfterMs: 10 * 60_000,
}

/** Whether a view still stands where it was opened: what it asked is done only then. */
export function isLive(view: View) {
  return views.get(view.id) === view && (view.status === 'live' || view.status === 'opening') && view.epoch === state.epoch
}
