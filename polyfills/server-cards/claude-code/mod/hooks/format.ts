// What the model and the person read. Cards and catalogs are fetched before any
// connection, and Server Cards are advisory (discovery.md): each field is
// cleaned of control characters and capped, with the URL it came from.

import { plainText, type ServerCard } from './card'
import { defaultName, host, isCompatible, previewUrl } from './configure'
import type { Discovery, FoundServer } from './discover'
import type { Offered } from './offer'

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
      `   remote #${i}: ${r.type} ${clean(r.url, 2048)}${versions}${isCompatible(r) ? '' : ` (NOT usable: ${host.name} speaks none of these versions)`}`,
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
  lines.push(`Discovery for ${d.origin} (MCP Server Cards, SEP-2127; AI Catalog v0.9${d.extra ? `; further sources from ${clean(d.extra, 100)}` : ''})`)
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
    `MCP servers listed: ${d.servers.length} (${valid.length} with a valid Server Card). Server Cards are advisory (SEP-2127): ${host.name} checks the real server when it connects.`,
  )
  d.servers.forEach((s, i) => lines.push(formatServer(s, i + 1)))
  if (d.registries.length)
    lines.push(
      '',
      `Also listed: ${d.registries.length} search registr${d.registries.length === 1 ? 'y' : 'ies'} (${d.registries.map(r => clean(r.displayName ?? r.identifier, 100)).join(', ')}). Searching one is not part of this polyfill.`,
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

export const describePublisher = (o: Offered): string => {
  const p = o.publisher
  const who = o.publisherDomain
  if (!p) return 'not checked (the card was refused)'
  if (p.state === 'confirmed')
    return `CONFIRMED: ${who}'s own catalog (${clean(p.catalog, 200)}) lists this server${p.sameCard ? '' : '. The finder pointed to a card with different endpoints; the publisher\'s card is the one shown here and the one that would be added'}`
  if (p.state === 'card-refused')
    return `NOT CONFIRMED: ${who}'s catalog lists this identifier, but its card is refused (${p.errors.map(e => clean(e, 200)).join('; ')}); the card below is the finder's, unconfirmed`
  if (p.state === 'not-listed') return `NOT CONFIRMED: ${who} publishes a catalog, and it does not list this server`
  if (p.state === 'no-catalog') return `NOT CONFIRMED: ${who} publishes no catalog to check against`
  if (p.state === 'not-checked') return 'NOT CHECKED: too many servers to check against their publishers'
  return 'NOT CONFIRMED: the identifier names no publisher domain'
}

/** Servers another plugin found (`foundBy`) and handed over. */
export const formatOffered = (r: { offered: Offered[]; skipped: number; problems: string[] }, foundBy: string) => {
  const lines: string[] = []
  const valid = r.offered.filter(o => o.installCard)
  lines.push(
    `MCP servers found by ${clean(foundBy, 120)}: ${r.offered.length} (${valid.length} with a valid Server Card, ${valid.filter(o => o.publisher?.state === 'confirmed').length} confirmed by their publisher). What says who stands behind a server is whether the publisher's own domain lists it, not the finder's order.`,
  )
  r.offered.forEach((o, i) => {
    lines.push(`${i + 1}. ${clean(o.displayName ?? o.identifier, 120)}`)
    lines.push(`   identifier: ${clean(o.identifier, 200)}`)
    lines.push(`   found in: ${clean(o.listedIn, 300)}${o.score !== undefined ? ` (the finder's relevance ${o.score})` : ''}`)
    if (o.description) lines.push(`   the finder's description: ${clean(o.description, 200)}`)
    lines.push(`   card: ${clean(o.cardUrl ?? 'inline', 300)}`)
    if (!o.installCard) {
      lines.push(`   REFUSED: ${o.errors.map(e => clean(e, 300)).join('; ')}`)
      return
    }
    const c = o.installCard
    lines.push(`   publisher: ${describePublisher(o)}`)
    lines.push(`   name: ${clean(c.name, 200)}  version: ${clean(c.version, 60)}${c.title ? `  title: ${clean(c.title, 100)}` : ''}`)
    lines.push(`   description: ${clean(c.description, 100)}`)
    lines.push(`   suggested server name: ${defaultName(c)}`)
    c.remotes?.forEach((rm, j) => {
      lines.push(`   remote #${j}: ${rm.type} ${clean(rm.url, 2048)}${isCompatible(rm) ? '' : ` (NOT usable: ${host.name} speaks none of its protocol versions)`}`)
      const connects = previewUrl(c, j, o.isLocal)
      if (connects !== rm.url) lines.push(`      connects to: ${clean(connects, 2048)} (with its defaults)`)
    })
  })
  if (r.skipped) lines.push('', `${r.skipped} entries of other types (skills, agents) were ignored.`)
  if (r.problems.length) lines.push('', 'Problems:', ...r.problems.map(p => `  - ${clean(p, 300)}`))
  if (valid.length)
    lines.push(
      '',
      'To add one, tell the person which server it is, the URL it connects to, and whether its publisher confirms it; ask them; then call add_mcp_server with its identifier and that URL as `url` (the "connects to" URL where one is shown, else the remote\'s URL; no domain).',
    )
  return lines.join('\n')
}
