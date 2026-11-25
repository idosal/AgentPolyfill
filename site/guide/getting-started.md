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

`ard-discovery` is for ARD, a draft from outside MCP. It isn't in the bundle,
because a search sends the words of your request to the ARD registry you
choose. Install it by name, and it brings `mcp-server-cards` with it.

There is no Skills polyfill for Claude Code: Claude Code lists skills from MCP
servers itself, in beta from 2.1.332. [Skills](./skills#claude-code) says what
is known, and how to uninstall the `mcp-skills` plugin if you installed it
before.

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
`ard-discovery`, for ARD (a draft from outside MCP), is added by name, for the
same reason as in Claude Code:

```bash
codex plugin add ard-discovery@agent-polyfill
```

### Pi

Pi 1.6.0 (`@earendil-works/pi-coding-agent`, the version tested), with Node
22 or newer. Install Events, Skills and Server Cards together:

```bash
pi install git:github.com/idosal/AgentPolyfill
```

Pi clones the repository into its agent folder (under `~/.pi/agent/git/`)
and loads the three extensions from there. Nothing is published to npm or
Pi's package gallery, and nothing is built. Checked in Pi 1.6.0. Start `pi`
to use them.

Update installed packages with `pi update --extensions`. To try all three
for one run without installing:

```bash
pi -e git:github.com/idosal/AgentPolyfill
```

ARD is left out for the same reason it isn't in the Claude Code bundle:
its search sends the words of your request to a registry after asking you
each time. Install it on its own from a clone:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/ard/pi/extension
```

ARD includes its own Server Cards checks and add tool; it needs no other
polyfill installed. Apps has no Pi form.

The clone path also works for any one form alone. From the clone, replace
`<form>` with `events`, `skills`, `server-cards` or `ard`:

```bash
pi install ./polyfills/<form>/pi/extension
```

Pi loads a local path where it is, so keep the clone; `git pull` in it brings
the next version. Use one way per form,
not both: Pi tells packages apart by their repository address or local
path, so a form installed both ways loads twice.

For one run of a single form without installing, from the clone:

```bash
pi -e ./polyfills/<form>/pi/extension
```

### OpenCode

OpenCode 2.4 or newer (the V2 plugin API; tested with 2.4.1), with Git, which
OpenCode uses to fetch each plugin. OpenCode runs the plugins itself, so you
don't need Node. Nothing for OpenCode is published to npm: OpenCode installs
each plugin from this repository on GitHub. In a terminal, install the ones
you want:

```bash
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/events/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/skills/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'
```

Checked in OpenCode 2.4.1. There is no OpenCode bundle or single install for every polyfill.
Apps has no OpenCode form. ARD carries the Server Cards code and its own add
tool; installing `mcp-server-cards` beside it is optional.

Each command adds the plugin to `plugins` in your global configuration
(`~/.config/opencode/opencode.json`), so it runs in every project, from the
next time OpenCode opens one. `#main` installs what the main branch holds; a
commit in its place pins one version. Each `plugin/` folder holds one bundled
file, `server.js`, and a `package.json` that names it, with nothing to build;
the Events and Skills folders carry the bundle's licence notices too.

Or, from a clone of this repository, add a plugin's folder to `plugins`
yourself, in the global configuration or a project's `opencode.json`:

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/events/opencode/plugin"]
}
```

OpenCode loads it the next time it opens the project.

### Antigravity

The forms are plugins for Google Antigravity's App and CLI (`agy`). Checked
in App 2.35.1 and CLI 1.5.17. The IDE documents no plugin hooks, so the forms
aren't supported there, and their gated calls are refused. The plugins'
hooks run `node`, so Node 20 or newer must be on `PATH`. Nothing is
published to Antigravity's Marketplace. Installing needs the Antigravity CLI:
`agy plugin install` is a CLI command, and the App doesn't ship `agy`. From a
clone of this repository, install the plugins you want:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/events/antigravity/plugin
agy plugin install ./polyfills/skills/antigravity/plugin
agy plugin install ./polyfills/server-cards/antigravity/plugin
```

`ard-discovery`, for ARD (a draft from outside MCP), installs the same way,
from the same clone. Every search asks you first and goes to a registry you
choose:

```bash
agy plugin install ./polyfills/ard/antigravity/plugin
```

`agy plugin install` copies the folder to `~/.gemini/config/plugins/<name>`,
which the App and the CLI both read. Apps has no Antigravity form: the App
renders MCP Apps itself (v2.34.0 and later), and the CLI and IDE show text
only.

Events can wake an idle App conversation only through its sidecar, which is
off until you add `"sidecars": {"mcp-events/wake": {"enabled": true}}` to
`~/.gemini/config/config.json`. The plugin never edits that file.

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
`git pull` in it brings the next version. From GitHub,
`copilot plugin marketplace add idosal/AgentPolyfill` adds the same
marketplace, and Copilot keeps its own copy. Checked in Copilot CLI 1.0.105.
Not checked in 1.0.115, in the interactive TUI, or in VS Code.

There is no Copilot bundle. Events is a Copilot extension, and Copilot loads
extensions only in its experimental mode: start it with
`copilot --experimental`, or, per Copilot's help, run `/settings experimental on` once (not checked). Server
Cards and ARD are MCP servers in plugins and need no experimental mode.
`ard-discovery`, for ARD (a draft from outside MCP), carries its own add tool;
installing `mcp-server-cards` beside it is optional. Copilot has Skills over
MCP and MCP Apps built in, so there is no Copilot form of those
([why](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/README.md#skills-and-apps-in-copilot)).

To try one for a single run without installing, replace `<polyfill>` with
`events`, `server-cards` or `ard`:

```bash
copilot --experimental --plugin-dir ./AgentPolyfill/polyfills/<polyfill>/copilot/plugin
```

### Hermes Agent

Hermes Agent v0.23.4 (the version tested), with Node 20 or newer on the
gateway's machine. Install each plugin from its folder in this repository:

```bash
hermes plugins install idosal/AgentPolyfill/polyfills/events/hermes/plugin --enable
hermes plugins install idosal/AgentPolyfill/polyfills/skills/hermes/plugin --enable
hermes plugins install idosal/AgentPolyfill/polyfills/server-cards/hermes/plugin --enable
```

ARD is a draft from outside MCP. Install it separately:

```bash
hermes plugins install idosal/AgentPolyfill/polyfills/ard/hermes/plugin --enable
```

Each plugin carries its Python code and bundled Node helper; no npm install
is needed. `AGENTPOLYFILL_NODE` can name another Node executable. Apps has
no Hermes form yet. ARD carries its own add and remove tools and can run
beside Server Cards.

Events and Skills use only the servers you name in the plugin's settings.
In `~/.hermes/config.yaml` (or your profile's), merge these settings with any
entries you already have:

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

These names must also have entries under `mcp_servers`; the first runs below
show them. The server list is the plugin's own grant, separate from Hermes's
`mcp_allowlist`. Without `allow_gateway_injection`, Events stores events but
cannot wake a session; `list_watches` says so.

### T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) runs the Codex, Claude Code
or OpenCode already on your machine, so install the plugins above for the
agent you use in it. For Events in Codex threads, use the T3 form instead of
the Codex plugin. Nothing for T3 Code is published; add it from a clone:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
codex mcp add mcp-events-t3 -- node "$PWD/AgentPolyfill/polyfills/events/t3/plugin/dist/server.js"
```

Then use **Restart agent session** in T3 Code. To remove it, run
`codex mcp remove mcp-events-t3` and
`node AgentPolyfill/polyfills/events/t3/plugin/dist/server.js --stop`; its data
stays in `~/.codex/mcp-events-t3` until you delete it.

## Requirements

### In Claude Code

| | Claude Code | What else it needs | Where it has run |
|---|---|---|---|
| Events | 2.1.326 or newer | Node 20 or newer, or Bun (webhook delivery through a relay needs Node 22 or newer, or Bun); `/mcp-events setup` can fetch Bun for the mod alone on macOS and Linux. A terminal session, or one an app keeps open. | Checked on macOS; its tests also run on Linux and Windows |
| Server Cards, ARD | 2.1.329 or newer | Nothing else: no helper process, no Node, no account. To add a server, the `claude` command, found on your `PATH` or in the usual install folders. | |
| Apps | 2.1.329 or newer | Nothing else, not even Node: the plugin carries a small helper program for each platform. A Chromium-based browser (Chrome, Edge, Chromium, Brave); clicking into views needs Claude Code's fullscreen layout. | macOS, Linux (x64 or Arm64) and Windows x64; Windows hasn't been used in a Claude Code session yet |

All of them run as mods, the kind of Claude Code plugin whose code runs inside
Claude Code; mods are on by default from Claude Code 2.1.287. Claude Code runs a
plugin's code only in a folder you've told it you trust, which it asks the
first time you start `claude` in a folder. In a folder you haven't trusted,
the polyfills do nothing.

The runtime download doesn't happen unless you send the command yourself (at
the prompt, or from your own Remote Control) and then answer Download in
Claude Code's own dialog. What is fetched and how it's checked is on the
[Events](./events#the-mod-s-own-runtime) page.

Skills needs no polyfill in Claude Code: it is built in, in beta from 2.1.332
([Skills](./skills#claude-code)).

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

### In OpenCode

| | OpenCode | What else it needs |
|---|---|---|
| Events | 2.4 or newer (tested with 2.4.1) | Git, to install it. A watch runs while OpenCode has the project open. |
| Skills | 2.4 or newer (tested with 2.4.1) | Git, to install it. |
| Server Cards, ARD | 2.4 or newer (tested with 2.4.1) | Git, to install it. An added server connects over streamable HTTP; an SSE remote is refused. |
| Apps | not available | OpenCode has no MCP Apps support, and a plugin can't read a `ui://` resource or a tool's `_meta`; an OpenCode form was assessed, not built. |

Each one runs inside OpenCode's own server, once per project folder, so it
works the same from the TUI (`opencode`), OpenCode Desktop or a client of
`opencode serve`. All four were checked against OpenCode's server; Events,
Skills and Server Cards in the TUI too; Events and Skills in OpenCode Desktop
2.4.1. Not checked: Server Cards and ARD in OpenCode Desktop, and ARD in the
TUI. The tests run in OpenCode 2.4.1 on Linux, macOS and Windows; Windows
was not checked beyond the tests.

OpenCode's shipped permission rules allow every action. Each polyfill puts
its own actions to those rules and asks you by default: starting or stopping
a watch, loading a skill, a read of another server's resource while a served
skill is loaded, adding or removing a server, a registry search. A `deny` or
`ask` rule you write wins. With nobody there to answer, as in a scheduled
run, OpenCode refuses the question. To leave them to OpenCode's rules alone,
set the plugin option `askByDefault` to `false`, in the object form of the
plugin's entry (`{ "package": "<path or spec>", "options": { "askByDefault": false } }`),
or `MCP_EVENTS_ASK_BY_DEFAULT=0`, `MCP_SKILLS_ASK_BY_DEFAULT=0`,
`MCP_SERVER_CARDS_ASK_BY_DEFAULT=0` or `ARD_DISCOVERY_ASK_BY_DEFAULT=0` in
the environment OpenCode starts in. An `allow` rule you write doesn't skip
the question by itself, since the plugin can't tell it from OpenCode's
default.

"Allow always" keeps your answer for a watch's server and event type
(Events) or for a skill as it is now (Skills), in that project. The plugin
keeps its own record of it, so taking it back in OpenCode doesn't make it ask
again; an `ask` rule for the action does. Server Cards and ARD save nothing:
each addition and each search is asked about on its own.

In OpenCode 2.4.1's TUI, the prompt for a polyfill's action says only "Call
tool `<action>`", such as "Call tool mcp_events_watch"; the details are on the
model's call line just above it. OpenCode Desktop shows the action and its
resource (checked for Events and Skills). After a wake or a load, what the model
does goes through OpenCode's rules as usual, and their default allows it.

Events and Skills each open their own connection to a server: a local server
runs twice. OpenCode loads a project's plugins when something uses that
project, so a saved watch runs again only when OpenCode next opens the
project; events from the meantime arrive then.

Each OpenCode form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/opencode),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/opencode),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/opencode) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/opencode).

### In Antigravity

| | Antigravity | What else it needs |
|---|---|---|
| Events | App v2.35.1 and CLI v1.5.17 | Node 20 or newer on `PATH`. A watch needs an answer in the approval card. Waking an idle App conversation needs the sidecar on; CLI conversations get new events at their next model call. |
| Skills | App v2.35.1 and CLI v1.5.17 | Node 20 or newer on `PATH`. Loading a new or changed skill needs an answer in the approval card. |
| Server Cards | App v2.35.1 and CLI v1.5.17 | Node 20 or newer on `PATH`. An addition needs an answer in the approval card. |
| ARD | App v2.35.1 and CLI v1.5.17 (an addition through ARD was not checked in the App) | Node 20 or newer on `PATH`. An addition or a registry search needs an answer in the approval card. |
| Apps | no form | The App renders MCP Apps itself (v2.34.0 and later); the CLI and IDE show text only. |

Antigravity documents no MCP elicitation, and its MCP client cancels every
request without showing it. So each plugin asks through its `PreToolUse`
hook, which answers `force_ask`: Antigravity's own approval card, with the
hook's question (the CLI's card shows its first two lines). The App greys
out the card's "always allow" choices; the CLI's card still lists them. The
hook leaves a one-use ticket for exactly that call, and the MCP server acts
only with it. Editors on `agy acp` see the tool and its arguments, not the
question.

Watches, new or changed skill loads, additions and searches ask through
`force_ask`. The other Events tools, an approved unchanged skill load and
skill file reads pass with a ticket and then get Antigravity's usual MCP
question, which allow rules can skip. By default that question is asked: the
interactive CLI starts in auto mode, where an MCP tool call still asks, and
headless `agy -p` reports `request-review` and denies a call nobody answers.
Whether `--dangerously-skip-permissions` also skips `force_ask` hasn't been
checked. In CLI 1.5.17 a `PreToolUse` hook that fails makes the call fail.

The IDE documents no plugin hooks, so the forms aren't supported there, and
their gated calls are refused. A webhook watch was not checked.

Each Antigravity form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity).

### In Copilot CLI

| | Copilot CLI | What else it needs |
|---|---|---|
| Events | 1.0.115 or newer, in experimental mode | Nothing else: Copilot runs the extension with its own Node. An open session. The first session asks once whether the extension may have elevated permissions. A new watch needs someone to answer the plugin's question. |
| Server Cards, ARD | 1.0.115 or newer | Node 20 or newer on your `PATH`. Adding a server or sending a registry search needs Copilot's form, so it works in the interactive session only. |
| Skills | built in | Copilot CLI 1.0.115 declares Skills over MCP to every server; there is no Copilot form. |
| Apps | built in for graphical hosts | VS Code's Copilot harness turns MCP Apps on (from its source; not checked in VS Code); the terminal draws none. There is no Copilot form. |

Copilot asks before each of the plugins' tools that act (`watch_event`,
`unwatch_event`, `add_mcp_server`, `ard_search`), as for any tool. Copilot can
approve a call without you, though: in assisted mode (an LLM review, which an
organisation can make the default) or with allow-all. So each plugin asks its own question after
Copilot's prompt. Before a watch starts, Events asks in a Copilot dialog,
naming the server, the event type, the filters and the note, and
saying that events will start turns; **Don't watch it** comes first. Server
Cards and ARD ask in the plugin's form before adding a server or sending a
search. Where nobody can be asked (`copilot -p`), a watch is refused, and
Copilot declines the form, even with `--yolo`. To leave watches to Copilot's
rules alone, set `MCP_EVENTS_ASK_BY_DEFAULT=0` in the environment Copilot
starts in. `ard_search` is marked not read-only, because VS Code's Copilot
harness runs read-only tools without asking (Copilot CLI 1.0.115 asked before
them).

Events opens its own connection to a server, so a local (stdio) server runs
twice. It reads only the servers Copilot enables for the session.
`copilot --acp` loads no extensions, and `copilot -p` ends the session with
the prompt, so nothing is woken there. A server that Server Cards or ARD adds
connects after `/mcp reload`, or in the next session.

Checked in VS Code 1.147.0's Copilot harness: Events end to end, where a
wake shows as a message from the plugin, then the turn; and Server Cards
adding a server, through VS Code's tool prompt and then the plugin's form,
which VS Code shows as one paragraph. ARD's server loads there. Not checked
in VS Code: an ARD search, and the Events watch question.

Each Copilot form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/copilot),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/copilot) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/copilot).

### In Hermes

| | Hermes Agent | What else it needs |
|---|---|---|
| Events | v0.23.4 (the version tested) | Node 20 or newer on the gateway's PATH. Servers named in `plugins.entries.mcp-events.settings.servers`; `allow_gateway_injection` to wake a session. Poll and push; webhook stays with Hermes. |
| Skills | v0.23.4 (the version tested) | Node 20 or newer on the gateway's PATH. Servers named in `plugins.entries.mcp-skills.settings.servers`. Newly found skills are listed from the next session. |
| Server Cards, ARD | v0.23.4 (the version tested) | Node 20 or newer on the gateway's PATH. Hermes's approval for additions and searches; `/reload-mcp` to connect an added server. |
| Apps | not yet | |

By default Hermes lists plugin tools behind Tool Search, and a small model may
not find them there: with `tools.tool_search.enabled: off` in `config.yaml`
it sees them directly.

The Python plugin runs in Hermes's gateway and starts its Node helper there.
Approvals go through Hermes's own once/session/always/deny prompt on the
session's surface, and fail closed where nobody can answer. A lasting ARD
search approval covers only that exact query to that endpoint; different
words ask again. Where Hermes approves without asking (`--yolo`, `/yolo`, `hermes -z`,
`approvals.mode: off`), the plugins refuse a watch, a skill load, a registry
search and a server addition instead; unattended approve modes still approve
them.

Events and Skills open their own connections, so a local server runs twice.
They leave alone a server that uses Hermes's sign-in, or whose entry takes
`${VAR}` from Hermes's `.env`. Events also leaves `events: true` servers to
Hermes's own webhook delivery. The configuration is read again at every turn
and tool call. After a gateway restart, watches resume at the first session
or turn.

Each Hermes form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/hermes),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/hermes),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/hermes) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/hermes).

### In T3 Code

T3 Code 0.1.11 is the version tested, with Codex 0.172.0.

| | In T3 Code | What else it needs |
|---|---|---|
| Events | the T3 form, for Codex threads only | The `t3` command on the PATH Codex runs with, and Node 20 or newer. |
| Skills, Server Cards, ARD | the plugins of the agent you use | With Codex, the question each asks before loading, adding or searching is cancelled by T3 Code without being shown, so that step doesn't happen. |
| Apps | T3 Code shows MCP Apps itself | Nothing: don't use the Apps polyfill there. |

Not checked in T3 Code: anything with Claude Code or OpenCode as the agent,
the approval prompt for `watch_event` in a thread whose mode asks, Server
Cards and ARD. [T3 Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md) has the details.

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

```jsonc [OpenCode]
// opencode.json
{
  "mcp": { "feeds": { "type": "remote", "url": "https://event-feeds.idosalomon.workers.dev/mcp" } }
}
```

```bash [Antigravity]
agy mcp add feeds https://event-feeds.idosalomon.workers.dev/mcp
```

```bash [Copilot CLI]
copilot mcp add --transport=http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

```yaml [Hermes]
# config.yaml in your Hermes profile
mcp_servers:
  feeds:
    url: https://event-feeds.idosalomon.workers.dev/mcp
plugins:
  entries:
    mcp-events:
      settings:
        servers: [feeds]
      allow_gateway_injection: true
```

:::

`agy mcp add` is in CLI 1.5.17's own help, not in Antigravity's docs. The
Antigravity App doesn't ship `agy`. There, add the server under
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
  folder. Checked in Pi 1.6.0: a confirmed watch, an idle wake, the event
  read, the answer and the stop.
- **OpenCode:** the entry goes in `mcp` in `opencode.json`, the project's or
  your global one. The agent makes a private button page, gives you its link,
  and watches it. OpenCode asks before the watch starts, naming the server
  and the event type; in the TUI the prompt says only "Call tool
  mcp_events_watch", and both are on the model's call line above it. "Allow
  always" keeps that answer for that server and event type in this project.
  Press the button: the idle session wakes with a message from the plugin
  that starts with `[mcp-events]`, and the model reads the event and answers.
  The TUI shows the wake as `◈ mcp-events: new events`; OpenCode Desktop
  shows no entry for it, so the turn starts with no visible cause. By
  default, a watch can wake the session once a minute and the session can
  wake 30 times an hour. Watches resume when OpenCode next opens the project.
  Checked in OpenCode 2.4.1: a demo button pressed on this server wakes the
  idle session.
- **Antigravity:** try the same question. A watch asks in Antigravity's
  approval card, through the plugin's `force_ask`. New events reach the
  conversation at its next model call, through the plugin's `PreInvocation`
  hook (checked in CLI 1.5.17; Antigravity's plugins page doesn't list
  `PreInvocation` among plugin hooks), as fixed text with a count and the
  plugin's own watch ids. An idle App conversation wakes only with the
  sidecar on ([Install](#antigravity)); CLI conversations can't be woken. The
  feeds demo was not checked in Antigravity. Checked in App 2.35.1 and CLI
  1.5.17: a watch approved and one declined, delivery at the next turn in the
  CLI, and an idle App conversation woken by the sidecar.
- **Copilot CLI:** start `copilot --experimental`. The first session asks
  once whether the extension may have elevated permissions; choose **Yes**.
  A watch asks twice: Copilot's tool prompt for `watch_event`, then the
  plugin's dialog, which names the server, the event type, the filters and
  the note and says events will start turns; choose **Watch it**. Press the
  button: a few seconds later the idle session starts a turn by itself, reads
  the event and tells you what you typed. The wake's first line says the
  plugin sent it, not you. Checked in Copilot CLI 1.0.115: a watch set
  through Copilot's tool prompt, an idle wake and the read.
- **Hermes:** start `hermes`, with the demo server and plugin settings above
  in your profile's `config.yaml`. Hermes makes a private button page and
  asks you to approve the watch. Type a message on the page and press the
  button. The idle session gets a message starting `[mcp-events]`, reads the
  event with `get_event`, and tells you what you typed. Stop it with
  "Stop watching the demo button."

[More on Events](./events)

### Skills

::: code-group

```bash [Codex]
codex mcp add huggingface --url https://huggingface.co/mcp
```

```bash [Pi]
pi mcp add huggingface --url https://huggingface.co/mcp
```

```jsonc [OpenCode]
// opencode.json
{
  "mcp": { "huggingface": { "type": "remote", "url": "https://huggingface.co/mcp", "oauth": false } }
}
```

```bash [Antigravity]
agy mcp add huggingface https://huggingface.co/mcp
```

```yaml [Hermes]
# config.yaml in your Hermes profile
mcp_servers:
  huggingface:
    url: https://huggingface.co/mcp
plugins:
  entries:
    mcp-skills:
      settings:
        servers: [huggingface]
```

:::

- **Codex:** the served skills appear in the `$` list after you ask once to
  list the served skills, from the next turn.
- **Pi:** the served skills appear in Pi's own list as
  `mcp-<server>-<name>`, with descriptions marked
  `[MCP server "<server>", not a local skill]`. Pi can choose one for the
  task, or you can name it with `/skill:mcp-...`.
- **OpenCode:** the served skills are in OpenCode's own skill list as
  `mcp-skills:huggingface:<name>`, each described
  `[MCP server "huggingface", not a local skill] …`.
  `mcp_skills_list_skills` lists them, and each server it left alone, with
  the reason.
- **Antigravity:** in the App, add the server under Customizations >
  Installed > MCP Servers. Served skills appear as placeholder folders in
  `~/.gemini/config/skills/`, which Antigravity documents reading before
  each turn.

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
Checked in Pi 1.6.0 with Hugging Face's server: loading two skills after
approval, reading reference files and answering from them, and previewing a
skill first.

In OpenCode, loading takes two steps: OpenCode's skill tool returns a short
note from the plugin, then the model calls `mcp_skills_load_skill`, and
OpenCode asks: "Allow once", "Allow always" or "Reject". There is no preview
of the skill's `SKILL.md` before you decide. In the TUI the prompt says only
"Call tool mcp_skills_load": the server and the skill's URI are on the
model's call line above it, and "Always allow" shows the pattern it would
save, bound to the skill's digest. "Allow always" covers that skill as it is
now; a changed skill asks again. While a served skill is loaded, OpenCode's
own read of another server's resource is asked about, naming both servers
(SEP-2640 X8). Checked in OpenCode 2.4.1: loading two Hugging Face skills
after OpenCode asked, and answering from them. Under OpenCode's default
rules, the model can also run a command a loaded skill describes, without a
prompt.

In Antigravity the question is the approval card, yes or no, for a new or
changed skill. An approved, unchanged skill skips the plugin's question and
gets only Antigravity's usual MCP question, which allow rules can skip. X8
isn't met: once a served skill is loaded, the plugin's hook asks before a
`read_resource` from another server, naming both, but Antigravity (CLI
1.5.17, App 2.35.1) ignores that question (no card; the read goes ahead).

In Hermes, the plugin looks at the server during your first turn. From the
next session, skills appear as `mcp-skills:huggingface-<name>`, each marked
with its server. `list_skills` and `load_skill` reach them at once. Ask:

> Use the Hugging Face local-models skill: which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Hermes views the stub and calls `load_skill`. Its approval names the skill,
server and files. To read SKILL.md first, deny and type the `/mcp-skills show`
line in the question; the model never sees that preview. A kept approval
covers that version only, and a changed skill asks again. While a served
skill is loaded, reading another server's resource asks each time.

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
  added. Checked in Pi 1.6.0.
  For a server that needs sign-in, use `/mcp` or `pi mcp login <name>`.
- **OpenCode:** ask "Add Neon Docs". OpenCode asks; in the TUI the prompt
  says only "Call tool mcp_server_cards_add", with "Allow once" and "Reject",
  and the name and URL are on the model's call line above it. Allowed, the
  server is in OpenCode's MCP servers at once, for this project, and OpenCode
  connects it. It isn't written to your configuration files. For a server
  behind a sign-in, add it the same way, then run `opencode mcp auth <name>`
  in a terminal. Ask OpenCode to remove Neon Docs to take it out again
  (`server_cards_remove_mcp_server`). Checked in OpenCode 2.4.1's TUI with
  Neon Docs.
- **Antigravity:** approve the addition in Antigravity's approval card. The
  plugin then writes the server to `~/.gemini/config/mcp_config.json`. A card
  that needs a secret can't be added: Antigravity's personal
  `mcp_config.json` reads no `${VAR}`, and the plugin never writes a secret.
- **Copilot CLI:** ask "Add Neon Docs". Copilot asks before it runs each of
  the plugin's tools, then shows the plugin's form, naming the host, URL,
  headers, the file it writes and the undo command: choose **Add it**. Run
  `/mcp reload` (or start a new session) to use it.
  `copilot mcp remove neon-docs` removes it again. For a server that needs
  sign-in, Copilot offers it when it first connects (`/mcp auth <name>`).
- **Hermes:** ask "Add Neon Docs" and approve the prompt naming the server,
  URL, headers with their values (secrets as `${VAR}` references), transport, file and undo action. It writes `mcp_servers` in
  `config.yaml`. Run `/reload-mcp` or start a new session to connect it.
  `hermes mcp remove neon-docs`, then `/reload-mcp`, removes it again.
  If the result names an OAuth challenge, run `hermes mcp login <name>`
  before reloading. The plugin never handles the sign-in.

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

Checked in Pi 1.6.0: reading buildkite.com's `ard.json`, and a search of the
repository's demo registry after approval. Adding is checked by the form's
tests only.
[More on ARD](./ard)

### ARD in OpenCode

Ask "What does buildkite.com list in its ard.json?" `ard_discover` reads the
domain's manifest and checks its cards. To search, name a registry in your
request or set `ARD_DISCOVERY_REGISTRY`: there is no default registry.
Before anything is sent, `ard_search` is put to OpenCode's rules on the
registry hosts, and OpenCode asks; nothing is saved, so each search is asked
about on its own. A registry a referral names is asked about in a prompt of
its own before the query goes there; rejected, it gets nothing.

In OpenCode's TUI, a prompt for a plugin's action says only "Call tool
`<action>`" (checked for the other three plugins; ARD was not checked there). Since
nothing is saved, a search's prompt would offer only "Allow once" and
"Reject", as for Server Cards. The query and the registry you named are on
the model's call line above it, but **nothing on screen names a registry a
referral names**, so reject a prompt you can't read. OpenCode Desktop shows a plugin action's
resource in its prompt, here the registry's host; ARD was not checked there
either.

Adding a result is a separate question through `ard_add_mcp_server`, under
the same action as a Server Cards addition (`mcp_server_cards_add`).

Checked in OpenCode 2.4.1: reading buildkite.com's `ard.json`, and a search
of the repository's demo registry after OpenCode asked. No public registry
that takes an unauthenticated search was found. Adding is checked by the
form's tests only.
[More on ARD](./ard)

### ARD in Antigravity

The Antigravity form carries the Server Cards checks and add step itself; it
needs no other polyfill installed. There is no default registry: name one in
your request, or set `ARD_DISCOVERY_REGISTRY` in the environment Antigravity
starts in. Every registry search, and every addition, is put to you in
Antigravity's approval card. An addition writes
`~/.gemini/config/mcp_config.json`. Checked in the App and the CLI.
[More on ARD](./ard)

### ARD in Copilot CLI

Ask "What does buildkite.com list in its ard.json?", then "Add it". Copilot
asks before it runs each tool, then shows the plugin's form. Accept it, run
`/mcp reload`, and sign in when Copilot asks (`/mcp auth buildkite`). To
search, name a registry in your request or set `ARD_DISCOVERY_REGISTRY`:
there is no default registry. Before every search, the form names the
registry and the exact query; only "Send the search" sends it.

Checked in Copilot CLI 1.0.115: `ard_discover` reading buildkite.com's
catalogs, and a search of the repository's demo registry going out only
after Copilot's tool prompt and **Send the search**. No other registry was
checked. The add step is the Server Cards form's, and is checked by the
form's tests only.
[More on ARD](./ard)

### ARD in Hermes

Ask "Use ARD to discover the MCP servers neon.com publishes." Discovery
reads public documents and sends no query to a registry. To search, name a
registry or set `ARD_DISCOVERY_REGISTRY` in the gateway's environment; none
is chosen for you. Hermes's approval names the exact endpoint and query.
Session and always cover only that exact query to that endpoint; different
words ask again. Each referral requires its own call and approval.

Adding is a separate approval through `ard_add_mcp_server`. The server goes
in `mcp_servers` in `config.yaml`; `/reload-mcp` connects it.
`ard_remove_mcp_server` removes an unchanged entry this plugin added, after
approval, and `/reload-mcp` disconnects it.

The recorded live run used a scripted model to read buildkite.com's
`ard.json` and card. Search, referrals and additions were checked with local
fixtures in Hermes; no live registry search was sent.
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
- **OpenCode:** a server OpenCode signs in to with OAuth
  (`opencode mcp auth`) is out of reach; the polyfill's list tool names each
  server it left alone, and why. The headers in a server's OpenCode
  configuration work. The plugins never read OpenCode's stored credentials.
- **Antigravity:** a server that needs Antigravity's own sign-in is skipped.
  A header works: `agy mcp add --header "Authorization: Bearer <token>" <name> <url>`
  writes it to `~/.gemini/config/mcp_config.json`. The plugins read that
  file, header values included, to connect, and never log or show those
  values. They never open
  `~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in store.
- **Copilot CLI:** Events can't use a server you sign in to through Copilot
  (`/mcp auth`, OAuth). A header in `mcp-config.json` works, written out or
  from `${VAR}`, except variables Copilot strips from extensions
  (`GITHUB_TOKEN`, for one). The plugin never reads Copilot's stored
  credentials.
- **Hermes:** Events and Skills leave alone `auth: oauth` servers and
  entries that take `${VAR}` from Hermes's `.env`. Local commands and URLs
  with headers written in `config.yaml` work, if named in the plugin's
  `settings.servers`. Neither form reads Hermes's stored credentials.

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
