---
layout: home
markdownStyles: false
titleTemplate: false
title: AgentPolyfill
description: "Polyfills for agent protocols: run new MCP extensions (Events, Apps, Skills, Server Cards) in the agent you already use, before its host supports them. Today in Claude Code and Codex."
hero:
  name: AgentPolyfill
  text: Polyfills for agent protocols
  tagline: Run new MCP extensions in the agent you already use, before its host supports them. No server changes. Today in Claude Code and Codex.
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
    - theme: alt
      text: Security
      link: /guide/security
---

<div class="ap-home"><div class="wrap">

<section aria-label="The launch video">
  <LaunchVideo />
</section>

<section>
  <h2>The polyfills</h2>
  <p class="lede">Each implements one MCP extension's client side, to spec, until the host ships its own.</p>
  <PolyfillCards />
  <h3 class="beyond">Beyond MCP</h3>
  <PolyfillCards group="beyond" />
  <p class="closing">Building a polyfill, bringing one to another host, or writing a spec? <a href="/guide/build-a-polyfill">Build a polyfill</a> · <a href="/guide/community">Community</a> · <a href="/guide/spec-authors">For spec authors</a></p>
</section>

</div></div>
