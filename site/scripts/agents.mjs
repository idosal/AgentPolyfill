#!/usr/bin/env node
// Writes the site for agents into the build (.vitepress/dist), after
// `vitepress build` (npm run build runs it):
//
//   /llms.txt         an index of the site in the llms.txt format (llmstxt.org):
//                     what AgentPolyfill is, how to install it, and a link to
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
  ['Optional', ['about']],
]

const INSTALL = '/plugin install agent-polyfill --marketplace idosal/AgentPolyfill'
const INSTALL_CLI = 'claude plugin install agent-polyfill --marketplace idosal/AgentPolyfill'
const INSTALL_CODEX = [
  'codex plugin marketplace add idosal/AgentPolyfill',
  'codex plugin add mcp-events@agent-polyfill',
  'codex plugin add mcp-skills@agent-polyfill',
  'codex plugin add mcp-server-cards@agent-polyfill',
]
const HOSTS = [
  { name: 'Claude Code', command: 'claude', addKey: 'add', form: 'Mod (plugin)', polyfills: 'Events, Skills, Server Cards, Apps, ARD' },
  { name: 'Codex', command: 'codex', addKey: 'addCodex', form: 'Plugin', polyfills: 'Events, Skills, Server Cards, ARD; no Apps form' },
  { name: 'Pi', command: 'pi', addKey: 'addPi', form: 'Extension', polyfills: 'Events, Skills, Server Cards, ARD; no Apps form' },
  { name: 'Antigravity', command: 'agy', start: 'open the Antigravity App or start `agy`', addKey: 'addAntigravity', form: 'Plugin', polyfills: 'Events, Skills, Server Cards, ARD; no Apps form (the App renders MCP Apps itself)' },
]
// Pi's source installs and examples, for the Markdown served to agents.
const PI_FORMS = {
  'mcp-events': {
    path: 'polyfills/events/pi/extension',
    add: 'pi mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp',
    ask: 'Watch for new earthquakes from the feeds server and tell me where each one was.',
  },
  'mcp-skills': {
    path: 'polyfills/skills/pi/extension',
    add: 'pi mcp add huggingface --url https://huggingface.co/mcp',
  },
  'mcp-server-cards': {
    path: 'polyfills/server-cards/pi/extension',
  },
  'ard-discovery': {
    path: 'polyfills/ard/pi/extension',
    add: 'pi install ./polyfills/ard/pi/extension',
  },
}
const INSTALL_PI = [
  'git clone https://github.com/idosal/AgentPolyfill.git',
  'cd AgentPolyfill',
  ...Object.values(PI_FORMS).map(({ path }) => `pi install ./${path}`),
]
const PI_INSTALL_NOTES = 'Nothing for Pi is published to npm or Pi\'s package gallery. There is no bundle: install each extension separately. Pi cannot install one folder of a git repository, so use a local clone. Each extension is bundled, with nothing to build. Pi loads each path where it is; keep the clone and run `git pull` there to update it. For one run without installing, use `pi -e ./polyfills/<polyfill>/pi/extension`. Remove it from the same folder with `pi remove ./polyfills/<polyfill>/pi/extension` (`<polyfill>` is `events`, `skills`, `server-cards` or `ard`). Data stays in `mcp-events/` and `mcp-skills/` in Pi\'s agent folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`); delete those to remove it. Added servers stay in `mcp.json`; undo with `pi mcp remove <name>`.'
const PI_APPS_LIMIT = 'Apps has no Pi form. Pi 1.6.0 leaves out `ui://` resources and tool `_meta`, so an extension cannot get an App\'s UI through Pi. Its terminal could draw one in principle, but no Pi Apps form is built or tested.'
// Antigravity's source installs and examples, for the Markdown served to agents.
const ANTIGRAVITY_FORMS = {
  'mcp-events': {
    path: 'polyfills/events/antigravity/plugin',
    add: 'agy mcp add feeds https://event-feeds.idosalomon.workers.dev/mcp',
  },
  'mcp-skills': {
    path: 'polyfills/skills/antigravity/plugin',
    add: 'agy mcp add huggingface https://huggingface.co/mcp',
  },
  'mcp-server-cards': {
    path: 'polyfills/server-cards/antigravity/plugin',
  },
  'ard-discovery': {
    path: 'polyfills/ard/antigravity/plugin',
    add: 'agy plugin install ./polyfills/ard/antigravity/plugin',
  },
}
const INSTALL_ANTIGRAVITY = [
  'git clone https://github.com/idosal/AgentPolyfill.git',
  'cd AgentPolyfill',
  ...Object.values(ANTIGRAVITY_FORMS).map(({ path }) => `agy plugin install ./${path}`),
]
const ANTIGRAVITY_INSTALL_NOTES = 'Nothing is published to Antigravity\'s Marketplace; each plugin installs separately. `agy plugin install` copies the folder to `~/.gemini/config/plugins/<name>`, which the App and the CLI both read. Uninstall one with `agy plugin uninstall <name>` (`mcp-events`, `mcp-skills`, `mcp-server-cards` or `ard-discovery`). Events wakes an idle App conversation only through its sidecar, which is off until you add `"sidecars": {"mcp-events/wake": {"enabled": true}}` to `~/.gemini/config/config.json`; the plugin never edits that file. The plugins write only their own folder, `~/.gemini/agentpolyfill/<plugin>/`; Skills\' placeholders, `~/.gemini/config/skills/mcp-skills-served--*`; and, for Server Cards and ARD after your approval, `~/.gemini/config/mcp_config.json`.'
const ANTIGRAVITY_ADD_NOTES = 'To add a server in the CLI: `agy mcp add <name> <url>`, with `--header "Authorization: Bearer <token>"` for a header; `agy mcp remove <name>` removes it. Both edit `~/.gemini/config/mcp_config.json`. The App doesn\'t ship `agy`; there, use Customizations > Installed > MCP Servers or edit that file.'
const ANTIGRAVITY_APPS_LIMIT = 'Apps has no Antigravity form. Antigravity\'s App renders MCP Apps itself (v2.34.0 and later); the CLI and IDE show text only.'

function hostTable() {
  return ['| Host | Form | Polyfills |', '|---|---|---|', ...HOSTS.map(({ name, form, polyfills }) => `| ${name} | ${form} | ${polyfills} |`)].join('\n')
}

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
  const { data, body } = frontMatter(readFileSync(join(site, 'index.md'), 'utf8'))
  const hero = readFileSync(join(site, 'index.md'), 'utf8')
  const text = /^\s+text:\s*(.+)$/m.exec(hero)[1]
  const tagline = /^\s+tagline:\s*"?(.+?)"?$/m.exec(hero)[1]
  const html = (s) =>
    s
      .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, (_, href, label) => `[${label}](${resolveLink(href, 'index')})`)
      .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
      .replace(/<[^>]+>/g, '')
      .trim()
  const section = (heading) => {
    const match = new RegExp(`<h2>${heading}</h2>([\\s\\S]*?)</section>`).exec(body)
    if (!match) fail(`index.md has no section "${heading}"`)
    return match[1]
  }
  const paragraphs = (chunk) => [...chunk.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => html(m[1]))
  const [lede] = paragraphs(section('The polyfills'))
  const poc = /<p class="poc">([\s\S]*?)<\/p>/.exec(body)
  if (!poc) fail('index.md has no proof-of-concept notice (<p class="poc">)')
  const notice = html(poc[1].replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**'))
  const card = (p) => {
    const cut = media.cuts.find((c) => c.name === p.cut)
    const forms = { Pi: PI_FORMS[p.plugin], Antigravity: ANTIGRAVITY_FORMS[p.plugin] }
    const hosts = HOSTS.filter(({ name }) => p.hosts.includes(name))
    const lines = [
      `### ${p.name} (\`${p.plugin}\`)`,
      '',
      `${p.id ? `\`${p.id}\`, ` : ''}${p.spec}. Early.`,
      '',
      p.line,
      '',
      'Hosts:',
      '',
      ...hosts.map(({ name }) => `- ${name}`),
    ]
    const block = (command) => [command.startsWith('/') ? '```' : '```bash', command, '```']
    if (p.addStep) lines.push('', p.addStep)
    for (const host of hosts) {
      const form = forms[host.name]
      const add = form?.add ?? p[host.addKey]
      const ask = form?.ask ?? p.ask
      const start = host.start ?? `start \`${host.command}\``
      lines.push('', `**${host.name}**`, '')
      if (add) lines.push(...block(add), '', `Then ${start} and ask: "${ask}"`)
      else lines.push(`Nothing to set up. ${start[0].toUpperCase()}${start.slice(1)} and ask: "${ask}"`)
    }
    if (p.then) lines.push('', p.then)
    if (p.note) lines.push('', p.note)
    if (p.plugin === 'mcp-apps-cli') lines.push('', PI_APPS_LIMIT, '', ANTIGRAVITY_APPS_LIMIT)
    lines.push('', videoLine({ file: cut.file, seconds: cut.seconds, description: p.alt }), '', `The ${p.name} guide: ${resolveLink(p.link, 'index')}`)
    return lines.join('\n')
  }
  const cards = home.polyfills.map(card)
  const beyondCards = home.beyond.map(card)
  const audiences = home.audiences.map((a) => `- **${a.title}.** ${a.text} [${a.linkText}](${resolveLink(a.link, 'index')})`)

  return `# ${data.title ?? 'AgentPolyfill'}

> ${/[.!?]$/.test(text) ? text : `${text}.`} ${tagline}

${notice}

${hostTable()}

## Install

**Claude Code** (2.1.329 or newer). At the prompt of a \`claude\` session, install every polyfill at once, then start a new session:

\`\`\`
${INSTALL}
\`\`\`

The same works in a terminal: \`${INSTALL_CLI}\`.

**Codex** (0.170 or newer; Skills was tested on 0.172; Node 20 or newer). In a terminal:

\`\`\`bash
${INSTALL_CODEX.join('\n')}
\`\`\`

Apps isn't in Codex yet, and Codex has no bundle.

**Pi** (1.6.0, the version tested; Node 22 or newer). From a clone:

\`\`\`bash
${INSTALL_PI.join('\n')}
\`\`\`

${PI_INSTALL_NOTES}

${PI_APPS_LIMIT}

**Antigravity** (App v2.35.1 and CLI v1.5.16, the versions run; ARD in the CLI only; the IDE wasn't run; Node 20 or newer on \`PATH\`). From a clone:

\`\`\`bash
${INSTALL_ANTIGRAVITY.join('\n')}
\`\`\`

${ANTIGRAVITY_INSTALL_NOTES}

${ANTIGRAVITY_ADD_NOTES}

${ANTIGRAVITY_APPS_LIMIT}

Beyond MCP, ARD is a draft. Every search asks you first and goes to a registry you choose. Install it separately:

- **Claude Code:** \`/plugin install ard-discovery --marketplace idosal/AgentPolyfill\`; it isn't in the bundle.
- **Codex:** \`codex plugin add ard-discovery@agent-polyfill\`.
- **Pi:** \`pi install ./polyfills/ard/pi/extension\` from the clone (included in the commands above).
- **Antigravity:** \`agy plugin install ./polyfills/ard/antigravity/plugin\` from the clone (included in the commands above).

${videoLine({ file: media.launch.file, seconds: media.launch.seconds, description: media.launch.description })}

## The polyfills

${lede}

${cards.join('\n\n')}

## Beyond MCP

${beyondCards.join('\n\n')}

## Who it is for

${audiences.join('\n')}

---

This page on the web: ${pageUrl('index')}
`
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
  const { data } = frontMatter(readFileSync(join(site, 'index.md'), 'utf8'))
  const sections = SECTIONS.map(
    ([heading, list]) => `## ${heading}\n\n${list.map((page) => `- [${title(page)}](${markdownUrl(page)}): ${description(page)}`).join('\n')}`,
  )
  return `# AgentPolyfill

> ${data.description}

AgentPolyfill makes polyfills for agent protocols: it brings more of MCP to the clients you already use, before they support it. Each MCP polyfill implements the client side of one published extension, follows that extension's spec with stated exceptions, and can be removed or disabled once the host ships its own. Servers don't change.

${hostTable()}

The MCP polyfills implement Events (SEP-3415), Skills (SEP-2640), Server Cards (SEP-2127) and Apps (MCP Apps 2026-01-26). It's an early proof of concept: some gaps, like servers behind OAuth, need small changes to the hosts' plugin APIs (${origin}/guide/how-it-works.md). ${PI_APPS_LIMIT} ${ANTIGRAVITY_APPS_LIMIT}

Beyond MCP, \`ard-discovery\` adds Agentic Resource Discovery v0.91 (a draft). A search sends the words of your request to the ARD registry you choose and asks you first every time, so ARD is installed separately. Pi's live run showed domain discovery and an approved search of the repository's demo registry, but did not complete the add step; additions are covered by real-Pi tests with a scripted model and a local server. In Antigravity, every registry search and every addition is put to you in Antigravity's approval card.

## Install

- **Claude Code 2.1.329 or newer:** every MCP polyfill, the \`agent-polyfill\` bundle, from a terminal: \`${INSTALL_CLI}\`. At the prompt of a \`claude\` session it is \`${INSTALL}\`. Start a new session for the plugins to load. ARD is separate: \`/plugin install ard-discovery --marketplace idosal/AgentPolyfill\`.
- **Codex 0.170 or newer (Node 20 or newer):** from a terminal: \`${INSTALL_CODEX.join(' && ')}\`. ARD is separate: \`codex plugin add ard-discovery@agent-polyfill\`. There is no bundle.
- **Pi 1.6.0 (the version tested; Node 22 or newer):** use the clone commands below.
- **Antigravity (App v2.35.1 and CLI v1.5.16, the versions run, ARD in the CLI only; Node 20 or newer on \`PATH\`):** use the Antigravity clone commands after Pi's below.

\`\`\`bash
${INSTALL_PI.join('\n')}
\`\`\`

${PI_INSTALL_NOTES}

In Pi, Events and Skills use their own MCP connections, so a local (stdio) server runs twice. They cannot use Pi's OAuth or \`auth.provider\` sign-ins, and never read Pi's stored credentials. An \`Authorization\` header in \`mcp.json\` works, written out or using \`\${VARIABLE}\` or \`!command\`. Events needs protocol revision 2026-07-28; Pi's own client stops at 2025-11-25. With Pi's MCP support off, Events and Skills stand down too. Servers another extension registers later are reached after \`/reload\`.

Pi runs tools without asking unless a permission extension asks. Each polyfill asks before its consequential step: a watch, a skill load, a search or an add. Skills meets X8: a cross-server read while a served skill is loaded asks first, naming both servers. There is no per-skill switch in Pi; server-level \`skip\` in \`mcp-skills/settings.json\` leaves out a server's skills. None of the Pi forms detects native support automatically; remove it or use its off switch when Pi supports it itself:

| Pi form | Off switch |
|---|---|
| Events | \`MCP_EVENTS_OFF=1\` |
| Skills | \`MCP_SKILLS_OFF=1\` |
| Server Cards | \`MCP_SERVER_CARDS_DISABLED=1\` |
| ARD | \`ARD_DISCOVERY_DISABLED=1\` |

Antigravity, from a clone:

\`\`\`bash
${INSTALL_ANTIGRAVITY.join('\n')}
\`\`\`

${ANTIGRAVITY_INSTALL_NOTES}

${ANTIGRAVITY_ADD_NOTES}

In Antigravity, an MCP server isn't told which conversation calls it, and Antigravity's MCP client cancels every elicitation request without showing it. So each plugin pairs its MCP server with a \`PreToolUse\` hook, which passes the conversation id to the call and asks through Antigravity's own approval card (\`force_ask\`). The hook leaves a one-use ticket for exactly that call, and the server acts only with it. New events reach a conversation at its next model call in the App and the CLI; only App conversations can be woken, through the sidecar. The IDE wasn't run; its hooks page lists no plugin hooks, and without them every Events call is refused. Events and Skills read \`~/.gemini/config/mcp_config.json\`, header values included, and can't reach servers behind Antigravity's own sign-in. A card that needs a secret can't be added: Antigravity's personal \`mcp_config.json\` reads no \`\${VAR}\`, and the plugin never writes a secret. Skills doesn't meet X8, as in Codex: the plugin can't put a question in front of Antigravity's own resource reads, so the loaded skill tells the model to ask the person first. ARD carries the Server Cards checks and add step itself, and has no default registry: name one, or set \`ARD_DISCOVERY_REGISTRY\` in the environment Antigravity starts in.

Antigravity's own approval system is the boundary. Each form's own actions (an addition, a registry search, a skill load) ask in the approval card, which is yes or no and can't be approved for good; nothing is auto-approved. Read-only tools and Events watches go through Antigravity's usual MCP approval, which by default asks before any MCP tool (the App's card; the CLI's default mode, \`request-review\`). Upstream conformance (suite at c8625de, 25 November 2026): Skills passes all four client scenarios; Events passes 17 of 17 checks of conformance PR #541, through the form's MCP server and its ticket hook. Editors on \`agy acp\` see the tool and its arguments, not the question. The forms never open \`~/.gemini/antigravity/mcp_oauth_tokens.json\` or any sign-in store. The IDE's agent wasn't run (IDE 2.8.0 stayed signed out, and its hooks page lists no plugin hooks), and neither were a webhook watch or an ARD search in the App. The Antigravity forms are awaiting the independent AI review the other forms had. None of them detects native support; Antigravity tells plugins nothing about its MCP client's extensions. Disable or uninstall the plugin (\`agy plugin disable <name>\`), or use its off switch:

| Antigravity form | Off switch |
|---|---|
| Events | \`MCP_EVENTS_OFF=1\`, or \`{"MCP_EVENTS_OFF": "1"}\` in \`~/.gemini/agentpolyfill/mcp-events/settings.json\` |
| Skills | \`MCP_SKILLS_DISABLED=1\`, or \`"off": true\` in \`~/.gemini/agentpolyfill/mcp-skills/settings.json\` |
| Server Cards | \`MCP_SERVER_CARDS_DISABLED=1\` |
| ARD | \`ARD_DISCOVERY_DISABLED=1\` |

Anyone can build a polyfill to the contract, bring an existing one to another host, or list one they keep in their own repository in the community directory (${origin}/guide/community.md).

By Ido Salomon (https://x.com/idosal1). Not affiliated with Anthropic, OpenAI, MCP, Agentic Resource Discovery or the Agentic AI Foundation (AAIF). Source: https://github.com/idosal/AgentPolyfill (Apache-2.0).

Every page of this site is also plain Markdown at its address plus \`.md\`, and all of them together are at ${origin}/llms-full.txt.

- [Home](${markdownUrl('index')}): what a polyfill does, the install for each host, the polyfills with a demo server and a first question for each, and the launch video.

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
