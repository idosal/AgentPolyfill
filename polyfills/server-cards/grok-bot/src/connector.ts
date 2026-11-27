// A Server Card, turned into what Grok Bot's *Add a custom connector* form asks for: a name, a
// Remote HTTPS URL, headers, and an OAuth client id. Grok Bot has no API to add a connector, so
// this is the most a polyfill can do: read the card, check it, and say exactly what to paste.
//
// The reading, checks and planning are the shared modules' (polyfills/server-cards/claude-code/
// mod/hooks): `discover` finds and validates cards, `planAdd` resolves a remote's variables and
// headers as it does for Claude Code. Here a planned secret (a `${MCP_…}` reference) becomes an
// instruction to type the value into the form, never a value this script knows.

import { plainText, type ServerCard } from '../../claude-code/mod/hooks/card'
import { isPrivateHost, mayFollow } from '../../claude-code/mod/hooks/discover'
import { planAdd, defaultName } from '../../claude-code/mod/hooks/configure'
import type { Fetch } from '../../claude-code/mod/hooks/http'

export type HeaderField = { name: string; value?: string; ask?: string; secret: boolean }
export type OAuthHint =
  | { kind: 'none' }
  | { kind: 'dynamic'; issuer: string }
  | { kind: 'needs-client-id'; issuer: string }
  | { kind: 'unknown'; why: string }

export type Connector =
  | { ok: true; name: string; url: string; transport: 'http' | 'sse'; headers: HeaderField[]; urlSecrets: string[]; notes: string[] }
  | { ok: false; missing?: { input: string; description?: string; choices?: string[] }[]; error?: string }

const REF = /\$\{([A-Z0-9_]+)\}/g

/** One remote of a card as connector fields. `values` fills inputs the card leaves open (not secrets). */
export function connectorFor(card: ServerCard, remoteIndex: number, values: Record<string, string> = {}, fromLocal = false): Connector {
  const r = planAdd(card, remoteIndex, values, defaultName(card), 'user', fromLocal)
  if ('error' in r) return { ok: false, error: r.error }
  if ('missing' in r) return { ok: false, missing: r.missing }
  const plan = r.plan
  const forOf = new Map(plan.envVars.map(v => [v.name, v]))
  const describe = (ref: string) => {
    const v = forOf.get(ref)
    return v ? `${v.for.replace(/^\{(.*)\}$/, "$1")}${v.description ? ` (${plainText(v.description)})` : ''}` : 'a secret value'
  }
  const headers: HeaderField[] = plan.headers.map(h => {
    const refs = [...h.value.matchAll(REF)].map(m => m[1]!)
    if (!refs.length) return { name: h.name, value: h.value, secret: false }
    // The value as the form wants it, with each secret part named, for the person to type.
    const ask = h.value.replace(REF, (_, ref: string) => `<${describe(ref)}>`)
    return { name: h.name, ask, secret: true }
  })
  const urlSecrets = [...plan.url.matchAll(REF)].map(m => describe(m[1]!))
  const notes: string[] = []
  if (plan.transport === 'sse') notes.push("This remote speaks the older HTTP+SSE transport. Grok Bot's Remote HTTPS connector is documented for HTTPS MCP servers; whether it speaks SSE is not documented, so it may not connect.")
  if (!plan.url.startsWith('https://')) notes.push('This URL is not https. Grok Bot calls remote connectors from Cursor\'s servers, which need a public https address.')
  else {
    try {
      if (isPrivateHost(new URL(plan.url.replace(REF, 'x')).hostname)) notes.push('This host is on a private network. Grok Bot calls remote connectors from Cursor\'s servers, so it has to be reachable from the internet (a private server needs your approval and may not work).')
    } catch {
      // planAdd already checked the URL
    }
  }
  return { ok: true, name: plan.name, url: plan.url, transport: plan.transport, headers, urlSecrets, notes }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether the server advertises OAuth (RFC 9728 protected resource metadata), and if so whether its
 * authorization server lets a client register itself (RFC 7591, a `registration_endpoint`). That is
 * the one thing the form's "OAuth client id" depends on: with dynamic registration it can be left
 * empty; without it, the provider has to issue one.
 */
export async function oauthHint(fetch: Fetch, url: string): Promise<OAuthHint> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'unknown', why: 'the URL is not complete yet' }
  }
  const local = isPrivateHost(u.hostname)
  const getJson = async (where: string): Promise<Record<string, unknown> | undefined> => {
    const w = new URL(where)
    if (!mayFollow(w, local)) return undefined
    const r = await fetch(w.href, { headers: { accept: 'application/json' } }).catch(() => undefined)
    if (!r?.ok) return undefined
    try {
      const j = JSON.parse(r.text)
      return isObject(j) ? j : undefined
    } catch {
      return undefined
    }
  }
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  const resource = (await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`)) ?? (path ? await getJson(`${u.origin}/.well-known/oauth-protected-resource`) : undefined)
  if (!resource) return { kind: 'none' }
  const servers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers.filter((s): s is string => typeof s === 'string') : []
  const issuer = servers[0]
  if (!issuer) return { kind: 'unknown', why: 'the server publishes OAuth metadata without an authorization server' }
  let iu: URL
  try {
    iu = new URL(issuer)
  } catch {
    return { kind: 'unknown', why: 'the server names an authorization server that is not a URL' }
  }
  const ipath = iu.pathname === '/' ? '' : iu.pathname.replace(/\/+$/, '')
  const meta =
    (await getJson(`${iu.origin}/.well-known/oauth-authorization-server${ipath}`)) ?? (await getJson(`${iu.origin}/.well-known/openid-configuration${ipath}`)) ?? (ipath ? await getJson(`${iu.origin}${ipath}/.well-known/openid-configuration`) : undefined)
  const shown = plainText(iu.origin + ipath)
  if (!meta) return { kind: 'unknown', why: `its authorization server (${shown}) publishes no metadata this script could read` }
  return typeof meta.registration_endpoint === 'string' ? { kind: 'dynamic', issuer: shown } : { kind: 'needs-client-id', issuer: shown }
}

/** What to paste, in plain words, for the person (or the Bot, to tell the person). */
export function pasteText(card: ServerCard, c: Extract<Connector, { ok: true }>, oauth: OAuthHint, cardFrom: string): string {
  const title = plainText(card.title ?? card.name)
  const lines = [
    `${title} (${plainText(card.name)} ${plainText(card.version)}), from ${plainText(cardFrom)}.`,
    '',
    'In Grok Bot: Connect apps → Add a custom connector → Remote HTTPS, then:',
    `  Name:  ${c.name}`,
    `  URL:   ${c.urlSecrets.length ? c.url.replace(REF, '<secret>') : c.url}`
  ]
  if (c.urlSecrets.length) lines.push(`         (the URL holds a secret: type ${c.urlSecrets.join(' and ')} in place of <secret> yourself)`)
  if (!c.headers.length) lines.push('  Headers: none')
  for (const h of c.headers) lines.push(h.secret ? `  Header: ${h.name} = ${h.ask}   ← type this value yourself; it is a secret` : `  Header: ${h.name} = ${h.value}`)
  if (oauth.kind === 'none') lines.push('  OAuth client id: leave empty (the server advertises no OAuth; it authenticates by the headers above, if at all)')
  else if (oauth.kind === 'dynamic') lines.push(`  OAuth client id: leave empty. The server signs in with OAuth through ${oauth.issuer}, which lets clients register themselves; Grok Bot should ask you to sign in when it connects.`)
  else if (oauth.kind === 'needs-client-id') lines.push(`  OAuth client id (and secret): needed. The server signs in with OAuth through ${oauth.issuer}, which does not let clients register themselves: create an OAuth app with that provider and paste its client id (and secret) here.`)
  else lines.push(`  OAuth client id: could not tell (${oauth.why}). Try leaving it empty first.`)
  for (const n of c.notes) lines.push('', `Note: ${n}`)
  lines.push('', 'Or ask a Bot: "Add the app at <URL>", and give it the headers when it asks. Never paste a secret into a chat.')
  return lines.join('\n')
}
