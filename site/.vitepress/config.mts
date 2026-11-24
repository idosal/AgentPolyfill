import { defineConfig } from 'vitepress'

const repo = 'https://github.com/idosal/AgentPolyfill'
const site = 'https://agentpolyfill.com'
const description =
  'Open agent extensions, in the host you already have. Plugins for Claude Code and Codex that add MCP Events, Apps, Skills and Server Cards.'

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
    ['meta', { property: 'og:image', content: `${site}/media/launch-poster.jpg` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  sitemap: { hostname: site },

  // The community directory lives at the repository's root
  // (../community/polyfills.json); let the dev server read it.
  vite: { server: { fs: { allow: ['..'] } } },

  // Each page's Markdown copy, written by scripts/agents.mjs after the build.
  transformHead({ pageData }) {
    if (pageData.isNotFound || pageData.relativePath === '404.md') return []
    const page = pageData.relativePath.replace(/\.md$/, '')
    return [
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
        activeMatch: '^/guide/(events|apps|skills|server-cards|ard)',
        items: [
          {
            text: 'MCP extensions',
            items: [
              { text: 'Events', link: '/guide/events' },
              { text: 'Apps', link: '/guide/apps' },
              { text: 'Skills', link: '/guide/skills' },
              { text: 'Server Cards', link: '/guide/server-cards' },
            ],
          },
          {
            text: 'Beyond MCP',
            items: [{ text: 'ARD discovery', link: '/guide/ard' }],
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
            { text: 'Apps', link: '/guide/apps' },
            { text: 'Skills', link: '/guide/skills' },
            { text: 'Server Cards', link: '/guide/server-cards' },
          ],
        },
        {
          text: 'Beyond MCP',
          items: [{ text: 'ARD discovery', link: '/guide/ard' }],
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

    socialLinks: [{ icon: 'github', link: repo, ariaLabel: 'AgentPolyfill on GitHub' }],

    editLink: {
      pattern: `${repo}/edit/main/site/:path`,
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: { prev: 'Previous', next: 'Next' },

    footer: {
      message:
        'A community project. Not affiliated with or endorsed by the MCP project, the Agentic AI Foundation, the Linux Foundation, Anthropic, any host vendor, or the authors of Agentic Resource Discovery. <a href="/about">About</a>',
      copyright: `Apache-2.0 · <a href="${repo}">Source on GitHub</a> · <a href="/llms.txt">llms.txt</a>`,
    },

    externalLinkIcon: true,
  },
})
