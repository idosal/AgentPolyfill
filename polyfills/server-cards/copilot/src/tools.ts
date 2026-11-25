// add_mcp_server, as Copilot sees it. Discovery, the session's memory of what was shown, and the
// form are the Codex form's (../../codex/src/tools.ts), unchanged: Copilot is an MCP client that
// shows a server's form (MCP elicitation) the same way. What is Copilot's is the plan and the
// write (copilot.ts) and the words.

import type { ServerCard } from '../../claude-code/mod/hooks/card'
import { hostOf } from '../../claude-code/mod/hooks/configure'
import { parseTarget } from '../../claude-code/mod/hooks/discover'
import type { Tool, ToolResult, CallContext } from '../../codex/src/mcp'
import { ADD, ADD_CHOICES, askPerson, shownText, type Session } from '../../codex/src/tools'
import { configPath, isNameTaken, planForCopilot, writeEntry, type CopilotPlan } from './copilot'

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const refuse = (text: string): ToolResult => ({ text: shownText(text), isError: true })

type Resolved = { card: ServerCard; provenance: string; plan: CopilotPlan } | { deny: string }

/** One reading of an add_mcp_server call: the card shown, the plan it gives, and the URL check (as the Codex form's resolveAdd). */
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
  const planned = planForCopilot(card, remote, values, str(args.name), fromLocal)
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
export function askText(plan: CopilotPlan, card: ServerCard, provenance: string, file: string) {
  const headers = plan.headers.map(h => `${h.name}: ${h.value.replace(/\$\{([A-Z0-9_]+)\}/g, '(the value of $$$1)')}`)
  const host = hostOf(plan.url) || '(unknown host)'
  return shownText(
    [
      // The host first, on its own line too (as the Codex form's form, security review C3).
      `${host}: add the MCP server "${plan.name}" to Copilot?`,
      `It connects to the host ${host}`,
      `URL: ${plan.url.replace(/\$\{([A-Z0-9_]+)\}/g, '(the value of $$$1)')} (${plan.transport === 'sse' ? 'SSE' : 'streamable HTTP'})`,
      headers.length ? `Headers: ${headers.join('; ')}` : 'Headers: none',
      `From the Server Card ${card.name}, ${provenance}.`,
      `Written to ${file} (all your projects).`,
      `To undo: copilot mcp remove ${plan.name}`,
    ].join('\n'),
  )
}

export function addTool(session: Session, discoverName: string, foundBy: string): Tool {
  return {
    name: ADD,
    description:
      `Add an MCP server that ${foundBy} showed in this session to Copilot's MCP configuration (as \`copilot mcp add\` does). The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      'Secret inputs never pass through you: they are written as ${VAR} references to environment variables that the person sets. Sign-in (OAuth) is Copilot\'s own, with /mcp auth. ' +
      'Copilot asks the person in a form before anything is written, naming the server, URL, headers and how to undo it; without that form, or if they decline, nothing is written. ' +
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
        return refuse(`A server named "${plan.name}" already exists in Copilot's configuration (or copilot could not say). Ask the person: add it under another name (pass \`name\`), or keep theirs.`)
      // The person decides every addition (security review SC4): asked through the client's form,
      // refused where there is no form or the form is not accepted.
      const file = configPath(session.deps.env)
      const asked = await askPerson(ctx, askText(plan, card, provenance, file), ADD_CHOICES.yes, ADD_CHOICES.no)
      if ('why' in asked) return refuse(`Nothing was written: ${asked.why}. Don't ask again unless the person brings it up.`)
      if (await isNameTaken(session.deps.run, plan.name))
        return refuse(`A server named "${plan.name}" appeared in Copilot's configuration while the person was asked. Nothing was written.`)
      const w = await writeEntry(session.deps.run, plan)
      if (!w.ok) return refuse(`${w.error}. The person can add it by hand: put this under "mcpServers" in ${file}:\n${plan.json}`)
      const lines = [`Added "${plan.name}" (${plan.url}) to ${file} with copilot mcp add, from the Server Card ${card.name}, ${provenance}. To remove it: copilot mcp remove ${plan.name}`]
      if (plan.envVars.length)
        lines.push(
          `It reads ${plan.envVars.length === 1 ? 'a secret' : 'secrets'} from the environment: ${plan.envVars.map(v => `${v.name} (${v.for}${v.description ? `: ${v.description}` : ''})`).join('; ')}. The person sets ${plan.envVars.length === 1 ? 'it' : 'them'} where Copilot starts, then starts Copilot again; until then the server can't connect.`,
        )
      lines.push("Copilot connects new servers after /mcp reload, or in the next session. If the server asks for a sign-in, Copilot offers it then (/mcp auth " + plan.name + ').')
      return { text: shownText(lines.join('\n')) }
    },
  }
}
