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

### Antigravity

Google Antigravity's App, CLI (`agy`) and IDE share one plugin format. The
forms were run in the App and the CLI; the IDE wasn't run. The plugins' hooks
run `node`, so Node 20 or newer must be on `PATH`. Nothing is
published to Antigravity's Marketplace. From a clone of this repository,
install the plugins you want:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/events/antigravity/plugin
agy plugin install ./polyfills/skills/antigravity/plugin
agy plugin install ./polyfills/server-cards/antigravity/plugin
agy plugin install ./polyfills/ard/antigravity/plugin
```

`agy plugin install` copies the folder to `~/.gemini/config/plugins/<name>`,
which the App and the CLI both read. Apps has no Antigravity form: the App
renders MCP Apps itself (v2.34.0 and later), and the CLI and IDE show text
only.

Events can wake an idle App conversation only through its sidecar, which is
off until you add `"sidecars": {"mcp-events/wake": {"enabled": true}}` to
`~/.gemini/config/config.json`. The plugin never edits that file.

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

### In Antigravity

| | Antigravity | What else it needs |
|---|---|---|
| Events | App v2.35.1, CLI v1.5.16 (the versions run) | Node 20 or newer on `PATH`. Waking an idle App conversation needs the sidecar on; CLI conversations get new events at their next model call. |
| Skills | App v2.35.1, CLI v1.5.16 (the versions run) | Node 20 or newer on `PATH`. A skill load needs an answer in the approval card. |
| Server Cards | App v2.35.1, CLI v1.5.16 (the versions run) | Node 20 or newer on `PATH`. An addition needs an answer in the approval card. |
| ARD | CLI v1.5.16 (the version run; not run in the App) | Node 20 or newer on `PATH`. An addition or a registry search needs an answer in the approval card. |
| Apps | no form | The App renders MCP Apps itself (v2.34.0 and later); the CLI and IDE show text only. |

Antigravity documents no MCP elicitation, and its MCP client cancels every
request without showing it. So each plugin asks through its `PreToolUse`
hook, which answers `force_ask`: Antigravity's own approval card, which shows
the hook's question and can't be approved for good. The hook leaves a one-use
ticket for exactly that call, and the MCP server acts only with it. Editors
on `agy acp` see the tool and its arguments, not the question.

The IDE's agent wasn't run: IDE 2.8.0 stayed signed out, and its hooks page
lists no plugin hooks. Without the hooks every Events call is refused, so the
plugins probably don't work in the IDE at all. A webhook watch wasn't run
either.

Each Antigravity form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity).

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

```bash [Antigravity]
agy mcp add feeds https://event-feeds.idosalomon.workers.dev/mcp
```

:::

The Antigravity App doesn't ship `agy`. There, add the server under
Customizations > Installed > MCP Servers, or in
`~/.gemini/config/mcp_config.json`.

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
- **Antigravity:** try the same question. A watch goes through
  Antigravity's usual MCP approval. New events reach the conversation at its
  next model call. An idle App conversation wakes only with the sidecar on
  ([Install](#antigravity)); CLI conversations can't be woken. The feeds demo
  wasn't run in Antigravity: the [live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/live-run.md)
  used the repository's local deploys demo, and records delivery at the next
  turn in the CLI, an idle App conversation woken by the sidecar, and a wake
  during a running turn.

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

```bash [Antigravity]
agy mcp add huggingface https://huggingface.co/mcp
```

:::

- **Claude Code:** `/mcp-skills` lists what it serves.
- **Codex:** the served skills appear in the `$` list after you ask once to
  list the served skills, from the next turn.
- **Pi:** the served skills appear in Pi's own list as
  `mcp-<server>-<name>`, with descriptions marked
  `[MCP server "<server>", not a local skill]`. Pi can choose one for the
  task, or you can name it with `/skill:mcp-...`.
- **Antigravity:** in the App, add the server under Customizations >
  Installed > MCP Servers. Served skills appear as placeholder folders in
  `~/.gemini/config/skills/`, which Antigravity reads before each turn. In
  the live run the plugin listed Hugging Face's 25 skills and loaded one
  after approval.

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
In Antigravity the question is the approval card, yes or no. An approved,
unchanged skill loads again with no question. X8 isn't met there, as in
Codex: the plugin can't put a question in front of Antigravity's own
resource reads, so the loaded skill tells the model to ask you first.

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
- **Antigravity:** approve the addition in Antigravity's approval card. The
  plugin then writes the server to `~/.gemini/config/mcp_config.json`. A card
  that needs a secret can't be added: Antigravity's personal
  `mcp_config.json` reads no `${VAR}`, and the plugin never writes a secret.

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

### ARD in Antigravity

The Antigravity form carries the Server Cards checks and add step itself; it
needs no other polyfill installed. There is no default registry: name one in
your request, or set `ARD_DISCOVERY_REGISTRY` in the environment Antigravity
starts in. Every registry search, and every addition, is put to you in
Antigravity's approval card. An addition writes
`~/.gemini/config/mcp_config.json`. ARD was run in the CLI only, not in the
App.
[More on ARD](./ard)

### Apps

Apps runs in Claude Code. Availability in each host is listed in the
[polyfills table](./introduction#the-polyfills). The Antigravity App renders
MCP Apps itself (v2.34.0 and later), with no polyfill; its CLI and IDE show
text only.

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
- **Antigravity:** a server that needs Antigravity's own sign-in is skipped.
  A header works: `agy mcp add --header "Authorization: Bearer <token>" <name> <url>`
  writes it to `~/.gemini/config/mcp_config.json`. The plugins read that
  file, header values included, to connect, and never log or show those
  values. They never open
  `~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in store.

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
`mcp_config.json`; remove it with `agy mcp remove <name>`, or delete its
entry from that file.
