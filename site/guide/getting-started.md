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
Pi's package gallery, and nothing is built. These steps were tested from a
clean, isolated Pi 1.6.0 against this repository on GitHub. Start `pi` to use them.

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

These steps were tested from a clean, isolated OpenCode, installing from
GitHub. There is no OpenCode bundle or single install for every polyfill.
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

The forms are plugins for Google Antigravity's App and CLI (`agy`). These
builds were run in App 2.35.1 and CLI 1.5.17. The IDE documents no plugin hooks, so the forms
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
stays in `~/.codex/mcp-events-t3` until you delete it. These steps were tried
in a fresh Codex home.

## Requirements

### In Claude Code

| | Claude Code | What else it needs | Where it has run |
|---|---|---|---|
| Events | 2.1.326 or newer | Node 20 or newer, or Bun (webhook delivery through a relay needs Node 22 or newer, or Bun); `/mcp-events setup` can fetch Bun for the mod alone on macOS and Linux. A terminal session, or one an app keeps open. | Tested live on macOS; its tests also run on Linux and Windows |
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
`opencode serve`. All four were run with a real model against OpenCode's
server; Events, Skills and Server Cards in the TUI too; Events and Skills in
OpenCode Desktop 2.4.1. Server Cards and ARD weren't tried in OpenCode
Desktop, and ARD wasn't tried in the TUI. The tests run in OpenCode 2.4.1 on
Linux, macOS and Windows; Windows hasn't been tried by hand.

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
resource (seen for Events and Skills). After a wake or a load, what the model
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
| Events | CLI v1.5.17 (these builds); App v2.35.1 (earlier builds) | Node 20 or newer on `PATH`. A watch needs an answer in the approval card. Waking an idle App conversation needs the sidecar on; CLI conversations get new events at their next model call. |
| Skills | CLI v1.5.17 (these builds); App v2.35.1 (earlier builds) | Node 20 or newer on `PATH`. Loading a new or changed skill needs an answer in the approval card. |
| Server Cards | CLI v1.5.17 (these builds); App v2.35.1 (earlier builds) | Node 20 or newer on `PATH`. An addition needs an answer in the approval card. |
| ARD | CLI v1.5.17 (the version run; not run in the App) | Node 20 or newer on `PATH`. An addition or a registry search needs an answer in the approval card. |
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
their gated calls are refused. A webhook watch wasn't run, and these builds
haven't been run in the App yet.

Each Antigravity form's README has the rest:
[Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity) and
[ARD discovery](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity).

### In T3 Code

T3 Code 0.1.11 is the version tested, with Codex 0.172.0.

| | In T3 Code | What else it needs |
|---|---|---|
| Events | the T3 form, for Codex threads only | The `t3` command on the PATH Codex runs with, and Node 20 or newer. |
| Skills, Server Cards, ARD | the plugins of the agent you use | With Codex, the question each asks before loading, adding or searching is cancelled by T3 Code without being shown, so that step doesn't happen. |
| Apps | T3 Code shows MCP Apps itself | Nothing: don't use the Apps polyfill there. |

Not run live in T3 Code: anything with Claude Code or OpenCode as the agent,
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
  folder. The [Pi live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/live-run.md)
  records a confirmed watch, idle wake, event read, answer and stop against
  a local ticket server.
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
  The [OpenCode live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md#public-infrastructure)
  records a demo button pressed on this server and the idle session woken.
- **Antigravity:** try the same question. A watch asks in Antigravity's
  approval card, through the plugin's `force_ask`. New events reach the
  conversation at its next model call, through the plugin's `PreInvocation`
  hook (seen live in the CLI; Antigravity's plugins page doesn't list
  `PreInvocation` among plugin hooks), as fixed text with a count and the
  plugin's own watch ids. An idle App conversation wakes only with the
  sidecar on ([Install](#antigravity)); CLI conversations can't be woken. The
  feeds demo wasn't run in Antigravity: the [live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/live-run.md)
  used the repository's local deploys demo. It records, in CLI 1.5.17, a
  watch approved and one declined, and delivery at the next turn; with
  earlier builds, an idle App conversation woken by the sidecar and a wake
  during a running turn.

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
  each turn. In a live run of earlier builds the plugin listed Hugging Face's
  25 skills and loaded one after approval.

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

In OpenCode, loading takes two steps: OpenCode's skill tool returns a short
note from the plugin, then the model calls `mcp_skills_load_skill`, and
OpenCode asks: "Allow once", "Allow always" or "Reject". There is no preview
of the skill's `SKILL.md` before you decide. In the TUI the prompt says only
"Call tool mcp_skills_load": the server and the skill's URI are on the
model's call line above it, and "Always allow" shows the pattern it would
save, bound to the skill's digest. "Allow always" covers that skill as it is
now; a changed skill asks again. While a served skill is loaded, OpenCode's
own read of another server's resource is asked about, naming both servers
(SEP-2640 X8). The [OpenCode live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md)
loaded two Hugging Face skills after OpenCode asked, and answered from them.
In that run, under OpenCode's default rules, the model also ran a command a
loaded skill described, without a prompt.

In Antigravity the question is the approval card, yes or no, for a new or
changed skill. An approved, unchanged skill skips the plugin's question and
gets only Antigravity's usual MCP question, which allow rules can skip. X8
isn't met: once a served skill is loaded, the plugin's hook asks before a
`read_resource` from another server, naming both, but Antigravity (CLI
1.5.17, App 2.35.1) ignores that question (no card; the read goes ahead).

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
- **OpenCode:** ask "Add Neon Docs". OpenCode asks; in the TUI the prompt
  says only "Call tool mcp_server_cards_add", with "Allow once" and "Reject",
  and the name and URL are on the model's call line above it. Allowed, the
  server is in OpenCode's MCP servers at once, for this project, and OpenCode
  connects it. It isn't written to your configuration files. For a server
  behind a sign-in, add it the same way, then run `opencode mcp auth <name>`
  in a terminal. Ask OpenCode to remove Neon Docs to take it out again
  (`server_cards_remove_mcp_server`). The [OpenCode live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md#in-opencodes-tui)
  added Neon Docs in the TUI, and OpenCode connected it.
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

### ARD in OpenCode

Ask "What does buildkite.com list in its ard.json?" `ard_discover` reads the
domain's manifest and checks its cards. To search, name a registry in your
request or set `ARD_DISCOVERY_REGISTRY`: there is no default registry.
Before anything is sent, `ard_search` is put to OpenCode's rules on the
registry hosts, and OpenCode asks; nothing is saved, so each search is asked
about on its own. A registry a referral names is asked about in a prompt of
its own before the query goes there; rejected, it gets nothing.

In OpenCode's TUI, a prompt for a plugin's action says only "Call tool
`<action>`" (seen for the other three plugins; ARD wasn't tried there). Since
nothing is saved, a search's prompt would offer only "Allow once" and
"Reject", as for Server Cards. The query and the registry you named are on
the model's call line above it, but **nothing on screen names a registry a
referral names**, so reject a prompt you can't read. OpenCode Desktop shows a plugin action's
resource in its prompt, here the registry's host; ARD wasn't tried there
either.

Adding a result is a separate question through `ard_add_mcp_server`, under
the same action as a Server Cards addition (`mcp_server_cards_add`).

The [OpenCode live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md)
read buildkite.com's `ard.json`, and sent a search to the repository's demo
registry after OpenCode asked. It returned Buildkite's and Netlify's servers,
each confirmed by its publisher's catalog. No public registry that takes an
unauthenticated search was found. Addition is covered by tests in real
OpenCode with a scripted model and a local server.
[More on ARD](./ard)

### ARD in Antigravity

The Antigravity form carries the Server Cards checks and add step itself; it
needs no other polyfill installed. There is no default registry: name one in
your request, or set `ARD_DISCOVERY_REGISTRY` in the environment Antigravity
starts in. Every registry search, and every addition, is put to you in
Antigravity's approval card. An addition writes
`~/.gemini/config/mcp_config.json`. ARD was run in the App and the CLI.
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
