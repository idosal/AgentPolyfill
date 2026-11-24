#!/usr/bin/env node
// Checks every internal link and asset the site's pages refer to.
//
//   node scripts/check-links.mjs                 the build in .vitepress/dist
//   node scripts/check-links.mjs <https://site>  a deployed copy, over HTTP: every
//                                                page and asset must answer 200
//
// Links to other sites are listed, not fetched (GitHub links answer 404 while the
// repository is private).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(site, '.vitepress', 'dist')
const base = process.argv[2]

const linkPattern = /\s(?:href|src|poster)="([^"]+)"/g
const external = new Set()
const problems = []

function linksIn(html) {
  const found = []
  for (const [, raw] of html.matchAll(linkPattern)) {
    const link = raw.replaceAll('&amp;', '&')
    if (/^(mailto:|javascript:|data:|#)/.test(link)) continue
    if (/^https?:\/\//.test(link)) {
      if (!base || !link.startsWith(base)) {
        external.add(link)
        continue
      }
    }
    found.push(link)
  }
  return found
}

if (!base) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(dist)
  const has = (path) => existsSync(join(dist, path)) && statSync(join(dist, path)).isFile()
  let checked = 0
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    const page = '/' + relative(dist, file)
    for (const link of linksIn(readFileSync(file, 'utf8'))) {
      const url = new URL(link, `https://site.invalid${page}`)
      const path = decodeURIComponent(url.pathname)
      const target = path.endsWith('/') ? `${path}index.html` : path
      const ok = has(target) || has(`${target}.html`) || has(`${target}/index.html`)
      checked++
      if (!ok) problems.push(`${page}: ${link}`)
      if (ok && url.hash && (has(`${target}.html`) || has(target))) {
        const html = readFileSync(join(dist, has(`${target}.html`) ? `${target}.html` : target), 'utf8')
        const id = decodeURIComponent(url.hash.slice(1))
        if (target.endsWith('.html') || has(`${target}.html`)) {
          if (!html.includes(`id="${id}"`)) problems.push(`${page}: ${link} (no #${id})`)
        }
      }
    }
  }
  console.log(`links: ${checked} internal links in ${files.filter((f) => f.endsWith('.html')).length} pages`)
} else {
  const origin = new URL(base).origin
  const seen = new Map()
  const queue = ['/']
  while (queue.length) {
    const path = queue.shift()
    if (seen.has(path)) continue
    const response = await fetch(origin + path, { redirect: 'manual' })
    seen.set(path, response.status)
    if (response.status !== 200) {
      problems.push(`${path}: HTTP ${response.status}`)
      continue
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
      await response.body?.cancel()
      continue
    }
    const html = await response.text()
    for (const link of linksIn(html)) {
      const url = new URL(link, origin + path)
      if (url.origin !== origin) continue
      if (!seen.has(url.pathname) && !queue.includes(url.pathname)) queue.push(url.pathname)
    }
  }
  console.log(`links: ${seen.size} paths fetched from ${origin}`)
}

console.log(`links: ${external.size} links to other sites, not fetched`)
if (problems.length) {
  console.error(`links: ${problems.length} broken:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('links: none broken')
