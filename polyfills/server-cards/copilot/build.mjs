// Builds plugin/dist/server.mjs for mcp-server-cards' Copilot form, with the build code of its
// Codex form (../codex/build.mjs), which the ARD plugins use too.
//
//   node build.mjs             build plugin/dist/server.mjs
//   node build.mjs --check     fail if plugin/dist/server.mjs is not what the sources build
//   node build.mjs --out DIR   build server.mjs into DIR instead (test/bundle.test.ts)
//   node build.mjs --tests     build the tests into test/.build, run by `npm test`; the
//                              tests run against the committed plugin/dist/server.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { main } from '../codex/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await main({
  esbuild,
  root: here,
  entry: 'src/main.ts',
  name: 'mcp-server-cards',
  host: 'GitHub Copilot CLI',
  version: JSON.parse(readFileSync(join(here, 'plugin/plugin.json'), 'utf8')).version,
  // The Claude Code form's rule tests, run here against this bundle.
  ruleTests: ['card', 'configure', 'discover', 'format', 'offer'].map(n => `../claude-code/mod/tests/${n}.test.ts`),
})
