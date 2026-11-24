---
description: mcp-events adds the client side of the MCP Events extension (SEP-3415) to Claude Code. Claude watches events on your MCP servers and acts when one fires, even while the session is idle.
---

# Events

`mcp-events` lets Claude watch events on your MCP servers ("tell me when a
deploy fails") and act when one fires, even while the session sits idle with
nobody typing. It adds the client side of the MCP **Events** extension,
`io.modelcontextprotocol/events`
([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
Final), which Claude Code does not support by itself yet.

<Recording
  cut="events"
  alt="One sentence to Claude Code, Give me a demo button, starts a watch and gives a private button page, and the session goes idle. On the page, ship it is typed and Press is pressed; the idle session wakes by itself, reads the event and says the message was ship it."
  caption="A real session against the hosted demo server (21 s; waits sped up, with a badge saying how fast). One sentence gives a private button page and a watch, and the session goes idle. A press on the page wakes it."
/>

## Install

```
/plugin install mcp-events --marketplace idosal/AgentPolyfill
```

Or in a terminal, `claude plugin install mcp-events --marketplace idosal/AgentPolyfill`.
The install is one small folder (about 0.8 MB), and nothing else is downloaded
unless you ask for it with `/mcp-events setup`. It needs Claude Code 2.1.326 or
newer, and Node 20 or newer or Bun.

Events also works in OpenAI Codex, as a plugin:
`codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-events@agent-polyfill`
([Other hosts](./how-it-works#other-hosts)).

## Try it

A demo server with events is hosted for anyone to try, with no sign-in:

```bash
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

Start `claude` in the same folder (one you trust) and ask:

> Give me a demo button and tell me what I type when I press it.

Claude makes a private button page with the server's `new_demo_button` tool,
gives you its link, and watches it. Open the link and press the button: a few
seconds later the idle session wakes by itself, shows a "Prompt from the
mcp-events plugin" line, and answers. The same server also offers `hn.comment`
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

| | Tools | An event wakes the session |
|---|---|---|
| `claude` in a terminal | Yes | Yes |
| A session kept open by an app or the Agent SDK (streaming input) | Yes | Yes |
| `claude -p "…"` (one prompt, then exit) | Yes | No: the process ends with its turn |
| Cloud sessions (Claude Code on the web) | Not supported: the mod has to start a local process | |

Tested live in Claude Code on macOS. The helper's tests also run on Linux and
Windows on every push, but the mod has not been run inside Claude Code on
Linux or Windows, in the desktop app, or in an IDE.

## Settings

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

## Security

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

## More

On GitHub, in [`polyfills/events/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/claude-code):

- [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/README.md): the full guide, the mod's own runtime, development.
- [`docs/conformance.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/conformance.md): every client-side rule of SEP-3415, with the code and the test for each.
- [`model/`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/model/README.md): the formal model, what it found, and what it shows within its bounds.
- [`docs/sign-in.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/sign-in.md): servers that need credentials, and why interactive OAuth is out of reach.
- [`docs/performance.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/performance.md): what it costs to run.
- [`docs/live-run.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/live-run.md): a transcript of a live session.
