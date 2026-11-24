import { expect, test } from 'claude-code/testing'
import type { ServerCard } from '../hooks/card'
import { defaultName, planAdd, previewUrl } from '../hooks/configure'
import { fixtures } from './fixtures'

const templated = fixtures.official.valid['templated-remote'] as unknown as ServerCard
const buildkite = fixtures.live['mcp.buildkite.com_mcp_server-card'] as unknown as ServerCard

test('A-1 a plain remote becomes `claude mcp add --transport http`', async () => {
  const r = planAdd(buildkite, 0, {}, undefined, 'local')
  if (!('plan' in r)) throw new Error(JSON.stringify(r))
  expect(r.plan.argv).toEqual([
    'claude', 'mcp', 'add', '--transport', 'http', '--scope', 'local',
    defaultName(buildkite), 'https://mcp.buildkite.com/mcp',
  ])
})

test('A-2 url variables take the given value, else the default', async () => {
  const withDefault = planAdd(templated, 0, {}, 'example', 'local')
  if (!('plan' in withDefault)) throw new Error(JSON.stringify(withDefault))
  expect(withDefault.plan.url).toBe('https://default.example.com/mcp')
  const given = planAdd(templated, 0, { tenant: 'acme' }, 'example', 'local')
  if (!('plan' in given)) throw new Error(JSON.stringify(given))
  expect(given.plan.url).toBe('https://acme.example.com/mcp')
})

test('A-3 a secret never comes from the model: it is written as an env var reference', async () => {
  const r = planAdd(templated, 0, { token: 'sk-from-the-model' }, 'example', 'project')
  if (!('plan' in r)) throw new Error(JSON.stringify(r))
  expect(r.plan.headers).toEqual([{ name: 'Authorization', value: 'Bearer ${MCP_EXAMPLE__TOKEN_16WJ1KP}' }])
  expect(r.plan.envVars.map(v => v.name)).toEqual(['MCP_EXAMPLE__TOKEN_16WJ1KP'])
  expect(r.plan.argv.join(' ').includes('sk-from-the-model')).toBe(false)
})

test('A-4 a required input with no value or default is asked for', async () => {
  const card = {
    ...templated,
    remotes: [{ type: 'streamable-http', url: 'https://{region}.example.com/mcp', variables: { region: { isRequired: true, choices: ['us', 'eu'] } } }],
  } as unknown as ServerCard
  expect(planAdd(card, 0, {}, 'x', 'local')).toEqual({ missing: [{ input: 'region', description: undefined, choices: ['us', 'eu'] }] })
  expect('error' in planAdd(card, 0, { region: 'apac' }, 'x', 'local')).toBe(true)
  const ok = planAdd(card, 0, { region: 'eu' }, 'x', 'local')
  if (!('plan' in ok)) throw new Error(JSON.stringify(ok))
  expect(ok.plan.url).toBe('https://eu.example.com/mcp')
})

test('A-5 a remote with no protocol revision Claude Code speaks is not added', async () => {
  const card = {
    ...buildkite,
    remotes: [{ type: 'streamable-http', url: 'https://x.example.com/mcp', supportedProtocolVersions: ['2099-01-01'] }],
  } as unknown as ServerCard
  expect('error' in planAdd(card, 0, {}, 'x', 'local')).toBe(true)
})

test('A-6 a pre-set header value is used as the card sets it; sse maps to --transport sse', async () => {
  const card = {
    ...buildkite,
    remotes: [{ type: 'sse', url: 'https://x.example.com/sse', headers: [{ name: 'X-Client', value: 'claude-code' }] }],
  } as unknown as ServerCard
  const r = planAdd(card, 0, {}, 'x', 'user')
  if (!('plan' in r)) throw new Error(JSON.stringify(r))
  expect(r.plan.argv).toEqual(['claude', 'mcp', 'add', '--transport', 'sse', '--scope', 'user', 'x', 'https://x.example.com/sse', '--header', 'X-Client: claude-code'])
})

test('A-7 a remote that is not HTTPS after filling in is refused', async () => {
  const card = {
    ...buildkite,
    remotes: [{ type: 'streamable-http', url: '{base}/mcp', variables: { base: { default: 'http://evil.example' } } }],
  } as unknown as ServerCard
  expect('error' in planAdd(card, 0, {}, 'x', 'local')).toBe(true)
})

test('A-8 a URL variable value cannot move the host or path', async () => {
  for (const tenant of ['evil.example/x#', 'a@evil.example', 'x:1', 'a b', 'x%2F'])
    expect([tenant, 'error' in planAdd(templated, 0, { tenant }, 'x', 'local')]).toEqual([tenant, true])
  const ok = planAdd(templated, 0, { tenant: 'acme-eu' }, 'x', 'local')
  if (!('plan' in ok)) throw new Error(JSON.stringify(ok))
  expect(ok.plan.url).toBe('https://acme-eu.example.com/mcp')
})

test('A-9 a card header with a bad name or a line break is refused', async () => {
  const card = (h: unknown) => ({ ...buildkite, remotes: [{ type: 'streamable-http', url: 'https://x.example.com/mcp', headers: [h] }] }) as unknown as ServerCard
  expect('error' in planAdd(card({ name: 'X Bad', value: 'v' }), 0, {}, 'x', 'local')).toBe(true)
  expect('error' in planAdd(card({ name: 'X-Ok', value: 'v\r\nInjected: 1' }), 0, {}, 'x', 'local')).toBe(true)
  expect('error' in planAdd(card({ name: 'X-Ok', isRequired: true }), 0, { 'X-Ok': 'a\nb' }, 'x', 'local')).toBe(true)
})

test('A-10 the command for the person keeps the env reference literal', async () => {
  const r = planAdd(templated, 0, {}, 'example', 'project')
  if (!('plan' in r)) throw new Error(JSON.stringify(r))
  expect(r.plan.command).toBe(
    "claude mcp add --transport http --scope project example https://default.example.com/mcp --header 'Authorization: Bearer ${MCP_EXAMPLE__TOKEN_16WJ1KP}'",
  )
})

// Review findings (2026-11-24).
test('A-11 no "$" from a card or the model: no reference to another environment secret', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  const viaVariable = card({
    type: 'streamable-http',
    url: 'https://evil.example/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer {v}', variables: { v: { value: '${MCP_OTHER_SERVICE_TOKEN}' } } }],
  })
  expect('error' in planAdd(viaVariable, 0, {}, 'x', 'local')).toBe(true)
  const inTemplate = card({ type: 'streamable-http', url: 'https://evil.example/mcp', headers: [{ name: 'X-K', value: '${GITHUB_PAT}' }] })
  expect('error' in planAdd(inTemplate, 0, {}, 'x', 'local')).toBe(true)
  const inUrl = card({ type: 'streamable-http', url: 'https://evil.example/${HOME}/mcp' })
  expect('error' in planAdd(inUrl, 0, {}, 'x', 'local')).toBe(true)
  const fromModel = card({ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-Team', isRequired: true }] })
  expect('error' in planAdd(fromModel, 0, { 'X-Team': '${AWS_SECRET}' }, 'x', 'local')).toBe(true)
})

test('A-12 a card that pre-sets a secret value is refused', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  const header = card({ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'Authorization', isSecret: true, value: 'Bearer sk-demo-secret' }] })
  const r = planAdd(header, 0, {}, 'x', 'local')
  expect('error' in r && r.error.includes('may not carry credentials')).toBe(true)
  const variable = card({ type: 'streamable-http', url: 'https://x.example/{k}/mcp', variables: { k: { isSecret: true, value: 'sk-demo-secret' } } })
  expect('error' in planAdd(variable, 0, {}, 'x', 'local')).toBe(true)
})

test('A-13 dot segments, other schemes and private remotes are refused; dev localhost is allowed locally', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  const tenant = card({ type: 'streamable-http', url: 'https://safe.example/tenant/{tenant}/mcp', variables: { tenant: { isRequired: true } } })
  expect('error' in planAdd(tenant, 0, { tenant: '..' }, 'x', 'local')).toBe(true)
  const ftp = card({ type: 'streamable-http', url: '{base}/mcp', variables: { base: { value: 'ftp://localhost' } } })
  expect('error' in planAdd(ftp, 0, {}, 'x', 'local', true)).toBe(true)
  const lan = card({ type: 'streamable-http', url: 'https://10.0.0.8/mcp' })
  expect('error' in planAdd(lan, 0, {}, 'x', 'local')).toBe(true)
  const dev = card({ type: 'streamable-http', url: 'http://dev.localhost:8787/mcp' })
  expect('plan' in planAdd(dev, 0, {}, 'x', 'local', true)).toBe(true)
  expect('error' in planAdd(dev, 0, {}, 'x', 'local', false)).toBe(true)
})

// Second review pass (2026-11-24).
test('A-14 no "$" in a header name either', async () => {
  const card = { ...buildkite, remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-$', value: 'ok' }] }] } as unknown as ServerCard
  expect('error' in planAdd(card, 0, {}, 'x', 'local')).toBe(true)
})

test('A-15 a secret variable with any pre-set value, or a secret header with no secret variable, is refused', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  expect('error' in planAdd(card({ type: 'streamable-http', url: 'https://x.example/p/{k}', variables: { k: { isSecret: true, value: 'sk-demo{suffix}' } } }), 0, {}, 'x', 'local')).toBe(true)
  const header = card({ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'Authorization', isSecret: true, value: 'sk-demo{suffix}', variables: { suffix: { default: 'a' } } }] })
  expect('error' in planAdd(header, 0, {}, 'x', 'local')).toBe(true)
})

test('A-16 dot segments however they arise are refused', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  expect('error' in planAdd(card({ type: 'streamable-http', url: 'https://x.example/a/..{s}/mcp', variables: { s: { default: '' } } }), 0, {}, 'x', 'local')).toBe(true)
  expect('error' in planAdd(card({ type: 'streamable-http', url: 'https://x.example/a/{s}/mcp', variables: { s: { value: '..' } } }), 0, {}, 'x', 'local')).toBe(true)
  expect('error' in planAdd(card({ type: 'streamable-http', url: 'https://x.example/a/%2e%2e/mcp' }), 0, {}, 'x', 'local')).toBe(true)
})

test('A-17 secret names are tied to one card and cannot collide', async () => {
  const card = (name: string, url = 'https://x.example/mcp') =>
    ({ ...buildkite, name, remotes: [{ type: 'streamable-http', url, headers: [{ name: 'Authorization', value: 'Bearer {t}', variables: { t: { isSecret: true } } }] }] }) as unknown as ServerCard
  const a = planAdd(card('com.a/x'), 0, {}, 'foo-bar', 'local')
  const b = planAdd(card('com.b/x'), 0, {}, 'foo-bar', 'local')
  const c = planAdd(card('com.a/x', 'https://y.example/mcp'), 0, {}, 'foo-bar', 'local')
  if (!('plan' in a && 'plan' in b && 'plan' in c)) throw new Error('no plan')
  const names = [a, b, c].map(r => r.plan.envVars[0]!.name)
  expect(new Set(names).size).toBe(3)
})

test('A-18 a secret may not stand in the host part of the URL', async () => {
  const card = { ...buildkite, remotes: [{ type: 'streamable-http', url: 'https://{prefix}public.example/mcp', variables: { prefix: { isSecret: true } } }] } as unknown as ServerCard
  expect('error' in planAdd(card, 0, {}, 'x', 'local')).toBe(true)
  const inPath = { ...buildkite, remotes: [{ type: 'streamable-http', url: 'https://public.example/{key}/mcp', variables: { key: { isSecret: true } } }] } as unknown as ServerCard
  expect('plan' in planAdd(inPath, 0, {}, 'x', 'local')).toBe(true)
})

test('A-19 a variable cannot add query parameters', async () => {
  const card = { ...buildkite, remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp?tenant={tenant}', variables: { tenant: { isRequired: true } } }] } as unknown as ServerCard
  expect('error' in planAdd(card, 0, { tenant: 'ok&admin=true' }, 'x', 'local')).toBe(true)
  expect('plan' in planAdd(card, 0, { tenant: 'acme' }, 'x', 'local')).toBe(true)
})

test('A-20 the preview shows where a template really connects', async () => {
  const card = { ...buildkite, remotes: [{ type: 'streamable-http', url: '{base}/mcp', variables: { base: { value: 'https://attacker.example' } } }] } as unknown as ServerCard
  expect(previewUrl(card, 0)).toBe('https://attacker.example/mcp')
})

// Security review (2026-11-24).
test('A-21 what is added is printable: no control or formatting character from a card or from Claude', async () => {
  const card = (r: unknown) => ({ ...buildkite, remotes: [r] }) as unknown as ServerCard
  // planAdd also holds the line on its own, for a card that reached it unvalidated.
  const esc = card({ type: 'streamable-http', url: 'https://evil.example/mcp\x1b[2K\x1b[1Ghttps://good.example/mcp' })
  expect('error' in planAdd(esc, 0, {}, 'x', 'local')).toBe(true)
  const tenant = card({ type: 'streamable-http', url: 'https://x.example/{t}/mcp', variables: { t: { isRequired: true } } })
  expect('error' in planAdd(tenant, 0, { t: 'a‮b' }, 'x', 'local')).toBe(true)
  const header = card({ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-Team', isRequired: true }] })
  expect('error' in planAdd(header, 0, { 'X-Team': 'ops\x1b]8;;x\x07' }, 'x', 'local')).toBe(true)
  const preset = card({ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-Client', value: 'a\u0085b' }] })
  expect('error' in planAdd(preset, 0, {}, 'x', 'local')).toBe(true)
})
