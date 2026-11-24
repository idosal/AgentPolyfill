// The tools, as Antigravity sees them. Reading, checks and wording are the
// shared modules' (../../claude-code/mod/hooks) and the Codex form's
// (../../codex/src/tools.ts); what is new is how the person is asked (the
// plugin's PreToolUse hook and Antigravity's approval card, see gate.ts) and
// how a server is written (into ~/.gemini/config/mcp_config.json).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerCard } from '../../claude-code/mod/hooks/card'
import { hostOf } from '../../claude-code/mod/hooks/configure'
import type { Discovery } from '../../claude-code/mod/hooks/discover'
import type { Offered } from '../../claude-code/mod/hooks/offer'
import type { Tool, ToolResult } from '../../codex/src/mcp'
import { ADD, resolveAdd, Session, shownText, type SessionDeps } from '../../codex/src/tools'
import { configPath, isNameTaken, planForAntigravity, undoText, writeEntry, type AntigravityPlan } from './antigravity'
import { digestOf, ownArgs, redeemTicket, TICKET_ARG, writePrivate, type Handler } from './gate'

export { ADD }

const refuse = (text: string): ToolResult => ({ text: shownText(text), isError: true })

/** How long what a tool showed stays addable: an hour, as a conversation goes on. */
export const SHOWN_TTL_MS = 60 * 60_000

type ShownFile = {
  discovered: [string, { card: ServerCard; isLocal: boolean; provenance: string; at: number }][]
  offered: [string, Offered & { at: number }][]
}

/**
 * A Session whose cards the plugin's hook can read: the hook runs in its own
 * process, and must put to the person exactly what the server will add. What
 * a tool showed is kept in `<state>/shown.json` (private to the user) for an
 * hour. The MCP server reads it too, so a card shown through one of its
 * processes can be added through another (Antigravity may run more than one).
 */
export class SharedSession extends Session {
  constructor(
    deps: SessionDeps,
    readonly dir: string,
    readonly now: () => number = () => Date.now(),
  ) {
    super(deps)
    this.load()
  }

  private get file() {
    return join(this.dir, 'shown.json')
  }

  /** Reads what was shown within the hour, from any of the plugin's processes. */
  load() {
    if (!existsSync(this.file)) return
    let f: ShownFile
    try {
      f = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    const fresh = (at: unknown) => typeof at === 'number' && this.now() - at < SHOWN_TTL_MS
    for (const [k, v] of f.discovered ?? []) if (fresh(v.at)) this.discovered.set(k, v)
    for (const [k, v] of f.offered ?? []) if (fresh(v.at)) this.offered.set(k, v)
  }

  private save() {
    const at = this.now()
    const stamp = <T extends object>(v: T) => ({ ...v, at: (v as { at?: number }).at ?? at })
    const f: ShownFile = {
      discovered: [...this.discovered].map(([k, v]) => [k, stamp(v)]),
      offered: [...this.offered].map(([k, v]) => [k, stamp(v)]),
    }
    writePrivate(this.file, JSON.stringify(f))
  }

  override remember(d: Discovery) {
    this.load()
    for (const s of d.servers)
      if (s.card) this.discovered.set(`${d.origin}\n${s.identifier}`, { card: s.card, isLocal: s.isLocal, provenance: `listed in ${d.origin}'s catalog`, at: this.now() } as never)
    this.save()
  }

  override rememberOffered(list: Offered[]) {
    this.load()
    for (const o of list) if (o.installCard) this.offered.set(o.identifier, { ...o, at: this.now() } as never)
    this.save()
  }
}

/** The question Antigravity's approval card shows: the server, the URL, the headers, the file, and the undo. */
export function askText(plan: AntigravityPlan, card: ServerCard, provenance: string, file: string) {
  const host = hostOf(plan.url) || '(unknown host)'
  const headers = Object.entries(plan.headers).map(([k, v]) => `${k}: ${v}`)
  return shownText(
    [
      // The host first, as in the other forms: a card that joins lines still reads it first.
      `${host}: add the MCP server "${plan.name}" to Antigravity?`,
      `It connects to the host ${host}`,
      `URL: ${plan.url}`,
      headers.length ? `Headers: ${headers.join('; ')}` : 'Headers: none',
      `From the Server Card ${card.name}, ${provenance}.`,
      `Written to ${file} (all your projects, in the App, the CLI and the IDE).`,
      `To undo: ${undoText(plan.name, file)}.`,
    ].join('\n'),
  )
}

/** What a ticket for an addition is for: the entry, its name and the file. */
const addDigest = (plan: AntigravityPlan, file: string) => digestOf({ name: plan.name, entry: plan.entry, file })

/** The hook's side of add_mcp_server: the same reading as the tool's, then the question. */
export function addHandler(session: SharedSession, discoverName: string): Handler {
  return args => {
    session.load()
    const r = resolveAdd(session, args, discoverName, planForAntigravity)
    if ('deny' in r) return { deny: shownText(r.deny) }
    const file = configPath(session.deps.env)
    if (isNameTaken(file, r.plan.name))
      return { deny: shownText(`A server named "${r.plan.name}" is already in ${file} (or the file can't be read). Ask the person: add it under another name (pass \`name\`), or keep theirs.`) }
    return { ask: askText(r.plan, r.card, r.provenance, file), digest: addDigest(r.plan, file) }
  }
}

export function addTool(session: SharedSession, discoverName: string, foundBy: string): Tool {
  return {
    name: ADD,
    description:
      `Add an MCP server that ${foundBy} showed in this conversation to Antigravity's MCP configuration (~/.gemini/config/mcp_config.json). The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      "A card that needs a secret (an API key in a header) can't be added this way: the plugin never writes a secret, and Antigravity's file has no environment variables. Sign-in (OAuth) is Antigravity's own. " +
      "Antigravity's approval card asks the person first, naming the server, URL, headers and how to undo it; if they decline, nothing is written. " +
      'Pass `url`, the URL the server connects to as the result showed it (its "connects to" line, else the remote\'s URL): the server is added only if that is the URL the card yields.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain or URL a discovery was for. Leave out for a search result.' },
        identifier: { type: 'string', description: 'The catalog entry identifier of the server to add.' },
        url: { type: 'string', description: 'The URL the server connects to, exactly as the result showed it: its "connects to" line, or else the remote\'s URL after "remote #N: <transport>". With other `values`, the URL those values give.' },
        remote: { type: 'integer', minimum: 0, description: 'The remote number from the result. Default 0.' },
        name: { type: 'string', description: 'The name to add the server under. Default: the suggested server name.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: "Values for the card's non-secret inputs, by variable or header name." },
        [TICKET_ARG]: { type: 'string', description: "Set by the plugin's approval hook. Leave it out." },
      },
      required: ['identifier', 'url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async args => {
      session.load()
      const r = resolveAdd(session, ownArgs(args), discoverName, planForAntigravity)
      if ('deny' in r) return refuse(r.deny)
      const { plan, card, provenance } = r
      const file = configPath(session.deps.env)
      // The person decides every addition (security review SC4): the hook put
      // this exact entry to them, and its ticket says they approved it.
      const t = redeemTicket(session.dir, args[TICKET_ARG], ADD, addDigest(plan, file))
      if (!t.ok)
        return refuse(
          `Nothing was written: ${t.why}. Antigravity asks the person through the plugin's hook; if it never asks, the hook isn't running (see the plugin's README, "If the approval never shows"). Don't ask again unless the person brings it up.`,
        )
      // Never over a server the person has (security review SC2).
      if (isNameTaken(file, plan.name)) return refuse(`A server named "${plan.name}" appeared in ${file} while the person was asked. Nothing was written.`)
      const w = writeEntry(file, plan)
      if (!w.ok) return refuse(`${w.error}. The person can add it by hand: under mcpServers in ${file}, "${plan.name}": ${JSON.stringify(plan.entry)}`)
      const lines = [
        `Added "${plan.name}" (${plan.url}) to ${file}, from the Server Card ${card.name}, ${provenance}. To undo: ${undoText(plan.name, file)}.`,
        'If the server asks for a sign-in, the person uses Authenticate next to it in Customizations > Installed > MCP Servers (the CLI: /mcp). Antigravity holds that sign-in itself.',
        "The new server's tools are there once Antigravity connects it: in a new conversation, or after refreshing the server in /mcp or the MCP Servers list.",
      ]
      return { text: shownText(lines.join('\n')) }
    },
  }
}
