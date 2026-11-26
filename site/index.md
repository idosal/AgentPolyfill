---
layout: home
markdownStyles: false
titleTemplate: false
title: AgentPolyfill
description: "Plugins for MCP Events, Skills, Server Cards and Apps, with optional Agentic Resource Discovery."
hero:
  name: AgentPolyfill
  text: Polyfills for agent protocols
  tagline: Watch server events, load remote skills, discover MCP servers and use interactive apps in your agent.
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

<section aria-label="Plugin demonstrations">
  <LaunchVideo />
</section>

<section>
  <h2>The polyfills</h2>
  <p class="lede">Choose an extension to see its supported hosts, install command and examples.</p>
  <PolyfillCards />
  <h3 class="beyond">Beyond MCP</h3>
  <PolyfillCards group="beyond" />
  <p class="closing"><a href="/guide/build-a-polyfill">Build a polyfill</a> · <a href="/guide/community">Community plugins</a> · <a href="/guide/spec-authors">Conformance results</a></p>
</section>

</div></div>
