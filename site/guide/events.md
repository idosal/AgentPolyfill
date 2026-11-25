---
description: mcp-events adds the client side of the MCP Events extension (SEP-3415). The agent watches events on your MCP servers and acts when one fires, even while the session is idle. Install and limits are listed per host.
---

# Events

`mcp-events` lets your agent watch events on your MCP servers ("tell me when
a deploy fails") and act when one fires, even while the session sits idle with
nobody typing. It adds the client side of the MCP **Events** extension,
`io.modelcontextprotocol/events`
([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
Final). The forms fill these gaps:

- **Claude Code:** no native Events support yet; the polyfill is a mod (plugin).
- **Codex:** no Events support for your own servers; the polyfill is a plugin.
- **Pi:** no native Events support in Pi 1.6.0; the polyfill is an extension.
- **OpenCode:** OpenCode 2.4 takes push events for its automations, but
  doesn't poll, take webhooks or watch for a session; the polyfill is a
  plugin.
- **Muse Code:** the polyfill is the Codex plugin, which Muse installs from
  the same marketplace.

<Recording
  cut="events"
  alt="In Claude Code, asked to watch the acme-checkout Worker on Cloudflare and say what breaks, Claude starts a watch through Cloudflare's MCP server, run locally with a fix, delivered by webhook through a relay, and the session goes idle. When the Worker throws an error, the idle session wakes by itself with a prompt from the mcp-events plugin, reads the event and says what broke: a SyntaxError, where a request that expected JSON got plain text."
  caption="A real session (14 s; the wait is sped up, with a badge saying how fast). Cloudflare's MCP server, run locally with a fix its hosted server doesn't have yet (cloudflare/mcp#438); the Worker's error was set off from outside."
/>

## Install

::: code-group

```txt [Claude Code]
/plugin install mcp-events --marketplace idosal/AgentPolyfill
```

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-events@agent-polyfill
```

```bash [Pi]
pi install git:github.com/idosal/AgentPolyfill
```

```bash [OpenCode]
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/events/opencode/plugin'
```

```bash [Muse Code]
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-events@agent-polyfill
muse plugins approve mcp-events
```

:::

**In Claude Code** (2.1.326 or newer, with Node 20 or newer or Bun), the
terminal form is `claude plugin install mcp-events --marketplace idosal/AgentPolyfill`.
The install is one small folder (about 0.8 MB), and nothing else is downloaded
unless you ask for it with `/mcp-events setup`.

**In Codex** (0.170 or newer, with Node 20 or newer), a watch wakes a Codex
CLI session (the terminal app or `codex exec`). A chat in the ChatGPT desktop
app keeps its events but can't be woken, so ask it for `recent_events`. A
resumed Codex session starts watching at its first Events tool call.

**In Pi** (1.6.0, the version tested, with Node 22 or newer), the command
above installs Events, Skills and Server Cards together.
Pi clones the repository under `~/.pi/agent/git/` and loads the three
extensions from there. Nothing is published to npm or Pi's package gallery,
and nothing is built.

Update installed packages with `pi update --extensions`. Remove all three
and Pi's copy of the repository with
`pi remove git:github.com/idosal/AgentPolyfill`. For one run of all three
without installing, use `pi -e git:github.com/idosal/AgentPolyfill`.

To install only Events, use a clone:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/events/pi/extension
```

Pi loads the local path where it is, so keep the clone. From the same folder,
`pi remove ./polyfills/events/pi/extension` removes that local install;
`pi -e ./polyfills/events/pi/extension` runs it once without installing.
Use one way per form: Pi tells packages apart by repository address or local
path, so a form installed both ways loads twice.

[ARD](./ard#install) is left out of the one-line install, as it is from the
Claude Code bundle: its search sends the words of your request to a registry
after asking each time. Install it separately from a clone.

Removal leaves watches and events in `mcp-events/`, and approvals and skill
stubs in `mcp-skills/`, in Pi's agent folder (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`); delete those folders too to remove that data.
Servers you added stay in `mcp.json`; remove one with
`pi mcp remove <name>`.

**In OpenCode** (2.4 or newer; tested with 2.4.1), OpenCode runs the plugin
itself, so you don't need Node. The plugin isn't on npm: the command fetches
it from GitHub, with Git, and adds it to `plugins` in your global
`~/.config/opencode/opencode.json`, so it runs in every project from the next
time OpenCode opens one. A commit in place of `main` pins one version. From a
clone, put the folder `polyfills/events/opencode/plugin` in `plugins` in an
`opencode.json` instead. To remove it, run `opencode plugin remove` with the
same text; OpenCode's downloaded copy stays in `~/.cache/opencode/npm/` (a
`git-AgentPolyfill-…` folder), which you can delete. Watches, events and the
log stay in `~/.local/share/opencode/mcp-events/` (or `MCP_EVENTS_STATE`);
delete that folder too to remove them. The "Allow always" answers it kept
stay in OpenCode's plugin storage (OpenCode's own database).

**In Muse Code** (1.4.25, the version tested, on macOS only, with Node 20 or
newer), Muse holds the plugin's MCP server and hook until you run
`muse plugins approve mcp-events`, and again after each update. Then start
a new `muse` session. To remove it, run
`muse plugins remove mcp-events --delete-data`, which removes its data
folder and approval too.

The sections below name the host where behavior differs. Full guides by host:

- [Claude Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/claude-code)
- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/pi)
- [OpenCode](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/opencode)
- [Muse Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/muse)

## Try it

A demo server with events is hosted for anyone to try, with no sign-in:

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
{
  "mcp": { "feeds": { "type": "remote", "url": "https://event-feeds.idosalomon.workers.dev/mcp", "oauth": false } }
}
```

```bash [Muse Code]
muse mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

:::

Start your host in the same folder:

- **Claude Code:** `claude`, in a folder you trust.
- **Codex:** `codex`.
- **Pi:** `pi`. Ask "Watch for new earthquakes from the feeds server and tell
  me where each one was." Confirm the watch in Pi's dialog; stop it with
  "Stop watching the earthquakes."
- **OpenCode:** `opencode`, with that entry in the project's `opencode.json`
  or the global one. OpenCode asks you before the watch starts.
- **Muse Code:** `muse`, in a workspace you trust. Ask "Watch for new
  earthquakes from the feeds server and tell me where each one was." The
  answer gives a phrase such as `watch feeds usgs.earthquake 4821`; send exactly that phrase to
  start the watch. New events reach Muse with your next message. Stopping it
  waits for its own phrase, such as `unwatch feeds usgs.earthquake 3307`.

For the button demo, ask:

> Give me a demo button and tell me what I type when I press it.

The agent makes a private button page with the server's `new_demo_button`
tool, gives you its link, and watches it. Open the link and press the button:
a few seconds later the idle session wakes by itself and answers (in Claude
Code, under a "Prompt from the mcp-events plugin" line; in OpenCode's TUI,
under `◈ mcp-events: new events`). The same server also offers `hn.comment`
(new comments in a Hacker News thread), `hn.story`, `npm.release`,
`github.release` and `usgs.earthquake`, all delivered by poll. Its source is in
[`servers/event-feeds`](https://github.com/idosal/AgentPolyfill/tree/main/servers/event-feeds).

To stop: "Stop watching the demo button."

### Or run a demo server yourself

The polyfill's [`demo/`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/claude-code/demo)
folder holds a small Events server: a "deploys" service with a page of
buttons. It needs Node 22.18 or newer.

```bash
git clone https://github.com/idosal/AgentPolyfill
cd AgentPolyfill/polyfills/events/claude-code/demo
npm install
DEPLOYS_TOKEN=demo-token npm start
```

In another terminal, in a project folder you trust:

```bash
claude mcp add --transport http deploys http://127.0.0.1:4010/mcp --header "Authorization: Bearer demo-token"
claude
```

> Watch the deploys server. When a deploy fails, tell me why in one line.

Open http://127.0.0.1:4010/ and press **Deploy a bad commit**. A couple of
seconds later the session wakes by itself, reads the event and the deploy's
log, and tells you the cause.

<Recording
  src="/media/events-deploys.mp4"
  poster="/media/events-deploys.jpg"
  :width="960"
  :height="540"
  alt="A Claude Code session is asked to watch the demo server for failed deploys, and goes idle. On the demo's page a bad commit is deployed; the idle session wakes by itself, reads the deploy's log and names the cause."
  caption="A real session with the deploys demo server (24 s). Waits are shortened, and the frame zooms in on what is being typed or shown."
/>

## From install to the first event

### In Claude Code

1. **Install.** The plugin has no settings to fill in.
2. **A folder you trust.** In a folder you have not trusted, the mod does
   nothing.
3. **Node 20 or newer, or Bun.** The mod looks on Claude Code's PATH, then
   where your login shell finds them, then where their installers put them.
   Without one, the mod shows one notice saying so, and on macOS or Linux
   `/mcp-events setup` then fetches a copy of Bun for the mod alone.
4. **An MCP server with events that Claude Code itself uses in the session:**
   added with `claude mcp add` or in a project's `.mcp.json`, approved, and
   not switched off. The mod leaves alone any server Claude Code is not using.
5. **Ask for a watch**, in plain words. In the default permission mode, the
   first time Claude uses each of the mod's tools, Claude Code asks "Do you
   want to proceed?", as for any MCP tool. An event that arrives while you are
   away waits at that question until you answer, so choose the answer that
   stops Claude Code asking again for that tool, or allow all six of the mod's
   tools up front in `~/.claude/settings.json`:

   ```json
   { "permissions": { "allow": ["mcp__mcp-events__*"] } }
   ```

6. **A server that delivers only by webhook** also needs a relay (below).
   Push and poll delivery need no relay.

### In Pi

At session start, the extension connects to configured servers that offer
Events and lists their event types in the system prompt. When Pi calls
`watch_event`, a yes/no dialog names the server, event type, filters and note
in full, and says that events will start turns. Declining starts no watch. Print
and JSON modes cannot ask, so they start no watch.

After yes, an event wakes an idle session with a message starting
`[mcp-events]`, saying it was sent by the extension, not typed by you. Pi
reads the event with `get_event` and answers. A watch belongs to that Pi
session and resumes with it; a local (stdio) watch resumes only in the same
folder. The [live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/live-run.md)
shows approval, an idle session waking, the answer and stopping the watch.

### In OpenCode

OpenCode loads the plugin into its server once per project folder. The
plugin reads your MCP servers from OpenCode's own configuration and connects
to each the first time one of its tools is called. Its six tools are in
OpenCode's `mcp_events` namespace (`mcp_events_watch_event` and so on), and a
watch belongs to the session it was started in.

When the model calls `mcp_events_watch_event`, OpenCode asks you first,
naming the server and the event type, and again before a watch is stopped.
OpenCode's shipped rules allow every action, so the plugin makes its two
actions ask by default. "Allow always" keeps your answer for that server and
event type in this project. A `deny` or `ask` rule you write wins, and with
nobody there to answer, as in a scheduled run, OpenCode refuses the question,
so no watch starts unattended. The plugin option `askByDefault: false` (or
`MCP_EVENTS_ASK_BY_DEFAULT=0`) leaves watches to OpenCode's rules alone,
under whose default a watch starts without a prompt. In OpenCode 2.4.1's TUI
the question says only "Call tool mcp_events_watch": the server and event
type are on the model's call line just above it, and "Always allow" lists
the pattern it would save. OpenCode Desktop names them in the prompt itself.

After yes, an event wakes an idle session with a message from the plugin
that starts with `[mcp-events]` and carries none of what the server sent; the
model reads the event with `mcp_events_get_event`. The TUI shows that
message as `◈ mcp-events: new events`. OpenCode Desktop starts the turn too,
but shows no entry for the message, so the turn appears with no visible
cause. Watches are kept on disk and resume when OpenCode next opens the
project. The [live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md)
shows the question, an idle session waking and the answer, through OpenCode's
server, in its TUI and in OpenCode Desktop.

### In Muse Code

Muse gives a plugin no way to ask you, and a tool call that isn't read-only
goes to Muse's approval judge, a model that may approve it with nobody asked.
So `watch_event` starts nothing at first. Its answer gives a phrase that names
the server and the event type, such as `watch tickets ticket.created 4821`.
Only a message of yours that is exactly that phrase approves the watch: Muse
runs the plugin's `UserPromptSubmit` hook for your messages, and none of the
ways a model can put text into a session ran it when each was checked. The
phrase is good for that one question, in that session, for 15 minutes.
`unwatch_event` works the same way: its answer names the watch and gives a
phrase such as `unwatch tickets ticket.created 3307`, and the watch stops only
after you send it.

New events reach the model with your next message, as a context block from
the hook that starts
`[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)`.
Nothing wakes an idle session by default.

**Waking an idle session (opt-in, experimental).** Put
`{"MCP_EVENTS_MUSE_WAKE": "attach"}` in the plugin's settings file (see
[Settings](#settings)), and start `muse` with both gates:

```bash
MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1 muse
```

::: warning With these gates on, any program you run can drive the session
Any local process of the same user can attach to the session and start
turns, with no prompt, and could type the phrases. Turn the gates on only on
a machine where you trust everything that runs as you.
:::

Waking is capped as in Codex: once a minute per watch, and 30 times an
hour. It was checked with Muse's echo provider only.

## What Claude can do with it

The mod gives Claude six tools. You do not call them yourself; you ask in
plain words.

| You say | Claude uses |
|---|---|
| "What can you watch on my servers?" | `list_event_types` |
| "Tell me when a high-priority ticket comes in." | `watch_event` |
| "What are you watching?" | `list_watches` |
| "Show me that last event in full." | `get_event`, `recent_events` |
| "Stop watching tickets." | `unwatch_event` |

Watches belong to the project folder and survive a restart: when you start
Claude Code there again, a watch picks up where it stopped, and events from the
meantime arrive if the server (or your relay) kept them.

## How it works

### In Claude Code

A hooks module has no network or process of its own, so the Events client
lives in a small helper process the module starts.

- **Finding servers.** The helper reads the MCP servers Claude Code is
  configured with, and connects only to those Claude Code itself is using in
  this session. It keeps the ones that offer events.
- **Watching.** A watch is one subscription. The delivery mode follows the
  SEP's guidance for clients: webhook where a relay is set up, then push
  (`events/stream`), then poll (`events/poll`).
- **Waking Claude.** Each event is written to disk, then handed to Claude Code
  as a prompt from the plugin, which starts a turn once the session is idle.
  Claude reads it as a message from the plugin, never as your words. The
  message names the server and event type and gives the new events' ids, and
  nothing the server wrote; Claude reads what happened with `get_event`.
- **One session per project** runs the watches. If the first window closes, a
  second one on the same project takes over.
- **Nothing to watch, nothing running.** If no server offers events and
  nothing is watched, the helper exits after 20 seconds.

## Which servers it works with

In Pi, servers offering Events over stdio or Streamable HTTP work with
push, poll or webhook delivery. Credentials must be in Pi's configuration;
Pi's stored sign-ins cannot be used. See [Pi's limits](#limits).

In OpenCode, every server in your OpenCode configuration that declares the
Events extension works, with push, poll or webhook delivery. A remote server
works with the headers in its OpenCode configuration. A server OpenCode signs
in to with OAuth (`opencode mcp auth`) doesn't, and the plugin never reads
OpenCode's stored credentials; `mcp_events_list_event_types` names each
server it left alone, and why. See [OpenCode's limits](#limits).

In Muse Code, the plugin reads the servers in `mcpServers` in
`~/.config/muse/settings.json`, which can hold header values you wrote. It
never reads Muse's sign-in store or a project's `.mcp.json`. It skips a
server signed in with `muse mcp login`, a server whose values come from
`${VAR}` (Muse passes the variable to no plugin), and a server with
`enabled: false`. When an organisation manages Muse (`muse config status`
shows a defaults or policy plane), it reads nothing at all.

### In Claude Code

- Servers that implement the Events extension (SEP-3415), over stdio or
  Streamable HTTP, with push, poll or webhook delivery.
- Servers that speak the form from before the standard, which advertise events
  as a top-level `events` capability instead of the extension. The mod uses
  these by default. Strictly, SEP-3415 says a client must not send `events/*`
  to a server that has not advertised the extension, so this is a step outside
  it; set `MCP_EVENTS_PRE_STANDARD=off` to keep to the SEP exactly.
- Servers that need credentials, when the credential is in the server's
  configuration: a header (including `${VAR}`), or a `headersHelper`.

It does **not** work with a server you can only reach through Claude Code's
interactive OAuth sign-in (`/mcp`), or with claude.ai connectors.

## Webhook delivery: the relay

Pi uses the shared Events relay client. A relay of your own, the public relay
(`MCP_EVENTS_RELAY=public`), or your own forwarder (`MCP_EVENTS_PUBLIC_URL`)
provides the public address. Webhook delivery needs a connection carrying
credentials. The setup command below is for Claude Code; Pi's
[relay instructions](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/README.md#webhook-delivery-the-relay)
link to the shared setup and trade-offs.

OpenCode uses the same relay client: a relay of your own, the public relay
(`MCP_EVENTS_RELAY=public`), or your own forwarder (`MCP_EVENTS_PUBLIC_URL`),
set in the environment OpenCode starts in. Deliveries are taken by the
plugin's receiver inside OpenCode's server, only when signed with the watch's
secret, and only from a subscription on a connection that carries your
credentials. In a live run, a webhook through the public relay woke an
OpenCode session.
[OpenCode's README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/README.md#webhook-delivery)
points to the shared setup.

Some servers deliver only by webhook, and a webhook needs a public https
address, which Claude Code on your machine does not have. A relay is that
address: it keeps each delivery until the mod collects it. Nothing uses a
relay until you set one up.

**Your own relay (recommended)** is a small Cloudflare Worker deployed to your
own Cloudflare account. From inside Claude Code:

```
/mcp-events:relay-setup
```

Webhook delivery through a relay needs Node 22 or newer (or Bun); push and poll
work on Node 20.

**The public relay** is off unless you turn it on by name, with
`MCP_EVENTS_RELAY=public`. It is run by Ido Salomon, the author of the mod.
The payloads of your webhook-delivered events pass through that server and are
stored there until the mod collects them, for about a day at most; webhooks are
signed, not encrypted, so whoever runs a relay can read them. It cannot create
or alter an event: the signing secret never leaves your machine, and the mod
checks every delivery. It is a courtesy with limits and no promise of
availability.

| Delivery | Besides you and the MCP server |
|---|---|
| Push, poll | Nobody. |
| Webhook, your own relay | Nobody else's server. It runs on your Cloudflare account. |
| Webhook, the public relay | The public relay's operator could read payloads in transit and while stored (about a day at most). It cannot forge them. |
| Webhook, `MCP_EVENTS_PUBLIC_URL` | Whoever runs the forwarder you pointed it at. |

## Where it runs

### In Claude Code

| | Tools | An event wakes the session |
|---|---|---|
| `claude` in a terminal | Yes | Yes |
| A session kept open by an app or the Agent SDK (streaming input) | Yes | Yes |
| `claude -p "…"` (one prompt, then exit) | Yes | No: the process ends with its turn |
| Cloud sessions (Claude Code on the web) | Not supported: the mod has to start a local process | |

Tested live in Claude Code on macOS. The helper's tests also run on Linux and
Windows on every push, but the mod has not been run inside Claude Code on
Linux or Windows, in the desktop app, or in an IDE.

### In Pi

In the interactive terminal and RPC mode, for as long as the session stays
open. RPC clients relay the extension's dialogs. Print and JSON modes can
list and read events but cannot start a watch.

### In OpenCode

The plugin runs inside OpenCode's server, which loads a project's plugins
when something uses that project: the TUI (`opencode`), OpenCode Desktop, or
another client of the server (`opencode serve`). Until then a saved watch
doesn't run; events from the meantime arrive when it resumes. An event wakes
an idle session in the TUI and in OpenCode Desktop; Desktop shows no entry
for the wake itself. Tried live through the server's API, in the TUI and in
OpenCode Desktop 2.4.1. CI runs the tests on Linux, macOS and Windows; it
hasn't been tried by hand on Windows.

### In Muse Code

In a `muse` session in a workspace you trust. Events reach the model with
your next message. With the experimental opt-in and both gates on, an event
starts a turn in an idle session. Checked on macOS only.

## Settings

In Pi, set environment variables before starting `pi`. `MCP_EVENTS_OFF=1`
turns the extension off. It cannot detect native Events support; remove it
or use that switch when Pi supports Events itself. The full
[Pi settings table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/README.md#settings)
lists its controls.

In OpenCode, set environment variables in the environment OpenCode starts
in, or plugin options in the object form of the plugin's entry in `plugins`
(`{ "package": "…", "options": { "askByDefault": false } }`).
`MCP_EVENTS_OFF=1`, or the option `off`, turns the plugin off, and
`MCP_EVENTS_ASK_BY_DEFAULT=0`, or `askByDefault: false`, leaves watches to
OpenCode's rules alone. If OpenCode comes to watch every event type for a
session, by push, poll and webhook, turn the plugin off or remove it. The full
[OpenCode settings table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/README.md#settings)
lists its controls.

In Muse Code, environment variables don't work: Muse passes the plugin's
server and hook none of yours. Put the same `MCP_EVENTS_*` settings, by
name, in `settings.json` in the plugin's data folder,
`~/.local/share/muse/plugins/data/mcp-events/`. For example,
`{"MCP_EVENTS_OFF": "1"}` turns it off, and
`{"MCP_EVENTS_MUSE_WAKE": "attach"}` turns on the experimental wake. It
cannot detect native Events support; disable it
(`muse plugins disable mcp-events`) when Muse ships Events. The
[Muse README](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/muse)
has the rest.

The table below is for Claude Code.

Environment variables, for example in the `env` block of
`~/.claude/settings.json`. None is needed to start.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Installed, and doing nothing. |
| `MCP_EVENTS_RUNTIME` | What runs the helper: the full path of a Node 20+ or a Bun, or `private` for only the copy of Bun `/mcp-events setup` fetched. |
| `MCP_EVENTS_PRE_STANDARD` | Servers that advertise events only in the form from before the standard are used by default. `off` refuses servers that advertise events only in the form from before the standard, which is exactly the SEP; a comma-separated list of server names allows that form for those servers only. |
| `MCP_EVENTS_SERVERS` / `MCP_EVENTS_SKIP` | Only these server names, or never these (comma-separated). |
| `MCP_EVENTS_SOURCES` | Which Claude Code configuration scopes to read: `project,local,user` (default all three). |
| `MCP_EVENTS_CONFIG` | A servers file of your own instead of Claude Code's configuration, outside the project folder and its repository. |
| `MCP_EVENTS_BATCH_MS` | How long the helper waits after an event before handing it over, so a burst arrives as one prompt. Default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | The least time between two wakes that one watch starts, in seconds. Default 60; 0 for none. |
| `MCP_EVENTS_WAKES_PER_HOUR` | How many times events may wake a session in an hour before waking stops until you send a message. Default 30; 0 for no limit. |
| `MCP_EVENTS_WAKE_VALUES=1` | Put a few short fields of each event's payload into the message that wakes the session. Off by default: it puts text a server wrote into a prompt. |
| `MCP_EVENTS_MIN_POLL_MS` | The least time between two polls of one watch. Default 1000. |
| `MCP_EVENTS_RELAY=public` | Use the public relay for webhook delivery when you have no relay of your own. Off by default. |
| `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY` | Your own relay, instead of `~/.mcp-events/relay.json`. |
| `MCP_EVENTS_PUBLIC_URL` | A public https forwarder of your own to the helper's local receiver, instead of a relay. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default: the plugin's data folder. |

## Limits

### In Claude Code

- **No interactive OAuth**, as above.
- **It needs an open session.** Nothing starts Claude Code when an event
  arrives. With a relay, webhook events wait for your next session (for up to a
  week on your own relay, a day on the public one).
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute, and a session is woken at most 30 times in an hour; after that
  it is told once that events are waiting, and is not woken again until you
  send a message. Nothing is dropped.
- **A second connection.** The helper opens its own connection to each server
  that offers events, so a local (stdio) server runs twice.
- **Webhook needs credentials.** Webhook delivery is used only for a server
  whose configuration carries a header or a `headersHelper`.
- **Delivery is at least once.** After a crash at the wrong moment an event can
  show twice.
- **Sizes.** One event is at most 256 KiB, one answer from a remote server
  4 MiB, one session's stored events 64 MiB.
- **Managed machines.** Where your organisation sets an MCP allow or deny
  policy that the mod can see, it connects to nothing.
- **The mod API is new.** It still gains and changes parts between releases,
  which can break the mod until it is updated.

### In Pi

- **Its own connection.** The extension cannot send requests over Pi's MCP
  connection, so a local (stdio) server runs twice. Events needs protocol
  revision 2026-07-28; Pi 1.6.0's own client stops at 2025-11-25.
- **No sign-in through Pi.** OAuth and `auth.provider` servers are out of
  reach, and the extension says so. An `Authorization` header in `mcp.json`
  works, written out or using `${VARIABLE}` or `!command`. The extension
  never reads Pi's stored credentials.
- **An open session and limited wakes.** Nothing starts Pi when it is closed.
  By default a watch wakes at most once a minute, and a session at most 30
  times an hour. Past that it is told once, and waits until you write.
- **Reload for later servers.** Servers are read at session start; one
  another extension registers later is reached after `/reload`.
- **Off with Pi's MCP support.** With `--no-mcp`, `-builtin:mcp` in the
  extension settings, or a replacement MCP extension, Events stands down too.

### In OpenCode

- **Its own connection.** OpenCode gives a plugin neither its sign-in nor a
  way to send `events/*` over its own connection. Servers OpenCode signs in
  to with OAuth (`opencode mcp auth`) are out of reach, and a local server
  that offers events runs twice.
- **Two ways to take push events.** OpenCode has part of Events itself: its
  automations take push events, but it doesn't poll or take webhooks, and it
  skips event types whose schemas it can't check (it skipped both of the
  fixture server's types, valid under the SEP). A plugin can't ask which
  types it took, so the plugin watches every type, push included, and tells
  the model to use a watch or an automation for an event type, not both.
  Nothing enforces it: with both set up, an event wakes the session twice.
  That's a stated departure from rule 4 of
  [the contract](./build-a-polyfill#the-contract), which has a polyfill stand
  down where the host is native. OpenCode Console's `console_watch` tools,
  for a signed-in workspace, weren't tried.
- **Watches resume when OpenCode opens the project**, not when its server
  starts. Events from the meantime aren't lost.
- **The wake reaches the model as a user message.** OpenCode stores it as
  synthetic, but sends it in the user's role; its first line says it was
  sent by the plugin, not typed by you.
- **Limited wakes.** By default a watch wakes at most once a minute, and a
  session at most 30 times an hour. Past that it is told once, and waits
  until you write.
- **A watch's note and filter are plain text.** One holding a control or
  hidden character, a note over 500 characters or `arguments` over 2,000 is
  refused, and the model is told to write it again.
- **The plugin keeps its own "Allow always".** Taking a saved approval back
  in OpenCode doesn't take it back from the plugin; an `ask` rule does. An
  `allow` rule you write doesn't skip the question by itself, since the
  plugin can't tell it from OpenCode's default.

### In Muse Code

- **No wake by default.** New events reach the model with your next
  message. Only the experimental opt-in wakes an idle session, and it lets
  any local process of the same user drive the session.
- **No OAuth servers.** A server signed in with `muse mcp login` is skipped,
  and so is one whose values come from `${VAR}`.
- **A typed yes.** Muse gives a plugin no way to ask you, so each watch
  waits for a phrase you type.
- **Settings in a file.** Muse passes the plugin none of your environment
  variables.
- **Off while not approved.** While the plugin's MCP server is rejected or
  not approved in Muse, its hook does nothing.
- **A validation warning.** `muse plugins validate` warns
  `multiple-manifests`, because the folder also holds the Codex manifest.
  The plugin is still valid, with compatibility `full`.
- **Checked on macOS only**, with Muse Code 1.4.25.

## Security

### In Claude Code

An event is data from a server you configured. What the server sent reaches
Claude only as a tool result, when Claude reads it with `get_event` or
`recent_events`. The message that wakes the session carries nothing the server
wrote: only which watch has new events, how many, and their ids. Receiving an
event gives Claude no permission it did not already have: what Claude does
next goes through Claude Code's own permission mode, rules and hooks. An event
arrives without anyone asking, so in a session that approves actions without
asking, a server you watch can set work in motion, as often as the wake limit
allows.

The mod connects only to servers Claude Code itself uses, verifies every
webhook itself (Standard Webhooks signatures, a five-minute window, no
replays), holds no OAuth grant, and listens only on the loopback address behind
a token.

How it is checked:

- **Conformance.** Every client-side rule of SEP-3415, clause by clause, with
  the code and the test for each. The upstream conformance suite's Events
  client scenarios (an unmerged pull request) pass 17 of 17, as run on 0.5.0.
- **Property-based tests** over what a server, a relay or anyone on the wire
  sends first reaches.
- **A formal model** of delivery and of waking, in Quint and in TLA+:
  simulated, and model-checked with TLC to small, stated bounds. TLC checks the
  model, not the code, and says nothing past its bounds. On 0.5.0's model it
  found three cases the simulation had missed; two were in the code too, and
  0.5.1 fixes both, each with a test that fails on 0.5.0.
- **One review from outside the sessions that built it, and no audit by a
  person.** On 24 November 2026 an AI reviewer that had not built any of it
  reviewed the mod and the public relay; what it found is fixed or listed in
  `SECURITY.md`.

The full account, including what it does not protect against:
[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/SECURITY.md).

### In Pi

Pi runs tools without asking unless a permission extension asks. Events adds
its own question before each watch; that does not grant extra permission for
what Pi does next. The tools carry `readOnlyHint` annotations so permission
extensions can distinguish reads from changes. The wake reaches the model
in the user's turn, so its first line identifies the extension. Event payloads
are read as tool results. See
[Pi's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/SECURITY.md).

The shared client's clause table applies in Pi. The Events scenarios in
conformance PR #541 pass 17 of 17 with the shared client as Pi runs it. End
to end through real Pi, 11 pass, none fail and 6 cannot be evaluated because
Pi's own client also connects to the suite's server. See
[Pi's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/conformance.md).
An AI reviewer who did not build the Pi forms reviewed them, and checked
the fixes again. They have not been audited by a person.

### In OpenCode

Starting or stopping a watch is put to OpenCode's permission rules, and
asked about by default. The plugin never answers a prompt and never turns
anything into `allow`. Receiving an event grants nothing, but OpenCode's
shipped default allows the model's other actions, so what it does after a
wake isn't asked about unless your rules say so. The wake carries no event
content; payloads reach the model as tool results, from
`mcp_events_get_event` or `mcp_events_recent_events`. Webhooks are verified,
wakes are capped, and the plugin never reads OpenCode's stored credentials.
See [OpenCode's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/SECURITY.md).

The shared client's clause table applies in OpenCode: the form bundles that
client unchanged (with `MCP_EVENTS_PRE_STANDARD=off`, 80 clauses met and 6
not applicable). The upstream suite's Events scenarios were run against that
client in the Claude Code and Codex forms, not through OpenCode. The form's
own tests run it in OpenCode 2.4.1 with a scripted model, against the fixture
events server: listing, poll, push and webhook delivery, a wake with no
payload, a watch resumed after a restart, and the permission question. See
[OpenCode's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/docs/conformance.md).
Live, with a real model, AgentPolyfill's event-feeds server by poll and a
webhook through the public relay each woke an idle session.
An AI reviewer who did not build the OpenCode forms reviewed them. They have
not been audited by a person.

### In Muse Code

A watch starts only after you send its phrase yourself, so Muse's approval
judge can't start one with nobody asked. The phrase counts only in a message
of yours: Muse runs the plugin's hook for your messages, not for a turn Muse or a model
starts. The context block that hands over new events says it was sent
by the plugin, not typed by you. The experimental wake weakens this: with
its gates on, any local process of the same user can attach to the session,
start turns and type the phrases.

No Muse run used a real model. Every run used Muse's echo provider, or a
local stand-in for the Responses API on 127.0.0.1 with a made-up key, which
also answered the approval judge, in an isolated home with no `muse login`.
See the Muse form's
[SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/muse/SECURITY.md),
[conformance notes](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/muse/docs/conformance.md)
and [run records](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/muse/docs/live-run.md).

## The mod's own runtime

The helper is JavaScript, so it needs Node or Bun, and Claude Code comes with
neither. On a machine with none, `/mcp-events setup` fetches one:

- **Only when you ask, and only after you say yes.** The command counts only
  when you type it at the prompt, or send it from your own Remote Control.
  Claude Code's own dialog then asks whether to download; "Not now" is the first
  answer.
- **What is fetched:** one fixed Bun release, for macOS or Linux, arm64 or x64,
  from that release's page on GitHub, over HTTPS only.
- **Checked before it is installed:** its SHA-256 must equal the one written in
  the mod's source, copied from the release's own checksum file. A download that
  does not match is deleted.
- **Where it goes:** a `runtime` folder in the plugin's data folder, used for
  this mod's helper and nothing else. `/mcp-events setup remove` deletes it.

**Not yet run as one sequence.** The download, the check and the unpacking are
tested with stand-ins for the machine; the download itself has not been run
from this mod. The same code in the mcp-skills mod was run in parts against the
real release.

## When Claude Code supports Events itself

This mod is a stopgap. Once Claude Code handles Events natively, uninstall it
(`/plugin uninstall mcp-events`) or set `MCP_EVENTS_OFF=1`; running both would
show each event twice. It cannot stand down by itself, because a mod has no way
to see what Claude Code's own MCP client supports.

## In T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) runs Codex and Claude Code for
you, and neither of their Events forms can wake one of its threads: the Codex
plugin's wake runs a turn the thread doesn't show, and the Claude Code mod's
helper ends when T3 Code closes the session. So Events has a form of its own
there, [`mcp-events-t3`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/t3), for **Codex threads
only**:

- It's an MCP server you add to Codex (see [Getting started](./getting-started#t3-code)).
  T3 Code tells it which thread it serves (`T3CODE_THREAD_ID`).
- A watcher it starts runs the watches, and outlives the agent's sessions and
  T3 Code itself. It ends by itself when no thread has a watch.
- An event wakes the thread through T3 Code's own `t3 thread send`. The turn
  runs in the thread's permission mode; the message says it's from the
  polyfill, and T3 Code adds that it came through T3 Code's tools.
- The [live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/t3/docs/live-run.md) stopped T3 Code
  entirely before the event arrived; when T3 Code came back, the thread woke
  and read the event.

Claude Code threads can't use it: T3 Code doesn't tell Claude Code's servers
which thread they serve. Not run live: the approval prompt for `watch_event`
in a thread whose mode asks.

## More

On GitHub, in [`polyfills/events/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/claude-code):

- [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/README.md): the full guide, the mod's own runtime, development.
- [`docs/conformance.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/conformance.md): every client-side rule of SEP-3415, with the code and the test for each.
- [`model/`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/model/README.md): the formal model, what it found, and what it shows within its bounds.
- [`docs/sign-in.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/sign-in.md): servers that need credentials, and why interactive OAuth is out of reach.
- [`docs/performance.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/performance.md): what it costs to run.
- [`docs/live-run.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/live-run.md): a transcript of a live session.
