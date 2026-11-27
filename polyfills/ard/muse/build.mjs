// Builds the Muse form's one file, ../codex/plugin/muse/dist/server.mjs, from src/ and the
// sources it reuses (the Codex forms' and the shared Server Cards core), the way
// mcp-server-cards' Muse form builds (../../server-cards/muse/build.mjs), with the ARD Codex form's
// pinned esbuild. The Codex bundle, ../codex/plugin/dist/server.mjs, is built by
// ../codex/build.mjs alone, from unchanged sources.
//
//   node build.mjs             build ../codex/plugin/muse/dist/server.mjs
//   node build.mjs --check     fail if it is not what the sources build
//   node build.mjs --out DIR   build server.mjs into DIR instead (test/bundle.test.ts)
//   node build.mjs --tests     build the tests into test/.build, run by `npm test`

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { museMain } from '../../server-cards/muse/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await museMain({
  root: here,
  codexRoot: resolve(here, '../codex'),
  entry: 'src/main.ts',
  name: 'ard-discovery',
  version: JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version,
})
