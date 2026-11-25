---
description: Install the AgentPolyfill plugins and extensions, what each one needs in each host, and a first run of each.
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

### Pi

Pi 1.6.0 (`@earendil-works/pi-coding-agent`, the version tested), with Node
22 or newer. Nothing for Pi is published to npm or Pi's package gallery.
From a clone of this repository, install the extensions you want:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/events/pi/extension
pi install ./polyfills/skills/pi/extension
pi install ./polyfills/server-cards/pi/extension
pi install ./polyfills/ard/pi/extension
```

These steps were tested from a clean, isolated Pi against the public
repository. There is no Pi bundle or single install for every polyfill. Apps
has no Pi form. ARD includes its own Server Cards checks and add tool; it
needs no other polyfill installed.

Start `pi` to use the installed extensions. Each `extension/` folder holds
a manifest and one bundled file, with nothing to build. Pi loads a local
path where it is, so keep the clone; `git pull` in it brings the next version.
Pi's git installer takes a whole repository, not a folder within it, which
is why these steps use local paths.

To try one for a single run without installing, replace `<polyfill>` with
`events`, `skills`, `server-cards` or `ard`:

```bash
pi -e ./polyfills/<polyfill>/pi/extension
```

### GitHub Copilot CLI

Copilot CLI 1.0.115 (the version tested). From a clone of this repository,
add it as a marketplace and install the plugins you want:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install mcp-events@agent-polyfill
copilot plugin install mcp-server-cards@agent-polyfill
copilot plugin install ard-discovery@agent-polyfill
```

This install, from a clone, is the one tested. Copilot loads a plugin from a
local marketplace where it is, without copying it, so keep the clone;
`git pull` in it brings the next version. Once these plugins are on the
repository's default branch,
`copilot plugin marketplace add idosal/AgentPolyfill` adds the same
marketplace from GitHub, and Copilot keeps its own copy. That install hasn't
been tested yet.

There is no Copilot bundle. Events is a Copilot extension, and Copilot loads
extensions only in its experimental mode: start it with
`copilot --experimental`, or run `/settings experimental on` once. Server
Cards and ARD are MCP servers in plugins and need no experimental mode. Copilot has
Skills over MCP and MCP Apps built in, so there is no Copilot form of those
([why](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/README.md#skills-and-apps-in-copilot)).

To try one for a single run without installing, replace `<polyfill>` with
`events`, `server-cards` or `ard`:

```bash
copilot --experimental --plugin-dir ./AgentPolyfill/polyfills/<polyfill>/copilot/plugin
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

### In Pi

| | Pi | What else it needs |
|---|---|---|
| Events | 1.6.0 (the version tested) | Node 22 or newer. An open session; a new watch needs a dialog in the terminal or an RPC client. |
| Skills | 1.6.0 (the version tested) | Node 22 or newer. A new skill approval needs a dialog in the terminal or an RPC client. |
| Server Cards, ARD | 1.6.0 (the version tested) | Node 22 or newer. Adding a server or sending a registry search needs a dialog in the terminal or an RPC client. |
| Apps | not available | Pi leaves out `ui://` resources and tool `_meta`; nothing for Apps in Pi is built or tested. |

Pi runs tool calls without asking unless a permission extension asks. Each
polyfill asks before its consequential step itself. Print and JSON modes
cannot ask, so they refuse new watches, unapproved skill loads, searches
and server additions.

Events and Skills each open their own connection to a server: a local
(stdio) server runs twice. Events needs protocol revision 2026-07-28, while
Pi's own MCP client stops at 2025-11-25. Servers are read when a session
starts; a server another extension registers later is reached after
`/reload`. When Pi's own MCP support is off (`--no-mcp`, `-builtin:mcp` in
the extensions setting, or an extension that replaces it), Events and Skills
stand down too.

Each Pi form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/pi),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/pi) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi).

### In Copilot CLI

| | Copilot CLI | What else it needs |
|---|---|---|
| Events | 1.0.115 or newer, in experimental mode | Nothing else: Copilot runs the extension with its own Node. An open session. The first session asks once whether the extension may have elevated permissions. |
| Server Cards, ARD | 1.0.115 or newer | Node 20 or newer on your `PATH`. Adding a server or sending a registry search needs Copilot's form, so it works in the interactive session only. |
| Skills | built in | Copilot CLI 1.0.115 declares Skills over MCP to every server; there is no Copilot form. |
| Apps | built in for graphical hosts | VS Code's Copilot harness renders MCP Apps; the terminal draws none. There is no Copilot form. |

Copilot asks before each of the plugins' tools that act (`watch_event`,
`unwatch_event`, `add_mcp_server`, `ard_search`), as for any tool. Adding a
server or sending a search also asks in the plugin's form, which Copilot
declines in `copilot -p`, even with `--yolo`.

Events opens its own connection to a server, so a local (stdio) server runs
twice. It reads only the servers Copilot enables for the session.
`copilot --acp` loads no extensions, and `copilot -p` ends the session with
the prompt, so nothing is woken there. A server that Server Cards or ARD adds
connects after `/mcp reload`, or in the next session.

In VS Code 1.147.0's Copilot harness, Events was run end to end: a wake shows
as a message from the plugin, then the turn. The Server Cards and ARD servers
loaded there, but nothing was added or searched there.

Each Copilot form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/copilot),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/copilot) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/copilot).

## First run

Events and Apps each have a hosted demo server to try them against, Skills
uses Hugging Face's public MCP server, and Server Cards needs nothing set up.
Add the server, start your host in the same folder, and ask. Each host's
steps are below.

### Events

::: code-group

```bash [Claude Code]
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

```bash [Codex]
codex mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

```bash [Pi]
pi mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

```bash [Copilot CLI]
copilot mcp add --transport=http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

:::

For the demo button:

> Give me a demo button and tell me what I type when I press it.

- **Claude Code:** the agent makes a private button page, gives you its link,
  and watches it. Press the button: a few seconds later the idle session
  wakes by itself and answers. The first time the agent uses each of the
  mod's tools, Claude Code asks whether to go ahead, as for any MCP tool.
- **Codex:** the agent makes a private button page, gives you its link, and
  watches it. Press the button to wake an idle Codex CLI session (the
  terminal app or `codex exec`). A chat in the ChatGPT desktop app keeps its
  events but can't be woken, so ask it for `recent_events`. A resumed Codex
  session starts watching at its first Events tool call.
- **Pi:** try "Watch for new earthquakes from the feeds server and tell me
  where each one was." At session start, the extension lists the server's
  event types in the system prompt. `watch_event` asks a yes/no dialog naming
  the server, event type, filters and note in full, and saying its events
  will start turns. No or closing the dialog starts no watch. After yes, an
  event wakes the idle session with a message starting `[mcp-events]`, saying
  the extension sent it, not you; Pi calls `get_event` and answers. By
  default, a watch can wake the session once a minute and the session can
  wake 30 times an hour. Past that it is told once and waits until you
  write; events stay stored. Ask "Stop watching the earthquakes" to stop.
  A local (stdio) watch resumes only when you resume the session in the same
  folder. The [Pi live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/live-run.md)
  records a confirmed watch, idle wake, event read, answer and stop against
  a local ticket server.
- **Copilot CLI:** start `copilot --experimental`. The first session asks
  once whether the extension may have elevated permissions; choose **Yes**.
  Copilot asks before `watch_event` runs, as for any tool that changes
  something. Press the button: a few seconds later the idle session starts a
  turn by itself, reads the event and tells you what you typed. The wake's
  first line says the plugin sent it, not you. The
  [Copilot live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/docs/live-run.md)
  records a watch set through Copilot's tool prompt, an idle wake and the
  read, against a local ticket server.

[More on Events](./events)

### Skills

::: code-group

```bash [Claude Code]
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

```bash [Codex]
codex mcp add huggingface --url https://huggingface.co/mcp
```

```bash [Pi]
pi mcp add huggingface --url https://huggingface.co/mcp
```

:::

- **Claude Code:** `/mcp-skills` lists what it serves.
- **Codex:** the served skills appear in the `$` list after you ask once to
  list the served skills, from the next turn.
- **Pi:** the served skills appear in Pi's own list as
  `mcp-<server>-<name>`, with descriptions marked
  `[MCP server "<server>", not a local skill]`. Pi can choose one for the
  task, or you can name it with `/skill:mcp-...`.
- **Copilot CLI:** Skills over MCP is built in, so there is no Copilot form
  to install.

Then ask a question one of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

You're asked once whether to load the skill, in the host's own dialog, and
then the agent reads the skill's files from the server and answers from them.
In Pi the choices are "Don't load it", "Show me its SKILL.md first" and
"Load it". Declining loads nothing. Previewing shows the text to you before
the model sees it. Your yes is kept for that skill with exactly those files;
a change asks again. While a served skill is loaded, reaching another MCP
server asks "mcp-skills: reach another MCP server?", naming both servers
(SEP-2640 X8). Skills a server adds mid-session appear after `/reload`.
The [Pi live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/live-run.md)
used Hugging Face's server, loaded two skills after approval, read reference
files and answered from them; a second run previewed each skill first.

[More on Skills](./skills)

### Server Cards

Nothing to set up. Start your host and ask:

> What MCP servers does neon.com publish?

Then add **Neon Docs** (no sign-in):

- **Claude Code:** press **Add**. For one behind a sign-in, ask about
  buildkite.com; once it's added, the host asks you to sign in.
  `claude mcp remove neon-docs -s local` removes Neon Docs again.
- **Codex:** choose "Add it" in its own form. For one behind a sign-in, ask
  about buildkite.com; once it's added, the host asks you to sign in.
- **Pi:** `discover_mcp_servers` reads the domain's AI Catalog and checks
  each card. Ask "Add Neon Docs". `add_mcp_server` shows "Don't add it" and
  "Add it", naming the host, URL, headers, destination `mcp.json` (normally
  `~/.pi/agent/mcp.json`) and `pi mcp remove <name>` to undo it. Only "Add
  it" runs `pi mcp add` and registers the server for the session, so it
  connects without a restart. Decline or close the dialog and nothing is
  added. This was shown in the [Pi live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/live-run.md).
  For a server that needs sign-in, use `/mcp` or `pi mcp login <name>`.
- **Copilot CLI:** ask "Add Neon Docs". Copilot asks before it runs each of
  the plugin's tools, then shows the plugin's form, naming the host, URL,
  headers, the file it writes and the undo command: choose **Add it**. Run
  `/mcp reload` (or start a new session) to use it.
  `copilot mcp remove neon-docs` removes it again. For a server that needs
  sign-in, Copilot offers it when it first connects (`/mcp auth <name>`).

[More on Server Cards](./server-cards)

### ARD in Pi

Ask "What does buildkite.com list in its ard.json?" `ard_discover` reads the
domain's manifest and checks its cards. To search, name a registry in your
request or set `ARD_DISCOVERY_REGISTRY`: there is no default registry.
`ard_search` asks before sending, naming the exact query and registry
endpoint, and saying that up to three referrals may receive it. "Don't send
it" or closing the dialog sends no query; "Send the search" sends it.

Adding a result is a separate question through `ard_add_mcp_server`, with
the host, URL, headers, configuration file and undo command, just as for
Server Cards. It has a different tool name because Pi shares tool names
across extensions and keeps the first registration under a name.

The [Pi live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/live-run.md)
read buildkite.com's `ard.json` and searched the repository's demo registry
after approval. **It did not complete the add step:** the model asked in
chat instead of calling `ard_add_mcp_server`. Addition is covered by tests
in real Pi with a scripted model and a local server.
[More on ARD](./ard)

### ARD in Copilot CLI

Ask "What does buildkite.com list in its ard.json?", then "Add it". Copilot
asks before it runs each tool, then shows the plugin's form. Accept it, run
`/mcp reload`, and sign in when Copilot asks (`/mcp auth buildkite`). To
search, name a registry in your request or set `ARD_DISCOVERY_REGISTRY`:
there is no default registry. Before every search, the form names the
registry and the exact query; only "Send the search" sends it.

In Copilot CLI 1.0.115, `ard_discover` read buildkite.com's catalogs, and a
search of the repository's demo registry on 127.0.0.1 went out only after
Copilot's tool prompt and **Send the search**. No server was added through
ARD in that run; its add step is the Server Cards form's, covered here by
tests that run the plugin's server as Copilot starts it.
[More on ARD](./ard)

### Apps

Apps runs in Claude Code. Availability in each host is listed in the
[polyfills table](./introduction#the-polyfills).

```bash
claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp
```

> Find a shareware game in the arcade and load it.

The app appears under the tool call. After the first view appears, the plugin
offers to switch Claude Code to its fullscreen layout, the only one that
passes clicks and keys to a view. [More on Apps](./apps)

## Servers behind a sign-in

Events and Skills can't use the host's OAuth sign-in; Apps has the same
limit in its available form. A server whose credential is in its
configuration works with Events and Skills:

- **Claude Code:** a server you sign in to through `/mcp`, or a claude.ai
  connector, is out of reach. A header (including `${VAR}`) or a
  `headersHelper` works.
- **Codex:** a header written in the config works; a token kept in an
  environment variable (`bearer_token_env_var`, `env_http_headers`) is out of
  reach, because a plugin's MCP server only sees a fixed few variables.
- **Pi:** a server you sign in to through `/mcp` or `pi mcp login`, or one
  using `auth.provider`, is out of reach and the extension says why. An
  `Authorization` header in `mcp.json` works, written out or resolved from
  `${VARIABLE}` or `!command`. The extensions never read `mcp-auth.json` or
  `auth.json`.
- **Copilot CLI:** Events can't use a server you sign in to through Copilot
  (`/mcp auth`, OAuth). A header in `mcp-config.json` works, written out or
  from `${VAR}`, except variables Copilot strips from extensions
  (`GITHUB_TOKEN`, for one). The plugin never reads Copilot's stored
  credentials.

Server Cards is different: it adds a server to the host's own config, and the
host connects it with its own sign-in. [How it works](./how-it-works) says
why, and what would fix it.

## Turning one off

No polyfill can detect native support on its own yet. When your host ships
one of these extensions, turn that polyfill off.

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

In Pi, set the off switch in the environment Pi starts with, or remove the
extension from the same repository folder you installed from:

| | Off without uninstalling | Remove |
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
