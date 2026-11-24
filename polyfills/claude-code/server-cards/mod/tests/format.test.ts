import { expect, test } from 'claude-code/testing'
import type { ServerCard } from '../hooks/card'
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
