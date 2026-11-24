// Turning a Server Card remote into a Claude Code MCP server entry
// (discovery.md step 4: "Use the Server Card metadata to configure and
// establish an MCP connection"). Inputs follow schema.ts `Input` /
// `KeyValueInput`: a pre-set `value` is not configurable, `choices` limit the
// value, `default` fills an unset one, `isSecret` values "should be handled
// securely". Here a secret never passes through the model or the command
// line: the config holds a ${ENV_VAR} reference for the person to set.
//
// Claude Code expands ${VAR} in a server's url and headers, and that is the
// one thing to guard here: nothing a card or the model supplies may contain
// `$`, a secret reference is named for this card alone, and a secret may not
// stand where it could change which host is reached.

import { hasUserinfo, PLAIN_URL, UNSAFE_TEXT, type Input, type Remote, type ServerCard } from './card'
import { isAllowedUrl, isPrivateHost } from './discover'
import { base32, sha256 } from './sha256'

/**
 * Protocol revisions Claude Code 2.1.329 can negotiate: 2026-07-28 on its v2
 * runtime with fallback to the older ones (code.claude.com/docs/en/mcp and
 * CHANGELOG, read 2026-11-24). Only used to skip a remote that lists none of them.
 */
export const HOST_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

/**
 * The host a server is added to: its name in what is shown, and the protocol
 * revisions it can negotiate. Claude Code by default. Another host's build of
 * these modules (the Codex form, polyfills/codex/server-cards) sets both once,
 * at start.
 */
export const host: { name: string; protocolVersions: readonly string[] } = {
  name: 'Claude Code',
  protocolVersions: HOST_PROTOCOL_VERSIONS,
}

export type Scope = 'local' | 'project' | 'user'

export type Plan = {
  name: string
  url: string
  transport: 'http' | 'sse'
  headers: { name: string; value: string }[]
  /** ${VAR} references written into the config, for the person to set */
  envVars: { name: string; for: string; description?: string }[]
  argv: string[]
  /** the same command, quoted for a POSIX shell, for the person to run by hand */
  command: string
}

export type PlanResult =
  | { plan: Plan }
  | { missing: { input: string; description?: string; choices?: string[] }[] }
  | { error: string }

const MAX_URL = 2048

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

export const defaultName = (card: ServerCard) =>
  slug(card.title ?? '') || slug(card.name.split('/')[1] ?? card.name) || 'mcp-server'

const shellQuote = (a: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

export const isCompatible = (remote: Remote) =>
  !remote.supportedProtocolVersions?.length ||
  remote.supportedProtocolVersions.some(v => host.protocolVersions.includes(v))

// RFC 9110 field-name (token); a value may hold no control character or
// invisible formatting mark (card.ts UNSAFE_TEXT), CR and LF among them.
const HEADER_NAME = /^[!#%&'*+.^_`|~0-9A-Za-z-]+$/
const BAD_VALUE = UNSAFE_TEXT
// A value put into the URL after its start may hold only unreserved
// characters (RFC 3986), so it cannot change the host, path, query or fragment.
const URL_VALUE = /^[A-Za-z0-9._~-]+$/
const VAR = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

/**
 * 80 bits of SHA-256 over the card's name and the remote's URL, in base32: a tag
 * that ties a secret's name to one card. Both inputs are the card author's to
 * choose, so the tag has to resist a second preimage (security review SC3: a
 * 32-bit FNV tag was matched in a minute).
 */
export const tag = (s: string) => base32(sha256(s), 80)

/**
 * MCP_<SERVER>__<INPUT>_<TAG>: another card, even one added under the same
 * server name, never gets a reference to this one's secret; only a card with
 * the same name and the same URL, which sends it to the same server, does.
 */
const envName = (server: string, input: string, card: ServerCard, remote: Remote) =>
  `MCP_${server.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}__${input.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${tag(`${card.name}\n${remote.url}`)}`

const checkValue = (label: string, input: Input, value: string): string | undefined => {
  if (input.choices?.length && !input.choices.includes(value))
    return `${label} must be one of: ${input.choices.join(', ')}`
  if (input.format === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return `${label} must be a number`
  if (input.format === 'boolean' && value !== 'true' && value !== 'false')
    return `${label} must be "true" or "false"`
  if (BAD_VALUE.test(value)) return `${label} may not hold a control character or an invisible formatting mark`
  return undefined
}

/** Where the authority (host) of a URL template ends: the first "/", "?" or "#" after "://". */
const authorityEnd = (template: string) => {
  const scheme = template.indexOf('://')
  if (scheme < 0) return 0
  const rest = template.slice(scheme + 3).search(/[/?#]/)
  return rest < 0 ? template.length : scheme + 3 + rest
}

export const planAdd = (
  card: ServerCard,
  remoteIndex: number,
  values: Record<string, string>,
  name: string | undefined,
  scope: Scope,
  /** the card came from this machine or its network (local development) */
  fromLocal = false,
): PlanResult => {
  const remote = card.remotes?.[remoteIndex]
  if (!remote) return { error: `The card has no remote #${remoteIndex}.` }
  if (!isCompatible(remote))
    return {
      error: `Remote #${remoteIndex} supports only protocol ${remote.supportedProtocolVersions!.join(', ')}, none of which ${host.name} speaks.`,
    }
  const server = name ? slug(name) : defaultName(card)
  if (!server) return { error: 'The server name has no letters or digits.' }

  const missing: { input: string; description?: string; choices?: string[] }[] = []
  const envVars: Plan['envVars'] = []
  const problems: string[] = []

  const noDollar = (label: string, v: string) => {
    if (v.includes('$')) problems.push(`${label} may not contain "$"`)
    return v
  }
  const secretRef = (key: string, label: string, input: Input) => {
    const v = envName(server, key, card, remote)
    if (!envVars.some(e => e.name === v)) envVars.push({ name: v, for: label, description: input.description })
    return `\${${v}}`
  }

  // One variable's value: pre-set, supplied, default, or a ${VAR} for a secret.
  const valueOf = (key: string, label: string, input: Input): string | undefined => {
    if (input.isSecret && input.value !== undefined) {
      // A card MUST NOT include credentials (discovery.md, Information Disclosure).
      problems.push(`the card sets a value for the secret ${label}; cards may not carry credentials`)
      return undefined
    }
    if (input.value !== undefined) return noDollar(label, input.value)
    if (input.isSecret) return secretRef(key, label, input)
    const given = values[key] ?? input.default
    if (given === undefined) {
      if (input.isRequired) missing.push({ input: key, description: input.description, choices: input.choices })
      return undefined
    }
    const bad = checkValue(label, input, given)
    if (bad) problems.push(bad)
    return noDollar(label, given)
  }

  // The URL: a variable at the start is a base URL; any other holds unreserved
  // characters only; a secret may not stand in the host part.
  const hostEnd = authorityEnd(remote.url)
  const url = noDollar('the URL', remote.url).replace(VAR, (whole, key: string, at: number) => {
    const input = remote.variables?.[key]
    if (!input) {
      problems.push(`the URL uses {${key}}, which the card does not define`)
      return whole
    }
    if (input.isSecret && at < hostEnd) {
      problems.push(`the secret {${key}} stands in the URL's host part, where its value would decide which server is reached`)
      return whole
    }
    const v = valueOf(key, `{${key}}`, input)
    if (v === undefined) return whole
    if (!input.isSecret) {
      if (at === 0) {
        if (!PLAIN_URL.test(v)) problems.push(`{${key}} must be a URL, in printable ASCII without \`, <, >, a backslash or square brackets (but an IPv6 host's)`)
      } else if (!URL_VALUE.test(v) || /^\.+$/.test(v))
        problems.push(`{${key}} may hold only letters, digits and . _ ~ - (and not be "." or "..")`)
    }
    return v
  })

  const headers: Plan['headers'] = []
  for (const h of remote.headers ?? []) {
    noDollar(`the header name ${h.name}`, h.name)
    if (h.value !== undefined) {
      // A pre-set header value is a template over the header's variables. For a
      // secret header, the secret has to come from a secret variable.
      const vars = [...h.value.matchAll(VAR)].map(m => m[1]!)
      if (h.isSecret && !vars.some(k => (h.variables?.[k] ?? remote.variables?.[k])?.isSecret)) {
        problems.push(`the card sets a value for the secret header ${h.name}; cards may not carry credentials`)
        continue
      }
      const v = noDollar(`header ${h.name}`, h.value).replace(VAR, (whole, key: string) => {
        const input = h.variables?.[key] ?? remote.variables?.[key]
        if (!input) {
          problems.push(`header ${h.name} uses {${key}}, which the card does not define`)
          return whole
        }
        return valueOf(key, `{${key}}`, input) ?? whole
      })
      headers.push({ name: h.name, value: v })
      continue
    }
    const v = valueOf(h.name, `header ${h.name}`, h)
    if (v !== undefined) headers.push({ name: h.name, value: v })
  }

  for (const h of headers) {
    if (!HEADER_NAME.test(h.name)) problems.push(`the card's header name "${h.name}" is not a valid HTTP field name`)
    if (BAD_VALUE.test(h.value)) problems.push(`the value for header ${h.name} holds a control character or an invisible formatting mark`)
  }
  if (problems.length) return { error: problems.join('; ') }
  if (missing.length) return { missing }

  if (url.length > MAX_URL) return { error: `The URL is longer than ${MAX_URL} characters.` }
  // What is shown is what is added: printable ASCII, and no markup that a
  // host could render as a link text in place of the URL (card.ts hasMarkup).
  if (!/^[\x21-\x7e]+$/.test(url)) return { error: 'The URL holds a space, a control character or a non-ASCII character.' }
  if (!PLAIN_URL.test(url)) return { error: 'The URL holds `, <, >, a backslash or a square bracket outside an IPv6 host, which could show as something else.' }
  const probe = url.replace(/\$\{[A-Z0-9_]+\}/g, 'x')
  // A user before the host shows one host and connects to another (security review C3).
  if (hasUserinfo(probe)) return { error: `${url}: the URL names a user before its host (an "@"), so it would show one host and connect to another.` }
  let parsed: URL
  try {
    parsed = new URL(probe)
  } catch {
    return { error: `The URL "${url}" is not valid after filling in its variables.` }
  }
  // The path as written must be the path that is reached: no "." or ".."
  // segments for URL normalisation to fold away.
  const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(probe)?.[1] ?? ''
  if (rawPath.split('/').some(seg => seg === '.' || seg === '..' || /^%2e(%2e)?$/i.test(seg) || seg === '.%2e' || seg === '%2e.'))
    return { error: `${url}: the URL's path holds a "." or ".." segment.` }
  if (!isAllowedUrl(parsed)) return { error: `${url}: the remote is not HTTPS.` }
  // A card on the public web MUST NOT name private endpoints (discovery.md,
  // Information Disclosure); one that does is not added.
  if (!fromLocal && isPrivateHost(parsed.hostname))
    return { error: `${url}: a card from a public source may not point at a local or private address.` }

  const transport = remote.type === 'sse' ? 'sse' : 'http'
  const argv = ['claude', 'mcp', 'add', '--transport', transport, '--scope', scope, server, url]
  for (const h of headers) argv.push('--header', `${h.name}: ${h.value}`)
  return { plan: { name: server, url, transport, headers, envVars, argv, command: argv.map(shellQuote).join(' ') } }
}

/** The host a URL connects to (as Node's URL parser reads it), for display on its own; empty if it can't be read. */
export const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/\$\{[A-Z0-9_]+\}/g, 'x')).host
  } catch {
    return ''
  }
}

/** The URL a remote connects to with its defaults, for display; the template if inputs are missing. */
export const previewUrl = (card: ServerCard, remoteIndex: number, fromLocal = false): string => {
  const r = planAdd(card, remoteIndex, {}, undefined, 'local', fromLocal)
  return 'plan' in r ? r.plan.url : (card.remotes?.[remoteIndex]?.url ?? '')
}
