#!/usr/bin/env node
// Writes the site for agents into the build (.vitepress/dist), after
// `vitepress build` (npm run build runs it):
//
//   /llms.txt         an index of the site in the llms.txt format (llmstxt.org):
//                     project and installation links, and a link to
//                     each page's Markdown with one line about it
//   /llms-full.txt    every page's Markdown, one after another
//   /<page>.md        each page as plain Markdown, next to its HTML
//                     (/guide/events -> /guide/events.md, / -> /index.md)
//   _headers          gains each of those files' type, with its charset
//
// The Markdown comes from the pages' own sources. Components become text: a
// recording becomes a line with what it shows and a link to its MP4; the home
// page's cards come from home.json, with host install and demo commands below. Links
// to other pages point at their Markdown. Every page in the site must be in
// SECTIONS below, or the build fails.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(site, '.vitepress', 'dist')
const origin = 'https://agentpolyfill.com'
const media = JSON.parse(readFileSync(join(site, 'media.json'), 'utf8'))
const home = JSON.parse(readFileSync(join(site, 'home.json'), 'utf8'))
const community = JSON.parse(readFileSync(join(site, '..', 'community', 'polyfills.json'), 'utf8')).polyfills

// In the order of the sidebar. The page's description (front matter) is its
// line in llms.txt.
const SECTIONS = [
  ['Start', ['guide/introduction', 'guide/getting-started']],
  ['Polyfills for MCP extensions', ['guide/events', 'guide/skills', 'guide/server-cards', 'guide/apps']],
  ['Beyond MCP', ['guide/ard']],
  ['Build', ['guide/build-a-polyfill', 'guide/spec-authors', 'guide/contributing', 'guide/community']],
  ['Reference', ['guide/how-it-works', 'guide/security']],
  ['Project', ['about']],
]

if (!existsSync(dist)) fail('.vitepress/dist is missing: run vitepress build first')

// Every page source must be listed, so a new page is not left out by accident.
const listed = new Set(['index', ...SECTIONS.flatMap(([, pages]) => pages)])
for (const page of sources(site)) {
  if (!listed.has(page)) fail(`${page}.md is not in SECTIONS in scripts/agents.mjs`)
}

const pages = new Map()
pages.set('index', homeMarkdown())
for (const page of listed) if (page !== 'index') pages.set(page, pageMarkdown(page))

for (const [page, markdown] of pages) {
  const target = join(dist, `${page}.md`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, markdown)
}
writeFileSync(join(dist, 'llms.txt'), llmsTxt())
writeFileSync(join(dist, 'llms-full.txt'), llmsFull())

// Their type, with the charset (the text is UTF-8: quotes, arrows, section
// signs), and open to pages on other sites, for agents that run in a browser.
const headers = [
  ...['/llms.txt', '/llms-full.txt'].map((path) => [path, 'text/plain; charset=utf-8']),
  ...[...pages.keys()].map((page) => [`/${page}.md`, 'text/markdown; charset=utf-8']),
]
  .map(([path, type]) => `${path}\n  Content-Type: ${type}\n  Access-Control-Allow-Origin: *\n`)
  .join('\n')
writeFileSync(join(dist, '_headers'), `${readFileSync(join(dist, '_headers'), 'utf8').trimEnd()}\n\n${headers}`)
console.log(`agents: llms.txt, llms-full.txt and ${pages.size} Markdown pages`)

function sources(dir) {
  const found = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      if (name === 'node_modules' || name.startsWith('.')) continue
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.md') && !/^(README|CHANGELOG)\.md$/i.test(name)) found.push(relative(site, path).replace(/\.md$/, ''))
    }
  }
  walk(dir)
  return found
}

function frontMatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source)
  if (!match) return { data: {}, body: source }
  const data = {}
  for (const line of match[1].split('\n')) {
    const field = /^(\w+):\s*(.*)$/.exec(line)
    if (field) data[field[1]] = field[2].replace(/^"(.*)"$/, '$1')
  }
  return { data, body: source.slice(match[0].length) }
}

function pageUrl(page) {
  return page === 'index' ? `${origin}/` : `${origin}/${page}`
}

function markdownUrl(page) {
  return `${origin}/${page}.md`
}

// A link from `page` to another page of the site points at that page's
// Markdown; a link to a file (a video, an image) or to another site is left
// as it is, made absolute.
function resolveLink(href, page) {
  if (/^(https?:|mailto:)/.test(href)) return href
  if (href.startsWith('#')) return href
  const url = new URL(href, `${origin}/${page}`)
  const path = url.pathname.replace(/\/$/, '/index')
  if (/\.[a-z0-9]+$/i.test(path)) return url.href
  const target = path.slice(1)
  if (!listed.has(target)) fail(`${page}.md links to ${href}, which is not a page`)
  return `${markdownUrl(target)}${url.hash}`
}

function attributes(tag) {
  const found = {}
  for (const [, name, value] of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) found[name.replace(/^:/, '')] = value
  return found
}

function videoLine({ file, seconds, description }) {
  const sound = /no sound/.test(description) ? '' : ', no sound'
  return `> Video (${Math.round(seconds)} s${sound}, [MP4](${origin}/media/${file})): ${description}`
}

// A recording on a page: its caption (what it is), then its alt text (what is
// on screen).
function recording(tag) {
  const a = attributes(tag)
  let file
  let seconds
  if (a.cut) {
    const cut = media.cuts.find((c) => c.name === a.cut)
    if (!cut) fail(`no cut named ${a.cut} in media.json`)
    ;({ file, seconds } = cut)
  } else file = a.src.replace(/^\/media\//, '')
  if (a.caption) return `> Video ([MP4](${origin}/media/${file})): ${a.caption} On screen: ${a.alt}`
  return videoLine({ file, seconds, description: a.alt })
}

function pageMarkdown(page) {
  const { data, body } = frontMatter(readFileSync(join(site, `${page}.md`), 'utf8'))
  const lines = []
  let fence = null
  let container = null
  for (const line of body.split('\n')) {
    const fenceMatch = /^(`{3,})(.*)$/.exec(line)
    if (fence) {
      lines.push(container === 'quote' ? `> ${line}` : line)
      if (fenceMatch && fenceMatch[1] === fence && !fenceMatch[2].trim()) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      // A code-group tab: its label goes before the block.
      const [, lang = '', label] = /^(\S*)(?:\s+\[(.+)\])?/.exec(fenceMatch[2].trim()) ?? []
      if (label) lines.push(`${label}:`, '')
      lines.push(`${fence}${lang}`)
      continue
    }
    const open = /^:::\s*(\S+)\s*(.*)$/.exec(line)
    if (open) {
      if (open[1] === 'code-group') container = 'group'
      else {
        container = 'quote'
        lines.push(`> **${open[2] || open[1][0].toUpperCase() + open[1].slice(1)}**`, '>')
      }
      continue
    }
    if (/^:::\s*$/.test(line)) {
      container = null
      continue
    }
    lines.push(container === 'quote' ? (line ? `> ${line}` : '>') : line)
  }
  let markdown = lines.join('\n')
  markdown = markdown.replace(/<Recording\b[\s\S]*?\/>/g, (tag) => recording(tag))
  markdown = markdown.replace(/<CommunityList\s*\/>/g, () => communityList())
  if (/<[A-Z][A-Za-z]+\b/.test(markdown)) fail(`${page}.md has a component scripts/agents.mjs does not turn into text`)
  markdown = markdown.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (_, text, href) => `${text}(${resolveLink(href, page)})`)
  markdown = markdown.replace(/^# (.+)$/m, (heading) => (data.description ? `${heading}\n\n> ${data.description}` : heading))
  return `${markdown.replace(/\n{3,}/g, '\n\n').trim()}\n\n---\n\nThis page on the web: ${pageUrl(page)}\n`
}

// The home page is a layout with components; it is written here from the
// same data.
function homeMarkdown() {
  const installGuide = /^## Install$[\s\S]*?(?=^## (?!#)|^---$)/m.exec(pageMarkdown('guide/getting-started'))
  if (!installGuide) fail('getting-started.md needs an Install section')
  const cards = [...home.polyfills, ...home.beyond].map((entry) => {
    const cut = media.cuts.find((video) => video.name === entry.cut)
    return [
      `## ${entry.name}`,
      `${entry.line} ${entry.note ?? ''}`.trim(),
      `Plugin: \`${entry.plugin}\`. Hosts: ${entry.hosts.join(', ')}. Specification: ${entry.spec}.`,
      `[Setup and examples](${resolveLink(entry.link, 'index')})`,
      videoLine({ ...cut, description: entry.alt }),
    ].join('\n\n')
  })
  return [
    '# AgentPolyfill',
    description('index'),
    `[Install a plugin](${markdownUrl('guide/getting-started')}) · [Host support](${markdownUrl('guide/introduction')})`,
    installGuide[0].trim(),
    videoLine(media.launch),
    ...cards,
    `[Contribute a polyfill](${markdownUrl('guide/contributing')}) · [Security](${markdownUrl('guide/security')})`,
  ].join('\n\n') + '\n'
}

// The community directory as Markdown: one item per listed polyfill.
function communityList() {
  if (!community.length) return 'Nothing is listed yet.'
  return community
    .map(
      (p) =>
        `- **[${p.name}](${p.repository})**: ${p.extension}, [${p.spec}](${p.specUrl}); ${p.hosts.join(', ')}; by ${p.maintainer}. ${p.summary} Install: \`${p.install}\`. As its author states: client rules ${p.contract.clientRules}; run against another's server: ${p.contract.otherServer ? 'yes' : 'no'}; stand-down: ${p.contract.standDown}; limits stated: ${p.contract.limits ? 'yes' : 'no'}.`,
    )
    .join('\n')
}

function description(page) {
  return frontMatter(readFileSync(join(site, `${page}.md`), 'utf8')).data.description ?? ''
}

function title(page) {
  return /^# (.+)$/m.exec(readFileSync(join(site, `${page}.md`), 'utf8'))[1]
}

function llmsTxt() {
  const sections = SECTIONS.map(
    ([heading, list]) => `## ${heading}\n\n${list.map((page) => `- [${title(page)}](${markdownUrl(page)}): ${description(page)}`).join('\n')}`,
  )
  return `# AgentPolyfill

> ${description('index')}

- [Host support](${markdownUrl('guide/introduction')}#the-polyfills)
- [Install a plugin](${markdownUrl('guide/getting-started')}#install)
- [All guides in one file](${origin}/llms-full.txt)
- [Source](https://github.com/idosal/AgentPolyfill)

${sections.join('\n\n')}
`
}

function llmsFull() {
  const order = ['index', ...SECTIONS.flatMap(([, list]) => list)]
  return `# AgentPolyfill: every page of ${origin}, as Markdown\n\n${order.map((page) => pages.get(page).trim()).join('\n\n---\n\n')}\n`
}

function fail(message) {
  console.error(`agents: ${message}`)
  process.exit(1)
}
