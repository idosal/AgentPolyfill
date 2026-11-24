---
description: Install the AgentPolyfill plugins in Claude Code, what each one needs, and the first run of each.
---

# Getting started

## Install

At the prompt of a `claude` session (Claude Code 2.1.329 or newer), every
polyfill at once:

```
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

Then start a new `claude` session for the polyfills to load.

`agent-polyfill` holds nothing of its own: it depends on each MCP polyfill, and
each stays a plugin you can disable or uninstall on its own. To install only
the one you want:

::: code-group

```txt [Events]
/plugin install mcp-events --marketplace idosal/AgentPolyfill
```

```txt [Apps]
/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill
```

```txt [Skills]
/plugin install mcp-skills --marketplace idosal/AgentPolyfill
```

```txt [Server Cards]
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

```txt [ARD discovery]
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

:::

`agent-polyfill` installs the four MCP polyfills. `ard-discovery` is not in
it, because its search sends the words of your request to a third-party
registry; install it by name, and it installs `mcp-server-cards` with it.

The same works in a terminal:

```bash
claude plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

It adds this repository's marketplace and installs from it in one step. With
the marketplace already added, the short form is
`/plugin install mcp-events@agent-polyfill`; to add the marketplace by itself,
`/plugin marketplace add idosal/AgentPolyfill`.

In a session, Claude Code shows the marketplace it resolved and asks you to
confirm adding it, then opens the plugin's page, where you choose who gets it:
you, everyone on this repository, or you in this repository only. The terminal
form asks nothing. Say no to the marketplace and nothing is installed.

## Requirements

| | Events | Apps | Skills | Server Cards, ARD |
|---|---|---|---|---|
| Claude Code | 2.1.326 or newer | 2.1.329 or later | 2.1.329 or newer | 2.1.329 or newer |
| Runtime | Node 20 or newer, or Bun; `/mcp-events setup` can fetch Bun for the mod alone (macOS, Linux) | Nothing else, not even Node: the plugin carries a small helper program for each platform | Node 20 or newer, or Bun; `/mcp-skills setup` can fetch Bun for the mod alone (macOS, Linux) | Nothing else: no helper process, no Node, no account |
| Also | A terminal session, or one an app keeps open | A Chromium-based browser (Chrome, Edge, Chromium, Brave); clicking into views needs Claude Code's fullscreen layout | | To add a server, the `claude` command, found on your `PATH` or in the usual install folders |
| Platforms | Tested live on macOS; its tests also run on Linux and Windows | macOS, Linux (x64 or Arm64) and Windows x64; Windows has not yet been used in a Claude Code session | Run on macOS; Linux and Windows not tried yet | |

All of them run as mods, the kind of Claude Code plugin whose code runs inside
Claude Code; mods are on by default from Claude Code 2.1.287. Claude Code runs a
plugin's code only in a folder you have told it you trust, which it asks the
first time you start `claude` in a folder. In a folder you have not trusted,
the polyfills do nothing.

Neither runtime download happens unless you type the command yourself and then
answer Download in Claude Code's own dialog. What is fetched and how it is
checked is on each polyfill's page.

## First run

Each polyfill has a hosted demo server to try it against. Add one, start
`claude` in the same folder, and ask.

### Events

```bash
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

> Give me a demo button and tell me what I type when I press it.

Claude makes a private button page, gives you its link, and watches it. Press
the button: a few seconds later the idle session wakes by itself and answers.
The first time Claude uses each of the mod's tools, Claude Code asks whether to
proceed, as for any MCP tool. [More on Events](./events)

### Apps

```bash
claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp
```

> Find a shareware game in the arcade and load it.

The app appears under the tool call. After the first view appears, the plugin
offers to switch Claude Code to its fullscreen layout, the only one that passes
clicks and keys to a view. [More on Apps](./apps)

### Skills

```bash
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

Type `/mcp-skills` to see what it serves, or ask a question one of its skills
covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Claude Code asks you once whether to load the skill, then Claude reads the
skill's files from the server and answers from them. [More on Skills](./skills)

### Server Cards

Nothing to set up. Start `claude` and ask:

> What MCP servers does neon.com publish?

Then press **Add** on **Neon Docs** (no sign-in). For one behind a sign-in, ask
about buildkite.com; after **Add**, Claude Code asks you to sign in through
`/mcp`. `claude mcp remove neon-docs -s local` removes it again.
[More on Server Cards](./server-cards)

## Servers behind a sign-in

Events, Apps and Skills don't reach a server you can only reach by signing in
through `/mcp` (OAuth), or a claude.ai connector. A server whose credential is
in its configuration (a header, including `${VAR}`, or a `headersHelper`) works
with Events and Skills. Server Cards is different: it adds a server to Claude
Code's own config, and Claude Code connects it with its own sign-in.
[How it works](./how-it-works) says why.

## Turning one off

When Claude Code ships one of these extensions itself, disable that polyfill.
None can yet detect native support reliably, because a mod cannot see what
Claude Code's own MCP client supports.

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1` | `/plugin uninstall mcp-events` |
| Apps | `claude plugin disable mcp-apps-cli@agent-polyfill` | `claude plugin uninstall mcp-apps-cli@agent-polyfill` |
| Skills | `MCP_SKILLS_OFF=1`, or disable the plugin in `/plugin` | `/plugin` |
| Server Cards | `disabled` in `/config` | `/plugin` |
| ARD discovery | `disabled` in `/config` (`mcp-server-cards` keeps working) | `/plugin` |

The environment variables go, for example, in the `env` block of
`~/.claude/settings.json`.
