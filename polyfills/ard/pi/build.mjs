import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { main } from '../../server-cards/pi/build.mjs'

await main({ esbuild, root: fileURLToPath(new URL('.', import.meta.url)), ruleTests: [
  '../claude-code/mod/tests/registry.test.ts',
  '../../server-cards/pi/test/adapter.test.ts',
  '../../server-cards/pi/test/network.test.ts',
  ...['card', 'configure', 'discover', 'format', 'offer'].map(n => `../../server-cards/claude-code/mod/tests/${n}.test.ts`),
] })
