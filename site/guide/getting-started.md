---
description: Install the AgentPolyfill plugins in Claude Code or Codex, what each one needs in each host, and a first run of each.
---

# Getting started

## Install

### Claude Code

Claude Code 2.1.329 or newer. At the prompt of a `claude` session, install
every polyfill at once:

```
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

Then start a new `claude` session for the polyfills to load.

`agent-polyfill` holds nothing of its own: it depends on every MCP polyfill
here, and each one stays a plugin you can disable or uninstall separately. To
install just one:

::: code-group

```txt [Events]
/plugin install mcp-events --marketplace idosal/AgentPolyfill
```

```txt [Skills]
/plugin install mcp-skills --marketplace idosal/AgentPolyfill
```

```txt [Server Cards]
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

```txt [Apps]
/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill
```

```txt [ARD discovery]
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

:::

`ard-discovery` isn't in the bundle, because a search sends the words of your
request to the ARD registry you choose. Install it by name, and it brings
`mcp-server-cards` with it.

In a terminal, use `claude plugin install` with the same arguments:

```bash
claude plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

The first install adds this repository's marketplace too. After that, the
short form is `/plugin install mcp-events@agent-polyfill`. To add the
marketplace on its own, run `/plugin marketplace add idosal/AgentPolyfill`.

In a session, Claude Code shows the marketplace it resolved and asks you to
confirm adding it, then opens the plugin's page, where you choose who gets it:
you, everyone on this repository, or you in this repository only. The terminal
form asks nothing. Say no to the marketplace and nothing is installed.

### Codex

Codex 0.170 or newer (Skills was tested on 0.172), with Node 20 or newer on
the `PATH` Codex runs with. In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-events@agent-polyfill
codex plugin add mcp-skills@agent-polyfill
codex plugin add mcp-server-cards@agent-polyfill
```

Codex has no bundle, so add the ones you want. Apps isn't in Codex yet.
`ard-discovery` is added by name, for the same reason as in Claude Code:

```bash
codex plugin add ard-discovery@agent-polyfill
```

## Requirements

### In Claude Code

| | Claude Code | What else it needs | Where it has run |
|---|---|---|---|
| Events | 2.1.326 or newer | Node 20 or newer, or Bun (webhook delivery through a relay needs Node 22 or newer, or Bun); `/mcp-events setup` can fetch Bun for the mod alone on macOS and Linux. A terminal session, or one an app keeps open. | Tested live on macOS; its tests also run on Linux and Windows |
| Skills | 2.1.329 or newer | Node 20 or newer, or Bun; `/mcp-skills setup` can fetch Bun for the mod alone on macOS and Linux. | Run on macOS; Linux and Windows not tried yet |
| Server Cards, ARD | 2.1.329 or newer | Nothing else: no helper process, no Node, no account. To add a server, the `claude` command, found on your `PATH` or in the usual install folders. | |
| Apps | 2.1.329 or newer | Nothing else, not even Node: the plugin carries a small helper program for each platform. A Chromium-based browser (Chrome, Edge, Chromium, Brave); clicking into views needs Claude Code's fullscreen layout. | macOS, Linux (x64 or Arm64) and Windows x64; Windows hasn't been used in a Claude Code session yet |

All of them run as mods, the kind of Claude Code plugin whose code runs inside
Claude Code; mods are on by default from Claude Code 2.1.287. Claude Code runs a
plugin's code only in a folder you've told it you trust, which it asks the
first time you start `claude` in a folder. In a folder you haven't trusted,
the polyfills do nothing.

Neither runtime download happens unless you send the command yourself (at the
prompt, or from your own Remote Control) and then answer Download in Claude
Code's own dialog. What is fetched and how it's checked is on the
[Events](./events#the-mod-s-own-runtime) and
[Skills](./skills#the-mod-s-own-runtime) pages.

### In Codex

| | Codex | What else it needs |
|---|---|---|
| Events | 0.170 or newer | Node 20 or newer. A watch wakes a Codex CLI session (the terminal app or `codex exec`). |
| Skills | 0.172 (the version it was tested on) | Node 20 or newer |
| Server Cards, ARD | 0.170 or newer | Node 20 or newer |
| Apps | not yet | |

Each Codex plugin's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex).

## First run

Events and Apps each have a hosted demo server to try them against, Skills
uses Hugging Face's public MCP server, and Server Cards needs nothing set up.
Add the server, start `claude` or `codex` in the same folder, and ask.

### Events

::: code-group

```bash [Claude Code]
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

```bash [Codex]
codex mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

:::

> Give me a demo button and tell me what I type when I press it.

The agent makes a private button page, gives you its link, and watches it.
Press the button: a few seconds later the idle session wakes by itself and
answers. In Claude Code, the first time the agent uses each of the mod's
tools, Claude Code asks whether to go ahead, as for any MCP tool. In Codex, a
woken session is a Codex CLI session (the terminal app or `codex exec`): a
chat in the ChatGPT desktop app keeps its events but can't be woken, so ask it
for `recent_events`. A resumed Codex session starts watching at its first
Events tool call. [More on Events](./events)

### Skills

::: code-group

```bash [Claude Code]
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

```bash [Codex]
codex mcp add huggingface --url https://huggingface.co/mcp
```

:::

In Claude Code, `/mcp-skills` lists what it serves. In Codex, the served
skills appear in the `$` list from your next session. Then ask a question one
of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

You're asked once whether to load the skill, in the host's own dialog, and
then the agent reads the skill's files from the server and answers from them.
[More on Skills](./skills)

### Server Cards

Nothing to set up. Start `claude` or `codex` and ask:

> What MCP servers does neon.com publish?

Then add **Neon Docs** (no sign-in): press **Add** in Claude Code, or choose
"Add it" in Codex's own form. For one behind a sign-in, ask about
buildkite.com; once it's added, the host asks you to sign in. In Claude Code,
`claude mcp remove neon-docs -s local` removes it again.
[More on Server Cards](./server-cards)

### Apps

Apps runs in Claude Code; it isn't in Codex yet.

```bash
claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp
```

> Find a shareware game in the arcade and load it.

The app appears under the tool call. After the first view appears, the plugin
offers to switch Claude Code to its fullscreen layout, the only one that
passes clicks and keys to a view. [More on Apps](./apps)

## Servers behind a sign-in

Events, Skills and Apps can't reach servers behind OAuth yet, in either host:
in Claude Code, a server you sign in to through `/mcp`, or a claude.ai
connector. A server whose credential is in its configuration works with
Events and Skills. In Claude Code that's a header (including `${VAR}`) or a
`headersHelper`. In Codex it's a header written in the config; a token kept in
an environment variable (`bearer_token_env_var`, `env_http_headers`) is out of
reach, because a plugin's MCP server only sees a fixed few variables.

Server Cards is different: it adds a server to the host's own config, and the
host connects it with its own sign-in. [How it works](./how-it-works) says
why, and what would fix it.

## Turning one off

No polyfill can detect native support on its own yet, because neither host
tells a plugin which extensions its own MCP client supports. So when your host
ships one of these extensions, turn that polyfill off.

In Claude Code:

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1` | `/plugin uninstall mcp-events` |
| Skills | `MCP_SKILLS_OFF=1`, or disable the plugin in `/plugin` | `/plugin` |
| Server Cards | `disabled` in `/config` | `/plugin` |
| ARD discovery | `disabled` in `/config` (`mcp-server-cards` keeps working) | `/plugin` |
| Apps | `claude plugin disable mcp-apps-cli@agent-polyfill` | `claude plugin uninstall mcp-apps-cli@agent-polyfill` |

The environment variables go, for example, in the `env` block of
`~/.claude/settings.json`.

In Codex, remove the plugin: `codex plugin remove mcp-events@agent-polyfill`,
and the same for `mcp-skills`, `mcp-server-cards` and `ard-discovery`.
