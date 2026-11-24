#!/usr/bin/env node
// After the build: Link headers that preload the stylesheet and the text face
// on every page. With Early Hints on in the zone, Cloudflare caches them and
// sends them as a 103 before the page, so the browser fetches both while the
// HTML is still on its way. The file names carry the build's hashes, so the
// rules are written here, into the build's _headers.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.vitepress', 'dist')
const assets = readdirSync(join(dist, 'assets'))
const css = assets.find((f) => /^style\.[\w-]+\.css$/.test(f))
const font = assets.find((f) => /^schibsted-grotesk-latin-wght-normal\.[\w-]+\.woff2$/.test(f))
if (!css || !font) {
  console.error(`early-hints: missing ${css ? 'the latin font' : 'the stylesheet'} in .vitepress/dist/assets`)
  process.exit(1)
}
const link = `</assets/${css}>; rel=preload; as=style, </assets/${font}>; rel=preload; as=font; type="font/woff2"; crossorigin`
const rules = ['/', '/guide/*', '/about'].map((path) => `${path}\n  Link: ${link}\n`).join('\n')
writeFileSync(join(dist, '_headers'), `${readFileSync(join(dist, '_headers'), 'utf8').trimEnd()}\n\n${rules}`)
console.log(`early-hints: ${css}, ${font}`)
