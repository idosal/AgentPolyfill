// The gate: how an Antigravity plugin's MCP server learns that the person
// approved a call, and which conversation made it.
//
// Antigravity documents no MCP elicitation, and its MCP servers aren't told
// which conversation calls them. Its hooks are: a plugin's `PreToolUse` hook
// gets the call (`toolCall.name`, `toolCall.args`) and the `conversationId`,
// and can answer `force_ask` (Antigravity's own approval card, which "always
// prompts you for approval, ignoring cached permissions") or `deny`, with a
// `reason` the person reads, and `overwrite` (arguments merged into the call).
//
// So the plugin's hook command (the same bundle, run with --hook) works out
// what the call would do, writes a ticket for exactly that, and answers
// `force_ask` with the question, adding the ticket's name to the arguments.
// The MCP server then does the call only when it finds that ticket, unused and
// fresh, for what it is about to do. No ticket, no write: if the hook didn't
// run (a matcher that doesn't match Antigravity's tool name, a hook that was
// turned off), the call is refused, never done unasked.
//
// A hook that exits non-zero, times out or prints something that isn't JSON
// makes Antigravity fail the call (CLI 1.5.17: "JSON
// hook ... failed: command failed: exit status 1"). So the hook always exits
// 0 with a JSON answer, and it runs only for this plugin's own tools: their
// eager names, `mcp_<server>_<tool>` (each plugin's mcp_config.json marks them
// eager). A lazy `call_mcp_tool` of one of them doesn't reach the hook, gets
// no ticket, and is refused by the server. A call that isn't this plugin's,
// however it reaches the hook, is answered `allow` and nothing else.

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The argument the hook adds to a call it gated. */
export const TICKET_ARG = 'agentpolyfill_ticket'
/**
 * How long a ticket waits for its call: an hour at most. The ticket is issued
 * when the hook runs, before Antigravity's approval card is answered, and a
 * person may leave the card open for as long as that. A
 * ticket also ends at the conversation's next model call and at the end of
 * its turn: the plugin's `PreInvocation` and `Stop` hooks remove every unused
 * ticket of the conversation (`revokeConversation`). A step's tool calls are
 * all answered and run before the next model call, so none is legitimately
 * waiting then; a question that was declined or never answered leaves nothing
 * a later call could use. (`Stop` alone isn't enough: it doesn't run when a
 * decline interrupts a CLI turn, or when the CLI is closed.) A card left open
 * longer than an hour is refused, saying so, and the person is asked again.
 */
export const TICKET_TTL_MS = 60 * 60_000

/**
 * Where a plugin keeps what its hook and its MCP server share, private to the
 * user: `~/.gemini/agentpolyfill/<plugin>`, or AGENTPOLYFILL_STATE_DIR. Both
 * are run by Antigravity as the same user with the same HOME; `${PLUGIN_DATA}`
 * isn't documented for hooks, so it can't be the meeting place.
 */
export const stateDir = (plugin: string, env: NodeJS.ProcessEnv = process.env) => {
  const dir = env.AGENTPOLYFILL_STATE_DIR ? join(env.AGENTPOLYFILL_STATE_DIR, plugin) : join(env.HOME || homedir(), '.gemini', 'agentpolyfill', plugin)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {}
  return dir
}

/** A digest of what a call would do: the ticket is for that and nothing else. */
export const digestOf = (what: unknown) => createHash('sha256').update(canonical(what)).digest('hex')

/** JSON with object keys sorted, so equal values give equal text. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Writes a private file in one step: a reader sees the old file or the new one, never half of one. */
export const writePrivate = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** `meta`: what else the hook saw about the call, for the server (short strings only). */
export type Ticket = { tool: string; digest: string; conversationId: string; issued: number; ttlMs?: number; meta?: Record<string, string> }

const NONCE = /^[0-9a-f]{32}$/

const ticketDir = (dir: string) => {
  const t = join(dir, 'tickets')
  mkdirSync(t, { recursive: true, mode: 0o700 })
  return t
}

/**
 * A ticket's file is named by the SHA-256 of its nonce, never by the nonce: a
 * listing of the folder gives nothing a call could carry.
 */
const ticketFile = (dir: string, nonce: string) => join(ticketDir(dir), `${createHash('sha256').update(nonce).digest('hex')}.json`)

/** Issues a ticket for one call, and clears out tickets that have expired. Returns its nonce, which goes only into the call. */
export function issueTicket(dir: string, t: Omit<Ticket, 'issued'>, now = Date.now()): string {
  const tickets = ticketDir(dir)
  for (const f of readdirSync(tickets))
    try {
      if (now - statSync(join(tickets, f)).mtimeMs > TICKET_TTL_MS) rmSync(join(tickets, f), { force: true })
    } catch {}
  const nonce = randomBytes(16).toString('hex')
  writePrivate(ticketFile(dir, nonce), JSON.stringify({ ...t, issued: now }))
  return nonce
}

/**
 * Removes every unused ticket of a conversation: what the plugin's `Stop`
 * hook does when that conversation's turn ends. Returns how many it removed.
 */
export function revokeConversation(dir: string, conversationId: string): number {
  let n = 0
  if (!conversationId) return n
  const tickets = ticketDir(dir)
  for (const f of readdirSync(tickets))
    try {
      const t = JSON.parse(readFileSync(join(tickets, f), 'utf8')) as Partial<Ticket>
      if (t.conversationId === conversationId) {
        rmSync(join(tickets, f), { force: true })
        n++
      }
    } catch {}
  return n
}

export type Redeemed = { ok: true; conversationId: string; meta?: Record<string, string> } | { ok: false; why: string }

/**
 * Takes the ticket a call carries, once: it must exist, be for this tool and
 * this digest, and be fresh. The ticket is gone after this, whatever the answer.
 */
export function redeemTicket(dir: string, nonce: unknown, tool: string, digest: string, now = Date.now(), server?: string): Redeemed {
  if (typeof nonce !== 'string' || !NONCE.test(nonce))
    return {
      ok: false,
      why: `Antigravity's approval for this call didn't reach the plugin: its PreToolUse hook didn't run for it. The hook runs only when the tool is called by its own name${server ? `, ${eagerName(server, tool)}` : ''}, not through call_mcp_tool`,
    }
  const file = ticketFile(dir, nonce)
  let t: Ticket
  try {
    t = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, why: 'the approval for this call was not found (it was used already, it expired, or the turn it was given in ended)' }
  } finally {
    rmSync(file, { force: true })
  }
  if (t.tool !== tool) return { ok: false, why: 'the approval was for another tool' }
  const ttl = typeof t.ttlMs === 'number' && t.ttlMs > 0 ? Math.min(t.ttlMs, TICKET_TTL_MS) : TICKET_TTL_MS
  if (now - t.issued > ttl)
    return { ok: false, why: `the approval expired before the call ran (it waited more than ${Math.round(ttl / 60_000)} minutes); ask the person whether to try again` }
  if (t.digest !== digest) return { ok: false, why: 'what the call would do changed after the person was asked' }
  return { ok: true, conversationId: t.conversationId, ...(t.meta ? { meta: t.meta } : {}) }
}

/** The arguments as the call's own: without the ticket the hook added. */
/**
 * Which Antigravity surface a conversation lives in, from where the hook says
 * its transcript is: `<app_data_dir>/brain/<id>/...`, where the app data dir is
 * ~/.gemini/antigravity (App), ~/.gemini/antigravity-cli (CLI) or
 * ~/.gemini/antigravity-ide (IDE) (hooks.md).
 */
export type Surface = 'app' | 'cli' | 'ide' | 'unknown'
export const surfaceOf = (transcriptPath: unknown): Surface => {
  if (typeof transcriptPath !== 'string') return 'unknown'
  const m = /[\\/]\.gemini[\\/](antigravity(?:-cli|-ide)?)[\\/]brain[\\/]/.exec(transcriptPath)
  return !m ? 'unknown' : m[1] === 'antigravity' ? 'app' : m[1] === 'antigravity-cli' ? 'cli' : 'ide'
}

export const ownArgs = (args: Record<string, unknown>) => {
  const { [TICKET_ARG]: _, ...rest } = args
  return rest
}

/** What a hook handler decides about one call. */
export type Verdict =
  /** Put the question to the person, and issue a ticket for `digest`. */
  | { ask: string; digest: string; meta?: Record<string, string> }
  /** Let the call through to Antigravity's usual approval, with a ticket that says which conversation made it. */
  | { pass: string; digest: string; meta?: Record<string, string> }
  /** Refuse it, with this reason for the model. */
  | { deny: string }

/** The hook's input, as Antigravity documents it for PreToolUse. */
export type HookInput = {
  toolCall?: { name?: unknown; args?: unknown }
  conversationId?: unknown
  transcriptPath?: unknown
  workspacePaths?: unknown
  hookEventName?: unknown
}

export type Handler = (args: Record<string, unknown>, input: HookInput) => Promise<Verdict> | Verdict

/** The tool a hook call is for: the handler whose name ends Antigravity's name for the tool. */
export const handlerFor = (name: string, handlers: Record<string, Handler>) => {
  const short = Object.keys(handlers)
    .sort((a, b) => b.length - a.length)
    .find(k => name === k || name.endsWith(`_${k}`) || name.endsWith(`/${k}`) || name.endsWith(`.${k}`))
  return short ? { short, handler: handlers[short]! } : undefined
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Antigravity's built-in tool for an MCP tool that isn't loaded eagerly (the default). */
export const CALL_MCP_TOOL = 'call_mcp_tool'

/** An eager tool's name, as Antigravity declares it to the model and names it to hooks (mcp.md, "Eager loading"). */
export const eagerName = (server: string, tool: string) => `mcp_${server}_${tool}`

/**
 * An argument Antigravity adds to an eager tool's call for its own display
 * (CLI 1.5.17) and takes out before the server gets the call. The
 * hook leaves it out, so its digest is of what the server gets.
 */
export const HOST_ARGS = ['toolSummary'] as const

/**
 * Which call of this plugin's server a PreToolUse input is, however
 * Antigravity named it (CLI 1.5.16; mcp.md, "Tool
 * loading"):
 *
 * - lazy (the default): `call_mcp_tool` with `{ServerName, ToolName,
 *   Arguments}`; `ServerName` is `<plugin>_<key>`;
 * - eager (`"eager": true`): `mcp_<plugin>_<key>_<tool>`, the tool's own
 *   arguments.
 *
 * `server` is this plugin's server as Antigravity names it. A call of any
 * other server is not this plugin's. Without `server` (unit tests), a name
 * that ends in a handler's name is taken.
 */
export type McpCall = { tool: string; args: Record<string, unknown>; lazy?: { asText: boolean } }

export function callOf(call: Record<string, unknown>, handlers: Record<string, unknown>, server?: string): McpCall | undefined {
  const name = typeof call.name === 'string' ? call.name : ''
  const args = isObject(call.args) ? call.args : {}
  if (name === CALL_MCP_TOOL) {
    if (!server || args.ServerName !== server || typeof args.ToolName !== 'string' || !Object.hasOwn(handlers, args.ToolName)) return undefined
    let inner: unknown = args.Arguments ?? {}
    const asText = typeof inner === 'string'
    if (asText)
      try {
        inner = JSON.parse(inner as string)
      } catch {
        inner = undefined
      }
    if (!isObject(inner)) return { tool: args.ToolName, args: {}, lazy: { asText } }
    return { tool: args.ToolName, args: inner, lazy: { asText } }
  }
  const own = Object.fromEntries(Object.entries(args).filter(([k]) => !(HOST_ARGS as readonly string[]).includes(k)))
  if (server) {
    const prefix = `mcp_${server}_`
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    return Object.hasOwn(handlers, tool) ? { tool, args: own } : undefined
  }
  const found = handlerFor(name, handlers as Record<string, Handler>)
  return found ? { tool: found.short, args: own } : undefined
}

/**
 * The answer for a call that isn't this plugin's, or that the hook can't
 * read: `allow` and nothing else, which "delegat[es] to the next hook or
 * default policy" (hooks.md). A plugin never denies or alters another
 * server's call. A call of this plugin's that the hook can't read gets no
 * ticket, and its server refuses it.
 */
export const LET_BE = Object.freeze({ decision: 'allow' })

/** Which of this plugin's calls a hook input is, or undefined. Never throws, and touches no state. */
export function identify(input: unknown, tools: readonly string[] | Record<string, unknown>, server?: string): McpCall | undefined {
  try {
    if (!isObject(input)) return undefined
    const names = Array.isArray(tools) ? Object.fromEntries(tools.map(t => [t, true])) : (tools as Record<string, unknown>)
    return callOf(isObject(input.toolCall) ? input.toolCall : {}, names, server)
  } catch {
    return undefined
  }
}

/** Antigravity's PreToolUse answer for one hook input. Never throws: another server's call is let be, and anything wrong with this plugin's is a deny. */
export async function answerHook(input: unknown, handlers: Record<string, Handler>, dir: string, now = Date.now(), server?: string): Promise<Record<string, unknown>> {
  const found = identify(input, handlers, server)
  // Not one of this plugin's tools: nothing to say about it.
  if (!found || !isObject(input)) return { ...LET_BE }
  try {
    // Antigravity documents plugin hooks for the App and the CLI, not the IDE
    // (hooks.md): the forms aren't supported there, and their calls are
    // refused, whether or not the IDE runs this hook.
    if (surfaceOf(input.transcriptPath) === 'ide')
      return { decision: 'deny', reason: "This plugin isn't supported in the Antigravity IDE, which documents no plugin hooks; use the Antigravity App or the CLI." }
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : ''
    const args = ownArgs(found.args)
    // The handler sees the call under its eager name, whichever way it came.
    const named = server ? { ...input, toolCall: { name: `mcp_${server}_${found.tool}`, args } } : input
    const v = await handlers[found.tool]!(args, named as HookInput)
    if ('deny' in v) return { decision: 'deny', reason: v.deny }
    const ticket = issueTicket(dir, { tool: found.tool, digest: v.digest, conversationId, ...(v.meta ? { meta: v.meta } : {}) }, now)
    // `overwrite` is a shallow merge into the call's own arguments: for
    // call_mcp_tool, that is `Arguments` as a whole.
    const withTicket = { ...args, [TICKET_ARG]: ticket }
    const overwrite = found.lazy ? { Arguments: found.lazy.asText ? JSON.stringify(withTicket) : withTicket } : { [TICKET_ARG]: ticket }
    return 'ask' in v ? { decision: 'force_ask', reason: v.ask, overwrite } : { decision: 'allow', reason: v.pass, overwrite }
  } catch (err) {
    return { decision: 'deny', reason: `The plugin's check of this call failed (${err instanceof Error ? err.message : String(err)}), so it was stopped.` }
  }
}

/**
 * The matcher a plugin's hooks.json gives its PreToolUse gate: the eager names
 * of `tools` on `server`, and nothing of any other server's (`also`: the
 * host's own tools a plugin must see, such as Skills' `read_resource`).
 * Antigravity matches the whole tool name.
 */
export const gateMatcher = (server: string, tools: readonly string[], also: readonly string[] = []) =>
  [`mcp_${server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(${tools.join('|')})`, ...also].join('|')

/** A hook's stdin as JSON, or undefined. At most 4 MiB is read. */
export async function readHookInput(): Promise<unknown> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) if (text.length < 4 * 1024 * 1024) text += chunk
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const answer = (out: Record<string, unknown>) =>
  new Promise<void>(resolve => {
    process.stdout.write(`${JSON.stringify(out)}\n`, () => resolve())
  })

/** What a plugin's PreToolUse gate is made of, built only once a call is known to be the plugin's. */
export type Gate = { handlers: Record<string, Handler>; dir: string }

export type HookOptions = {
  /** This plugin's server, as Antigravity names it: `<plugin>_<key in mcp_config.json>`. */
  server: string
  /** The tools the gate is for: their names are all the hook needs to tell its calls from any other. */
  tools: readonly string[]
  /** Builds the handlers and opens the state folder. Never called for another server's call. */
  gate: () => Gate | Promise<Gate>
  /**
   * A host tool the plugin asks about although it isn't the plugin's (Skills'
   * `read_resource`, rule X8): its answer, or undefined to let it be. A failure
   * lets it be.
   */
  other?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

/**
 * The PreToolUse hook: reads stdin, answers on stdout, and exits 0. Which call
 * it is comes first, from the input alone; only a call of this plugin's opens
 * its state.
 */
export async function runHook(o: HookOptions) {
  const input = await readHookInput()
  let out: Record<string, unknown> = { ...LET_BE }
  if (identify(input, o.tools, o.server)) {
    try {
      const g = await o.gate()
      out = await answerHook(input, g.handlers, g.dir, Date.now(), o.server)
    } catch {
      out = { decision: 'deny', reason: 'The plugin could not read its state, so it stopped this call. Nothing was done.' }
    }
  } else if (o.other && isObject(input)) {
    try {
      out = (await o.other(input)) ?? { ...LET_BE }
    } catch {
      out = { ...LET_BE }
    }
  }
  await answer(out)
  process.exitCode = 0
}

/**
 * The `Stop` and `PreInvocation` hooks: the conversation's turn ended, or its
 * model is about to be called, so every unused ticket of it goes (a question
 * declined, or never answered). Answers `{}`, which lets the stop happen, or
 * the model call go ahead with nothing injected, and exits 0.
 */
export async function runStop(dir: () => string) {
  const input = await readHookInput()
  try {
    if (isObject(input) && typeof input.conversationId === 'string' && input.conversationId) revokeConversation(dir(), input.conversationId)
  } catch {}
  await answer({})
  process.exitCode = 0
}
