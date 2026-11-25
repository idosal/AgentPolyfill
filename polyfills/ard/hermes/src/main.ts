import { Bridge } from './bridge'
import { CardSession, cardTools, hermesDeps, isMain, shownText, useHermesHost, probeOAuth } from '../../../../tools/hermes/card_client'
import { hasMarkup, hasUserinfo } from '../../../server-cards/claude-code/mod/hooks/card'
import { discover } from '../../../server-cards/claude-code/mod/hooks/discover'
import { formatOffered } from '../../../server-cards/claude-code/mod/hooks/format'
import { readOffered } from '../../../server-cards/claude-code/mod/hooks/offer'
import { search, searchEndpoint } from '../../claude-code/mod/hooks/registry'
import { originOf } from '../../claude-code/mod/hooks/urls'
export * from '../../../server-cards/claude-code/mod/hooks/card'
export * from '../../../server-cards/claude-code/mod/hooks/http'
export * from '../../../server-cards/claude-code/mod/hooks/sha256'
export * from '../../../server-cards/claude-code/mod/hooks/discover'
export * from '../../../server-cards/claude-code/mod/hooks/configure'
export * from '../../../server-cards/claude-code/mod/hooks/format'
export * from '../../../server-cards/claude-code/mod/hooks/offer'
export * from '../../../../tools/hermes/card_client'
export { search, searchEndpoint, originOf }
export const ARD_SOURCES = { catalogs: [{ url: '/.well-known/ard.json', requireVersion: false }], rels: ['ard'], by: 'ard-discovery (ARD v0.91 draft)' }
export const TOOLS = [...cardTools('ard_discover', 'ard_add_mcp_server', 'ard_remove_mcp_server', 'Also reads /.well-known/ard.json and rel="ard". '),
  { name: 'ard_search', description: 'Search a registry the person names. Sends the exact query to that third party only after Hermes approval. No default registry is shipped. Referrals and further registries are returned as next calls requiring their own approval; order is relevance, never trust.', parameters: { type: 'object', properties: {
    query: { type: 'string', maxLength: 300 }, registry: { type: 'string', description: 'Registry base URL or domain publishing registries. Defaults to ARD_DISCOVERY_REGISTRY when set.' }, referral: { type: 'boolean', description: 'Only for a complete referral endpoint returned by this session for this query; do not append /search.' }
  }, required: ['query'] } }]
export const INSTRUCTIONS = 'ARD v0.91 is a draft. Show discovery/search results and publisher confirmation. Registry relevance is not trust. Each ard_search goes through Hermes approval, including referrals. Add with ard_add_mcp_server, remove with ard_remove_mcp_server; these are separate from Server Cards tools. Never pass secret values.'
type SearchPlan = { query: string; endpoint: string; referral: boolean; additional: string[] }
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
export class ArdSession extends CardSession {
  readonly referrals = new Map<string, Set<string>>()
  async prepareSearch(a: Record<string, unknown>, defaultRegistry = ''): Promise<SearchPlan> {
    const query = typeof a.query === 'string' ? a.query.trim() : ''
    if (!query || query.length > 300 || UNSEEN.test(query) || /[`<>[\]]/.test(query)) throw new Error('Give a query of 1–300 plain characters, on one line, without markup or invisible characters. Nothing was sent.')
    const registry = (typeof a.registry === 'string' ? a.registry : defaultRegistry).trim()
    if (!registry) throw new Error('No registry was named or configured. Ask the person which registry to search. Nothing was sent.')
    if (registry.length > 200 || UNSEEN.test(registry) || /\s/.test(registry) || hasMarkup(registry) || hasUserinfo(registry)) throw new Error('The registry must be a plain URL or domain, at most 200 characters. Nothing was sent.')
    if (a.referral === true) {
      if (!this.referrals.get(query)?.has(registry)) throw new Error('This session has no such referral for this exact query.')
      return { query, endpoint: registry, referral: true, additional: [] }
    }
    let endpoints: string[] = []
    if (!/^https?:\/\//i.test(registry)) {
      const d = await discover(this.deps, registry, ARD_SOURCES)
      if (!('error' in d)) for (const r of d.registries) if (r.url) {
        const ep = searchEndpoint(r.url)
        if (typeof ep === 'string') endpoints.push(ep)
      }
    }
    if (!endpoints.length) {
      const ep = searchEndpoint(/^https?:\/\//i.test(registry) ? registry : `https://${registry}`)
      if (typeof ep !== 'string') throw new Error(ep.error)
      endpoints.push(ep)
    }
    endpoints = [...new Set(endpoints)].slice(0, 3)
    if (endpoints.some(ep => ep.length > 2048 || UNSEEN.test(ep) || hasMarkup(ep) || hasUserinfo(ep))) throw new Error('An endpoint cannot be shown literally. Nothing was sent.')
    return { query, endpoint: endpoints[0]!, referral: false, additional: endpoints.slice(1) }
  }
  async runSearch(p: SearchPlan) {
    const pending: string[] = []
    const s = await search(async (url, init) => {
      // The shared registry algorithm still validates, bounds, deduplicates and ranks.
      // Each further destination becomes a separately approved Hermes tool call.
      if (url !== p.endpoint) { pending.push(url); throw new Error('Separate Hermes approval is required; query not sent.') }
      const r = await this.deps.fetch(url, init)
      if (p.referral && r.ok) {
        try { const body = JSON.parse(r.text); delete body.referrals; return { ...r, text: JSON.stringify(body) } } catch {}
      }
      return r
    }, p.query, [p.endpoint])
    const permitted = pending.filter(ep => ep.length <= 200 && !UNSEEN.test(ep) && !hasMarkup(ep) && !hasUserinfo(ep))
    if (!p.referral) this.referrals.set(p.query, new Set(permitted))
    const r = await readOffered(this.deps, s.entries, ARD_SOURCES)
    for (const o of r.offered) { this.offered.delete(o.identifier); if (o.installCard) this.offered.set(o.identifier, o) }
    const lines = [`Registry search for "${p.query}". Query sent only to ${p.endpoint}. Ranking is relevance, not trust.`,
      ...s.registries.map(r => `${r.endpoint}: ${r.state}${r.note ? ` (${r.note})` : ''}`), ...s.problems,
      formatOffered(r, `the ARD registry at ${new URL(p.endpoint).host}`).replaceAll('call add_mcp_server with', 'call ard_add_mcp_server with')]
    if (permitted.length) lines.push('Referrals (not searched; each needs separate approval):', ...permitted.map(registry => JSON.stringify({ query: p.query, registry, referral: true })))
    if (p.additional.length) lines.push('Further catalog registries (not searched; each needs separate approval):', ...p.additional.map(ep => JSON.stringify({ query: p.query, registry: ep.replace(/\/search(?=\?|$)/, '') })))
    return { text: shownText(lines.join('\n')) }
  }
}
export function start() {
  useHermesHost()
  const sessions = new Map<string, ArdSession>()
  let registry = ''
  new Bridge(async (method, p) => {
    if (method === 'initialize') { registry = String(p.registry ?? ''); return { ok: true } }
    const key = String(p.session ?? '')
    if (!key) throw new Error('No calling session; refusing to share discovered cards across sessions.')
    if (!sessions.has(key)) sessions.set(key, new ArdSession(hermesDeps()))
    const s = sessions.get(key)!, a = (p.arguments ?? {}) as Record<string, unknown>
    if (method === 'discover') return s.discover(String(a.domain ?? ''), ARD_SOURCES, 'ard_add_mcp_server')
    if (method === 'prepare_add') return s.resolve(a, 'ard_discover')
    if (method === 'prepare_search') return s.prepareSearch(a, registry)
    if (method === 'search') return s.runSearch(p.plan as SearchPlan)
    if (method === 'probe_auth') return probeOAuth(p.plan as any)
    throw new Error(`Unknown method ${method}`)
  })
}
if (isMain(import.meta.url)) start()
