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
// Hooks fail open in Antigravity (a non-zero exit is logged and ignored), so
// the hook always exits 0 and answers `deny` when anything goes wrong.

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The argument the hook adds to a call it gated. */
export const TICKET_ARG = 'agentpolyfill_ticket'
/** How long a ticket waits for its call: the person may take a while to answer. */
export const TICKET_TTL_MS = 15 * 60_000

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

export type Ticket = { tool: string; digest: string; conversationId: string; issued: number }

const NONCE = /^[0-9a-f]{32}$/

const ticketDir = (dir: string) => {
  const t = join(dir, 'tickets')
  mkdirSync(t, { recursive: true, mode: 0o700 })
  return t
}

/** Issues a ticket for one call, and clears out tickets that have expired. Returns its name. */
export function issueTicket(dir: string, t: Omit<Ticket, 'issued'>, now = Date.now()): string {
  const tickets = ticketDir(dir)
  for (const f of readdirSync(tickets))
    try {
      if (now - statSync(join(tickets, f)).mtimeMs > TICKET_TTL_MS) rmSync(join(tickets, f), { force: true })
    } catch {}
  const nonce = randomBytes(16).toString('hex')
  writePrivate(join(tickets, `${nonce}.json`), JSON.stringify({ ...t, issued: now }))
  return nonce
}

export type Redeemed = { ok: true; conversationId: string } | { ok: false; why: string }

/**
 * Takes the ticket a call carries, once: it must exist, be for this tool and
 * this digest, and be fresh. The ticket is gone after this, whatever the answer.
 */
export function redeemTicket(dir: string, nonce: unknown, tool: string, digest: string, now = Date.now()): Redeemed {
  if (typeof nonce !== 'string' || !NONCE.test(nonce))
    return { ok: false, why: "Antigravity's approval for this call didn't reach the plugin: its PreToolUse hook didn't run for it" }
  const file = join(ticketDir(dir), `${nonce}.json`)
  let t: Ticket
  try {
    t = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, why: 'the approval for this call was not found (it was used already, or it expired)' }
  } finally {
    rmSync(file, { force: true })
  }
  if (t.tool !== tool) return { ok: false, why: 'the approval was for another tool' }
  if (now - t.issued > TICKET_TTL_MS) return { ok: false, why: 'the approval expired before the call ran' }
  if (t.digest !== digest) return { ok: false, why: 'what the call would do changed after the person was asked' }
  return { ok: true, conversationId: t.conversationId }
}

/** The arguments as the call's own: without the ticket the hook added. */
export const ownArgs = (args: Record<string, unknown>) => {
  const { [TICKET_ARG]: _, ...rest } = args
  return rest
}

/** What a hook handler decides about one call. */
export type Verdict =
  /** Put the question to the person, and issue a ticket for `digest`. */
  | { ask: string; digest: string }
  /** Let the call through to Antigravity's usual approval, with a ticket that says which conversation made it. */
  | { pass: string; digest: string }
  /** Refuse it, with this reason for the model. */
  | { deny: string }

/** The hook's input, as Antigravity documents it for PreToolUse. */
export type HookInput = {
  toolCall?: { name?: unknown; args?: unknown }
  conversationId?: unknown
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

/** Antigravity's PreToolUse answer for one hook input. Never throws: anything wrong is a deny. */
export async function answerHook(input: unknown, handlers: Record<string, Handler>, dir: string, now = Date.now()): Promise<Record<string, unknown>> {
  try {
    if (!isObject(input)) return { decision: 'deny', reason: 'The plugin could not read the call it was asked about.' }
    const call = isObject(input.toolCall) ? input.toolCall : {}
    const name = typeof call.name === 'string' ? call.name : ''
    const found = handlerFor(name, handlers)
    // Not one of this plugin's tools: nothing to say about it.
    if (!found) return { decision: 'allow' }
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : ''
    const args = ownArgs(isObject(call.args) ? call.args : {})
    const v = await found.handler(args, input as HookInput)
    if ('deny' in v) return { decision: 'deny', reason: v.deny }
    const ticket = issueTicket(dir, { tool: found.short, digest: v.digest, conversationId }, now)
    return 'ask' in v
      ? { decision: 'force_ask', reason: v.ask, overwrite: { [TICKET_ARG]: ticket } }
      : { decision: 'allow', reason: v.pass, overwrite: { [TICKET_ARG]: ticket } }
  } catch (err) {
    return { decision: 'deny', reason: `The plugin's check of this call failed (${err instanceof Error ? err.message : String(err)}), so it was stopped.` }
  }
}

/** Reads the hook's stdin, answers on stdout, and exits 0. */
export async function runHook(handlers: Record<string, Handler>, dir: string) {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    input = undefined
  }
  const out = await answerHook(input, handlers, dir)
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exitCode = 0
}
