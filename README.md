# AgentPolyfill

Polyfills for agent protocols. Run new MCP extensions in the agent you already
use, before its host supports them. Today in Claude Code and Codex.

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

- **If you use Claude Code or Codex,** installing takes one line and trying it
  takes one more. See below.
- **If you build,** the `create-polyfill` and `design-extension` skills and the
  [contract](docs/polyfill-contract.md) every polyfill here meets are your
  starting point. New polyfills, and existing ones brought to another host,
  are welcome: [Build one](#build-one). If you keep one in your own
  repository, list it in the [community directory](community/).
- **If you write specs,** a polyfill can be the client half of the two
  implementations an extension needs to reach Stable:
  [For spec authors](#for-spec-authors).

## Install

**Claude Code** (2.1.329 or newer). At the prompt of a `claude` session,
install every polyfill at once:

```
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

Or install just one, with its name in place of `agent-polyfill`:
`mcp-events`, `mcp-apps-cli`, `mcp-skills` or `mcp-server-cards`. Then start a
new `claude` session.

**Codex** (0.170 or newer; Skills was tested on 0.172; Node 20 or newer). In a
terminal:

```
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-events@agent-polyfill
codex plugin add mcp-skills@agent-polyfill
codex plugin add mcp-server-cards@agent-polyfill
```

There are [more ways to install](#more-ways-to-install) further down.

## Polyfills

| Extension | Spec | Claude Code | Codex |
|---|---|---|---|
| Events | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | [`mcp-events`](polyfills/events/claude-code) | [`mcp-events`](polyfills/events/codex) |
| Skills | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | [`mcp-skills`](polyfills/skills/claude-code) | [`mcp-skills`](polyfills/skills/codex) |
| Server Cards | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (the extension is Beta) | [`mcp-server-cards`](polyfills/server-cards/claude-code) | [`mcp-server-cards`](polyfills/server-cards/codex) |
| Apps | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 2026-01-26, Stable | [`mcp-apps-cli`](polyfills/apps/claude-code) | not yet |

All of them are early. Here is what each one does, and where it stops:

- **Events.** The agent watches events on your MCP servers, by poll, push or
  webhook, and an event wakes an idle session. In Codex, a woken session is a
  Codex CLI session (the terminal app or `codex exec`): a chat in the ChatGPT
  desktop app keeps its events but can't be woken, so ask it for
  `recent_events`. A resumed Codex session starts watching at its first Events
  tool call.
- **Skills.** Skills an MCP server serves show up next to your own, load only
  after you say yes to each one, and are checked against the server's
  digests. In Codex they appear in Codex's own skill list from the session
  after a server first serves them. One rule of the spec can't be met in Codex
  yet: a skill from one server reading another server's resources isn't put
  to you first (rule X8), because Codex doesn't let a plugin ask.
- **Server Cards.** Name a company and the agent finds the MCP servers its domain
  publishes, checks each card against the schema, and adds the one you pick
  to the host's own configuration. The host then connects it with its own
  sign-in, so servers behind OAuth work. You see the host it connects to
  before you add it.
- **Apps.** A server's app opens right under the tool call in the terminal
  and answers the mouse and keyboard: real pixels in iTerm2, kitty and
  Ghostty, text cells everywhere else.

Events, Skills and Apps can't reach servers behind OAuth yet, in either host.
[Why, and what would fix it.](#how-it-works-in-each-host-and-where-it-stops)

**Beyond MCP**, `ard-discovery` ([Claude Code](polyfills/ard/claude-code),
[Codex](polyfills/ard/codex)) adds
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91,
a draft. It finds MCP servers through a domain's `ard.json`, or by searching
an ARD registry you choose, and hands the cards to `mcp-server-cards`. A
search sends the words of your request to that registry, so every search asks
you first and names where it's going. That's also why it isn't part of the
`agent-polyfill` bundle; install it by name.

Neither host supports these extensions itself yet. On 23 November 2026 the
official
[extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
listed Tasks for Claude Code, and none of Events, Apps or Skills (Server Cards
isn't in the matrix). Codex doesn't support Events for your own servers, or
Skills (openai/codex#48000). Hosts add extensions all the time, so check the
matrix for today's picture. The Skills SEP notes that Claude Code support has
been prototyped at Anthropic.

## Try it

### Events: the agent wakes up when something happens

![One sentence to Claude Code gives a private button page and a watch, and the session goes idle. Someone types "ship it" on the page and presses the button; the idle session wakes by itself and says what was typed.](polyfills/events/claude-code/docs/media/button-demo.gif)

Add the hosted demo server (no sign-in), start `claude` or `codex`, and ask
"Give me a demo button and tell me what I type when I press it":

```
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

```
codex mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

The same server also offers new comments in a Hacker News thread, new npm and
GitHub releases, and earthquakes. Its source is in
[`servers/event-feeds`](servers/event-feeds).

### Skills: skills that come from an MCP server

![In Claude Code, the skills a server offers are listed. A question is asked, Claude asks to load one skill from the server, reads the files it points to, and answers from them.](polyfills/skills/claude-code/docs/media/demo.gif)

Add Hugging Face's public MCP server (no sign-in) and ask a question one of
its skills covers. In Claude Code, `/mcp-skills` lists what it serves. In
Codex, the served skills appear in the `$` list from your next session.

```
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

```
codex mcp add huggingface --url https://huggingface.co/mcp
```

### Server Cards: add a company's MCP server by its domain

Nothing to set up. Ask "What MCP servers does neon.com publish?" and add
**Neon Docs** (no sign-in). For one behind a sign-in, ask about buildkite.com;
once it's added, the host asks you to sign in. In Claude Code,
`claude mcp remove neon-docs -s local` removes it again.

### Apps: an MCP App's interface, in the terminal

A server's app opens under the tool call and answers the mouse
([full video, 33 s](https://github.com/idosal/AgentPolyfill/releases/download/mcp-apps-cli-v0.1.0/mcp-apps-cli-demo.mp4)).

![In Claude Code, a classic shareware game from the hosted arcade server runs under the tool call and is played with keys and clicks. Then a cohort retention heatmap from another MCP server opens inline, shows a tooltip wherever the pointer goes, and a control switches its period. Last, a 3D scene opens and turns when dragged.](docs/media/mcp-apps-cli.gif)

Add the hosted arcade (classic shareware games from archive.org), start
`claude`, and ask "Find a shareware game in the arcade and load it":

```
claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp
```

Each polyfill's own README has the details: requirements, what happens between
installing and first use, and everything it can't do yet.

## What makes something a polyfill

1. It implements one published extension, client side, and nothing else: no
   extra protocol and no vendor additions. The one exception is an earlier
   form of the same extension that servers still speak, listed in the
   polyfill's README and switched off with one setting.
2. It names the spec revision it implements.
3. Every client rule in the spec has a test, and it runs against servers
   someone else wrote.
4. It stands down once the host supports the extension itself.
5. It says plainly what it can't do in each host, and what the host would
   need to change.

The full text is in [`docs/polyfill-contract.md`](docs/polyfill-contract.md).

Events uses the exception in rule 1: by default it also talks to servers that
advertise events in the form from before SEP-3415. `MCP_EVENTS_PRE_STANDARD=off`
makes it follow the SEP exactly.

For rule 4, no polyfill can detect native support on its own yet, because
neither host tells a plugin which extensions its own MCP client supports. So
when your host ships one of these extensions, turn that polyfill off. In Claude
Code, disable its plugin (`/plugin disable mcp-events`), or use its own
setting (`MCP_EVENTS_OFF=1`, `MCP_SKILLS_OFF=1`, or `disabled` in `/config`
for Server Cards and ARD). In Codex, remove the plugin
(`codex plugin remove mcp-events@agent-polyfill`). Each README says how.

## How it works in each host, and where it stops

Both hosts let outside code in, in different ways.

- **Claude Code** runs mods inside the host (on by default since 2.1.287). A
  mod can register tools, draw UI, start a turn in an idle session, and call a
  server's tools over Claude Code's own connection.
- **Codex** runs plugins that bring their own MCP server. Every tool call the
  server receives says which session it came from, `codex queue --resume`
  starts a turn in an idle session from outside, and Codex lists the skills a
  plugin's folder holds alongside its own.

That's the host half of almost any extension. The protocol half is missing in
both. Neither host lets a plugin send an extension's own methods, such as
`events/poll` or `skills/list`, over the host's connection, see everything a
server advertised, or receive a server's notifications. So Events, Skills and
Apps each open a second connection of their own, using the headers in your
config. That connection can't use the host's sign-in, which is why those
three can't reach servers behind OAuth.

Server Cards doesn't have this problem. A card is a public document, and the
server it describes goes into the host's own config, so the host connects it
with its own sign-in.

Four small, generic changes would remove the limit, in both hosts. None of
them names an extension:

| Change | Claude Code today | Codex today |
|---|---|---|
| Send any MCP method over the host's connection | missing | missing (its client can, internally) |
| Read what the server advertised | missing | mostly there |
| Deliver a server's notifications to the plugin | missing | only for OpenAI's hosted apps server |
| Raw tool results; declare a client extension | missing | declaring only by Codex's own client |

The first two are enough for Events (by poll and webhook) and Skills to work
with every server you've signed in to. What each change would look like, what
each extension needs, and the questions they raise about permissions are in
[`docs/host-changes.md`](docs/host-changes.md).

## Other hosts

We haven't found a documented way for third-party code to send requests over
the host's MCP connection in Cursor or VS Code, and ChatGPT runs no
third-party code on the client side. For those, the only polyfill would be a
gateway: an MCP server that presents an extension as plain tools. That's a
weaker form (for Events, the model would have to poll, and nothing would wake
it), and none is built here yet. Bringing a polyfill to another host is
[welcome](#an-existing-polyfill-in-another-host).

## Build one

There are three ways in: build a new polyfill, bring an existing one to
another host, or list your own in the community directory.

### A new polyfill

The `create-polyfill` skill walks an agent through building a polyfill to
this contract: the spec's client rules as a checklist, how to reach each
thing the extension needs in the host, standing down, and what counts as
proof.

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

Then ask for the extension you want, for example "polyfill MCP Apps in
Codex". The skill points the agent at the primary sources (the SEP, the
extension's spec, the core spec for the revision in use, the conformance
suite) and has it work from those.

### When the spec doesn't have what you want

A polyfill stays exact, so new behaviour doesn't go into one. The
`design-extension` skill, in the same plugin, covers that case. First it
checks whether the protocol already has a place for what you want. If it's
really new, it helps you design it as its own extension under MCP's extension
rules (your own identifier, a declaration, defined behaviour when the other
side lacks it, a written spec, two implementations) and take it to the
working group.

Both skills are plain `SKILL.md` files
([create-polyfill](plugins/polyfill-author/skills/create-polyfill/SKILL.md),
[design-extension](plugins/polyfill-author/skills/design-extension/SKILL.md)),
so any agent that reads skills can use them.

### An existing polyfill in another host

Each polyfill is one folder per extension. The part that doesn't depend on a
host (the protocol, the spec's client rules and their tests) lives in `core/`,
and next to it is one adapter per host, which wires that core into what the
host lets outside code do. Events and Skills are built that way: one `core/`,
a `claude-code/` mod and a `codex/` plugin.

Bringing one to a new host means writing a new adapter. Find how the host lets
a plugin reach the wire (a connection of its own, a tool call, a way to wake
an idle session), meet the contract there, write down what that host can't
do, and add the plugin to that host's marketplace.
[`CONTRIBUTING.md`](CONTRIBUTING.md#bringing-a-polyfill-to-another-host) has
the steps, and `create-polyfill` covers it too.

### Your own, listed in the community directory

If you keep a polyfill in your own repository, you can list it in
[`community/`](community/) with a pull request: one entry with the extension,
the spec revision, the hosts, your repository and its install line. Listed
polyfills aren't reviewed or shipped by this project and aren't in its
marketplaces. One that meets the contract can move into `polyfills/` after a
review.

## For spec authors

An MCP extension reaches Stable through a second Extensions Track SEP. Among
other things, that SEP must "Show two independent implementations, at least
one client-side and one server-side, that interoperate", include a
conformance scenario, and show the extension has been used for real
([SEP-3392](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3392-extension-lifecycle.md)).

A polyfill can be that client-side implementation, in hosts that haven't
shipped the extension yet, used by real people against real servers. Each one
here names the spec revision it implements. Events and Skills have a test for
every client rule and run against servers their authors didn't write. Skills
passes the official conformance suite's Skills client scenarios in both hosts,
and Events passes the Events client scenarios proposed upstream (still an open
pull request in the conformance suite). Apps checks the spec
requirement by requirement in its design notes. Whether a polyfill counts as
an independent implementation for a given SEP is up to that extension's
maintainers.

If your extension needs a client in a host that doesn't have one, open an
issue, or build it with the `create-polyfill` skill.

## More ways to install

**Claude Code.** One polyfill at a time, at the prompt of a `claude` session:

```
/plugin install mcp-events --marketplace idosal/AgentPolyfill
```

The same works for `mcp-apps-cli`, `mcp-skills`, `mcp-server-cards` and
`ard-discovery`; `ard-discovery` brings `mcp-server-cards` with it. In a
terminal, use `claude plugin install` with the same arguments.

The first install adds this repository's marketplace too. After that, the
short form is `/plugin install mcp-events@agent-polyfill`. To add the
marketplace on its own, run `/plugin marketplace add idosal/AgentPolyfill`.
`agent-polyfill` holds nothing of its own: it depends on every MCP polyfill
here (all of the above except `ard-discovery`), and each one stays a plugin
you can disable or uninstall separately. Start a new `claude` session for
plugins to load.

**Codex.** With the marketplace added, `codex plugin add <name>@agent-polyfill`
installs one (`mcp-events`, `mcp-skills`, `mcp-server-cards` or
`ard-discovery`), and `codex plugin remove <name>@agent-polyfill` removes it.
Codex has no bundle.

## Safety

These are third-party plugins, and they run with your permissions, like every
Claude Code mod and Codex plugin. None of them reads the host's stored
credentials: not Claude Code's, and not Codex's sign-ins or tokens. Each
polyfill's `SECURITY.md` says what it checks and what it doesn't protect
against. [`SECURITY.md`](SECURITY.md) says how to report a problem privately.

## Repository layout

- **`polyfills/<extension>/`**: one folder per extension, with a subfolder per
  host it runs in, and a `core/` next to them when the hosts share code.
  [`events`](polyfills/events) and [`skills`](polyfills/skills) have a core,
  a Claude Code mod and a Codex plugin; [`server-cards`](polyfills/server-cards)
  and [`ard`](polyfills/ard) run in both hosts; [`apps`](polyfills/apps)
  runs in Claude Code.
- **Marketplaces**, one per host.
  [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) lists
  everything for Claude Code, including the two plugins in
  [`plugins/`](plugins): `agent-polyfill`, which installs every MCP polyfill,
  and `polyfill-author`, the skills for building one.
  [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) lists
  the Codex plugins.
- **[`servers/`](servers):** the demo servers hosted for trying a polyfill,
  such as [`event-feeds`](servers/event-feeds) for Events.
- **[`community/`](community/):** the community directory.
- **[`site/`](site):** the website, [agentpolyfill.com](https://agentpolyfill.com).

Each polyfill releases on its own, under tags that start with its plugin's
name (for example `mcp-apps-cli-v0.1.0`).

## Contributing

Found a problem or have a question? Open an issue. A new polyfill, or an
existing one brought to another host, is welcome if it meets the
[contract](docs/polyfill-contract.md); the `create-polyfill` skill is the
quickest way to build one that does. [`CONTRIBUTING.md`](CONTRIBUTING.md)
explains how to add one to this repository, and how to list one you keep
elsewhere in the [community directory](community/).

## Licence and status

Apache-2.0. See [LICENSE](LICENSE).

A community project by [Ido Salomon](https://github.com/idosal). It isn't part
of the MCP specification, and it isn't affiliated with or endorsed by the MCP
project, the Agentic AI Foundation, the Linux Foundation, Anthropic, OpenAI or
any other host vendor. The author works in the MCP Apps working group; this
isn't working-group output. Model Context Protocol and MCP are trademarks of
LF Projects, LLC. Claude and Claude Code are trademarks of Anthropic, PBC.
OpenAI and Codex are trademarks of OpenAI.
