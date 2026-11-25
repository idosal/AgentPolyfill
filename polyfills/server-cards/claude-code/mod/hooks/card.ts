// Server Card validation, written against ext-server-card schema.ts / schema.json
// at commit 28db12c9b4 (2026-11-19). The schema is the source of truth; every
// check below names the schema rule it enforces. A card that fails any check is
// refused, not repaired (polyfill contract rule 1).

export const CARD_TYPE = 'application/mcp-server-card+json'
export const CARD_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'

export type Input = {
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  format?: 'string' | 'number' | 'boolean' | 'filepath'
  default?: string
  placeholder?: string
  value?: string
  choices?: string[]
}

export type KeyValueInput = Input & {
  name: string
  variables?: Record<string, Input>
}

export type Remote = {
  type: 'streamable-http' | 'sse'
  url: string
  headers?: KeyValueInput[]
  variables?: Record<string, Input>
  supportedProtocolVersions?: string[]
  extensionsInfo?: Record<string, Record<string, unknown>>
}

export type ServerCard = {
  $schema: string
  name: string
  version: string
  description: string
  title?: string
  websiteUrl?: string
  repository?: { url: string; source: string; subfolder?: string; id?: string }
  icons?: { src: string; mimeType?: string; sizes?: string[]; theme?: 'dark' | 'light' }[]
  remotes?: Remote[]
  _meta?: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether text holds `, <, > or a square bracket outside the brackets of an
 * IPv6 host (`https://[::1]:8080/`). In a URL they are Markdown or HTML: a
 * host that renders either would show the reader a link text in place of the
 * URL (`https://evil.example/x/[https://good.example/mcp](https://evil.example/)`).
 * RFC 3986 allows square brackets only around an IP literal anyway.
 */
export const hasMarkup = (s: string) => /[`<>[\]]/.test(s.replace(/^([a-z][a-z0-9+.-]*:\/\/)\[[0-9a-f:.]+\]/i, '$1'))

/**
 * Whether a URL names a user before its host: an `@` in its authority, or a
 * user name or password as a URL parser reads it. `https://good.example@evil.example/`
 * reads as one host and connects to the other (security review C3).
 */
export const hasUserinfo = (s: string) => {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*@/i.test(s)) return true
  try {
    const u = new URL(s)
    return !!(u.username || u.password)
  } catch {
    return false
  }
}

// JSON Schema `format: uri`: an absolute URI as written. WHATWG URL parsing
// repairs strings (spaces, backslashes), so check the characters first.
const isUri = (v: unknown): boolean => {
  if (typeof v !== 'string' || !/^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]*$/.test(v) || /%(?![0-9a-fA-F]{2})/.test(v) || hasMarkup(v) || hasUserinfo(v))
    return false
  try {
    new URL(v)
    return true
  } catch {
    return false
  }
}

/** Length as JSON Schema counts it: Unicode code points, not UTF-16 units. */
const length = (s: string) => [...s].length

/**
 * Characters no card text may hold: C0 controls, DEL, C1 controls, and the
 * invisible format and bidirectional marks. Any of them could make a terminal
 * or a page show one thing while another is meant (an ESC sequence that
 * rewrites a line, an OSC 8 link, a right-to-left override), and none has a
 * place in a name, a description or a URL.
 */
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

/**
 * Characters that show as nothing, beyond UNSAFE_TEXT: line and paragraph
 * separators, interlinear annotation marks, and every default-ignorable code
 * point (Unicode's Default_Ignorable_Code_Point: a soft hyphen, variation
 * selectors, plane 14's tag characters, which can carry text nobody sees, and
 * the rest). Taken out of anything shown; a card holding one is not refused for
 * it (an emoji's variation selector is one). The same set as ard-discovery's
 * HIDDEN, less UNSAFE_TEXT's controls.
 */
export const INVISIBLE_TEXT = /[\u2028\u2029\ufff9-\ufffb\p{Default_Ignorable_Code_Point}]/u

/** Text with every UNSAFE_TEXT and INVISIBLE_TEXT character removed: for anything shown. */
export const plainText = (s: unknown) =>
  String(s ?? '').replace(new RegExp(UNSAFE_TEXT.source, 'g'), '').replace(new RegExp(INVISIBLE_TEXT.source, 'gu'), '')

const NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/
// The schema's pattern, narrowed to printable ASCII without markup: a remote
// URL is what the person sees and what is added, so it holds no space,
// control, non-ASCII, `, <, >, or square bracket outside an IPv6 host; and no
// backslash, which a URL parser reads as "/" (so `https://evil.example\@good.example/`
// connects to evil.example; security review C3).
const URL_CHAR = '[\\x21-\\x3b\\x3d\\x3f-\\x5a\\x5e\\x5f\\x61-\\x7e]'
const IPV6_HOST = '\\[[0-9A-Fa-f:.]+\\]'
/** An http(s) URL that shows as itself: printable ASCII, and no markup (see hasMarkup). */
export const PLAIN_URL = new RegExp(`^https?://(?:${IPV6_HOST}${URL_CHAR}*|${URL_CHAR}+)$`)
const REMOTE_URL = new RegExp(`^(?:https?://(?:${IPV6_HOST}${URL_CHAR}*|${URL_CHAR}+)|\\{[a-zA-Z_][a-zA-Z0-9_]*\\}${URL_CHAR}*)$`)

/** The path of the first string, key or value, that holds an UNSAFE_TEXT character. */
const unsafeAt = (v: unknown, path: string): string | undefined => {
  if (typeof v === 'string') return UNSAFE_TEXT.test(v) ? path : undefined
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const at = unsafeAt(v[i], `${path}[${i}]`)
      if (at) return at
    }
    return undefined
  }
  if (typeof v === 'object' && v !== null)
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE_TEXT.test(k)) return `${path} (a key)`
      const at = unsafeAt(x, path ? `${path}.${k}` : k)
      if (at) return at
    }
  return undefined
}
// schema.ts, ServerCard.version: "Version ranges are rejected (e.g., '^1.2.3',
// '~1.2.3', '>=1.2.3', '1.x', '1.*')". schema.json does not encode this rule;
// schema.ts is the stated source of truth, so it is enforced here.
const VERSION_RANGE = /^[\^~<>=]|(^|\.)(x|X|\*)(\.|$)|\s-\s|\|\|/
// _meta key rules (MetaObject): an optional prefix (labels separated by dots,
// then a slash) and a name that, unless empty, starts and ends with an
// alphanumeric. extensionsInfo keys follow them "with a mandatory prefix".
const LABEL = '[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?'
const NAME_PART = '(?:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?'
const PREFIXED_KEY = new RegExp(`^${LABEL}(?:\\.${LABEL})*/${NAME_PART}$`)
const META_KEY = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*/)?${NAME_PART}$`)

const INPUT_FORMATS = ['string', 'number', 'boolean', 'filepath']

const checkString = (
  errors: string[],
  where: string,
  v: unknown,
  opts: { required?: boolean; min?: number; max?: number } = {},
) => {
  if (v === undefined) {
    if (opts.required) errors.push(`${where} is required`)
    return
  }
  if (typeof v !== 'string') return void errors.push(`${where} must be a string`)
  if (opts.min !== undefined && length(v) < opts.min)
    errors.push(`${where} must be at least ${opts.min} characters`)
  if (opts.max !== undefined && length(v) > opts.max)
    errors.push(`${where} must be at most ${opts.max} characters`)
}

const checkInput = (errors: string[], where: string, v: unknown) => {
  if (!isObject(v)) return void errors.push(`${where} must be an object`)
  for (const k of ['description', 'default', 'placeholder', 'value'] as const)
    checkString(errors, `${where}.${k}`, v[k])
  for (const k of ['isRequired', 'isSecret'] as const)
    if (v[k] !== undefined && typeof v[k] !== 'boolean')
      errors.push(`${where}.${k} must be a boolean`)
  if (v.format !== undefined && !INPUT_FORMATS.includes(v.format as string))
    errors.push(`${where}.format must be one of ${INPUT_FORMATS.join(', ')}`)
  if (v.choices !== undefined) {
    if (!Array.isArray(v.choices) || v.choices.some(c => typeof c !== 'string'))
      errors.push(`${where}.choices must be an array of strings`)
  }
}

const checkInputMap = (errors: string[], where: string, v: unknown) => {
  if (v === undefined) return
  if (!isObject(v)) return void errors.push(`${where} must be an object`)
  for (const [k, input] of Object.entries(v)) checkInput(errors, `${where}.${k}`, input)
}

// schema.ts JSONValue: string, number, boolean, null, object, array. (The
// generated schema.json leaves out null and non-integer numbers; schema.ts is
// the source of truth.)
const isJsonValue = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every(isJsonValue)) ||
  (isObject(v) && Object.values(v).every(isJsonValue))

const checkRemote = (errors: string[], where: string, v: unknown) => {
  if (!isObject(v)) return void errors.push(`${where} must be an object`)
  if (v.type !== 'streamable-http' && v.type !== 'sse')
    errors.push(`${where}.type must be "streamable-http" or "sse"`)
  if (typeof v.url !== 'string' || !REMOTE_URL.test(v.url))
    errors.push(`${where}.url must be printable ASCII without \`, <, >, a backslash or square brackets (but an IPv6 host's), starting with http://, https:// or a {variable}`)
  else if (hasUserinfo(String(v.url)))
    errors.push(`${where}.url names a user before its host (an "@" in it), so it would show one host and connect to another`)
  if (v.headers !== undefined) {
    if (!Array.isArray(v.headers)) errors.push(`${where}.headers must be an array`)
    else
      v.headers.forEach((h, i) => {
        checkInput(errors, `${where}.headers[${i}]`, h)
        if (isObject(h)) {
          checkString(errors, `${where}.headers[${i}].name`, h.name, { required: true })
          checkInputMap(errors, `${where}.headers[${i}].variables`, h.variables)
        }
      })
  }
  checkInputMap(errors, `${where}.variables`, v.variables)
  if (v.supportedProtocolVersions !== undefined) {
    const p = v.supportedProtocolVersions
    if (!Array.isArray(p) || p.some(x => typeof x !== 'string'))
      errors.push(`${where}.supportedProtocolVersions must be an array of strings`)
  }
  if (v.extensionsInfo !== undefined) {
    if (!isObject(v.extensionsInfo)) errors.push(`${where}.extensionsInfo must be an object`)
    else
      for (const [k, info] of Object.entries(v.extensionsInfo)) {
        if (!PREFIXED_KEY.test(k))
          errors.push(`${where}.extensionsInfo key "${k}" must be a prefixed _meta-style key`)
        if (!isObject(info) || !isJsonValue(info))
          errors.push(`${where}.extensionsInfo["${k}"] must be a JSON object`)
      }
  }
}

/** Returns the list of schema violations; empty means the card is valid. */
export const validateCard = (card: unknown): string[] => {
  const errors: string[] = []
  if (!isObject(card)) return ['the Server Card is not a JSON object']
  const unsafe = unsafeAt(card, '')
  if (unsafe) errors.push(`${unsafe || 'a key'} holds a control character or an invisible formatting mark`)
  if (card.$schema === undefined) errors.push('$schema is required')
  else if (card.$schema !== CARD_SCHEMA_URL)
    errors.push(`$schema must be ${CARD_SCHEMA_URL} (got ${JSON.stringify(card.$schema)})`)
  checkString(errors, 'name', card.name, { required: true, min: 3, max: 200 })
  if (typeof card.name === 'string' && !NAME.test(card.name))
    errors.push('name must be reverse-DNS with exactly one "/" (e.g. com.example/weather)')
  checkString(errors, 'version', card.version, { required: true, max: 255 })
  if (typeof card.version === 'string' && VERSION_RANGE.test(card.version.trim()))
    errors.push(`version must be one version, not a range (got "${card.version}")`)
  checkString(errors, 'description', card.description, { required: true, min: 1, max: 100 })
  checkString(errors, 'title', card.title, { min: 1, max: 100 })
  if (card.websiteUrl !== undefined && !isUri(card.websiteUrl))
    errors.push('websiteUrl must be a URI')
  if (card.repository !== undefined) {
    const r = card.repository
    if (!isObject(r)) errors.push('repository must be an object')
    else {
      if (!isUri(r.url)) errors.push('repository.url must be a URI')
      checkString(errors, 'repository.source', r.source, { required: true })
      checkString(errors, 'repository.subfolder', r.subfolder)
      checkString(errors, 'repository.id', r.id)
    }
  }
  if (card.icons !== undefined) {
    if (!Array.isArray(card.icons)) errors.push('icons must be an array')
    else
      card.icons.forEach((icon, i) => {
        if (!isObject(icon) || !isUri(icon.src)) return void errors.push(`icons[${i}].src must be a URI`)
        if (icon.theme !== undefined && icon.theme !== 'dark' && icon.theme !== 'light')
          errors.push(`icons[${i}].theme must be "dark" or "light"`)
        checkString(errors, `icons[${i}].mimeType`, icon.mimeType)
        if (icon.sizes !== undefined && (!Array.isArray(icon.sizes) || icon.sizes.some(x => typeof x !== 'string')))
          errors.push(`icons[${i}].sizes must be an array of strings`)
      })
  }
  if (card.remotes !== undefined) {
    if (!Array.isArray(card.remotes)) errors.push('remotes must be an array')
    else card.remotes.forEach((r, i) => checkRemote(errors, `remotes[${i}]`, r))
  }
  if (card._meta !== undefined) {
    if (!isObject(card._meta)) errors.push('_meta must be an object')
    else
      for (const k of Object.keys(card._meta))
        if (!META_KEY.test(k)) errors.push(`_meta key "${k}" does not follow the _meta key rules`)
  }
  return errors
}
