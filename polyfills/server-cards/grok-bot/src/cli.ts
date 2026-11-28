// card-to-connector: reads a domain's Server Cards (or one card by its URL) and prints what to
// paste into Grok Bot's Add a custom connector.
//
//   node card-to-connector.mjs <domain | page URL | card URL> [--server <identifier or name>] [--remote <n>] [--set NAME=value]... [--json] [--ard]
//
// It sends GET requests only, follows no redirect off https, and never sees a secret: inputs the
// card marks secret are left for the person to type into the form.

import { readCard, discover, isLoopback, type FoundServer } from '../../claude-code/mod/hooks/discover'
import { plainText, type ServerCard } from '../../claude-code/mod/hooks/card'
import { isCompatible } from '../../claude-code/mod/hooks/configure'
import type { Store } from '../../claude-code/mod/hooks/http'
import { nodeFetch } from '../../codex/src/fetch'
import { connectorFor, oauthHint, pasteText } from './connector'

const memoryStore = (): Store => {
  const m = new Map<string, unknown>()
  return { get: async k => m.get(k), set: async (k, v) => void m.set(k, v), delete: async k => void m.delete(k), keys: async () => [...m.keys()] }
}

type Args = { target?: string; server?: string; remote?: number; values: Record<string, string>; json: boolean; ard: boolean }

export function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = { values: {}, json: false, ard: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!
    if (x === '--ard') a.ard = true
    else if (x === '--json') a.json = true
    else if (x === '--server') {
      a.server = argv[++i]
      if (!a.server || a.server.startsWith('--')) return { error: '--server needs a server name' }
    }
    else if (x === '--remote') a.remote = Number(argv[++i])
    else if (x === '--set') {
      const m = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s.exec(argv[++i] ?? '')
      if (!m) return { error: '--set takes NAME=value' }
      a.values[m[1]!] = m[2]!
    } else if (x.startsWith('--')) return { error: `unknown option ${x}` }
    else if (a.target === undefined) a.target = x
    else return { error: 'give one domain or URL' }
  }
  if (!a.target) return { error: 'usage: card-to-connector <domain | URL> [--server <identifier>] [--remote <n>] [--set NAME=value] [--json] [--ard]' }
  if (a.remote !== undefined && !(Number.isInteger(a.remote) && a.remote >= 0)) return { error: '--remote takes a number (0 for the first remote)' }
  return a
}

export async function run(argv: string[], fetchImpl: typeof fetch = globalThis.fetch): Promise<{ code: number; out: string }> {
  const a = parseArgs(argv)
  if ('error' in a) return { code: 2, out: a.error }
  const target = a.target!
  const fetch = nodeFetch({ fetchImpl, userAgent: 'agentpolyfill-grok-bot-server-cards' })
  const deps = { fetch, store: memoryStore(), now: Date.now }

  // A card's own URL: read it as a card first.
  let found: FoundServer[] = []
  let problems: string[] = []
  // Only an https URL (or http on this machine) is read as a card; anything else is a domain to discover.
  const fetchable = /^https:\/\//i.test(target) || /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\//i.test(target)
  const direct = fetchable && !a.ard ? await fetch(target).catch(() => undefined) : undefined
  let directCard: ServerCard | undefined
  if (direct?.ok && /json/i.test(direct.headers['content-type'] ?? '')) {
    try {
      const parsed = readCard(JSON.parse(direct.text))
      if ('card' in parsed) directCard = parsed.card
    } catch {
      // not JSON: try discovery
    }
  }
  if (directCard) {
    const local = isLoopback(new URL(target).hostname)
    found = [{ identifier: directCard.name, listedIn: [], cardFrom: target, cardUrl: target, card: directCard, isLocal: local, errors: [] }]
  } else {
    const d = await discover(deps, target, a.ard ? { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: 'ARD v0.91 draft' } : {})
    if ('error' in d) return { code: 1, out: d.error }
    found = d.servers
    problems = d.problems
  }
  const valid = found.filter(s => s.card && !s.errors.length)
  if (!valid.length) {
    const why = [...found.filter(s => s.errors.length).map(s => `${plainText(s.identifier)}: ${s.errors.map(plainText).join('; ')}`), ...problems.map(plainText)]
    return { code: 1, out: [`No valid Server Card found for ${plainText(target)}.`, ...why.map(w => `- ${w}`)].join('\n') }
  }
  const chosen = a.server ? valid.filter(s => s.identifier === a.server || s.card!.name === a.server) : valid
  if (!chosen.length) return { code: 1, out: `No card named ${plainText(a.server!)}. Found: ${valid.map(s => plainText(s.identifier)).join(', ')}` }
  if (chosen.length > 1)
    return { code: 0, out: [`${chosen.length} servers found; run again with --server <one of these>:`, ...chosen.map(s => `- ${plainText(s.identifier)}: ${plainText(s.card!.title ?? s.card!.name)}, ${plainText(s.card!.description)}`)].join('\n') }
  const s = chosen[0]!
  const card = s.card!
  const remotes = card.remotes ?? []
  if (!remotes.length) return { code: 1, out: `${plainText(card.name)} has no remote: it runs as a local package, which Grok Bot can add only as a Command connector on its cloud computer.` }
  const index = a.remote ?? Math.max(0, remotes.findIndex(r => r.type === 'streamable-http' && isCompatible(r)))
  if (index >= remotes.length) return { code: 1, out: `${plainText(card.name)} has ${remotes.length} remote(s); --remote is 0 to ${remotes.length - 1}.` }
  const c = connectorFor(card, index, a.values, s.isLocal)
  if (!c.ok) {
    if (c.error) return { code: 1, out: plainText(c.error) }
    return { code: 1, out: ['The card leaves inputs open that are not secrets. Run again with --set for each:', ...(c.missing ?? []).map(m => `  --set ${m.input}=<value>${m.description ? `   (${plainText(m.description)})` : ''}${m.choices ? `   one of: ${m.choices.map(plainText).join(', ')}` : ''}`)].join('\n') }
  }
  const oauth = await oauthHint(fetch, c.url.replace(/\$\{[A-Z0-9_]+\}/g, 'x'))
  if (a.json) return { code: 0, out: JSON.stringify({ card: { name: card.name, version: card.version, title: card.title }, from: s.cardFrom, connector: { name: c.name, url: c.url, transport: c.transport, headers: c.headers, urlSecrets: c.urlSecrets }, oauth, notes: c.notes }, null, 2) }
  return { code: 0, out: pasteText(card, c, oauth, s.cardFrom) }
}

// Run as a script (the bundle's entry), not when a test imports it.
const self = process.argv[1] ?? ''
if (/card-to-connector\.m?js$/.test(self)) {
  run(process.argv.slice(2)).then(
    r => {
      process.stdout.write(r.out + '\n')
      process.exitCode = r.code
    },
    e => {
      process.stderr.write(`card-to-connector failed: ${plainText(e instanceof Error ? e.message : String(e))}\n`)
      process.exitCode = 1
    },
  )
}
