---
description: Install a plugin for your host and discover your first MCP server.
---

# Getting started

## Install

Choose your host below. To check whether it already implements an extension,
see the [host support table](./introduction#the-polyfills).

### Claude Code

In Claude Code 2.1.329 or later, install the bundle and start a new session
in a trusted project:

```text
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

The bundle includes Apps, Events and Server Cards. To install one plugin,
replace `agent-polyfill` with its name. Install `ard-discovery` separately.
In a shell, use `claude plugin install` with the same arguments.

Events needs Node.js 20+ or Bun. For webhook delivery through a relay, use
Node.js 22+ or Bun. Apps needs a Chromium-based browser.

Claude Code 2.1.332 added native Skills support in beta. See the
[Skills migration instructions](./skills#claude-code) if upgrading.

### Codex

Use Codex 0.170+ with Node.js 20+ on its `PATH`. Skills was tested on Codex
0.172. Add the marketplace once, then run the install commands you need:

```sh
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-events@agent-polyfill
codex plugin add mcp-skills@agent-polyfill
codex plugin add mcp-server-cards@agent-polyfill
codex plugin add ard-discovery@agent-polyfill
```

### Cursor IDE

Install Server Cards from a clone with Node.js 20+ available to Cursor. From the repository root on macOS or Linux, run

```sh
mkdir -p ~/.cursor/plugins/local/mcp-server-cards
cp -R polyfills/server-cards/codex/plugin/. ~/.cursor/plugins/local/mcp-server-cards/
```

Restart the editor. Open **Customize → MCPs** and look for `mcp-server-cards`. Ask which MCP servers a domain publishes, then pick one to review. [Watch a Cursor install review](./server-cards#in-cursor-ide).

### Pi

With Pi 1.6.0 and Node.js 22+, install Events, Skills and Server Cards together:

```sh
pi install git:github.com/idosal/AgentPolyfill
```

Start `pi` to load them. For ARD or an individual extension, install from a
clone. Pi loads local extensions in place, so keep the clone. Installing the
same extension from both sources loads it twice.

```sh
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/ard/pi/extension
```

### OpenCode

OpenCode 2.4+ uses Git to fetch each plugin. Run the commands for the plugins
you want, then reopen the project. Each command updates your global
`opencode.json`. Replace `main` with a commit to pin a version.

```sh
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/events/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/skills/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'
```

### Antigravity

Install with the Antigravity CLI (`agy`), Git and Node.js 20+ on `PATH`.
The App and CLI share the installed plugins. The IDE lacks the required hooks.
Tested with App 2.35.1 and CLI 1.5.17.

```sh
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity/plugin
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity/plugin
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity/plugin
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity/plugin
```

Rerun an install command to update that plugin. To wake an idle App
conversation, [enable the Events sidecar](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/README.md#enable-idle-wakes-in-the-app).

### GitHub Copilot CLI

Add a clone as a local marketplace. Copilot loads plugins directly from this
directory, so keep it after installation. Tested with Copilot CLI 1.0.115.

```sh
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install mcp-events@agent-polyfill
copilot plugin install mcp-server-cards@agent-polyfill
copilot plugin install ard-discovery@agent-polyfill
```

Start Copilot with `copilot --experimental` for Events. Server Cards and ARD
run in standard mode and require Node.js 20+.

### Hermes Agent

Install the plugins on the gateway machine with Node.js 20+ on its `PATH`.
Tested with Hermes Agent v0.23.4.

```sh
hermes plugins install idosal/AgentPolyfill/polyfills/events/hermes/plugin --enable
hermes plugins install idosal/AgentPolyfill/polyfills/skills/hermes/plugin --enable
hermes plugins install idosal/AgentPolyfill/polyfills/server-cards/hermes/plugin --enable
hermes plugins install idosal/AgentPolyfill/polyfills/ard/hermes/plugin --enable
```

For Events and Skills, list the permitted server names in your profile’s
`config.yaml`. Each name must also exist under `mcp_servers`. Grant
`allow_gateway_injection` if Events should wake the session.

```yaml
plugins:
  entries:
    mcp-events:
      settings:
        servers: [feeds]
      allow_gateway_injection: true
    mcp-skills:
      settings:
        servers: [huggingface]
```

### T3 Code

Install plugins for the underlying agent. For Events in a Codex thread,
use the T3 adapter in place of the Codex Events plugin:

```sh
git clone https://github.com/idosal/AgentPolyfill.git
codex mcp add mcp-events-t3 -- node "$PWD/AgentPolyfill/polyfills/events/t3/plugin/dist/server.js"
```

Select **Restart agent session** in T3 Code. The [adapter README](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/t3)
covers thread wake-ups and removal.

## First run

With Server Cards installed, ask **What MCP servers does neon.com publish?**
Select **Neon Docs** and review the server address before approving the addition.
The host handles the connection and any required sign-in.

| To try | Example |
|---|---|
| [Events](./events#try-it) | Create a demo button and have the agent report what you typed when you press it. |
| [Skills](./skills#try-it) | Load Hugging Face’s local-model skill to choose a quantization for a 7B model. |
| [Apps](./apps#try-it) | Open a game from the arcade MCP server in the Claude Code terminal. |
| [A2A delegation](./a2a) | Connect a named agent, review its questions, and receive its result in the originating chat. |
| [ARD](./ard#try-it) | Look up the MCP servers Buildkite publishes through its domain. |

## Servers behind a sign-in

Events, Skills and Apps plugins that connect to a server independently cannot
reuse OAuth credentials held by the host. Support for configured headers and
environment variables varies by adapter. See the [connection details](./how-it-works)
and [security guide](./security). ARD registry searches send your query to the
selected registry after approval.

## Turning one off

No polyfill can detect native support on its own yet. When your host ships
one of these extensions, turn that polyfill off.

In Claude Code:

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1` | `/plugin uninstall mcp-events` |
| Server Cards | `disabled` in `/config` | `/plugin` |
| ARD discovery | `disabled` in `/config` (`mcp-server-cards` keeps working) | `/plugin` |
| Apps | `claude plugin disable mcp-apps-cli@agent-polyfill` | `claude plugin uninstall mcp-apps-cli@agent-polyfill` |

The environment variables go, for example, in the `env` block of
`~/.claude/settings.json`.

Skills in Claude Code was the first such case: Claude Code ships it itself
now, in beta, and the form was removed from this project. If you still have
it, `/plugin uninstall mcp-skills@agent-polyfill` removes it
([Skills](./skills#claude-code)).

In Codex, remove the plugin: `codex plugin remove mcp-events@agent-polyfill`,
and the same for `mcp-skills`, `mcp-server-cards` and `ard-discovery`.

**Cursor IDE.** To remove the local plugin, move the `mcp-server-cards` folder out of `~/.cursor/plugins/local/` and restart Cursor. Manage any servers you previously installed separately in **Customize → MCPs**.

In Pi, remove all three forms installed by the one-line command, together
with Pi's copy of the repository:

```bash
pi remove git:github.com/idosal/AgentPolyfill
```

To turn off one form, set its off switch in the environment Pi starts with.
For a local install, use the removal command below from the same repository
folder you installed from:

| | Off without uninstalling | Remove a local install |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1` | `pi remove ./polyfills/events/pi/extension` |
| Skills | `MCP_SKILLS_OFF=1` | `pi remove ./polyfills/skills/pi/extension` |
| Server Cards | `MCP_SERVER_CARDS_DISABLED=1` | `pi remove ./polyfills/server-cards/pi/extension` |
| ARD discovery | `ARD_DISCOVERY_DISABLED=1` | `pi remove ./polyfills/ard/pi/extension` |

Pi has no per-skill switch for an extension's skills. To leave out a server's
skills, put `{"skip": ["server-name"]}` in `mcp-skills/settings.json` under
Pi's agent folder.

Uninstalling leaves data in Pi's agent folder (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`). Delete `mcp-events/` there to remove stored watches
and events, and `mcp-skills/` to remove approvals and skill stubs. If you set
`MCP_EVENTS_STATE` or `MCP_SKILLS_STATE`, the data is at that path instead.
Servers added through Server Cards or ARD remain in `mcp.json`; remove each
with `pi mcp remove <name>`, then `/reload` or start a new session to refresh
an already running Pi.

In OpenCode, set the off switch in the environment OpenCode starts in (or
the plugin option `{"off": true}`), or remove the plugin with
`opencode plugin remove` and the same text you added it with:

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1` | `opencode plugin remove 'github:idosal/AgentPolyfill#main::path:polyfills/events/opencode/plugin'` |
| Skills | `MCP_SKILLS_OFF=1` | `opencode plugin remove 'github:idosal/AgentPolyfill#main::path:polyfills/skills/opencode/plugin'` |
| Server Cards | `MCP_SERVER_CARDS_DISABLED=1` | `opencode plugin remove 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'` |
| ARD discovery | `ARD_DISCOVERY_DISABLED=1` | `opencode plugin remove 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'` |

A folder you added to `plugins` yourself is removed by taking its entry out.

OpenCode already has part of Events: its own client takes push events for
its automations. The Events polyfill stays on beside it, because OpenCode
doesn't poll or take webhooks and skips event types whose schemas it can't
check; it tells the model to use a watch or an automation for an event type,
not both. Turn it off once OpenCode watches every event type for a session,
by push, poll and webhook.

Removing a plugin leaves OpenCode's downloaded copy in `~/.cache/opencode/npm/`
(a `git-AgentPolyfill-…` folder), which you can delete. Events leaves its
watches, stored events and log in `~/.local/share/opencode/mcp-events/`, and
Skills its log in `~/.local/share/opencode/mcp-skills/`. If you set
`MCP_EVENTS_STATE` or `MCP_SKILLS_STATE`, the data is at that path instead.
Delete those to remove it. The "Allow always" answers Events and Skills kept,
and which skills each session loaded, stay in OpenCode's plugin storage
(OpenCode's own database). Servers added through Server Cards or ARD were
never in your configuration files, so they go with the plugin, but its list
of them stays in that storage and comes back if you install it again: ask
OpenCode to remove each one first (`server_cards_remove_mcp_server` or
`ard_remove_mcp_server`).

In Antigravity, disable or uninstall the plugin
(`agy plugin disable mcp-events`, `agy plugin uninstall mcp-events`, and the
same for `mcp-skills`, `mcp-server-cards` and `ard-discovery`), or use its
own setting, in the environment Antigravity starts in:

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1`, or `{"MCP_EVENTS_OFF": "1"}` in `~/.gemini/agentpolyfill/mcp-events/settings.json` | `agy plugin uninstall mcp-events` |
| Skills | `MCP_SKILLS_DISABLED=1`, or `"off": true` in `~/.gemini/agentpolyfill/mcp-skills/settings.json` | `agy plugin uninstall mcp-skills` |
| Server Cards | `MCP_SERVER_CARDS_DISABLED=1` | `agy plugin uninstall mcp-server-cards` |
| ARD discovery | `ARD_DISCOVERY_DISABLED=1` | `agy plugin uninstall ard-discovery` |

No Antigravity form detects native support: Antigravity tells plugins
nothing about its MCP client's extensions. The plugins write only their own folder, `~/.gemini/agentpolyfill/<plugin>/`;
Skills' placeholders, `~/.gemini/config/skills/mcp-skills-served--*`; and,
for Server Cards and ARD after your approval,
`~/.gemini/config/mcp_config.json`. Delete the first two to remove what they
stored. A server added through Server Cards or ARD stays in
`mcp_config.json`; remove it with `agy mcp remove <name>` (in CLI 1.5.17's
own help, not in Antigravity's docs), or delete its entry from that file.

In Copilot CLI, set the off switch in the environment Copilot starts in, or
disable or uninstall the plugin:

| | Off without uninstalling | Remove |
|---|---|---|
| Events | `MCP_EVENTS_OFF=1`, or `copilot plugin disable mcp-events@agent-polyfill` | `copilot plugin uninstall mcp-events@agent-polyfill` |
| Server Cards | `MCP_SERVER_CARDS_DISABLED=1`, or `copilot plugin disable mcp-server-cards@agent-polyfill` | `copilot plugin uninstall mcp-server-cards@agent-polyfill` |
| ARD discovery | `ARD_DISCOVERY_DISABLED=1`, or `copilot plugin disable ard-discovery@agent-polyfill` | `copilot plugin uninstall ard-discovery@agent-polyfill` |

Before you uninstall Events, stop the watches you want ended on their
servers: a webhook watch has a subscription that otherwise lasts until the
server expires it. Uninstalling leaves Events' data in `~/.copilot/mcp-events/`
(or under `COPILOT_HOME`); delete that folder to remove stored watches and
events. Servers added through Server Cards or ARD stay in
`~/.copilot/mcp-config.json`; remove each with `copilot mcp remove <name>`.
The marketplace stays until `copilot plugin marketplace remove agent-polyfill`.

In Hermes, use the host's own switches:

| | Off without uninstalling |
|---|---|
| Events | `hermes plugins disable mcp-events` |
| Skills | `hermes plugins disable mcp-skills` |
| Server Cards | `hermes plugins disable mcp-server-cards` |
| ARD discovery | `hermes plugins disable ard-discovery` |

Remove Events with `hermes plugins remove mcp-events`, or Skills with
`hermes plugins remove mcp-skills`.

Events already stands down for servers with `events: true`, from the next
turn after you set it. Hermes handles their webhook delivery itself.

Events keeps its watches, events, cursors, wake counts and log in
`$HERMES_HOME/mcp-events/`. Skills keeps stubs in `$HERMES_HOME/mcp-skills/`,
and what each session loaded in Hermes's plugin state. Server Cards and ARD
keep removal records in `$HERMES_HOME/mcp-server-cards/added.json` and
`$HERMES_HOME/ard-discovery/added.json`; discovery state lives in memory.
Disabling either leaves added servers in `mcp_servers` in `config.yaml`.
Ask the plugin to remove an unchanged entry it added, or use
`hermes mcp remove <name>`, then `/reload-mcp`. Removal leaves environment
variables and OAuth tokens alone.
