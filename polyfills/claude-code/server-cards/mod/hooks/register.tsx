import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Json, Pick } from '../types'
import { discover, parseTarget, type Deps, type Discovery } from './discover'
import { defaultName, isCompatible, planAdd, previewUrl, type Plan, type Scope } from './configure'
import { plainText, type ServerCard } from './card'
import { formatDiscovery, formatOffered } from './format'
import { freeName, install, isNameTaken } from './install'
import { readOffered, type Offered } from './offer'

const PLUGIN = 'mcp-server-cards'
const DISCOVER = 'discover_mcp_servers'
const ADD = 'add_mcp_server'
const PRESENT = 'present_server_cards'

function deps($: EngineInterface): Deps {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    now: () => Date.now(),
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// The picker: the servers offered under each discovery or search result, by
// that tool call's id, kept for the last few calls.
const picks = atom({ plugin: 'mcp-server-cards', key: 'picks' } as const, {})
const MAX_PICKS = 8
const KEPT_CALLS = 10

/** One pick per usable remote of a valid card. */
const picksFor = (
  card: ServerCard,
  identifier: string,
  trust: string,
  isConfirmed: boolean | null,
  provenance: string,
  fromLocal: boolean,
): Pick[] =>
  (card.remotes ?? []).flatMap((r, i): Pick[] => {
    if (!isCompatible(r)) return []
    const planned = planAdd(card, i, {}, undefined, 'local', fromLocal)
    if ('error' in planned) return []
    const needs = 'missing' in planned ? planned.missing.map(m => m.input) : []
    const plan = 'plan' in planned ? planned.plan : undefined
    return [
      {
        id: `${identifier}#${i}`,
        title: card.title ?? card.name,
        url: previewUrl(card, i, fromLocal),
        transport: r.type,
        name: plan?.name ?? defaultName(card),
        headers: plan ? plan.headers.map(h => h.name) : [],
        trust,
        isConfirmed,
        card: card as unknown as Json,
        remote: i,
        fromLocal,
        provenance,
        state: needs.length ? 'needs-input' : 'ready',
        note: needs.length ? `Needs ${needs.join(', ')}: ask Claude to add it.` : undefined,
      },
    ]
  })

async function keepPicks($: EngineInterface, toolUseId: string, list: Pick[]) {
  if (!list.length) return
  await update($, picks, (all: Record<string, Pick[]>) => {
    const next: Record<string, Pick[]> = { ...all, [toolUseId]: list.slice(0, MAX_PICKS) }
    const ids = Object.keys(next)
    for (const id of ids.slice(0, Math.max(0, ids.length - KEPT_CALLS))) delete next[id]
    return next
  })
}

async function setPick($: EngineInterface, toolUseId: string, id: string, change: Partial<Pick>) {
  await update($, picks, (all: Record<string, Pick[]>) => ({
    ...all,
    [toolUseId]: (all[toolUseId] ?? []).map(p => (p.id === id ? { ...p, ...change } : p)),
  }))
}

// A press is the person's own choice of a card they can see, so it adds the
// server without a further prompt: with the card as shown, its defaults, and
// the local scope.
async function press($: EngineInterface, toolUseId: string, id: string) {
  const pick = ((await read($, picks)) as Record<string, Pick[]>)[toolUseId]?.find(p => p.id === id)
  if (!pick || pick.state !== 'ready') return
  await setPick($, toolUseId, id, { state: 'adding', note: undefined })
  const card = pick.card as unknown as ServerCard
  const first = planAdd(card, pick.remote, {}, undefined, 'local', pick.fromLocal)
  if (!('plan' in first) || first.plan.url !== pick.url) {
    await setPick($, toolUseId, id, { state: 'failed', note: 'error' in first ? first.error : 'Ask Claude to add it.' })
    return
  }
  // Never over a server the person already has under that name (security
  // review SC2): the next free name, said so.
  const name = await freeName($, first.plan.name)
  if (!name) {
    await setPick($, toolUseId, id, { state: 'failed', note: `Servers named ${first.plan.name} to ${first.plan.name}-9 already exist. Ask Claude to add it under another name.` })
    return
  }
  const planned = name === first.plan.name ? first : planAdd(card, pick.remote, {}, name, 'local', pick.fromLocal)
  if (!('plan' in planned) || planned.plan.url !== pick.url) {
    await setPick($, toolUseId, id, { state: 'failed', note: 'Ask Claude to add it.' })
    return
  }
  const done = await install($, planned.plan, 'local', card.name, pick.provenance)
  const renamed = name === first.plan.name ? '' : ` (as "${name}": "${first.plan.name}" already exists)`
  await setPick($, toolUseId, id, { state: done.ok ? 'added' : 'failed', note: done.ok ? `${done.short}${renamed} Undo: claude mcp remove ${name} -s local` : done.short })
  $.ui.toast(plainText(done.short))
}

const STATE_LABEL: Record<Pick['state'], string> = {
  ready: '',
  'needs-input': 'needs input',
  adding: 'adding…',
  added: 'added',
  failed: 'not added',
}

export const register: Register = (on, options) => {
  // Stand-down (contract rule 4): a setting. Claude Code has no Server Card
  // support to detect yet; when it ships, this setting turns the polyfill off.
  if (options.disabled === true) return

  // Servers another plugin handed over (present_server_cards with `entries`)
  // in this session, by identifier: added by identifier alone.
  const handedOver = new Map<string, Offered>()
  // Cards a discovery showed in this session, by origin and identifier:
  // add_mcp_server installs exactly what was shown.
  const discovered = new Map<string, { card: ServerCard; isLocal: boolean }>()
  const shownKey = (origin: string, identifier: string) => `${origin}\n${identifier}`
  const showPicker = options.picker !== false
  const pickerLine = '\n\nThe person can also add one of these by pressing its Add button, shown under this result.'

  // A discovery, ours or one another plugin asked for with further sources:
  // the cards it showed are kept, and offered in the picker under `under`.
  const shownDiscovery = (d: Discovery): Pick[] => {
    const offered: Pick[] = []
    for (const s of d.servers) {
      if (!s.card) continue
      discovered.set(shownKey(d.origin, s.identifier), { card: s.card, isLocal: s.isLocal })
      offered.push(...picksFor(s.card, s.identifier, `listed by ${new URL(d.origin).host}`, null, `listed in ${d.origin}'s catalog`, s.isLocal))
    }
    return offered
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: DISCOVER,
      isDeferred: false,
      description:
        'Find the MCP servers a domain publishes, using the MCP Server Cards extension (SEP-2127): reads https://<domain>/.well-known/ai-catalog.json (the AI Catalog SEP-2127 names) and any rel="ai-catalog" link on the page, fetches each MCP Server Card the catalog lists, and checks it against the Server Card schema. ' +
        'Use when the person wants to connect Claude Code to a service by its domain or website, or a task needs a service that has no tools in this session and the person names its site. ' +
        'Read-only: it reads public documents from that domain and from the card URLs its catalog names, and returns the publisher\'s description of its servers.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'A domain ("buildkite.com") or a page URL on it ("https://buildkite.com/docs").',
          },
        },
        required: ['domain'],
      },
    })
    await $.tool.register({
      name: ADD,
      isDeferred: false,
      description:
        'Add an MCP server that discover_mcp_servers found, or that another plugin found and showed through this one (such as a search registry\'s result), to Claude Code\'s MCP configuration (as `claude mcp add` does), then connect it in this session. The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ' +
        'Secret inputs never pass through you: they are written as ${ENV_VAR} references that the person sets. Sign-in (OAuth) is Claude Code\'s own, through /mcp. ' +
        'This changes the person\'s configuration: ask them before calling it, and say which server and URL. Pass `url`, the URL the server connects to as the result showed it (its "connects to" line, else the remote\'s URL): the server is added only if that is the URL the card yields, and only for a card shown in this session.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'The domain or URL a discovery was for. Leave out for a server another plugin handed over (a search result).' },
          identifier: { type: 'string', description: 'The catalog entry identifier of the server to add.' },
          url: { type: 'string', description: 'The URL the server connects to, exactly as the result showed it: its "connects to" line, or else the remote\'s URL after "remote #N: <transport>". With other `values`, the URL those values give.' },
          remote: { type: 'integer', minimum: 0, description: 'The remote number from the result. Default 0.' },
          name: { type: 'string', description: 'The name to add the server under. Default: the suggested server name.' },
          scope: {
            type: 'string',
            enum: ['local', 'project', 'user'],
            description: 'local (this project, only you; the default), project (.mcp.json, shared with the repository) or user (all your projects).',
          },
          values: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Values for the card\'s non-secret inputs, by variable or header name.',
          },
        },
        required: ['identifier', 'url'],
      },
    })
    // For other plugins only (see the README, "For other plugins"): kept from
    // the model below, and refused when the model calls it.
    await $.tool.register({
      name: PRESENT,
      isDeferred: true,
      description:
        'For other plugins, not for the model. Shows MCP Server Cards that another plugin found, with this plugin\'s checks, picker and Add. ' +
        'Either `domain`, or `entries` (AI Catalog entries found elsewhere, each with `listedIn`); `catalogs` and link `rels` are further sources to read beside the AI Catalog, on that domain and on each entry\'s publisher domain. `under` is the caller\'s tool_use_id, under whose row the picker is drawn; `by` names the finder.',
      inputSchema: {
        type: 'object',
        properties: {
          under: { type: 'string' },
          by: { type: 'string' },
          domain: { type: 'string' },
          catalogs: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, requireVersion: { type: 'boolean' } }, required: ['url'] } },
          rels: { type: 'array', items: { type: 'string' } },
          entries: { type: 'array', items: { type: 'object' } },
        },
        required: ['by'],
      },
    })
    return started
  })

  on('tool.run', { tool: `mcp__${PLUGIN}__${DISCOVER}` }, async ($, e) => {
    const domain = str((e as Record<string, unknown>).domain) ?? ''
    const d = await discover(deps($), domain)
    if ('error' in d) return { deny: d.error }
    const offered = shownDiscovery(d)
    if (showPicker) await keepPicks($, e.tool_use_id, offered)
    return { result: formatDiscovery(d) + (showPicker && offered.length ? pickerLine : '') }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: discovery failed.` }))

  // present_server_cards is another plugin's door in, never the model's: the
  // model is not shown it, and a call of the model's is refused.
  on('tool.offer', { tool: `mcp__${PLUGIN}__${PRESENT}` }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('tool.call', { tool: `mcp__${PLUGIN}__${PRESENT}` }, ($, e, next) =>
    next.origin.plugin === 'engine' || next.origin.plugin === PLUGIN
      ? { deny: `${PRESENT} is for other plugins to call.` }
      : next(e),
  ).catch(($, e, next) => ({ deny: `${PLUGIN}: ${PRESENT} could not check its caller.` }))

  on('tool.run', { tool: `mcp__${PLUGIN}__${PRESENT}` }, async ($, e) => {
    const input = e as Record<string, unknown>
    const by = plainText(str(input.by) ?? 'another plugin').slice(0, 80) || 'another plugin'
    const under = str(input.under)
    const lines: string[] = []
    let offered: Pick[] = []
    let registries: { identifier: string; url?: string; displayName?: string }[] = []
    let servers = 0
    // Further sources the caller reads: on the domain it names, and on each
    // handed-over server's publisher domain when that is checked.
    const catalogs = Array.isArray(input.catalogs)
      ? input.catalogs.flatMap(c =>
          c && typeof c === 'object' && typeof (c as { url?: unknown }).url === 'string'
            ? [{ url: (c as { url: string }).url, requireVersion: (c as { requireVersion?: unknown }).requireVersion !== false }]
            : [],
        )
      : []
    const rels = Array.isArray(input.rels) ? input.rels.filter((r): r is string => typeof r === 'string') : []
    const sources = { catalogs: catalogs.slice(0, 3), rels: rels.slice(0, 3), by }
    if (str(input.domain)) {
      const d = await discover(deps($), str(input.domain)!, sources)
      if ('error' in d) return { deny: d.error }
      offered = shownDiscovery(d)
      registries = d.registries
      servers = d.servers.filter(s => s.card).length
      lines.push(formatDiscovery(d))
    }
    if (Array.isArray(input.entries)) {
      const r = await readOffered(deps($), input.entries, sources)
      for (const o of r.offered) {
        if (!o.installCard) continue
        handedOver.set(o.identifier, o)
        servers++
        const confirmed = o.publisher?.state === 'confirmed'
        offered.push(
          ...picksFor(
            o.installCard,
            o.identifier,
            confirmed ? `confirmed by ${o.publisherDomain}` : `NOT confirmed by its publisher (found by ${by})`,
            confirmed,
            confirmed
              ? `found by ${by} in ${o.listedIn} and confirmed by ${o.publisherDomain}'s own catalog`
              : `found by ${by} in ${o.listedIn}; NOT confirmed by its publisher's own catalog`,
            o.isLocal,
          ),
        )
      }
      lines.push(formatOffered(r, by))
    }
    if (!lines.length) return { deny: 'Give `domain` (with `catalogs` or `rels`) or `entries`.' }
    if (showPicker && under) await keepPicks($, under, offered)
    // As JSON text: Claude Code holds a registered tool's result to its output
    // shape, which takes text, not an object.
    return {
      result: JSON.stringify({ text: lines.join('\n\n') + (showPicker && under && offered.length ? pickerLine : ''), servers, registries }),
    }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: showing the cards failed.` }))

  // One reading of an add_mcp_server call, for the permission check and the
  // run alike: the card a domain or a registry served and a tool showed in this
  // session, never a URL taken from the conversation; and the URL it yields
  // must be the `url` in the call, which Claude Code's prompt displays.
  type Resolved = { card: ServerCard; provenance: string; plan: Plan; scope: Scope } | { deny: string }
  const resolveAdd = (raw: unknown): Resolved => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const domain = str(input.domain) ?? ''
    const identifier = str(input.identifier) ?? ''
    const remote = typeof input.remote === 'number' ? input.remote : 0
    const scope = (['local', 'project', 'user'].includes(str(input.scope) ?? '') ? input.scope : 'local') as Scope
    const values: Record<string, string> = {}
    if (input.values && typeof input.values === 'object')
      for (const [k, v] of Object.entries(input.values)) if (typeof v === 'string') values[k] = v
    const shownUrl = str(input.url) ?? ''
    let card: ServerCard
    let provenance: string
    let fromLocal: boolean
    if (domain) {
      const target = parseTarget(domain)
      if ('error' in target) return { deny: target.error }
      const shown = discovered.get(shownKey(target.origin, identifier))
      if (!shown)
        return {
          deny: `No valid card "${identifier}" from ${target.origin} was shown in this session. Run ${DISCOVER} for ${target.origin}, show the person the server and its URL, then add it.`,
        }
      card = shown.card
      fromLocal = shown.isLocal
      provenance = `listed in ${target.origin}'s catalog`
    } else {
      const o = handedOver.get(identifier)
      if (!o?.installCard)
        return { deny: `"${identifier}" is not a server shown in this session without a domain. Pass \`domain\` for a server found with ${DISCOVER}.` }
      card = o.installCard
      fromLocal = o.isLocal
      provenance =
        o.publisher?.state === 'confirmed'
          ? `found in ${o.listedIn} and confirmed by ${o.publisherDomain}'s own catalog`
          : `found in ${o.listedIn}; NOT confirmed by its publisher's own catalog`
    }
    const planned = planAdd(card, remote, values, str(input.name), scope, fromLocal)
    if ('error' in planned) return { deny: planned.error }
    if ('missing' in planned)
      return {
        deny:
          'The card needs these inputs; ask the person and call again with `values`: ' +
          planned.missing
            .map(m => `${m.input}${m.description ? ` (${m.description})` : ''}${m.choices ? ` one of ${m.choices.join(', ')}` : ''}`)
            .join('; '),
      }
    const { plan } = planned
    if (plan.url !== shownUrl)
      return {
        deny: `This would add ${plan.url}, not ${shownUrl || '(no url given)'}. Tell the person it connects to ${plan.url}, and if they agree, call again with that url.`,
      }
    return { card, provenance, plan, scope }
  }

  // The person decides every addition Claude asks for: an ask made by this
  // hook goes to a person, whatever the rules, allow-lists or auto mode say
  // (security review SC4), and names what would be written. Where nobody can
  // be asked, the addition is refused. The calls asked about are recorded, and
  // the run below adds only for one of them: a call that never met this check
  // (another plugin's $.tool.call) is refused, and so is one whose check came
  // before its card was shown (the re-check's two paths around the ask).
  const asked = new Set<string>()
  on('tool.check', { tool: `mcp__${PLUGIN}__${ADD}` }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict
    const r = resolveAdd(e.input)
    // Refused here, not left to the rules: an allow now could meet a card shown later.
    if ('deny' in r) return { decision: 'deny' as const, reason: plainText(r.deny) }
    if (e.approver === undefined)
      return { decision: 'deny' as const, reason: 'Adding an MCP server needs a person to approve it, and nobody can be asked in this session. Add it with `claude mcp add` instead.' }
    const { plan, card, provenance, scope } = r
    const headers = plan.headers.length ? ` It sends the header${plan.headers.length === 1 ? '' : 's'} ${plan.headers.map(h => `${h.name}: ${h.value}`).join('; ')}.` : ''
    const where =
      scope === 'project'
        ? ' The project scope writes .mcp.json, which is shared with everyone who uses this repository.'
        : scope === 'user'
          ? ' The user scope adds it to all your projects.'
          : ' The local scope adds it for you, in this project only.'
    if (e.tool_use_id) asked.add(e.tool_use_id)
    return {
      decision: 'ask' as const,
      reason: plainText(
        `Add the MCP server "${plan.name}" to your ${scope} MCP configuration? It connects to ${plan.url}.${headers}${where} From the Server Card ${card.name}, ${provenance}. To undo: claude mcp remove ${plan.name} -s ${scope}`,
      ),
    }
  }).catch(($, e, next) => ({ decision: 'ask' as const, reason: 'MCP Server Cards could not describe this addition. Check the server and URL in the call before you allow it.' }))

  on('tool.run', { tool: `mcp__${PLUGIN}__${ADD}` }, async ($, e) => {
    if (!e.tool_use_id || !asked.delete(e.tool_use_id))
      return { deny: `${ADD} adds a server only after a person approved it in Claude Code's prompt, and this call was not put to one. Ask the person to press Add under the result, or call ${ADD} again.` }
    const r = resolveAdd(e)
    if ('deny' in r) return { deny: r.deny }
    const { card, provenance, plan, scope } = r
    // A local-scope add over a server of the same name in another scope
    // would replace it for this project (security review SC2).
    if (await isNameTaken($, plan.name))
      return {
        deny: `A server named "${plan.name}" already exists, in this project or one of your scopes, and adding this one would replace it. Ask the person: add it under another name (pass \`name\`), or keep theirs.`,
      }
    const done = await install($, plan, scope, card.name, provenance)
    return done.ok ? { result: done.text } : { deny: done.text }
  }).catch(($, e, next) => ({ deny: `${PLUGIN}: adding the server failed.` }))

  // Host presentation: the picker. Under a discovery or search result, each
  // server found, with an Add button (see press above).
  if (showPicker)
    on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
      const row = await next(e)
      const p = e.props
      // Under our discovery's row, or under another plugin's call that handed cards over.
      if (p.isRunning || p.isErrored) return row
      const list = ((await read($, picks)) as Record<string, Pick[]>)[p.tool_use_id]
      if (!list?.length) return row
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {row}
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>MCP servers you can add</Text>
            {list.map(pick => (
              <Box flexDirection="row" gap={1}>
                <Box flexDirection="column" flexGrow={1}>
                  <Text>
                    {plainText(pick.title)} <Text dimColor>{plainText(pick.url)}</Text>
                  </Text>
                  <Text dimColor={pick.isConfirmed !== false} color={pick.isConfirmed === false ? 'warning' : undefined}>
                    {plainText(pick.trust)}
                  </Text>
                  <Text dimColor>
                    adds "{plainText(pick.name)}" to this project (local scope){pick.headers.length ? `, with the header${pick.headers.length === 1 ? '' : 's'} ${pick.headers.map(plainText).join(', ')}` : ''}
                  </Text>
                  {pick.note ? <Text dimColor>{plainText(pick.note)}</Text> : null}
                </Box>
                {pick.state === 'ready' ? (
                  <Button key={`add:${pick.id}`} label="Add" variant="primary" onPress={() => press($, p.tool_use_id, pick.id)} />
                ) : (
                  <Text dimColor>{STATE_LABEL[pick.state]}</Text>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )
    })

  // Host presentation: "Clients can automatically discover Server Cards through
  // AI Catalog entries advertised on domains present in agentic sessions"
  // (ext-server-card README). Only an origin Claude has already fetched from is
  // checked, once per session, and the person alone sees the line.
  if (options.notice_on_fetch === false) return
  const checked = new Set<string>()
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const target = parseTarget(e.url)
    if ('error' in target || checked.has(target.origin)) return ran
    checked.add(target.origin)
    void discover(deps($), target.origin)
      .then(d => {
        if ('error' in d) return
        const valid = d.servers.filter(s => s.card)
        if (!valid.length) return
        const names = valid.map(s => plainText(s.card!.title ?? s.card!.name)).join(', ')
        $.ui.log(
          `${new URL(d.origin).host} publishes ${valid.length === 1 ? 'an MCP server' : `${valid.length} MCP servers`} (Server Card): ${names}. Ask Claude to add it.`,
        )
      })
      .catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))
}
