// Which URLs this plugin may itself reach: registry endpoints and their
// referrals. (Catalogs and cards are read by mcp-server-cards, under its own
// rules.) The same address rules: HTTPS, plain HTTP only for loopback, and no
// step from a public source to a local or private address.

const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')

export const isLoopback = (host: string) => {
  const h = bare(host)
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1'
}

/** Loopback, private, shared, link-local and unique-local addresses, local names, single labels. */
export const isPrivateHost = (host: string): boolean => {
  const h = bare(host)
  if (!h) return true
  if (isLoopback(h)) return true
  if (/\.(local|internal|localhost|home\.arpa|lan)$/.test(h)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    )
  }
  if (h.includes(':'))
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:')
  return !h.includes('.')
}

export const isAllowedUrl = (u: URL) =>
  u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname))

export const mayFollow = (u: URL, fromLocal: boolean) =>
  isAllowedUrl(u) && (fromLocal || !isPrivateHost(u.hostname))

/** A domain or URL as typed, to its origin; HTTPS, or HTTP for loopback. */
export const originOf = (input: string): { origin: string; host: string } | { error: string } => {
  const raw = input.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: `"${raw}" is not a domain or URL.` }
  }
  if (!isAllowedUrl(u)) return { error: `${u.origin}: HTTPS only (plain HTTP only for localhost).` }
  return { origin: u.origin, host: u.host }
}
