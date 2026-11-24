---
layout: home
markdownStyles: false
titleTemplate: false
title: AgentPolyfill
description: Open agent extensions, in the host you already have. Claude Code plugins that add MCP Events, Apps, Skills and Server Cards.
hero:
  name: AgentPolyfill
  text: Open agent extensions, in the host you already have.
  tagline: MCP Events, Apps, Skills and Server Cards for Claude Code. No server changes.
  image:
    light: /mark-light.svg
    dark: /mark-dark.svg
    alt: ""
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/idosal/AgentPolyfill
---

<div class="ap-home"><div class="wrap">

<section>
  <h2>See it in action</h2>
  <LaunchVideo />
</section>

<section>
  <h2>The polyfills</h2>
  <p class="lede">Each adds one MCP extension's client side to Claude Code, to its spec, until Claude Code ships its own.</p>
  <PolyfillCards />
  <h3 class="beyond">Beyond MCP</h3>
  <PolyfillCards group="beyond" />
</section>

<section>
  <h2>Who it is for</h2>
  <Audiences />
</section>

</div></div>
