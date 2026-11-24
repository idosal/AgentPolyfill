// Server Cards in OpenCode: what discovery showed a session, the plan a card
// gives in OpenCode's terms, and how a server is added. The reading, checks and
// wording are the shared modules' (polyfills/server-cards/claude-code/mod/hooks);
// what is OpenCode's here is how the person decides (OpenCode's permission
// rules, `ctx.permission.assert`) and how a server is added (`ctx.mcp.transform`,
// with what the plugin added kept in its own storage and added again whenever
// OpenCode loads it). The ARD form (polyfills/ard/opencode) uses this too.

import { hasMarkup, plainText, type ServerCard } from '../../claude-code/mod/hooks/card'
import { hostOf, planAdd } from '../../claude-code/mod/hooks/configure'
import { discover, parseTarget, type Deps, type Discovery, type DiscoverOptions } from '../../claude-code/mod/hooks/discover'
import { formatDiscovery } from '../../claude-code/mod/hooks/format'
import type { Store } from '../../claude-code/mod/hooks/http'
import type { Offered } from '../../claude-code/mod/hooks/offer'
import type { Context, McpServerConfig, ToolCallContext } from './opencode'

/** The remote config OpenCode keeps for an added server. */
export type RemoteConfig = Extract<McpServerConfig, { type: 'remote' }>
export type ToolAnswer = { text: string; isError?: boolean }
export type Tool = { name: string; description: string; input: Record<string, unknown>; run: (args: Record<string, unknown>, call: ToolCallContext) => Promise<ToolAnswer> }

/** The permission actions these tools ask OpenCode about. */
export const ACTIONS = { add: 'mcp_server_cards_add', remove: 'mcp_server_cards_remove' } as const
/**
 * Where the servers this plugin added are kept, in its OpenCode storage (one store for every
 * project): one entry per project, so a server added in one project is added to that project only.
 * A Git project's folders and worktrees share its id; a folder outside Git is a project of its own.
 */
export const addedKey = (location: { directory: string; project: { id: string } }) =>
  location.project.id && location.project.id !== 'global' ? `added-servers/project/${location.project.id}` : `added-servers/folder/${location.directory}`

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
/** Text for the person and the model: each line passes the plain-text filter, line breaks kept. */
export const shownText = (s: string) => s.split('\n').map(plainText).join('\n')
const refuse = (text: string): ToolAnswer => ({ text: shownText(text), isError: true })

/** The cache, for this OpenCode server: at most what the shared cache keeps, in memory. */
export const memoryStore = (): Store => {
  const mem = new Map<string, unknown>()
  return {
    get: async k => mem.get(k),
    set: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
}

/** What one session was shown: add_mcp_server adds only a card a tool showed in that session, exactly as shown. */
export class Shown {
  readonly discovered = new Map<string, { card: ServerCard; isLocal: boolean; provenance: string }>()
  readonly offered = new Map<string, Offered>()

  remember(d: Discovery) {
    for (const s of d.servers)
      if (s.card) this.discovered.set(`${d.origin}\n${s.identifier}`, { card: s.card, isLocal: s.isLocal, provenance: `listed in ${d.origin}'s catalog` })
  }

  rememberOffered(list: Offered[]) {
    for (const o of list) if (o.installCard) this.offered.set(o.identifier, o)
  }
}

export type OpenCodePlan = { name: string; url: string; headers: Record<string, string>; config: RemoteConfig; envVars: { name: string; for: string; description?: string }[] }
export type OpenCodePlanResult = { plan: OpenCodePlan } | { missing: { input: string; description?: string; choices?: string[] }[] } | { error: string } | { byHand: string; plan: Omit<OpenCodePlan, 'config'> }

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g

/**
 * The card's remote as an OpenCode entry: planAdd's checks (inputs, `$`, the URL rules, no private
 * remote from a public card), then OpenCode's own limits. A secret is never a value: a card that
 * needs one (a `${VAR}` in a header or the URL) is not added by the plugin. OpenCode fills in
 * `{env:VAR}` only in its configuration files, so the person adds such a server there by hand.
 */
export const planForOpenCode = (card: ServerCard, remoteIndex: number, values: Record<string, string>, name: string | undefined, fromLocal: boolean): OpenCodePlanResult => {
  const remote = card.remotes?.[remoteIndex]
  if (remote?.type === 'sse') return { error: `Remote #${remoteIndex} is an SSE endpoint, and OpenCode connects to streamable HTTP servers only.` }
  const planned = planAdd(card, remoteIndex, values, name, 'local', fromLocal)
  if (!('plan' in planned)) return planned
  const p = planned.plan
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const h of p.headers) {
    const lower = h.name.toLowerCase()
    if (seen.has(lower)) return { error: `The card sets the header ${h.name} twice.` }
    seen.add(lower)
    if (!h.value.includes('${') && hasMarkup(h.value)) return { error: `The header ${h.name} holds \`, <, > or a square bracket (${h.value}), which could show as something else in the question.` }
    headers[h.name] = h.value
  }
  const base = { name: p.name, url: p.url, headers, envVars: p.envVars }
  if (p.url.includes('${') || Object.values(headers).some(v => v.includes('${'))) {
    const entry = { type: 'remote', url: p.url.replace(ENV_REF, '{env:$1}'), ...(Object.keys(headers).length ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(ENV_REF, '{env:$1}')])) } : {}) }
    return { byHand: JSON.stringify({ mcp: { [p.name]: entry } }, null, 2), plan: base }
  }
  return { plan: { ...base, config: { type: 'remote', url: p.url, ...(Object.keys(headers).length ? { headers } : {}) } } }
}

type Resolved = { card: ServerCard; provenance: string; planned: OpenCodePlanResult & { plan: unknown } } | { deny: string }

/** One reading of an add_mcp_server call: the card shown, the plan it gives, and the URL check. */
export function resolveAdd(shown: Shown, args: Record<string, unknown>, discoverName: string): Resolved {
  const domain = str(args.domain) ?? ''
  const identifier = str(args.identifier) ?? ''
  const remote = typeof args.remote === 'number' && Number.isInteger(args.remote) ? args.remote : 0
  const values: Record<string, string> = {}
  if (args.values && typeof args.values === 'object') for (const [k, v] of Object.entries(args.values)) if (typeof v === 'string') values[k] = v
  const shownUrl = str(args.url) ?? ''
  let card: ServerCard
  let provenance: string
  let fromLocal: boolean
  if (domain) {
    const target = parseTarget(domain)
    if ('error' in target) return { deny: target.error }
    const s = shown.discovered.get(`${target.origin}\n${identifier}`)
    if (!s) return { deny: `No valid card "${identifier}" from ${target.origin} was shown in this session. Run ${discoverName} for ${target.origin}, show the person the server and its URL, then add it.` }
    ;({ card, provenance } = s)
    fromLocal = s.isLocal
  } else {
    const o = shown.offered.get(identifier)
    if (!o?.installCard) return { deny: `"${identifier}" is not a server shown in this session without a domain. Pass \`domain\` for a server found with ${discoverName}.` }
    card = o.installCard
    fromLocal = o.isLocal
    provenance = o.publisher?.state === 'confirmed' ? `found in ${o.listedIn} and confirmed by ${o.publisherDomain}'s own catalog` : `found in ${o.listedIn}; NOT confirmed by its publisher's own catalog`
  }
  const planned = planForOpenCode(card, remote, values, str(args.name), fromLocal)
  if ('error' in planned) return { deny: planned.error }
  if ('missing' in planned)
    return {
      deny:
        'The card needs these inputs; ask the person and call again with `values`: ' +
        planned.missing.map(m => `${m.input}${m.description ? ` (${m.description})` : ''}${m.choices ? ` one of ${m.choices.join(', ')}` : ''}`).join('; '),
    }
  if (planned.plan.url !== shownUrl)
    return { deny: `This would add ${planned.plan.url}, not ${shownUrl || '(no url given)'}. Tell the person it connects to ${planned.plan.url}, and if they agree, call again with that url.` }
  return { card, provenance, planned }
}

/** What OpenCode's permission request carries: the server, the URL, the headers, where it comes from, and the undo. */
export function addMetadata(plan: OpenCodePlan, card: ServerCard, provenance: string, removeTool: string) {
  const host = hostOf(plan.url) || '(unknown host)'
  return {
    question: shownText(`${host}: add the MCP server "${plan.name}" to OpenCode? It connects to ${plan.url}.`),
    server: plan.name,
    host,
    url: plan.url,
    headers: Object.keys(plan.headers).length ? Object.entries(plan.headers).map(([k, v]) => `${k}: ${v}`).join('; ') : 'none',
    card: plainText(card.name),
    from: plainText(provenance),
    undo: `${removeTool} {"name": "${plan.name}"}`,
  }
}

/**
 * The servers this plugin added, kept in its OpenCode storage and added to OpenCode's MCP
 * configuration by one transform, whenever OpenCode builds it. Never over a server of that name
 * that OpenCode has from anywhere else.
 */
export class AddedServers {
  readonly #ctx: Context
  #added: Record<string, RemoteConfig> = {}
  /** Every server name OpenCode's configuration has, from any source, as last built. */
  names = new Set<string>()
  #registered?: Promise<unknown>

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  get added(): Readonly<Record<string, RemoteConfig>> {
    return this.#added
  }

  get #key() {
    return addedKey(this.#ctx.location)
  }

  /** What is kept for this project now, as another OpenCode server or window may have changed it. */
  async #read(): Promise<Record<string, RemoteConfig>> {
    const kept = await this.#ctx.storage.get(this.#key).catch(() => undefined)
    const out: Record<string, RemoteConfig> = {}
    if (kept && typeof kept === 'object' && !Array.isArray(kept))
      for (const [name, cfg] of Object.entries(kept as Record<string, unknown>)) {
        const c = cfg as RemoteConfig
        if (c && c.type === 'remote' && typeof c.url === 'string') out[name] = { type: 'remote', url: c.url, ...(c.headers ? { headers: { ...c.headers } } : {}) }
      }
    return out
  }

  async start(): Promise<void> {
    this.#added = await this.#read()
    this.#registered ??= this.#ctx.mcp.transform(editor => {
      // What OpenCode has before this transform: its files, and other plugins' transforms.
      this.names = new Set(editor.list().map(([n]) => n))
      for (const [name, cfg] of Object.entries(this.#added)) if (!editor.get(name)) editor.set(name, structuredClone(cfg))
    })
    await this.#registered
  }

  /** Whether OpenCode has a server of that name that this plugin did not add. */
  async taken(name: string): Promise<boolean> {
    await this.#ctx.mcp.list().catch(() => undefined) // rebuilds the configuration, so `names` is current
    return this.names.has(name) || name in this.#added || name in (await this.#read())
  }

  /** Changes one entry of what is kept, read afresh, so no stale copy undoes another change. */
  async #change(update: (kept: Record<string, RemoteConfig>) => void): Promise<void> {
    const kept = await this.#read()
    update(kept)
    await this.#ctx.storage.set(this.#key, kept as unknown as Record<string, unknown>)
    this.#added = kept
    await this.#ctx.mcp.reload()
  }

  add(name: string, cfg: RemoteConfig): Promise<void> {
    return this.#change(kept => void (kept[name] = cfg))
  }

  remove(name: string): Promise<void> {
    return this.#change(kept => void delete kept[name])
  }
}

/** How OpenCode's own connection to a server stands. */
export async function statusOf(ctx: Context, name: string): Promise<string | undefined> {
  try {
    const s = (await ctx.mcp.list()).data.find(x => x.name === name)?.status
    return typeof s === 'string' ? s : s?.status
  } catch {
    return undefined
  }
}

export type ToolSet = { deps: Deps; ctx: Context; shown: (session: string) => Shown; added: AddedServers; names: { discover: string; add: string; remove: string }; foundBy: string }

export function discoverTool(t: ToolSet, spec: { name: string; description: string; sources?: DiscoverOptions }): Tool {
  return {
    name: spec.name,
    description: spec.description,
    input: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'A domain ("buildkite.com") or a page URL on it ("https://buildkite.com/docs").' } },
      required: ['domain'],
      additionalProperties: false,
    },
    run: async (args, call) => {
      const d = await discover(t.deps, str(args.domain) ?? '', spec.sources)
      if ('error' in d) return refuse(d.error)
      t.shown(call.sessionID).remember(d)
      return { text: formatDiscovery(d) }
    },
  }
}

export function addTool(t: ToolSet): Tool {
  return {
    name: 'add_mcp_server',
    description:
      `Add an MCP server that ${t.foundBy} showed in this session to OpenCode's MCP configuration. The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      "A card that needs a secret is not added here: the person adds it to opencode.json by hand, with {env:VAR}, and the result gives the entry. Sign-in (OAuth) is OpenCode's own, with `opencode mcp auth <name>`. " +
      `OpenCode's permission rules decide before anything is added (action ${ACTIONS.add}); with an ask rule the person is asked, shown the server, URL and headers. ` +
      'Pass `url`, the URL the server connects to as the result showed it (its "connects to" line, else the remote\'s URL): the server is added only if that is the URL the card yields.',
    input: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain or URL a discovery was for. Leave out for a search result.' },
        identifier: { type: 'string', description: 'The catalog entry identifier of the server to add.' },
        url: { type: 'string', description: 'The URL the server connects to, exactly as the result showed it.' },
        remote: { type: 'integer', minimum: 0, description: 'The remote number from the result. Default 0.' },
        name: { type: 'string', description: 'The name to add the server under. Default: the suggested server name.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: "Values for the card's non-secret inputs, by variable or header name." },
      },
      required: ['identifier', 'url'],
      additionalProperties: false,
    },
    run: async (args, call) => {
      const r = resolveAdd(t.shown(call.sessionID), args, t.names.discover)
      if ('deny' in r) return refuse(r.deny)
      const { card, provenance, planned } = r
      if ('byHand' in planned)
        return refuse(
          `This card needs a secret (${planned.plan.envVars.map(v => `${v.name}, for ${v.for}`).join('; ') || 'in its URL or a header'}). A secret never passes through this plugin, and OpenCode fills in a variable only in its configuration files, so nothing was added. The person can add it to opencode.json by hand, and set the variable where OpenCode starts:\n${planned.byHand}`,
        )
      const plan = (planned as { plan: OpenCodePlan }).plan
      // Never over a server the person has.
      if (await t.added.taken(plan.name)) return refuse(`A server named "${plan.name}" already exists in OpenCode's configuration. Ask the person: add it under another name (pass \`name\`), or keep theirs.`)
      await t.ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        source: { type: 'tool', messageID: call.messageID, id: call.id },
        action: ACTIONS.add,
        resources: [`${plan.name}=${plan.url}`],
        save: [],
        metadata: addMetadata(plan, card, provenance, t.names.remove),
      })
      if (await t.added.taken(plan.name)) return refuse(`A server named "${plan.name}" appeared in OpenCode's configuration while the person was asked. Nothing was added.`)
      await t.added.add(plan.name, plan.config)
      const status = await statusOf(t.ctx, plan.name)
      const lines = [`Added "${plan.name}" (${plan.url}) to OpenCode's MCP servers, from the Server Card ${card.name}, ${provenance}. This plugin keeps it, and adds it again each time OpenCode starts, until it is removed with ${t.names.remove}.`]
      if (status === 'needs_auth') lines.push(`The server asks for a sign-in: the person runs \`opencode mcp auth ${plan.name}\` in a terminal. OpenCode holds that sign-in itself.`)
      else if (status) lines.push(`OpenCode's connection to it: ${status}.`)
      return { text: shownText(lines.join('\n')) }
    },
  }
}

export function removeTool(t: ToolSet): Tool {
  return {
    name: 'remove_mcp_server',
    description: `Remove an MCP server that this plugin added to OpenCode (with add_mcp_server). Servers from OpenCode's configuration files are not touched. OpenCode's permission rules decide first (action ${ACTIONS.remove}).`,
    input: { type: 'object', properties: { name: { type: 'string', description: 'The server name.' } }, required: ['name'], additionalProperties: false },
    run: async (args, call) => {
      const name = str(args.name) ?? ''
      if (!(name in t.added.added)) return refuse(`"${name}" is not a server this plugin added. Servers this plugin added: ${Object.keys(t.added.added).join(', ') || 'none'}.`)
      await t.ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        source: { type: 'tool', messageID: call.messageID, id: call.id },
        action: ACTIONS.remove,
        resources: [name],
        save: [],
        metadata: { server: name, url: t.added.added[name]!.url },
      })
      await t.added.remove(name)
      return { text: shownText(`Removed "${name}" from OpenCode's MCP servers.`) }
    },
  }
}

/** Registers the tools in one namespace, each answering with text. Errors from OpenCode (a denied or rejected permission) pass through. */
export async function registerTools(ctx: Context, namespace: { name: string; description: string }, tools: Tool[]) {
  await ctx.tool.transform(editor => {
    editor.namespace(namespace)
    for (const tool of tools)
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { namespace: namespace.name, codemode: false },
        execute: async (input, call) => {
          const r = await tool.run((typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, call)
          return { content: r.isError ? `Error: ${r.text}` : r.text }
        },
      })
  })
}
