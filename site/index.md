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
  <h3 class="beyond">Beyond MCP</h3>
  <p class="lede">The same approach for an open draft outside MCP, installed on its own.</p>
  <PolyfillCards group="beyond" />
</section>

<section>
  <h2>Who it is for</h2>
  <Audiences />
</section>

</div></div>
