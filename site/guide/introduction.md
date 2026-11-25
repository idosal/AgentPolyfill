---
description: What AgentPolyfill is, which polyfills run in each host, and who it is for.
---

# Introduction

AgentPolyfill makes polyfills for agent protocols. Bring more of MCP to the
clients you already use. Plugins and extensions add the client side of MCP
extensions to a host that hasn't shipped them yet. The table below shows
what runs in each host, including Agentic Resource Discovery, an open draft
beyond MCP.

> **An early proof of concept.** Some gaps, like servers behind OAuth, need
> small changes to the hosts' plugin APIs.
> [What's missing](./how-it-works#how-it-works-in-each-host-and-where-it-stops).

## Why polyfills

MCP grows through extensions now: Apps, Skills, Events, Server Cards. A server
can adopt one in a day, but every host has to build each one itself, on its
own schedule, so a new extension can sit unused for months. A polyfill closes
that gap from the outside. It implements one published extension's client side
as a plugin or extension, follows that extension's spec (any exception is
listed and can be switched off), and steps aside once the host ships its own.
Servers don't change at all.

We want this to be an open community around open specs: anyone can use these
extensions in the host they have, bring a polyfill to another host, or propose
a new extension, without waiting on one company's roadmap.

## The polyfills

| Extension | Spec | Claude Code | Codex | Pi | Antigravity |
|---|---|---|---|---|---|
| [Events](./events) | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | `mcp-events` | `mcp-events` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity) |
| [Skills](./skills) | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | `mcp-skills` | `mcp-skills` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity) |
| [Server Cards](./server-cards) | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (the extension is Beta) | `mcp-server-cards` | `mcp-server-cards` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity) |
| [Apps](./apps) | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 2026-01-26, Stable | `mcp-apps-cli` | not yet | not available | native in the App (v2.34.0+); the CLI and IDE show text |
| [ARD](./ard) (beyond MCP) | [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91, a draft | `ard-discovery` | `ard-discovery` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity) |

The Pi forms were tested with Pi 1.6.0 and need Node 22 or newer. Nothing for
Pi is published to npm or Pi's package gallery. Install the extensions from
a clone, with nothing to build; [Getting started](./getting-started#pi) has
the steps.

The Antigravity forms are plugins, in one format for the App, the CLI
(`agy`) and the IDE. They were run with App v2.35.1 and CLI v1.5.16 (ARD in
the CLI only), and need Node 20 or newer on `PATH`. The IDE wasn't run. Nothing is published to Antigravity's
Marketplace; [Getting started](./getting-started#antigravity) has the
clone-and-install steps.

All of them are early. Here is what each one does, and where it stops:

- **Events.** The agent watches events on your MCP servers, by poll, push or
  webhook, and an event wakes an idle session. In Codex, a woken session is a
  Codex CLI session (the terminal app or `codex exec`): a chat in the ChatGPT
  desktop app keeps its events but can't be woken, so ask it for
  `recent_events`. A resumed Codex session starts watching at its first Events
  tool call. In Pi, each watch asks you first; an event wakes the idle
  session with a message starting `[mcp-events]` that says the extension
  sent it, and Pi reads the event with `get_event`. In Antigravity, new
  events reach the conversation at its next model call. An idle App
  conversation wakes only through the plugin's sidecar, which you turn on;
  CLI conversations can't be woken.
- **Skills.** Skills an MCP server serves show up next to your own, load only
  after you say yes to each one, and are checked against the server's
  digests. In Codex they appear in Codex's own skill list after you ask once
  to list the served skills, from the next turn. One rule of the spec can't be
  met in Codex yet: a skill from one server reading another server's resources
  isn't put to you first (rule X8), because Codex doesn't let a plugin ask.
  In Pi, served skills appear as `mcp-<server>-<name>`, marked with their
  server. X8 is met: a cross-server read while a served skill is loaded asks
  you first, naming both servers, including calls made through codemode.
  In Antigravity, served skills appear as placeholder folders in
  `~/.gemini/config/skills/`, and loading one is put to you in Antigravity's
  approval card. X8 isn't met there, as in Codex: the plugin can't put a
  question in front of Antigravity's own resource reads, so the loaded skill
  tells the model to ask you first.
- **Server Cards.** Name a company and the agent finds the MCP servers its
  domain publishes, checks each card against the schema, and adds the one you
  pick to the host's own configuration. The host then connects it with its own
  sign-in, so servers behind OAuth work. You see the host it connects to
  before you add it. In Pi, the extension asks before running `pi mcp add`
  and registers the server for the current session, without a restart.
  In Antigravity, the addition is put to you in Antigravity's approval card,
  then written to `~/.gemini/config/mcp_config.json`.
- **Apps.** A server's app opens right under the tool call in the terminal
  and answers the mouse and keyboard: real pixels in iTerm2, kitty and
  Ghostty, text cells everywhere else. There is no Pi form: Pi 1.6.0 leaves
  out `ui://` resources and tool `_meta`, so an extension can't get an App's
  UI. Nothing for Apps in Pi is built or tested. There is no Antigravity
  form either: its App renders MCP Apps itself (v2.34.0 and later), and its
  CLI and IDE show text only.

Events and Skills can't use a host's OAuth sign-in. Apps has the same limit
in its available form. In Pi, Events and Skills open their own connections,
so a local (stdio) server runs twice. Headers in `mcp.json` work, including
`${VARIABLE}` and `!command` values; Pi's stored sign-ins and `auth.provider`
are out of reach. Events also needs protocol revision 2026-07-28, while
Pi 1.6.0's own MCP client stops at 2025-11-25. In Antigravity, Events and
Skills can't reach servers behind Antigravity's own sign-in, and a Server
Card that needs a secret can't be added.
[How it works](./how-it-works#how-it-works-in-each-host-and-where-it-stops)
says why, and what would fix it.

**Beyond MCP**, [`ard-discovery`](./ard) adds
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91,
a draft. It finds MCP servers through a domain's `ard.json`, or
by searching an ARD registry you choose, and hands the cards to
`mcp-server-cards`. The Pi form carries the Server Cards checks and its own
add tool, `ard_add_mcp_server`. The Antigravity form carries the Server Cards
checks and add step too.
A search sends the words of your request to that
registry, so every search asks you first and names where it's going. That's
also why it isn't part of the `agent-polyfill` bundle; install it by name.
Pi's recorded live run showed domain discovery and an approved search of the
repository's demo registry. It did not complete the add step: the model
asked in chat instead of calling the add tool. Addition is covered by tests
in real Pi with a scripted model and a local server. In Antigravity, every
registry search and every addition is put to you in Antigravity's approval
card. ARD was run in Antigravity's CLI only, not in the App.

Native support is separate from these polyfills:

- **Claude Code:** on 23 November 2026 the official
  [extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
  listed Tasks, and none of Events, Apps or Skills (Server Cards isn't in
  the matrix). The Skills SEP notes that Claude Code support has been
  prototyped at Anthropic.
- **Codex:** doesn't support Events for your own servers, or Skills
  (openai/codex#48000).
- **Pi:** 1.6.0 supports none of them itself; its MCP client implements no
  MCP extension. The Pi forms can't detect native support themselves, so
  remove them or use their off switches when Pi supports an extension.
- **Antigravity:** its App renders MCP Apps itself (v2.34.0 and later); the
  CLI and IDE show text only. The Antigravity forms can't detect native
  support: Antigravity tells plugins nothing about its MCP client's
  extensions. Disable or uninstall them, or use their off switches, when
  Antigravity supports an extension.

Hosts add extensions all the time, so check the matrix for today's picture.

## Who it is for

- **If you use an agent host,** see its install steps and first run in
  [Getting started](./getting-started).
- **If you build,** the `create-polyfill` and `design-extension` skills and the
  contract every polyfill here meets are your starting point. New polyfills,
  and existing ones brought to another host, are welcome:
  [Build a polyfill](./build-a-polyfill). If you keep one in your own
  repository, list it in the [community directory](./community).
- **If you write specs,** a polyfill can be the client half of the two
  implementations an extension needs to reach Stable:
  [For spec authors](./spec-authors).

## Before you install

These are third-party plugins and extensions, and they run with your
permissions. None of them reads the host's stored credentials. Pi runs tool
calls without asking unless a permission extension asks; each polyfill adds
its own question before a watch, skill load, registry search or server add.
In Antigravity, each polyfill asks through Antigravity's own approval card,
which can't be approved for good.
Each polyfill's `SECURITY.md` says what it checks and what it doesn't protect
against; [Security](./security) collects them.

AgentPolyfill isn't affiliated with Anthropic, OpenAI, MCP, ARD or the AAIF.
See [About](/about).
