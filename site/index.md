---
layout: home
markdownStyles: false
titleTemplate: false
title: AgentPolyfill
description: Open agent extensions, in the host you already have. Claude Code plugins that add MCP Events, Apps, Skills and Server Cards.
hero:
  name: AgentPolyfill
  text: Open agent extensions, in the host you already have.
  tagline: "Claude Code plugins that add MCP Events, Apps, Skills and Server Cards. No server changes needed."
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/idosal/AgentPolyfill
---

<div class="ap-home"><div class="wrap">

<section aria-label="Launch video">
  <LaunchVideo />
</section>

<section>
  <h2>The polyfills</h2>
  <p class="lede">Each one implements a published MCP extension's client side, follows its spec, and steps aside when Claude Code ships its own.</p>
  <PolyfillCards />
  <p class="lede beyond">Beyond MCP, <a href="/guide/ard"><code>ard-discovery</code></a> finds servers through Agentic Resource Discovery (v0.91, a draft). Its search sends your query to a third-party registry, so it asks you every time and is installed on its own, outside the bundle.</p>
</section>

<section>
  <h2>Who it is for</h2>
  <Audiences />
</section>

</div></div>
