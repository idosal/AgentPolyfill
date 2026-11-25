import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ArdSession, memoryStore, ARD_SOURCES } from '../src/main'

test('AH-1 search validates exactly visible words and registry before any network request', async () => {
  const seen = []
  const s = new ArdSession({ fetch: async (...args) => { seen.push(args); throw new Error('unexpected') }, store: memoryStore(), now: Date.now })
  for (const a of [{ query: 'find tools' }, { query: '[hidden](bad)', registry: 'https://registry.example' }, { query: 'a\nb', registry: 'https://registry.example' }, { query: 'x'.repeat(301), registry: 'https://registry.example' }, { query: 'hello', registry: 'https://good@bad.example' }])
    await assert.rejects(s.prepareSearch(a))
  assert.equal(seen.length, 0)
  const p = await s.prepareSearch({ query: 'find tools', registry: 'https://registry.example/base' })
  assert.equal(p.endpoint, 'https://registry.example/base/search')
  assert.equal(seen.length, 0)
})
test('AH-2 one approved endpoint is contacted, each referral is deferred and scoped to query/session', async () => {
  const seen = []
  const s = new ArdSession({ fetch: async (url) => { seen.push(url); return { ok: true, status: 200, headers: {}, text: JSON.stringify({ results: [], referrals: [{ url: 'https://referred.example/custom' }] }) } }, store: memoryStore(), now: Date.now })
  const p = await s.prepareSearch({ query: 'find tools', registry: 'https://registry.example' })
  const result = await s.runSearch(p)
  assert.deepEqual(seen, ['https://registry.example/search'])
  assert.match(result.text, /not searched; each needs separate approval/)
  await assert.rejects(s.prepareSearch({ query: 'other words', registry: 'https://referred.example/custom', referral: true }))
  const r = await s.prepareSearch({ query: 'find tools', registry: 'https://referred.example/custom', referral: true })
  assert.equal(r.endpoint, 'https://referred.example/custom')
  await s.runSearch(r)
  assert.deepEqual(seen, ['https://registry.example/search', 'https://referred.example/custom'])
  await assert.rejects(new ArdSession().prepareSearch({ query: 'find tools', registry: r.endpoint, referral: true }))
})
test('AH-3 ARD sources include an unversioned manifest and rel=ard', () => {
  assert.deepEqual(ARD_SOURCES.catalogs, [{ url: '/.well-known/ard.json', requireVersion: false }])
  assert.deepEqual(ARD_SOURCES.rels, ['ard'])
})
test('AH-4 installed bundle and shared Python modules match source', () => {
  const r = spawnSync(process.execPath, ['build.mjs', '--check'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
