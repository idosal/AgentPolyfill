// Builds plugin/dist/server.mjs for ard-discovery, the same way as
// mcp-server-cards' Antigravity form (../../server-cards/antigravity/build.mjs),
// whose build code this uses.
//
//   node build.mjs             build plugin/dist/server.mjs
//   node build.mjs --check     fail if plugin/dist/server.mjs is not what the sources build
//   node build.mjs --out DIR   build server.mjs into DIR instead (test/adapter.test.ts B-1)
//   node build.mjs --tests     build the tests into test/.build, run by `npm test`

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { build } from '../../server-cards/antigravity/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  esbuild,
  root: here,
  name: 'ard-discovery',
  version: JSON.parse(readFileSync(join(here, 'plugin/plugin.json'), 'utf8')).version,
  ruleTests: [
    // ARD's registry client rules, from the Claude Code form.
    '../claude-code/mod/tests/registry.test.ts',
    // This plugin carries the Server Cards core too, so its rules run here as well.
    ...['card', 'configure', 'discover', 'format', 'offer'].map(n => `../../server-cards/claude-code/mod/tests/${n}.test.ts`),
  ],
})
