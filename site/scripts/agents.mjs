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
  { name: 'OpenCode', command: 'opencode', addKey: 'addOpenCode', config: 'opencode.json', form: 'V2 server plugin', polyfills: 'Events, Skills, Server Cards, ARD; no Apps form' },
]
// Pi's installs and examples, for the Markdown served to agents.
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
    add: 'git clone https://github.com/idosal/AgentPolyfill.git\ncd AgentPolyfill\npi install ./polyfills/ard/pi/extension',
  },
}
const INSTALL_PI = ['pi install git:github.com/idosal/AgentPolyfill']
const PI_INSTALL_NOTES = [
  'The command installs Events, Skills and Server Cards together. Pi clones the repository into its agent folder (under `~/.pi/agent/git/`) and loads the three extensions from there. Nothing is published to npm or Pi\'s package gallery, and nothing is built.',
  'Update installed packages with `pi update --extensions`. Remove all three and Pi\'s copy of the repository with `pi remove git:github.com/idosal/AgentPolyfill`. For one run of all three without installing, use `pi -e git:github.com/idosal/AgentPolyfill`.',
  'ARD is left out for the same reason it isn\'t in the Claude Code bundle: its search sends the words of your request to a registry after asking each time. Install it on its own from a clone.',
  'The clone path also works for any one form alone. Replace `<form>` with `events`, `skills`, `server-cards` or `ard`:',
  '```bash\ngit clone https://github.com/idosal/AgentPolyfill.git\ncd AgentPolyfill\npi install ./polyfills/<form>/pi/extension\n```',
  'Pi loads a local path where it is, so keep the clone. From the same folder, use `pi -e ./polyfills/<form>/pi/extension` for one run without installing, or `pi remove ./polyfills/<form>/pi/extension` to remove a local install.',
  'Use one way per form, not both: Pi tells packages apart by repository address or local path, so a form installed both ways loads twice.',
  'Data stays in `mcp-events/` and `mcp-skills/` in Pi\'s agent folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`); delete those to remove it. Added servers stay in `mcp.json`; undo with `pi mcp remove <name>`.',
].join('\n\n')
const PI_APPS_LIMIT = 'Apps has no Pi form. Pi 1.6.0 leaves out `ui://` resources and tool `_meta`, so an extension cannot get an App\'s UI through Pi. Its terminal could draw one in principle, but no Pi Apps form is built or tested.'
// OpenCode's installs from GitHub and examples, for the Markdown served to
// agents. A setup that starts with `{` goes in the host's `config` file.
const OPENCODE_FORMS = {
  'mcp-events': {
    path: 'polyfills/events/opencode/plugin',
    add: '{ "mcp": { "feeds": { "type": "remote", "url": "https://event-feeds.idosalomon.workers.dev/mcp" } } }',
  },
  'mcp-skills': {
    path: 'polyfills/skills/opencode/plugin',
    add: '{ "mcp": { "huggingface": { "type": "remote", "url": "https://huggingface.co/mcp", "oauth": false } } }',
  },
  'mcp-server-cards': {
    path: 'polyfills/server-cards/opencode/plugin',
  },
  'ard-discovery': {
    path: 'polyfills/ard/opencode/plugin',
    add: "opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'",
  },
}
const INSTALL_OPENCODE = Object.values(OPENCODE_FORMS).map(({ path }) => `opencode plugin add 'github:idosal/AgentPolyfill#main::path:${path}'`)
const OPENCODE_INSTALL_NOTES = 'Nothing for OpenCode is published to npm. There is no bundle: install each plugin separately. OpenCode fetches each one from this repository on GitHub with Git, and runs it itself, so no Node is needed. Each command adds the plugin to `plugins` in the global `~/.config/opencode/opencode.json`, so it runs in every project from the next time OpenCode opens one. `#main` installs what the main branch holds; a commit in its place pins one version. From a clone, you can instead add a plugin\'s folder (`polyfills/<polyfill>/opencode/plugin`) to `plugins` in the global or a project\'s `opencode.json`. Remove one with `opencode plugin remove` and the same text it was added with. OpenCode keeps its downloaded copy in `~/.cache/opencode/npm/` (a `git-AgentPolyfill-…` folder), which can be deleted. Events leaves its watches, stored events and log in `~/.local/share/opencode/mcp-events/`, and Skills its log in `~/.local/share/opencode/mcp-skills/`; delete those to remove them. "Allow always" answers, the skills each session loaded, and the list of servers Server Cards and ARD added stay in OpenCode\'s plugin storage (its own database). An added server comes back if the plugin is installed again, unless it was removed first, with `server_cards_remove_mcp_server` or `ard_remove_mcp_server`.'
const OPENCODE_APPS_LIMIT = 'Apps has no OpenCode form. OpenCode has no MCP Apps support: a plugin cannot read a `ui://` resource or a tool\'s `_meta` over OpenCode\'s connection, and there is no place to draw in the conversation. The desktop app\'s experimental panels can embed a web view, but an OpenCode Apps form was only assessed, not built.'
// Each host's own installs and examples, where they differ from home.json's.
const FORMS = { Pi: PI_FORMS, OpenCode: OPENCODE_FORMS }

// T3 Code is not a host forms load into: it runs Codex, Claude Code and other agents for you.
const T3_ADD = 'codex mcp add mcp-events-t3 -- node "$PWD/AgentPolyfill/polyfills/events/t3/plugin/dist/server.js"'
const T3_NOTE = 'T3 Code (0.1.11, the version tested) is an app that runs the Codex, Claude Code, OpenCode and other agents on your machine from one interface; it has no plugin layer or MCP client of its own, so install the plugins above for the agent you use in it. What follows was checked with Codex as the agent. Apps: T3 Code shows MCP Apps itself, so the Apps polyfill should not be used there. Skills, Server Cards and ARD: their tools work, but with Codex the one question each asks before its consequential step (an MCP elicitation form: "Load it", "Add it", "Send the search") is cancelled by T3 Code without being shown, because it shows only forms it can answer with Approve or Decline; the step is refused as if you had said no, and nothing is approved for you (tried live with Skills; Server Cards and ARD were not run in T3 Code). Events: use the T3 form, mcp-events-t3, for Codex threads only, added to Codex from a clone (`' + T3_ADD + '`), then Restart agent session in T3 Code; T3 Code tells it which thread it serves, its watcher outlives the agent\'s sessions and T3 Code itself, and an event wakes the thread through T3 Code\'s own `t3 thread send`. The Codex Events plugin should not be used in T3 Code: its wake runs a turn the thread does not show. Claude Code threads cannot use the T3 form, since T3 Code does not tell Claude Code\'s servers which thread they serve. Not run live in T3 Code: anything with Claude Code or OpenCode as the agent, the watch_event approval prompt in a thread whose mode asks, Server Cards and ARD. Remove the T3 form with `codex mcp remove mcp-events-t3` and `node <clone>/polyfills/events/t3/plugin/dist/server.js --stop`; its data stays in `~/.codex/mcp-events-t3`. Details: https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md'

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
    const block = (command) => [command.startsWith('/') ? '```' : command.startsWith('{') ? '```json' : '```bash', command, '```']
    if (p.addStep) lines.push('', p.addStep)
    for (const host of hosts) {
      const form = FORMS[host.name]?.[p.plugin]
      const add = form?.add ?? p[host.addKey]
      const ask = form?.ask ?? p.ask
      lines.push('', `**${host.name}**`, '')
      if (add?.startsWith('{')) lines.push(`In \`${host.config}\`:`, '')
      if (add) lines.push(...block(add), '', `Then start \`${host.command}\` and ask: "${ask}"`)
      else lines.push(`Nothing to set up. Start \`${host.command}\` and ask: "${ask}"`)
    }
    if (p.then) lines.push('', p.then)
    if (p.note) lines.push('', p.note)
    if (p.plugin === 'mcp-apps-cli') lines.push('', PI_APPS_LIMIT, '', OPENCODE_APPS_LIMIT)
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

**Pi** (1.6.0, the version tested; Node 22 or newer). In a terminal:

\`\`\`bash
${INSTALL_PI.join('\n')}
\`\`\`

${PI_INSTALL_NOTES}

${PI_APPS_LIMIT}

**OpenCode** (2.4 or newer, tested with 2.4.1; Git). In a terminal:

\`\`\`bash
${INSTALL_OPENCODE.join('\n')}
\`\`\`

${OPENCODE_INSTALL_NOTES}

${OPENCODE_APPS_LIMIT}

**T3 Code.** ${T3_NOTE}

Beyond MCP, ARD is a draft. Every search asks you first and goes to a registry you choose. Install it separately:

- **Claude Code:** \`/plugin install ard-discovery --marketplace idosal/AgentPolyfill\`; it isn't in the bundle.
- **Codex:** \`codex plugin add ard-discovery@agent-polyfill\`.
- **Pi:** \`pi install ./polyfills/ard/pi/extension\` from a clone; it is left out of the one-line install.
- **OpenCode:** \`${OPENCODE_FORMS['ard-discovery'].add}\` (included in the commands above).

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

The MCP polyfills implement Events (SEP-3415), Skills (SEP-2640), Server Cards (SEP-2127) and Apps (MCP Apps 2026-01-26). It's an early proof of concept: some gaps, like servers behind OAuth, need small changes to the hosts' plugin APIs (${origin}/guide/how-it-works.md). ${PI_APPS_LIMIT} ${OPENCODE_APPS_LIMIT}

Beyond MCP, \`ard-discovery\` adds Agentic Resource Discovery v0.91 (a draft). A search sends the words of your request to the ARD registry you choose and asks you first every time, so ARD is installed separately. Pi's live run showed domain discovery and an approved search of the repository's demo registry, but did not complete the add step; additions are covered by real-Pi tests with a scripted model and a local server. OpenCode's live run read buildkite.com's \`ard.json\` and sent a search to the repository's demo registry after OpenCode asked (no public registry that takes an unauthenticated search was found); additions are covered by tests in real OpenCode with a scripted model and a local server.

## Install

- **Claude Code 2.1.329 or newer:** every MCP polyfill, the \`agent-polyfill\` bundle, from a terminal: \`${INSTALL_CLI}\`. At the prompt of a \`claude\` session it is \`${INSTALL}\`. Start a new session for the plugins to load. ARD is separate: \`/plugin install ard-discovery --marketplace idosal/AgentPolyfill\`.
- **Codex 0.170 or newer (Node 20 or newer):** from a terminal: \`${INSTALL_CODEX.join(' && ')}\`. ARD is separate: \`codex plugin add ard-discovery@agent-polyfill\`. There is no bundle.
- **Pi 1.6.0 (the version tested; Node 22 or newer):** one line installs Events, Skills and Server Cards together; the commands are below.
- **OpenCode 2.4 or newer (tested with 2.4.1; Git; no Node):** one \`opencode plugin add\` per polyfill, from GitHub, after Pi's below.
- **T3 Code:** not a host of its own here; see the T3 Code paragraph below.

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

OpenCode, one plugin per polyfill, from a terminal:

\`\`\`bash
${INSTALL_OPENCODE.join('\n')}
\`\`\`

${OPENCODE_INSTALL_NOTES}

In OpenCode, Events and Skills use their own MCP connections, so a local server runs twice. They cannot reach a server OpenCode signs in to with OAuth (\`opencode mcp auth\`), and never read OpenCode's stored credentials; the headers in a server's OpenCode configuration work. Server Cards and ARD add a server to OpenCode's MCP servers for the project, and OpenCode connects it with its own client and sign-in. Only streamable HTTP servers are added, and for a card that needs a secret the answer gives the \`opencode.json\` entry, with \`{env:VAR}\`, to add by hand. Events watches resume when OpenCode next opens the project. Events departs from contract rule 4: OpenCode's own client takes push events for its automations, but doesn't poll or take webhooks and skips event types whose schemas it can't check, so the polyfill watches every type and tells the model to use a watch or an automation for an event type, not both.

OpenCode's shipped permission rules allow every action. Each polyfill puts its own actions to those rules and asks by default: a watch, a skill load, a read of another server's resource while a served skill is loaded (X8, naming both servers), an addition or a search. A \`deny\` or \`ask\` rule you write wins; with nobody there to answer, OpenCode refuses. The plugin option \`askByDefault: false\`, or the variable below, leaves it to OpenCode's rules alone; an \`allow\` rule you write doesn't skip the question. In OpenCode 2.4.1's TUI, the prompt says only "Call tool <action>", with the details on the model's call line above it, and a prompt for a registry an ARD referral names shows no host. After a load or a wake, what the model does goes through OpenCode's rules, whose default allows it. When OpenCode supports an extension itself, remove that plugin or use its off switch:

| OpenCode form | Off switch | Leave it to OpenCode's rules |
|---|---|---|
| Events | \`MCP_EVENTS_OFF=1\` | \`MCP_EVENTS_ASK_BY_DEFAULT=0\` |
| Skills | \`MCP_SKILLS_OFF=1\` | \`MCP_SKILLS_ASK_BY_DEFAULT=0\` |
| Server Cards | \`MCP_SERVER_CARDS_DISABLED=1\` | \`MCP_SERVER_CARDS_ASK_BY_DEFAULT=0\` |
| ARD | \`ARD_DISCOVERY_DISABLED=1\` | \`ARD_DISCOVERY_ASK_BY_DEFAULT=0\` |

Each also takes the plugin options \`{"off": true}\` and \`{"askByDefault": false}\`, in the object form of its entry in \`plugins\`.

${T3_NOTE}

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
