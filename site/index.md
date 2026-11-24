---
layout: home
markdownStyles: false
titleTemplate: false
title: AgentPolyfill
description: Open agent extensions, in the host you already have. Claude Code plugins that add MCP Events, Apps, Skills and Server Cards.
hero:
  name: AgentPolyfill
  text: Open agent extensions, in the host you already have.
  tagline: "Claude Code and MCP first. Plugins that add four MCP extensions to Claude Code: Events, Apps, Skills and Server Cards. Servers need no changes."
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
  <h2>What a polyfill does</h2>
  <p class="lede">MCP now grows through extensions: Apps, Skills, Events, Server Cards. A server can adopt one quickly. Each host has to build and ship each one, on its own schedule. A polyfill closes that gap from the outside: it implements one published extension's client side as a plugin, follows that extension's spec (any exception is listed and can be switched off), and steps aside when the host ships its own.</p>
  <PolyfillCards />
  <p class="lede beyond">Beyond MCP, <a href="/guide/ard"><code>ard-discovery</code></a> adds Agentic Resource Discovery v0.91, a draft: it finds MCP servers through a domain's <code>ard.json</code> or by searching an ARD registry, and hands the cards to <code>mcp-server-cards</code>. Its search sends the words of your request to that registry, and asks you first every time; for that reason it is not part of the <code>agent-polyfill</code> bundle. Install it by name.</p>
</section>

<section>
  <h2>Who it is for</h2>
  <p class="lede">The aim is an open community around open specs, where anyone can use these capabilities in the host they have, build the next polyfill, or propose a new extension, and support does not depend on one host's roadmap. Today that is Claude Code, four MCP extensions, and one open draft beyond MCP (Agentic Resource Discovery). Other hosts are where it is meant to go; they are not built yet.</p>
  <Audiences />
</section>

</div></div>
