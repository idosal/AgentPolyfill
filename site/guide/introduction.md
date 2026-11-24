---
description: What AgentPolyfill is, which MCP extensions it adds to Claude Code and Codex, and who it is for.
---

# Introduction

AgentPolyfill makes polyfills for agent protocols. Bring more of MCP to the
clients you already use. Plugins add Apps, Skills, Events, Server Cards and
ARD to Claude Code and Codex: Events, Skills and Server Cards run in both,
Apps runs in Claude Code, and Agentic Resource Discovery, an open draft beyond
MCP, runs in both.

> **An early proof of concept.** It works today, and it has real gaps. Events,
> Skills and Apps can't reach servers behind OAuth yet, Apps doesn't run in
> Codex, and a few spec rules can't be met from a plugin. Each gap comes from
> what the hosts' plugin APIs expose, and small, generic changes to those APIs
> would close them:
> [what hosts would need to change](./how-it-works#how-it-works-in-each-host-and-where-it-stops).

## Why polyfills

MCP grows through extensions now: Apps, Skills, Events, Server Cards. A server
can adopt one in a day, but every host has to build each one itself, on its
own schedule, so a new extension can sit unused for months. A polyfill closes
that gap from the outside. It implements one published extension's client side
as a plugin, follows that extension's spec (any exception is listed and can be
switched off), and steps aside once the host ships its own. Servers don't
change at all.

We want this to be an open community around open specs: anyone can use these
extensions in the host they have, bring a polyfill to another host, or propose
a new extension, without waiting on one company's roadmap.

## The polyfills

| Extension | Spec | Claude Code | Codex |
|---|---|---|---|
| [Events](./events) | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | `mcp-events` | `mcp-events` |
| [Skills](./skills) | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | `mcp-skills` | `mcp-skills` |
| [Server Cards](./server-cards) | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (the extension is Beta) | `mcp-server-cards` | `mcp-server-cards` |
| [Apps](./apps) | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 2026-01-26, Stable | `mcp-apps-cli` | not yet |
| [ARD](./ard) (beyond MCP) | [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91, a draft | `ard-discovery` | `ard-discovery` |

All of them are early. Here is what each one does, and where it stops:

- **Events.** The agent watches events on your MCP servers, by poll, push or
  webhook, and an event wakes an idle session. In Codex, a woken session is a
  Codex CLI session (the terminal app or `codex exec`): a chat in the ChatGPT
  desktop app keeps its events but can't be woken, so ask it for
  `recent_events`. A resumed Codex session starts watching at its first Events
  tool call.
- **Skills.** Skills an MCP server serves show up next to your own, load only
  after you say yes to each one, and are checked against the server's
  digests. In Codex they appear in Codex's own skill list after you ask once
  to list the served skills, from the next turn. One rule of the spec can't be
  met in Codex yet: a skill from one server reading another server's resources
  isn't put to you first (rule X8), because Codex doesn't let a plugin ask.
- **Server Cards.** Name a company and the agent finds the MCP servers its
  domain publishes, checks each card against the schema, and adds the one you
  pick to the host's own configuration. The host then connects it with its own
  sign-in, so servers behind OAuth work. You see the host it connects to
  before you add it.
- **Apps.** A server's app opens right under the tool call in the terminal
  and answers the mouse and keyboard: real pixels in iTerm2, kitty and
  Ghostty, text cells everywhere else.

Events, Skills and Apps can't reach servers behind OAuth yet, in either host.
[How it works](./how-it-works#how-it-works-in-each-host-and-where-it-stops)
says why, and what would fix it.

**Beyond MCP**, [`ard-discovery`](./ard) adds
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91,
a draft, in both hosts. It finds MCP servers through a domain's `ard.json`, or
by searching an ARD registry you choose, and hands the cards to
`mcp-server-cards`. A search sends the words of your request to that
registry, so every search asks you first and names where it's going. That's
also why it isn't part of the `agent-polyfill` bundle; install it by name.

Neither host supports these extensions itself yet. On 23 November 2026 the
official
[extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
listed Tasks for Claude Code, and none of Events, Apps or Skills (Server Cards
isn't in the matrix). Codex doesn't support Events for your own servers, or
Skills (openai/codex#48000). Hosts add extensions all the time, so check the
matrix for today's picture. The Skills SEP notes that Claude Code support has
been prototyped at Anthropic.

## Who it is for

- **If you use Claude Code or Codex,** installing takes one line and trying it
  takes one more. See [Getting started](./getting-started).
- **If you build,** the `create-polyfill` and `design-extension` skills and the
  contract every polyfill here meets are your starting point. New polyfills,
  and existing ones brought to another host, are welcome:
  [Build a polyfill](./build-a-polyfill). If you keep one in your own
  repository, list it in the [community directory](./community).
- **If you write specs,** a polyfill can be the client half of the two
  implementations an extension needs to reach Stable:
  [For spec authors](./spec-authors).

## Before you install

These are third-party plugins, and they run with your permissions, like every
Claude Code mod and Codex plugin. None of them reads the host's stored
credentials: not Claude Code's, and not Codex's sign-ins or tokens. Each
polyfill's `SECURITY.md` says what it checks and what it doesn't protect
against; [Security](./security) collects them.

AgentPolyfill isn't affiliated with Anthropic, OpenAI, MCP, ARD or the AAIF.
See [About](/about).
