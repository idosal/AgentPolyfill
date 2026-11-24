// Consent for app requests and app messages, links, downloads, and model context.

import type { EngineInterface, On } from 'claude-code'
import type { View } from './state'
import { allowedForSession, isLive, linksAllowed, messagesAllowed, modelContext, state, views } from './state'

export function registerContextHooks(on: On) {
  // Context an app set with ui/update-model-context goes to the model with
  // the person's next prompt, beside it and out of their view. An app's
  // ui/message is the plugin's own submit, which skips this hook: appMessage
  // sends the context as notes instead.
  on('prompt.submit', async ($, e, next) => {
    const pending = takeModelContext()
    if (pending.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...pending] })
  })
}

/**
 * Whether an app may run one of its server's tools. Only a tool its server
 * lists. The person's own permission rules decide first, as for Claude's
 * calls (`$.mcp.call` itself skips them): denied is refused. Then the
 * setting: `rules` (the default) runs what the rules allow and asks where
 * they would ask; `ask` always asks; `allow` (an opt-in, as Claude Desktop
 * does) runs anything the rules don't deny. A check that fails is no
 * verdict, and the person is asked whatever the setting. A yes can be for
 * the session, once per tool.
 */
export async function allowTool(
  $: EngineInterface,
  view: View,
  name: string,
  args: Record<string, unknown>,
  appOnly = false,
): Promise<{ allow: boolean; reason?: string }> {
  // Only a tool the server lists: a made-up name (one carrying escape
  // sequences, say) is never put to the person or the rules.
  if (!state.toolNames.get(view.server)?.has(name)) {
    return { allow: false, reason: `the ${view.server} server lists no such tool` }
  }
  const key = `${view.server}/${name}`
  // The session it's asked in: a question still waiting when it ends is never asked.
  const epoch = state.epoch
  // The rules first, every time: a deny rule is the person's own decision,
  // whatever the setting, and outranks a grant made earlier this session.
  let checked = true
  const verdict = await $.tool
    .check({ tool: `mcp__${view.server}__${name}`, input: args })
    .catch((error: unknown) => {
      checked = false
      $.ui.log(`mcp-apps-cli: no permission check for ${plainText(key)}${appOnly ? ' (app-only)' : ''}: ${String(error)}`, { to: 'debug' })
      return { decision: 'ask' as const, reason: undefined }
    })
  if (verdict.decision === 'deny') {
    return { allow: false, reason: verdict.reason ?? `${name} is denied by your permission rules` }
  }
  if (allowedForSession.has(key)) return { allow: true }
  const mode = state.settings.appToolCalls ?? 'rules'
  if (checked && mode === 'allow') return { allow: true }
  if (checked && mode === 'rules' && verdict.decision === 'allow') return { allow: true }
  const turn = state.asking.then(() => askPerson($, view, name, args, key, epoch))
  state.asking = turn.catch(() => {})
  return turn
}

async function askPerson(
  $: EngineInterface,
  view: View,
  name: string,
  args: Record<string, unknown>,
  key: string,
  epoch: number,
): Promise<{ allow: boolean; reason?: string }> {
  // Its turn came after the session ended, or its view closed: not asked.
  if (state.epoch !== epoch) return { allow: false, reason: 'the session ended' }
  if (!isLive(view)) return { allow: false, reason: `the ${view.server} app closed` }
  // Allowed for the session while this call waited its turn.
  if (allowedForSession.has(key)) return { allow: true }
  // Shown as text only: the name is the server's (and listed by it), the
  // arguments the app's.
  const shown = plainText(JSON.stringify(args))
  const detail = shown === '{}' ? '' : ` with ${shown.length > 160 ? `${shown.slice(0, 157)}...` : shown}`
  const tool = plainText(name)
  const always = `Allow ${tool} this session`
  // Answered after the session ended (or after its view closed): no grant,
  // which would carry into the next conversation, and no run.
  try {
    const answer = await $.ui.ask(`The ${view.server} app wants to run ${tool}${detail}. Allow it?`, {
      options: ['Allow', always, 'Deny'],
      header: 'MCP App',
    })
    if (state.epoch !== epoch) return { allow: false, reason: 'the session ended' }
    if (!isLive(view)) return { allow: false, reason: `the ${view.server} app closed` }
    if (answer === always) allowedForSession.add(key)
    if (answer === 'Allow' || answer === always) return { allow: true }
    return { allow: false, reason: `the user declined ${name}` }
  } catch {
    return { allow: false, reason: `no one allowed ${name}` }
  }
}

/** An app's text with line breaks kept and no other control characters (escape sequences, bidi overrides). */
export function appText(text: string) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
}

/**
 * The most of one view's model context the model reads, as a block of its
 * own: Claude Code's own bound on a block of a prompt's context, past which it
 * would show a head and a file. The rest is cut, and says so.
 */
export const MODEL_CONTEXT_CHARS = 100_000

/** The most of all views' model context with one prompt: Claude Code's own bound on a prompt's context together. */
export const MODEL_CONTEXT_TOTAL_CHARS = 200_000

/**
 * ui/message: the app's text starts a turn, framed as the app's (never as the
 * person's own words), with the context apps set beside it.
 */
export async function appMessage($: EngineInterface, view: View, params: Record<string, unknown>) {
  const text = appText(textOf(params.content))
  if (!text) return { isError: true }
  // As in Claude Desktop, a message goes to Claude only with the person's
  // agreement: asked (ask, the default) or sent from their own prompt (fill).
  const mode = state.settings.appMessages ?? 'ask'
  if (mode === 'fill') {
    try {
      // Added to any draft, never replacing it, and said to be the app's:
      // the person sends it as theirs, but sees whose words they are.
      const { isFilled } = await $.prompt.fill({ text: `\n[from the ${view.server} app] ${text}`, mode: 'append' })
      return isFilled ? {} : { isError: true }
    } catch {
      return { isError: true }
    }
  }
  if (mode === 'ask' && !messagesAllowed.has(view.server)) {
    const shown = text.length > 240 ? `${text.slice(0, 237)}...` : text
    const always = `Send ${view.server} messages this session`
    const epoch = state.epoch
    const answer = await $.ui
      .ask(`The ${view.server} app wants to send Claude: "${shown}". Send it?`, {
        options: ['Send', always, "Don't send"],
        header: 'MCP App',
      })
      .catch(() => "Don't send")
    // Closed, or the session over, while the person was asked: nothing is sent or granted.
    if (state.epoch !== epoch || !isLive(view)) return { isError: true }
    if (answer === always) messagesAllowed.add(view.server)
    else if (answer !== 'Send') return { isError: true }
  }
  // Closed while the person was asked: nothing is sent.
  if (!isLive(view)) return { isError: true }
  try {
    // The context apps set rides with it, out of sight. A plugin's own submit
    // passes none of its own hooks (registerContextHooks' among them), so it
    // goes ahead as notes the model reads with the turn's request.
    for (const note of takeModelContext()) {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } }).catch(() => undefined)
    }
    await $.prompt.submit({ text: `Message from the ${view.server}/${view.tool} app:\n${text}` })
    return {}
  } catch {
    return { isError: true }
  }
}

/**
 * Whether a link an app asks to open may be: http(s), a URL that parses, and
 * nothing in it a terminal would act on or that would show other than it is
 * (C0 and C1 controls, such as the escape that starts OSC 8, OSC 52 and
 * cursor sequences; bidi overrides; invisible marks; spaces).
 */
export function linkOpenable(url: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(url) || plainText(url) !== url || /[\u0000-\u001f\u007f-\u009f]/.test(url)) return false
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** ui/open-link: http(s) only, after the person says yes (once per app if they like). */
export async function openLink($: EngineInterface, view: View, url: string) {
  if (!linkOpenable(url)) return { isError: true }
  if (!linksAllowed.has(view.server)) {
    const always = `Open ${view.server} links this session`
    const epoch = state.epoch
    const answer = await $.ui
      .ask(`The ${view.server} app wants to open ${url.length > 200 ? `${url.slice(0, 197)}...` : url} in your browser. Open it?`, {
        options: ['Open', always, "Don't open"],
        header: 'MCP App',
      })
      .catch(() => "Don't open")
    if (state.epoch !== epoch || !isLive(view)) return { isError: true }
    if (answer === always) linksAllowed.add(view.server)
    else if (answer !== 'Open') return { isError: true }
  }
  if (!isLive(view)) return { isError: true }
  try {
    await $.process.run(await openerFor($, url))
    return {}
  } catch {
    return { isError: true }
  }
}

/** ui/download-file: the person sees the names and sizes before anything is saved. */
export async function allowDownload($: EngineInterface, view: View, files: unknown) {
  // Not for a closed view, nor one closed (or a session ended) while asked.
  if (!isLive(view)) return { allow: false }
  const epoch = state.epoch
  const list = (Array.isArray(files) ? files : []) as Array<{ name?: unknown; size?: unknown }>
  const named = list
    .slice(0, 5)
    .map((f) => `${plainText(f.name)} (${Math.max(1, Math.round(Number(f.size) / 1024))} KB)`)
    .join(', ')
  const more = list.length > 5 ? ` and ${list.length - 5} more` : ''
  const answer = await $.ui
    .ask(`The ${view.server} app wants to save ${named}${more} to your Downloads folder. Save?`, {
      options: ['Save', "Don't save"],
      header: 'MCP App',
    })
    .catch(() => "Don't save")
  if (state.epoch !== epoch || !isLive(view)) return { allow: false }
  return { allow: answer === 'Save' }
}

/**
 * The model context views set since the last prompt: one block per view, the
 * latest each sent, each at most MODEL_CONTEXT_CHARS and all together at most
 * MODEL_CONTEXT_TOTAL_CHARS; what's cut says so.
 */
function takeModelContext(): string[] {
  // Only from live views whose call ran: one still waiting keeps its context
  // for later; a closed one's is dropped.
  for (const [id] of modelContext) {
    const view = views.get(id)
    // A resting one's too: it was set while live, and still describes the picture on screen.
    if (!view || (!isLive(view) && !(view.resting && view.epoch === state.epoch))) modelContext.delete(id)
  }
  const ready = [...modelContext].filter(([id]) => views.get(id)?.approved === true)
  for (const [id] of ready) modelContext.delete(id)
  let room = MODEL_CONTEXT_TOTAL_CHARS
  return ready.map(([, { label, text, sent }]) => {
    const head = `Context the ${label} MCP App view set (ui/update-model-context), its latest:\n`
    const fits = Math.min(MODEL_CONTEXT_CHARS, room)
    const cut = `… (cut: the app sent ${sent} characters)`
    const note = head.length + sent <= fits ? head + text : `${head}${text.slice(0, Math.max(0, fits - head.length - cut.length))}${cut}`
    room = Math.max(0, room - note.length)
    return note
  })
}

/**
 * The command that opens `url` in the person's browser: `open` on macOS,
 * `xdg-open` on Linux, and on Windows (no `uname`) the system's URL handler,
 * which takes the URL as one argument, with no shell to parse it.
 */
async function openerFor($: EngineInterface, url: string): Promise<string[]> {
  let system = ''
  try {
    system = (await $.process.run(['uname'])).stdout.trim()
  } catch {
    // No uname: Windows.
  }
  if (system === 'Darwin') return ['open', url]
  if (system) return ['xdg-open', url]
  return ['rundll32', 'url.dll,FileProtocolHandler', url]
}

export async function onNotify(
  $: EngineInterface,
  viewId: string,
  method: string,
  params: Record<string, unknown>,
) {
  const view = views.get(viewId)
  const label = view ? `${view.server}/${view.tool}` : 'an MCP App'
  if (method !== 'log') $.ui.log(`mcp-apps-cli: ${label} sent ${method}`, { to: 'debug' })
  if (method === 'ui/copy') {
    // Only from a live view whose call was allowed.
    if (!view || view.approved !== true || !isLive(view)) return
    // Untrusted: no escape sequences reach a terminal it's pasted into.
    const text = appText(String(params.text ?? ''))
    const { isCopied } = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
    if (isCopied) $.ui.toast(`Copied from the ${view?.server ?? 'MCP'} app`)
  } else if (method === 'ui/downloaded') {
    const files = Array.isArray(params.files) ? params.files.map(String) : []
    $.ui.toast(`Saved ${files.map((f) => f.split('/').pop()).join(', ')} to Downloads`)
    $.ui.log(`mcp-apps-cli: ${label} saved ${files.join(', ')}`)
  } else if (method === 'ui/app-modes') {
    if (view) {
      view.modes = Array.isArray(params.modes) ? params.modes.map(String) : null
      $.ui.invalidate('ui.render')
    }
  } else if (method === 'ui/update-model-context') {
    // Only from a live view: a closed one's (at /clear, evicted) never
    // reaches the model.
    if (!view || !isLive(view)) return
    // It rides along with the next prompt (takeModelContext): no control
    // characters, and no more of it kept than the model would read.
    const whole = appText(textOf(params.content) || (params.structuredContent ? JSON.stringify(params.structuredContent) : ''))
    if (whole) modelContext.set(viewId, { label, text: whole.slice(0, MODEL_CONTEXT_CHARS), sent: whole.length })
    else modelContext.delete(viewId)
  } else if (method === 'log') {
    $.ui.log(`mcp-apps-cli [${label}]: ${JSON.stringify(params).slice(0, 500)}`, { to: 'debug' })
  }
}

/** Text from an app, for the terminal: no control characters, bidi or invisible marks. */
export function plainText(text: unknown): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
}
