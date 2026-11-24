#!/usr/bin/env node
// Checks the community directory, ../community/polyfills.json, before the
// build shows it (guide/community). Each entry needs the fields that
// community/README.md lists; the build fails with the entry and the field.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(site, '..', 'community', 'polyfills.json')
const ours = ['mcp-events', 'mcp-apps-cli', 'mcp-skills', 'mcp-server-cards', 'ard-discovery', 'agent-polyfill', 'polyfill-author']

let list
try {
  list = JSON.parse(readFileSync(file, 'utf8')).polyfills
} catch (error) {
  fail(`community/polyfills.json: ${error.message}`)
}
if (!Array.isArray(list)) fail('community/polyfills.json: "polyfills" must be an array')

const text = (v) => typeof v === 'string' && v.trim().length > 0
const https = (v) => text(v) && /^https:\/\/\S+$/.test(v)
const problems = []
const seen = new Set()
list.forEach((p, i) => {
  const at = `entry ${i + 1}${text(p?.name) ? ` (${p.name})` : ''}`
  const need = (ok, field) => ok || problems.push(`${at}: ${field}`)
  need(text(p?.name), '"name" is missing')
  need(!ours.includes(p?.name), `"name" ${p?.name} is one of this repository's plugins`)
  need(!seen.has(p?.name), `"name" ${p?.name} is listed twice`)
  seen.add(p?.name)
  for (const field of ['extension', 'spec', 'summary', 'install', 'maintainer']) need(text(p?.[field]), `"${field}" is missing`)
  need(p?.id === undefined || text(p.id), '"id", when given, is a string')
  need(https(p?.specUrl), '"specUrl" must be an https:// link')
  need(https(p?.repository), '"repository" must be an https:// link')
  need(Array.isArray(p?.hosts) && p.hosts.length > 0 && p.hosts.every(text), '"hosts" must be a list of host names')
  const c = p?.contract ?? {}
  need(['tested', 'partial', 'no'].includes(c.clientRules), '"contract.clientRules" must be "tested", "partial" or "no"')
  need(typeof c.otherServer === 'boolean', '"contract.otherServer" must be true or false')
  need(['detects', 'setting', 'no'].includes(c.standDown), '"contract.standDown" must be "detects", "setting" or "no"')
  need(typeof c.limits === 'boolean', '"contract.limits" must be true or false')
})
if (problems.length) fail(`community/polyfills.json:\n  ${problems.join('\n  ')}`)
console.log(`community: ${list.length} listed`)

function fail(message) {
  console.error(`community: ${message}`)
  process.exit(1)
}
