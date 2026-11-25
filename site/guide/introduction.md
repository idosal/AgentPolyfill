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

| Extension | Spec | Claude Code | Codex | Pi | OpenCode | Muse Code |
|---|---|---|---|---|---|---|
| [Events](./events) | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | `mcp-events` | `mcp-events` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/opencode) | [`mcp-events`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/muse) (at your next message) |
| [Skills](./skills) | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | `mcp-skills` | `mcp-skills` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/opencode) | [`mcp-skills`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/muse) |
| [Server Cards](./server-cards) | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (the extension is Beta) | `mcp-server-cards` | `mcp-server-cards` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/opencode) | [`mcp-server-cards`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/muse) |
| [Apps](./apps) | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 2026-01-26, Stable | `mcp-apps-cli` | not yet | not available | not available | not available |
| [ARD](./ard) (beyond MCP) | [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91, a draft | `ard-discovery` | `ard-discovery` | [extension](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi) | [plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/opencode) | [`ard-discovery`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/muse) (no registry search) |

The Pi forms were tested with Pi 1.6.0 and need Node 22 or newer. Nothing for
Pi is published to npm or Pi's package gallery. Install the extensions from
a clone, with nothing to build; [Getting started](./getting-started#pi) has
the steps.

The OpenCode forms need OpenCode 2.4 or newer and were tested with 2.4.1.
OpenCode runs them itself, so they need no Node. Nothing for OpenCode is
published to npm: OpenCode installs each plugin from this repository on
GitHub, with Git; [Getting started](./getting-started#opencode) has the steps.

The Muse Code forms are the Codex plugins, which Muse installs from this
repository's marketplace. They were tested with Muse Code 1.4.25 on macOS
only, and need Node 20 or newer. No run used a real model: every run used
Muse's echo provider, or a local stand-in for the model.
[Getting started](./getting-started#muse-code) has the steps, and
[AgentPolyfill in Muse Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/muse.md)
says what works differently there, and why.

All of them are early. Here is what each one does, and where it stops:

- **Events.** The agent watches events on your MCP servers, by poll, push or
  webhook, and an event wakes an idle session. In Codex, a woken session is a
  Codex CLI session (the terminal app or `codex exec`): a chat in the ChatGPT
  desktop app keeps its events but can't be woken, so ask it for
  `recent_events`. A resumed Codex session starts watching at its first Events
  tool call. In Pi, each watch asks you first; an event wakes the idle
  session with a message starting `[mcp-events]` that says the extension
  sent it, and Pi reads the event with `get_event`. In OpenCode, each watch
  asks you first too; an event wakes the idle session with a message from the
  plugin, which the TUI shows as `◈ mcp-events: new events` and OpenCode
  Desktop doesn't show, so there the turn starts with no visible cause.
  OpenCode's own client takes push events for its automations, but skips
  event types whose schemas it can't check, so the polyfill watches every
  type, push included, and tells the model to use a watch or an automation,
  not both: a stated departure from the contract's rule 4. In Muse Code, a
  watch starts, and stops, only after you type the phrase the answer gives,
  such as `watch 4821`. New events reach the model with your next message;
  nothing wakes an idle session unless you turn on an experimental opt-in.
- **Skills.** Skills an MCP server serves show up next to your own, load only
  after you say yes to each one, and are checked against the server's
  digests. In Codex they appear in Codex's own skill list after you ask once
  to list the served skills, from the next turn. One rule of the spec can't be
  met in Codex yet: a skill from one server reading another server's resources
  isn't put to you first (rule X8), because Codex doesn't let a plugin ask.
  In Pi, served skills appear as `mcp-<server>-<name>`, marked with their
  server. X8 is met: a cross-server read while a served skill is loaded asks
  you first, naming both servers, including calls made through codemode.
  In OpenCode, served skills appear in OpenCode's own skill list as
  `mcp-skills:<server>:<name>`, marked with their server, and a load takes two
  steps: OpenCode's skill tool returns the plugin's note, then the model asks
  the plugin for the skill, and OpenCode asks you. There is no preview of its
  `SKILL.md` before you decide. X8 is met there too: once a served skill is
  loaded, OpenCode's own read of another server's resource asks first, naming
  both servers, including from Code Mode and in subagents.
  In Muse Code, a load waits until you type the phrase the answer gives,
  such as `load 4821`, because Muse gives a plugin no way to ask you.
- **Server Cards.** Name a company and the agent finds the MCP servers its
  domain publishes, checks each card against the schema, and adds the one you
  pick to the host's own configuration. The host then connects it with its own
  sign-in, so servers behind OAuth work. You see the host it connects to
  before you add it. In Pi, the extension asks before running `pi mcp add`
  and registers the server for the current session, without a restart. In
  OpenCode, the plugin adds it to OpenCode's MCP servers after OpenCode asks,
  and OpenCode connects it at once. It isn't written to your configuration
  files: the plugin keeps it for that project and adds it again each time
  OpenCode loads the plugin there. In Muse Code, it writes nothing: it gives
  you the `muse mcp add …` command, which you run yourself.
- **Apps.** A server's app opens right under the tool call in the terminal
  and answers the mouse and keyboard: real pixels in iTerm2, kitty and
  Ghostty, text cells everywhere else. There is no Pi form: Pi 1.6.0 leaves
  out `ui://` resources and tool `_meta`, so an extension can't get an App's
  UI. Nothing for Apps in Pi is built or tested. There is no OpenCode form
  either: OpenCode has no MCP Apps support, and a plugin can't read a `ui://`
  resource or a tool's `_meta` over OpenCode's connection. An OpenCode form
  was assessed, not built. Nor is there a Muse Code form: Muse gives a plugin
  no way to draw in its terminal.

Events and Skills can't use a host's OAuth sign-in. Apps has the same limit
in its available form. In Pi, Events and Skills open their own connections,
so a local (stdio) server runs twice. Headers in `mcp.json` work, including
`${VARIABLE}` and `!command` values; Pi's stored sign-ins and `auth.provider`
are out of reach. Events also needs protocol revision 2026-07-28, while
Pi 1.6.0's own MCP client stops at 2025-11-25. In OpenCode, Events and
Skills open their own connections too, so a local server runs twice. The
headers in a server's OpenCode configuration work; a server OpenCode signs in
to with `opencode mcp auth` is out of reach. In Muse Code, Events and Skills
read the servers in Muse's settings, never its sign-in store, so they can't
reach OAuth servers: a server signed in with `muse mcp login` is skipped, and
so is one whose values come from `${VAR}`.
[How it works](./how-it-works#how-it-works-in-each-host-and-where-it-stops)
says why, and what would fix it.

**Beyond MCP**, [`ard-discovery`](./ard) adds
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91,
a draft. It finds MCP servers through a domain's `ard.json`, or
by searching an ARD registry you choose, and hands the cards to
`mcp-server-cards`. The Pi form carries the Server Cards checks and its own
add tool, `ard_add_mcp_server`.
A search sends the words of your request to that
registry, so every search asks you first and names where it's going. That's
also why it isn't part of the `agent-polyfill` bundle; install it by name.
Pi's recorded live run showed domain discovery and an approved search of the
repository's demo registry. It did not complete the add step: the model
asked in chat instead of calling the add tool. Addition is covered by tests
in real Pi with a scripted model and a local server.
The OpenCode form carries the Server Cards code and its own add tool,
`ard_add_mcp_server`. OpenCode's live run read buildkite.com's `ard.json` and
sent a search to the repository's demo registry after OpenCode asked. In
OpenCode's TUI, the prompt for a registry a referral names doesn't show that
registry. Addition is covered by tests in real OpenCode with a scripted model
and a local server.
In Muse Code, ARD has no registry search, because a search must ask you
first.

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
- **OpenCode:** 2.4 has part of Events itself: its MCP client takes push
  events for its automations, but doesn't poll or take webhooks, and skips
  event types whose schemas it can't check. 2.4.1 has no support for Skills,
  Server Cards or Apps. Remove a polyfill or use its off switch when OpenCode
  supports its extension.
- **Muse Code:** no form detects native support. Disable the plugin
  (`muse plugins disable <name>`) when Muse ships the extension.

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
OpenCode's shipped permission rules allow every action; each OpenCode
polyfill puts its own actions to those rules and asks you by default.
Muse Code gives a plugin no way to ask you, so starting or stopping a watch
and loading a skill wait for a phrase you type, and you run `muse mcp add`
yourself.
Each polyfill's `SECURITY.md` says what it checks and what it doesn't protect
against; [Security](./security) collects them.

AgentPolyfill isn't affiliated with Anthropic, OpenAI, MCP, ARD or the AAIF.
See [About](/about).
