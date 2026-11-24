import { expect, test } from 'claude-code/testing'
import type { ServerCard } from '../hooks/card'
import { planAdd } from '../hooks/configure'
import { formatServer } from '../hooks/format'
import { fixtures } from './fixtures'

const BUILDKITE_CARD = fixtures.live['mcp.buildkite.com_mcp_server-card']

// Second review pass (2026-11-24).
test('F-1 a long URL is shown whole, so it can be passed back exactly', async () => {
  const url = 'https://safe.example/' + 'a'.repeat(400)
  const card = { ...BUILDKITE_CARD, remotes: [{ type: 'streamable-http', url }] } as unknown as ServerCard
  const text = formatServer({ identifier: 'x', listedIn: ['c'], cardFrom: 'c', card, isLocal: false, errors: [] }, 1)
  expect(text.includes(url)).toBe(true)
})

test('F-2 a template shows where it connects; a secret default is never printed', async () => {
  const card = {
    ...BUILDKITE_CARD,
    remotes: [
      {
        type: 'streamable-http',
        url: '{base}/mcp/{key}',
        variables: { base: { value: 'https://real.example' }, key: { isSecret: true, default: 'sk-demo-secret' } },
      },
    ],
  } as unknown as ServerCard
  const text = formatServer({ identifier: 'x', listedIn: ['c'], cardFrom: 'c', card, isLocal: false, errors: [] }, 1)
  expect(text.includes('connects to: https://real.example/mcp/${MCP_BUILDKITE__KEY_')).toBe(true)
  expect(text.includes('sk-demo-secret')).toBe(false)
})

// discovery.md, Consistency with Runtime Behavior: extensionsInfo relied on for
// a security decision MUST come from a same-origin card reached without a
// cross-origin redirect. The polyfill relies on it for nothing: it is never
// shown and never changes what is added (README, rules S-4 and S-5).
test('S-4 extensionsInfo is never read: it changes nothing shown or added', async () => {
  const base = fixtures.live['mcp.buildkite.com_mcp_server-card'] as unknown as ServerCard
  const remote = base.remotes![0]!
  const withInfo = {
    ...base,
    remotes: [{ ...remote, extensionsInfo: { 'io.example/keys': { verify: 'sk-not-a-secret', ranges: ['10.0.0.0/8'] } } }],
  } as unknown as ServerCard
  const shown = formatServer({ identifier: 'x', listedIn: ['c'], cardFrom: 'c', card: withInfo, isLocal: false, errors: [] }, 1)
  expect(shown.includes('io.example/keys')).toBe(false)
  expect(shown.includes('10.0.0.0/8')).toBe(false)
  const a = planAdd(base, 0, {}, undefined, 'local')
  const b = planAdd(withInfo, 0, {}, undefined, 'local')
  if (!('plan' in a && 'plan' in b)) throw new Error('no plan')
  expect(b.plan.argv).toEqual(a.plan.argv)
})
