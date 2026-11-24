// The tools, as Codex sees them. The reading, checks and wording are the shared
// modules' (polyfills/claude-code/server-cards/mod/hooks); what is new here is
// how a person is asked (MCP elicitation, in place of Claude Code's hook-made
// ask) and how a server is written (codex mcp add).

import { plainText, type ServerCard } from '../../claude-code/mod/hooks/card'
import { discover, parseTarget, type Deps, type Discovery, type DiscoverOptions } from '../../claude-code/mod/hooks/discover'
import { hostOf } from '../../claude-code/mod/hooks/configure'
import { formatDiscovery } from '../../claude-code/mod/hooks/format'
import type { Offered } from '../../claude-code/mod/hooks/offer'
import { configPath, isNameTaken, planForCodex, writeEntry, type CodexPlan, type Run } from './codex'
import type { CallContext, Tool, ToolResult } from './mcp'

export const ADD = 'add_mcp_server'

export type SessionDeps = Deps & { run: Run; env: NodeJS.ProcessEnv }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
/** Text for the person and the model: each line passes the plain-text filter, line breaks kept. */
export const shownText = (s: string) => s.split('\n').map(plainText).join('\n')
const refuse = (text: string): ToolResult => ({ text: shownText(text), isError: true })

/**
 * Puts a question to the person through the client's form (MCP elicitation)
 * and says whether they accepted. The form is the consent: refused when the
 * client offers no form, and on a decline or a close. Codex itself answers the
 * form in some modes: it declines it where nobody can be asked (codex exec,
 * --ask-for-approval never), and accepts it under
 * --dangerously-bypass-approvals-and-sandbox, as it approves every tool there.
 */
export async function askPerson(ctx: CallContext, message: string): Promise<{ ok: true } | { why: string }> {
  if (!ctx.canElicit) return { why: 'this Codex client offers no form to ask the person (MCP elicitation)' }
  let answer
  try {
    answer = await ctx.elicit(message, CONFIRM_SCHEMA)
  } catch (err) {
    return { why: `the person could not be asked (${err instanceof Error ? err.message : String(err)})` }
  }
  if (answer.action === 'decline')
    return { why: 'the form was declined, by the person or by Codex itself where nobody can be asked (codex exec, --ask-for-approval never)' }
  if (answer.action !== 'accept') return { why: 'the form was closed without an answer, by the person or by Codex where nobody can be asked (codex exec)' }
  return { ok: true }
}

/** An empty form: the question is the message, and the answer is accept or decline. */
export const CONFIRM_SCHEMA = { type: 'object', properties: {}, required: [] as string[] }

/**
 * What a session showed, so that add_mcp_server adds only a card a tool showed
 * in this session (never a URL taken from the conversation), exactly as shown.
 */
export class Session {
  /** Cards a discovery showed, by origin and identifier. */
  readonly discovered = new Map<string, { card: ServerCard; isLocal: boolean; provenance: string }>()
  /** Servers a search found and showed, by identifier. */
  readonly offered = new Map<string, Offered>()
  constructor(readonly deps: SessionDeps) {}

  remember(d: Discovery) {
    for (const s of d.servers)
      if (s.card) this.discovered.set(`${d.origin}\n${s.identifier}`, { card: s.card, isLocal: s.isLocal, provenance: `listed in ${d.origin}'s catalog` })
  }

  rememberOffered(list: Offered[]) {
    for (const o of list) if (o.installCard) this.offered.set(o.identifier, o)
  }
}

export function discoverTool(session: Session, spec: { name: string; description: string; sources?: DiscoverOptions }): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'A domain ("buildkite.com") or a page URL on it ("https://buildkite.com/docs").' } },
      required: ['domain'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async args => {
      const d = await discover(session.deps, str(args.domain) ?? '', spec.sources)
      if ('error' in d) return refuse(d.error)
      session.remember(d)
      return { text: formatDiscovery(d) }
    },
  }
}

type Resolved = { card: ServerCard; provenance: string; plan: CodexPlan } | { deny: string }

/** One reading of an add_mcp_server call: the card shown, the plan it gives, and the URL check. */
export function resolveAdd(session: Session, args: Record<string, unknown>, discoverName: string): Resolved {
  const domain = str(args.domain) ?? ''
  const identifier = str(args.identifier) ?? ''
  const remote = typeof args.remote === 'number' && Number.isInteger(args.remote) ? args.remote : 0
  const values: Record<string, string> = {}
  if (args.values && typeof args.values === 'object')
    for (const [k, v] of Object.entries(args.values)) if (typeof v === 'string') values[k] = v
  const shownUrl = str(args.url) ?? ''
  let card: ServerCard
  let provenance: string
  let fromLocal: boolean
  if (domain) {
    const target = parseTarget(domain)
    if ('error' in target) return { deny: target.error }
    const shown = session.discovered.get(`${target.origin}\n${identifier}`)
    if (!shown)
      return { deny: `No valid card "${identifier}" from ${target.origin} was shown in this session. Run ${discoverName} for ${target.origin}, show the person the server and its URL, then add it.` }
    ;({ card, provenance } = shown)
    fromLocal = shown.isLocal
  } else {
    const o = session.offered.get(identifier)
    if (!o?.installCard)
      return { deny: `"${identifier}" is not a server shown in this session without a domain. Pass \`domain\` for a server found with ${discoverName}.` }
    card = o.installCard
    fromLocal = o.isLocal
    provenance =
      o.publisher?.state === 'confirmed'
        ? `found in ${o.listedIn} and confirmed by ${o.publisherDomain}'s own catalog`
        : `found in ${o.listedIn}; NOT confirmed by its publisher's own catalog`
  }
  const planned = planForCodex(card, remote, values, str(args.name), fromLocal)
  if ('error' in planned) return { deny: planned.error }
  if ('missing' in planned)
    return {
      deny:
        'The card needs these inputs; ask the person and call again with `values`: ' +
        planned.missing.map(m => `${m.input}${m.description ? ` (${m.description})` : ''}${m.choices ? ` one of ${m.choices.join(', ')}` : ''}`).join('; '),
    }
  if (planned.plan.url !== shownUrl)
    return {
      deny: `This would add ${planned.plan.url}, not ${shownUrl || '(no url given)'}. Tell the person it connects to ${planned.plan.url}, and if they agree, call again with that url.`,
    }
  return { card, provenance, plan: planned.plan }
}

/** The question put to the person: the server, the URL, the headers, where it is written, and the undo. */
export function askText(plan: CodexPlan, card: ServerCard, provenance: string, file: string) {
  const headers = [
    ...(plan.bearerEnvVar ? [`Authorization: Bearer <the value of $${plan.bearerEnvVar}>`] : []),
    ...Object.entries(plan.httpHeaders).map(([k, v]) => `${k}: ${v}`),
    ...Object.entries(plan.envHttpHeaders).map(([k, v]) => `${k}: <the value of $${v}>`),
  ]
  return shownText(
    [
      `Add the MCP server "${plan.name}" to Codex?`,
      // The host on its own line: what the URL connects to (security review C3).
      `It connects to the host ${hostOf(plan.url) || '(unknown)'}`,
      `URL: ${plan.url}`,
      headers.length ? `Headers: ${headers.join('; ')}` : 'Headers: none',
      `From the Server Card ${card.name}, ${provenance}.`,
      `Written to ${file} (all your projects).`,
      `To undo: codex mcp remove ${plan.name}`,
    ].join('\n'),
  )
}

export function addTool(session: Session, discoverName: string, foundBy: string): Tool {
  return {
    name: ADD,
    description:
      `Add an MCP server that ${foundBy} showed in this session to Codex's MCP configuration (as \`codex mcp add\` does). The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      'Secret inputs never pass through you: they are written as the names of environment variables that the person sets. Sign-in (OAuth) is Codex\'s own, with `codex mcp login`. ' +
      'Codex asks the person in a form before anything is written, naming the server, URL, headers and how to undo it; without that form, or if they decline, nothing is written. ' +
      'Pass `url`, the URL the server connects to as the result showed it (its "connects to" line, else the remote\'s URL): the server is added only if that is the URL the card yields.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain or URL a discovery was for. Leave out for a search result.' },
        identifier: { type: 'string', description: 'The catalog entry identifier of the server to add.' },
        url: { type: 'string', description: 'The URL the server connects to, exactly as the result showed it: its "connects to" line, or else the remote\'s URL after "remote #N: <transport>". With other `values`, the URL those values give.' },
        remote: { type: 'integer', minimum: 0, description: 'The remote number from the result. Default 0.' },
        name: { type: 'string', description: 'The name to add the server under. Default: the suggested server name.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the card\'s non-secret inputs, by variable or header name.' },
      },
      required: ['identifier', 'url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx: CallContext) => {
      const r = resolveAdd(session, args, discoverName)
      if ('deny' in r) return refuse(r.deny)
      const { plan, card, provenance } = r
      // Never over a server the person has (security review SC2).
      if (await isNameTaken(session.deps.run, plan.name))
        return refuse(`A server named "${plan.name}" already exists in Codex's configuration (or codex could not say). Ask the person: add it under another name (pass \`name\`), or keep theirs.`)
      // The person decides every addition (security review SC4): asked here,
      // through the client's form, and refused where there is no form or the
      // form is not accepted.
      const file = configPath(session.deps.env)
      const asked = await askPerson(ctx, askText(plan, card, provenance, file))
      if ('why' in asked) return refuse(`Nothing was written: ${asked.why}. Don't ask again unless the person brings it up.`)
      // The person may have taken a while: check the name again.
      if (await isNameTaken(session.deps.run, plan.name))
        return refuse(`A server named "${plan.name}" appeared in Codex's configuration while the person was asked. Nothing was written.`)
      const w = await writeEntry(session.deps.run, plan)
      if (!w.ok) return refuse(`${w.error}. The person can add it by hand: put this in ${file}:\n${plan.toml}`)
      const lines = [`Added "${plan.name}" (${plan.url}) to ${file} with ${w.how}, from the Server Card ${card.name}, ${provenance}. To remove it: codex mcp remove ${plan.name}`]
      if (plan.envVars.length)
        lines.push(
          `It reads ${plan.envVars.length === 1 ? 'a secret' : 'secrets'} from the environment: ${plan.envVars.map(v => `${v.name} (${v.for}${v.description ? `: ${v.description}` : ''})`).join('; ')}. The person sets ${plan.envVars.length === 1 ? 'it' : 'them'} where Codex starts, then starts a new Codex session; until then the server can't connect.`,
        )
      if (w.needsSignIn) lines.push(`The server asks for a sign-in: the person runs \`codex mcp login ${plan.name}\` in a terminal. Codex holds that sign-in itself.`)
      lines.push('Codex connects servers when a session starts: the new server\'s tools are available in the next session.')
      return { text: shownText(lines.join('\n')) }
    },
  }
}
