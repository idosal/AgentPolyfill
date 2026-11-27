import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitepress'

const repo = 'https://github.com/idosal/AgentPolyfill'
const site = 'https://agentpolyfill.com'
// The link-preview card (og/og.html, rendered to public/og.jpg). Its hash is in
// the URL, so services that cached an older card fetch the new one.
const ogVersion = createHash('sha256')
  .update(readFileSync(new URL('../public/og.jpg', import.meta.url)))
  .digest('hex')
  .slice(0, 12)
const ogImage = `${site}/og.jpg?v=${ogVersion}`
const description =
  'Plugins for MCP Events, Skills, Server Cards and Apps, with optional Agentic Resource Discovery.'

export default defineConfig({
  lang: 'en',
  title: 'AgentPolyfill',
  description,
  cleanUrls: true,
  lastUpdated: false,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/mark.svg' }],
    ['meta', { name: 'theme-color', content: '#0b6b53' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'AgentPolyfill' }],
    ['meta', { property: 'og:title', content: 'AgentPolyfill' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { property: 'og:image', content: ogImage }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'AgentPolyfill: polyfills for agent protocols. Bring more of MCP to the clients you already use. Plugins add Apps, Skills, Events, Server Cards and ARD to Claude Code and Codex.' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'AgentPolyfill' }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: ogImage }],
    // Without JavaScript, the launch video's poster image would cover its
    // controls; hide it, and the browser's own controls show.
    ['noscript', {}, '<style>.ap-launch .poster{display:none}</style>'],
  ],

  sitemap: { hostname: site },

  // The community directory lives at the repository's root
  // (../community/polyfills.json); let the dev server read it.
  vite: { server: { fs: { allow: ['..'] } } },

  // Each page's Markdown copy, written by scripts/agents.mjs after the build.
  transformHead({ pageData, assets }) {
    // The text face, fetched with the CSS rather than after it.
    const font = assets.find((a) => /schibsted-grotesk-latin-wght-normal\.[\w-]+\.woff2$/.test(a))
    const preload = font ? [['link', { rel: 'preload', href: font, as: 'font', type: 'font/woff2', crossorigin: '' }]] : []
    if (pageData.isNotFound || pageData.relativePath === '404.md') return preload
    const page = pageData.relativePath.replace(/\.md$/, '')
    return [
      ...preload,
      ['link', { rel: 'alternate', type: 'text/markdown', href: `/${page}.md`, title: 'This page as Markdown' }],
      ['link', { rel: 'alternate', type: 'text/plain', href: '/llms.txt', title: 'llms.txt' }],
    ]
  },

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },

  themeConfig: {
    logo: { light: '/mark-light.svg', dark: '/mark-dark.svg', alt: '' },
    siteTitle: 'AgentPolyfill',

    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '^/guide/(introduction|getting-started|how-it-works|security)' },
      {
        text: 'Polyfills',
        activeMatch: '^/guide/(events|apps|skills|server-cards|ard|a2a|tasks)',
        items: [
          {
            text: 'MCP extensions',
            items: [
              { text: 'Events', link: '/guide/events' },
              { text: 'Skills', link: '/guide/skills' },
              { text: 'Server Cards', link: '/guide/server-cards' },
              { text: 'Apps', link: '/guide/apps' },
              { text: 'Tasks', link: '/guide/tasks' },
            ],
          },
          {
            text: 'Beyond MCP',
            items: [{ text: 'A2A delegation', link: '/guide/a2a' }, { text: 'ARD discovery', link: '/guide/ard' }],
          },
        ],
      },
      {
        text: 'Build',
        activeMatch: '^/guide/(build-a-polyfill|spec-authors|contributing|community)',
        items: [
          { text: 'Build a polyfill', link: '/guide/build-a-polyfill' },
          { text: 'For spec authors', link: '/guide/spec-authors' },
          { text: 'Contributing', link: '/guide/contributing' },
          { text: 'Community', link: '/guide/community' },
        ],
      },
      { text: 'About', link: '/about' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Start',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Polyfills',
          items: [
            { text: 'Events', link: '/guide/events' },
            { text: 'Skills', link: '/guide/skills' },
            { text: 'Server Cards', link: '/guide/server-cards' },
            { text: 'Apps', link: '/guide/apps' },
            { text: 'Tasks', link: '/guide/tasks' },
          ],
        },
        {
          text: 'Beyond MCP',
          items: [{ text: 'A2A delegation', link: '/guide/a2a' }, { text: 'ARD discovery', link: '/guide/ard' }],
        },
        {
          text: 'Build',
          items: [
            { text: 'Build a polyfill', link: '/guide/build-a-polyfill' },
            { text: 'For spec authors', link: '/guide/spec-authors' },
            { text: 'Contributing', link: '/guide/contributing' },
            { text: 'Community', link: '/guide/community' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'How it works', link: '/guide/how-it-works' },
            { text: 'Security', link: '/guide/security' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: repo, ariaLabel: 'AgentPolyfill on GitHub' },
    ],

    editLink: {
      pattern: `${repo}/edit/main/site/:path`,
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: { prev: 'Previous', next: 'Next' },

    footer: {
      message: '<a href="/about">About AgentPolyfill</a>',
      copyright: `Apache-2.0 · <a href="${repo}">Source on GitHub</a> · <a href="/llms.txt">llms.txt</a>`,
    },

    externalLinkIcon: true,
  },
})
