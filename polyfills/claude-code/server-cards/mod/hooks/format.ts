// What the model and the person read. Everything taken from a card or a
// catalog is the publisher's claim, fetched before any connection, and is
// labelled that way (discovery.md: cards are advisory, never authoritative).

import { plainText, type ServerCard } from './card'
import { defaultName, isCompatible, previewUrl } from './configure'
import type { Discovery, FoundServer } from './discover'
import type { Search, SearchHit } from './search'

const clean = (s: unknown, max = 300) => plainText(String(s ?? '').replace(/[\r\n\t]+/g, ' ')).slice(0, max)

const describeInputs = (card: ServerCard, i: number) => {
  const r = card.remotes![i]!
  const lines: string[] = []
  for (const [k, v] of Object.entries(r.variables ?? {})) {
    if (v.value !== undefined) continue
    lines.push(
      `      - {${clean(k, 60)}}${v.isRequired ? ' (required)' : ''}${v.isSecret ? ' (secret: written as an env var reference)' : ''}${v.default !== undefined && !v.isSecret ? ` default "${clean(v.default, 80)}"` : ''}${v.choices?.length ? ` one of ${v.choices.map(c => `"${clean(c, 40)}"`).join(', ')}` : ''}${v.description ? `: ${clean(v.description, 200)}` : ''}`,
    )
  }
  for (const h of r.headers ?? []) {
    const fixed = h.value !== undefined
    lines.push(
      `      - header ${clean(h.name, 80)}${fixed ? ' (set by the card)' : ''}${h.isRequired ? ' (required)' : ''}${h.isSecret ? ' (secret: written as an env var reference)' : ''}${h.description ? `: ${clean(h.description, 200)}` : ''}`,
    )
    for (const [k, v] of Object.entries(h.variables ?? {}))
      if (v.value === undefined)
        lines.push(
          `        - {${clean(k, 60)}}${v.isRequired ? ' (required)' : ''}${v.isSecret ? ' (secret: written as an env var reference)' : ''}${v.description ? `: ${clean(v.description, 200)}` : ''}`,
        )
  }
  return lines
}

export const formatServer = (s: FoundServer, n: number) => {
  const out = [`${n}. ${clean(s.identifier, 200)}`]
  out.push(`   card: ${clean(s.cardFrom, 300)}`)
  out.push(`   listed in: ${s.listedIn.map(u => clean(u, 300)).join(', ')}`)
  if (!s.card) {
    out.push(`   REFUSED: ${s.errors.map(e => clean(e, 300)).join('; ')}`)
    return out.join('\n')
  }
  const c = s.card
  out.push(`   name: ${clean(c.name, 200)}  version: ${clean(c.version, 60)}`)
  if (c.title) out.push(`   title: ${clean(c.title, 100)}`)
  out.push(`   description: ${clean(c.description, 100)}`)
  if (c.websiteUrl) out.push(`   website: ${clean(c.websiteUrl, 300)}`)
  if (c.repository) out.push(`   repository: ${clean(c.repository.url, 300)}`)
  out.push(`   suggested server name: ${defaultName(c)}`)
  if (!c.remotes?.length) out.push('   remotes: none (the card describes no endpoint to connect to)')
  c.remotes?.forEach((r, i) => {
    const versions = r.supportedProtocolVersions?.length
      ? ` protocol ${r.supportedProtocolVersions.map(v => clean(v, 20)).join(', ')}`
      : ''
    out.push(
      `   remote #${i}: ${r.type} ${clean(r.url, 2048)}${versions}${isCompatible(r) ? '' : ' (NOT usable: Claude Code speaks none of these versions)'}`,
    )
    const connects = previewUrl(c, i, s.isLocal)
    if (connects !== r.url) out.push(`      connects to: ${clean(connects, 2048)} (with its defaults)`)
    out.push(...describeInputs(c, i))
  })
  return out.join('\n')
}

export const formatDiscovery = (d: Discovery) => {
  const found = d.sources.filter(s => s.state === 'found')
  const lines: string[] = []
  lines.push(`Discovery for ${d.origin} (MCP Server Cards, SEP-2127; AI Catalog v0.9${d.ard ? '; ARD v0.91 draft' : ''})`)
  lines.push('Sources read:')
  for (const s of d.sources)
    lines.push(`  - ${s.url} [${s.kind}]: ${s.state}${s.note ? ` (${clean(s.note, 200)})` : ''}`)
  if (!found.length) {
    lines.push(`${d.origin} publishes no catalog, so there are no Server Cards to discover there.`)
    return lines.join('\n')
  }
  const valid = d.servers.filter(s => s.card)
  lines.push('')
  lines.push(
    `MCP servers listed: ${d.servers.length} (${valid.length} with a valid Server Card). The fields below are the publisher's claims, read before connecting; Claude Code checks the real server when it connects.`,
  )
  d.servers.forEach((s, i) => lines.push(formatServer(s, i + 1)))
  if (d.registries.length)
    lines.push(
      '',
      `Also listed: ${d.registries.length} ARD registr${d.registries.length === 1 ? 'y' : 'ies'} (${d.registries.map(r => clean(r.displayName ?? r.identifier, 100)).join(', ')}). Registry search is not part of this polyfill.`,
    )
  const others = Object.entries(d.otherEntries)
  if (others.length)
    lines.push(
      `Other catalog entries (not MCP servers): ${others.map(([t, n]) => `${n} ${clean(t, 80)}`).join(', ')}`,
    )
  if (d.problems.length) lines.push('', 'Problems:', ...d.problems.map(p => `  - ${clean(p, 300)}`))
  if (valid.length)
    lines.push(
      '',
      'To add one, tell the person the server and the URL it connects to and ask them; then call add_mcp_server with this domain, the entry identifier, the remote number and that URL as `url` (the "connects to" URL where one is shown, else the remote\'s URL).',
    )
  return lines.join('\n')
}

export const describePublisher = (hit: SearchHit): string => {
  const p = hit.publisher
  const who = hit.publisherDomain
  if (!p) return 'not checked (the card was refused)'
  if (p.state === 'confirmed')
    return `CONFIRMED: ${who}'s own catalog (${clean(p.catalog, 200)}) lists this server${p.sameCard ? '' : '. The registry pointed to a card with different endpoints; the publisher\'s card is the one shown here and the one that would be added'}`
  if (p.state === 'card-refused')
    return `NOT CONFIRMED: ${who}'s catalog lists this identifier, but its card is refused (${p.errors.map(e => clean(e, 200)).join('; ')}); the registry's card below is unconfirmed`
  if (p.state === 'not-checked') return 'NOT CHECKED: too many results to check against their publishers'
  if (p.state === 'not-listed')
    return `NOT CONFIRMED: ${who} publishes a catalog, and it does not list this server`
  if (p.state === 'no-catalog') return `NOT CONFIRMED: ${who} publishes no catalog to check against`
  return 'NOT CONFIRMED: the identifier names no publisher domain'
}

export const formatSearch = (s: Search) => {
  const lines: string[] = []
  lines.push(`Registry search for "${clean(s.query, 200)}" (Agentic Resource Discovery v0.91 §5.3; not part of SEP-2127)`)
  lines.push('Registries asked:')
  for (const r of s.registries)
    lines.push(`  - ${clean(r.endpoint, 300)}: ${r.state === 'ok' ? `${r.results} results` : `failed (${clean(r.note, 200)})`}`)
  if (!s.hits.length) {
    lines.push('No MCP Server Cards matched.')
    if (s.skipped) lines.push(`(${s.skipped} results of other types were ignored.)`)
    return lines.join('\n')
  }
  const valid = s.hits.filter(h => h.installCard)
  lines.push(
    '',
    `MCP servers found: ${s.hits.length} (${valid.length} with a valid Server Card, ${valid.filter(h => h.publisher?.state === 'confirmed').length} confirmed by their publisher). A registry's ranking is relevance, not trust: what says who stands behind a server is whether the publisher's own domain lists it.`,
  )
  s.hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${clean(h.displayName ?? h.identifier, 120)}`)
    lines.push(`   identifier: ${clean(h.identifier, 200)}`)
    lines.push(`   from registry: ${clean(h.registry, 300)}${h.score !== undefined ? ` (relevance ${h.score})` : ''}`)
    if (h.description) lines.push(`   registry's description: ${clean(h.description, 200)}`)
    lines.push(`   card: ${clean(h.cardUrl ?? 'inline', 300)}`)
    if (!h.installCard) {
      lines.push(`   REFUSED: ${h.errors.map(e => clean(e, 300)).join('; ')}`)
      return
    }
    const c = h.installCard
    lines.push(`   publisher: ${describePublisher(h)}`)
    lines.push(`   name: ${clean(c.name, 200)}  version: ${clean(c.version, 60)}${c.title ? `  title: ${clean(c.title, 100)}` : ''}`)
    lines.push(`   description: ${clean(c.description, 100)}`)
    lines.push(`   suggested server name: ${defaultName(c)}`)
    c.remotes?.forEach((r, j) => {
      lines.push(`   remote #${j}: ${r.type} ${clean(r.url, 2048)}${isCompatible(r) ? '' : ' (NOT usable: Claude Code speaks none of its protocol versions)'}`)
      const connects = previewUrl(c, j)
      if (connects !== r.url) lines.push(`      connects to: ${clean(connects, 2048)} (with its defaults)`)
    })
  })
  if (s.skipped) lines.push('', `${s.skipped} results of other types (skills, agents) were ignored.`)
  if (s.problems.length) lines.push('', 'Problems:', ...s.problems.map(p => `  - ${clean(p, 300)}`))
  if (valid.length)
    lines.push(
      '',
      'To add one, tell the person which server it is, the URL it connects to, and whether its publisher confirms it; ask them; then call add_mcp_server with its identifier and that URL as `url` (the "connects to" URL where one is shown, else the remote\'s URL; no domain for a search result).',
    )
  return lines.join('\n')
}
