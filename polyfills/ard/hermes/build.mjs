import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { buildCards } from '../../../tools/hermes/build-cards.mjs'
await buildCards(esbuild, fileURLToPath(new URL('.', import.meta.url)), true)
