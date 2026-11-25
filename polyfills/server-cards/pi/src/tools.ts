// Pi tools reuse the shared Server Cards modules; only consent and host writes differ.
import { join } from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { configPath, isNameTaken, planForPi, writeEntry, type PiPlan, type PiAPI } from './pi'
import { plainText, type ServerCard } from '../../claude-code/mod/hooks/card'
import { discover, parseTarget, type Deps, type Discovery, type DiscoverOptions } from '../../claude-code/mod/hooks/discover'
import { hostOf } from '../../claude-code/mod/hooks/configure'
import { formatDiscovery } from '../../claude-code/mod/hooks/format'
import type { Offered } from '../../claude-code/mod/hooks/offer'

export const ADD = 'add_mcp_server'
export type SessionDeps = Deps & { pi: PiAPI; env: NodeJS.ProcessEnv; cli?: string }
export type CallContext = Pick<ExtensionToolContext, 'hasUI' | 'ui' | 'cwd' | 'isProjectTrusted'>
export type ToolResult = { text: string; isError?: boolean }
export type Tool = {
  name: string; description: string; inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
  run: (args: Record<string, unknown>, ctx: CallContext, signal?: AbortSignal) => Promise<ToolResult>
}
const str = (v: unknown) => typeof v === 'string' ? v : undefined
export const shownText = (s: string) => s.split('\n').map(plainText).join('\n')
export const refuse = (text: string): ToolResult => ({ text: shownText(text), isError: true })
export const ADD_CHOICES = { yes: 'Add it', no: "Don't add it" } as const

export async function askPerson(ctx: CallContext, message: string, yes: string, no: string, signal?: AbortSignal): Promise<{ ok: true } | { why: string }> {
  if (!ctx.hasUI) return { why: 'Pi has no one to ask in this mode (print or JSON); use an interactive or RPC session' }
  if (signal?.aborted) return { why: 'the tool call was cancelled' }
  try {
    const answer = await ctx.ui.select(message, [no, yes], { signal })
    if (signal?.aborted) return { why: 'the tool call was cancelled' }
    if (answer === yes) return { ok: true }
    if (answer === no) return { why: `the person chose "${no}"` }
    return { why: "the question was closed without the person's explicit choice" }
  } catch {
    return { why: 'the person could not be asked' }
  }
}

/**
 * What a session showed, so that add_mcp_server adds only a card a tool showed
 * in this session (never a URL taken from the conversation), exactly as shown.
 */
export class Session {
  /** Cards a discovery showed, by origin and identifier. */
  readonly discovered = new Map<string, { card: ServerCard; isLocal: boolean; provenance: string }>()
  /** Servers a search found and showed, by identifier. */
  readonly offered = new Map<string, Offered>()
  busy = false
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

type Resolved = { card: ServerCard; provenance: string; plan: PiPlan } | { deny: string }

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
  const planned = planForPi(card, remote, values, str(args.name), fromLocal)
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

/** The person sees every part of the entry and where it is saved. */
export function askText(plan: PiPlan, card: ServerCard, provenance: string, file: string) {
  const host = hostOf(plan.url) || '(unknown host)'
  const headers = Object.entries(plan.headers).map(([key, value]) => `${key}: ${value}`)
  return shownText([
    `${host}: add the MCP server "${plan.name}" to Pi?`,
    `It connects to the host ${host}`,
    `URL: ${plan.url}`,
    headers.length ? `Headers: ${headers.join('; ')}` : 'Headers: none',
    `From the Server Card ${card.name}, ${provenance}.`,
    `Written to ${file} (all your projects).`,
    `To undo: pi mcp remove ${plan.name}`,
  ].join('\n'))
}

/** `name`: the tool's name. Pi's tool names are global, so the ARD form gives its own add tool a name of its own. */
export function addTool(session: Session, discoverName: string, foundBy: string, name = ADD): Tool {
  return {
    name,
    description:
      `Add an MCP server that ${foundBy} showed in this session to Pi's MCP configuration (as \`pi mcp add\` does). The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      'Secret inputs never pass through you: headers hold generated ${VAR} references that the person sets. Sign-in (OAuth) is Pi\'s own, with `pi mcp login`. ' +
      'Pi asks the person with a question before anything is written, naming the server, URL, headers and how to undo it; without that question, or if they decline, nothing is written. ' +
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, ctx, signal) => {
      if (session.busy) return refuse('An addition is already awaiting the person or being written. Wait for it to finish.')
      session.busy = true
      try {
        const r = resolveAdd(session, args, discoverName)
        if ('deny' in r) return refuse(r.deny)
        const { plan, card, provenance } = r
        const { pi, cli, env } = session.deps
        if (!cli) return refuse('The running Pi CLI could not be found. Nothing was written; use Pi itself to add this server.')
        const file = configPath(env)
        const projectFile = ctx.isProjectTrusted() ? join(ctx.cwd, '.pi', 'mcp.json') : undefined
        if (isNameTaken(pi, plan.name, file, projectFile))
          return refuse(`A server named "${plan.name}" already exists in Pi's configuration (or its configuration could not be read). Ask the person: add it under another name (pass \`name\`), or keep theirs.`)
        const asked = await askPerson(ctx, askText(plan, card, provenance, file), ADD_CHOICES.yes, ADD_CHOICES.no, signal)
        if ('why' in asked) return refuse(`Nothing was written: ${asked.why}. Don't ask again unless the person brings it up.`)
        if (isNameTaken(pi, plan.name, file, projectFile))
          return refuse(`A server named "${plan.name}" appeared in Pi's configuration while the person was asked. Nothing was written.`)
        if (signal?.aborted) return refuse('Nothing was written: the tool call was cancelled.')
        let w
        // Match configPath's base even if a library host supplies a different
        // tool cwd and PI_CODING_AGENT_DIR is relative. This is a user-level add.
        try { w = await writeEntry(pi, cli, plan, process.cwd(), signal) }
        catch { return refuse('pi mcp add could not finish. Check mcp.json before trying again. No subprocess output is shown because it may contain credentials.') }
        if (!w.ok) return refuse(w.error)
        const lines = [`Added "${plan.name}" (${plan.url}) to ${file} with pi mcp add, from the Server Card ${card.name}, ${provenance}. To remove it: pi mcp remove ${plan.name}`]
        if (plan.envVars.length)
          lines.push(`It reads ${plan.envVars.length === 1 ? 'a secret' : 'secrets'} from the environment: ${plan.envVars.map(v => `${v.name} (${v.for}${v.description ? `: ${v.description}` : ''})`).join('; ')}. The person sets these where Pi starts, then restarts Pi; until then the server may not connect.`)
        lines.push(w.registered ? 'Registered with Pi for this session; Pi connects it in the background, making its tools available without /reload.' : 'Saved, but registration for this session failed. Run /reload to connect it.')
        if (!Object.keys(plan.headers).some(k => k.toLowerCase() === 'authorization'))
          lines.push(`If the server needs a sign-in, use /mcp or run \`pi mcp login ${plan.name}\`. Pi holds that sign-in itself.`)
        return { text: shownText(lines.join('\n')) }
      } finally { session.busy = false }
    },
  }
}
