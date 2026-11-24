# mcp-events for Pi

Pi can watch events on your MCP servers ("tell me when a deploy fails") and
act when one fires, even while the session sits idle with nobody typing.

Also available for Claude Code: [mcp-events for Claude Code](../claude-code/README.md),
and for Codex: [mcp-events for Codex](../codex/README.md).

This extension implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which Pi doesn't support itself.
Details are in [Spec and conformance](#spec-and-conformance).

## Install

Nothing is published yet. From a clone of this repository:

```bash
pi install ./polyfills/events/pi/extension
```

Or, to try it for one run without installing:

```bash
pi -e ./polyfills/events/pi/extension
```

The extension is one folder, [`extension/`](extension/): a manifest and one
bundled file of about 0.5 MB, with nothing to install alongside it.

You need:

- **Pi 1.6.0**, the version it was tested with. Extensions are a standard
  part of Pi; nothing needs to be turned on.
- **Node 22 or newer**, which Pi itself needs.

To remove it, run `pi remove` with the same path, or delete it from
`packages` in Pi's `settings.json`.

## Try it

A demo server with events is hosted for anyone to try, with no sign-in. Add it
to Pi:

```bash
pi mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

Start `pi` in a folder and ask:

> Watch for new earthquakes from the feeds server and tell me where each one was.

Pi asks you to confirm the watch, then goes idle. When the server reports an
earthquake, a message from the extension that starts with `[mcp-events]`
arrives by itself, and Pi reads the event and answers. The same server also
offers `hn.comment`, `hn.story`, `npm.release`, `github.release` and
`demo.button`. We listed its event types and started this watch from Pi
1.6.0; a run with a real model, end to end, hasn't been recorded yet.

To stop: "Stop watching the earthquakes."

## How it works

### From install to the first event

| Step | What you see | If it's missing or declined |
|---|---|---|
| Pi starts a session | Nothing. The extension looks at the MCP servers Pi connects, in the background, and the first prompt waits up to 10 seconds for it. | A server that can't be reached is listed under `unavailable` by `list_event_types`, with the reason. |
| You ask Pi to watch something | Pi calls `watch_event`, and the extension asks you in a Pi dialog: which server, which event type, its filters, the note, and that its events will start turns by themselves. | "No", or closing the dialog: nothing is watched, and nothing is sent to the server. In print or JSON mode, where nobody can be asked, a watch is refused. |
| An event arrives | A message from the extension, starting with `[mcp-events]`, appears in the conversation. If Pi is idle it starts a turn at once; if it's busy, after the current one. | The event stays stored either way: `recent_events` lists it. |
| Pi reads the event | `get_event` returns it in full, marked as data from that server. | |

### What Pi can do with it

| Tool | What it does |
|---|---|
| `list_event_types` | What each server offers: event types, delivery modes, the arguments a watch can filter on, and the servers left out, with the reason. |
| `watch_event` | Starts a watch, after you confirm it. |
| `unwatch_event` | Stops one, and ends its subscription on the server. |
| `list_watches` | This session's watches, their status and their last event. |
| `get_event` | One event in full. |
| `recent_events` | The latest events and notices, one line each. |

The catalog of event types also goes into the system prompt, as a section of
its own, so Pi knows what it can watch without asking.

### How the parts fit together

- **`src/index.ts`** is the extension Pi loads. It registers the tools, asks
  you before a watch, adds the catalog to the system prompt
  (`before_agent_start`), notes when you write (`input`), and stops everything
  when the session ends (`session_shutdown`).
- **`src/pi-config.ts`** reads Pi's MCP configuration the way Pi does:
  `mcp.json` in Pi's agent directory, the project's `.pi/mcp.json` once you
  trust the project, and the servers other extensions register.
- **`src/session.ts`** hands new events to the session with
  `pi.sendMessage(…, { triggerTurn: true })`, at most as often as the wake
  limit allows ([Limits](#limits)).
- Everything else is the Events client shared with the other forms,
  [`../core`](../core): the requests, the watches and their delivery loops,
  webhooks and the relay, the event store and the wake gate.

A watch belongs to the Pi session that set it, by Pi's session id. Resuming
the session (`pi --resume`, `/resume`) resumes its watches from where they
stopped.

### Which servers it works with

- **Servers that implement the Events extension** (SEP-3415), over stdio or
  Streamable HTTP, with push, poll or webhook delivery.
- **Servers that speak the form from before the standard** (a top-level
  `events` capability, which ChatGPT reads), by default, as the other forms
  do. That is a step outside the SEP; `MCP_EVENTS_PRE_STANDARD=off` keeps to
  it exactly.
- **Servers with a credential in Pi's configuration**: an `Authorization`
  header, written out or as a `${VARIABLE}` or a `!command`, resolved the way
  Pi resolves it. It's tested against a server that refuses requests without
  the header.

Servers turned off in Pi (`enabled: false`) or hidden (`exposure: "hidden"`)
are left alone.

### Servers that need sign-in

A server you sign in to through Pi (`/mcp`, `pi mcp login`: OAuth, or a
provider's token with `auth.provider`) is out of reach on Pi 1.6.0. Pi keeps
that sign-in to its own connection and doesn't lend the connection to other
extensions, and this extension never reads Pi's stored credentials
(`mcp-auth.json`). `list_event_types` lists such a server under
`unavailable`, saying why. It's tested: Pi signs in to a test server, and the
extension reports it can't reach it.

A change to Pi that lends the connection to extensions
(`pi.getMcpServerSession()`) is prototyped against Pi 1.6.0, and not yet
proposed to Pi; the Skills form uses it when it's there. For
Events it isn't enough by itself: SEP-3415 is defined for protocol revision
2026-07-28 and later, and Pi 1.6.0's MCP client speaks up to 2025-11-25, so
Pi's client would also need to speak 2026-07-28. Until then this form keeps
to its own connection (which speaks 2026-07-28), on a patched Pi too.

### Webhook delivery: the relay

As in the other forms: an event type delivered by webhook only needs a public
address. A relay of your own (a small Cloudflare Worker), the public relay
(`MCP_EVENTS_RELAY=public`), or a forwarder of your own
(`MCP_EVENTS_PUBLIC_URL`) provides one. The relay's setup and trade-offs are
in the [Claude Code form's README](../claude-code/README.md#webhook-delivery-the-relay);
Claude Code, Codex and Pi share a relay. Webhook delivery is used only on a
connection that carries your credentials, as the SEP requires.

### Where it runs

In Pi's own process, for as long as the session is open: the interactive TUI,
and RPC mode, where the extension's dialogs go to the client. In print and
JSON modes a watch can't be confirmed, so none is started; listing and reading
events still work.

## Settings

Settings are environment variables, in the environment Pi starts with. You
don't need any of them to start.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Loaded, and doing nothing (no tools). |
| `MCP_EVENTS_PRE_STANDARD` | `off` refuses servers that advertise events only in the form from before the standard. A comma-separated list of server names allows that form for those servers only. |
| `MCP_EVENTS_BATCH_MS` | How long the extension waits after an event before waking, so a burst is one message. Default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | The least time between two wakes one watch starts, in seconds. Default 60; 0 for none. |
| `MCP_EVENTS_WAKES_PER_HOUR` | How many times events may wake a session in an hour. Default 30; 0 for no limit. |
| `MCP_EVENTS_WAKE_VALUES=1` | Put a few short payload fields into the wake message. Off by default, because it puts text a server wrote into the conversation. |
| `MCP_EVENTS_MIN_POLL_MS` | The least time between two polls of one watch. Default 1000. |
| `MCP_EVENTS_CONNECT_TIMEOUT_MS` | How long to wait for a server. Default 10000. |
| `MCP_EVENTS_RELAY=public`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_RELAY_FILE` | The relay ([Webhook delivery](#webhook-delivery-the-relay)). |
| `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | A forwarder of your own to the local receiver. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default `mcp-events` in Pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). |

### When Pi supports Events itself

This extension is a stopgap. Once Pi handles Events, remove it, or set
`MCP_EVENTS_OFF=1`. Running both would show each event twice. The extension
can't stand down by itself: Pi gives an extension no way to see what its MCP
client supports.

## Limits

The changes hosts would need are in
[What hosts would need to change](../../../docs/host-changes.md).

- **No sign-in through Pi** ([Servers that need sign-in](#servers-that-need-sign-in)).
  The change in Pi: lend its connection to extensions (the proposed patch),
  and speak protocol revision 2026-07-28. Using a lent connection would also
  take a change to the Events client every form shares.
- **A second connection.** The extension opens its own connection to each
  server that offers events, so a local (stdio) server runs twice, once for
  Pi and once for the extension. To save starting servers again at every
  session, a server found not to offer events isn't looked at again for a day.
- **It needs an open session.** Nothing starts Pi when an event arrives and
  no session is open. Events that arrive while it's closed are collected when
  it's resumed, for poll and relay watches, from where they stopped.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute, and a session is woken at most 30 times in an hour. Then it's
  told once, without starting a turn, that events are waiting, and isn't woken
  again until you write to it. Nothing is dropped: `recent_events` lists what
  waited.
- **The wake reaches the model as user input.** Pi shows the message as the
  extension's own (a custom message, not one you typed), but the model
  receives it in the user's turn, so its first line says it's from the
  extension and not typed by you.
- **Pi has no approval step for tools.** Pi runs tool calls without asking,
  unless a permission extension you installed asks. This extension asks you
  before each watch itself. What Pi does about an event is up to Pi and the
  extensions you run, as for anything else in the session.
- **A session open in two Pi processes.** The first runs the watches; the
  second only lists them, and takes over if the first goes.
- **Sizes.** One event is at most 256 KiB, one answer from a remote server
  4 MiB, and one session's stored events 64 MiB.
- **Not yet run against other implementations' servers from Pi.** The shared
  client's interop runs (in the [Codex form](../codex/docs/interop.md)) apply
  to the client; this form has been run against the hand-written fixture
  server, an HTTP server behind a token and behind OAuth, and the hosted demo
  server above.

## Security

An event is data from a server you configured. What the server sent reaches
Pi only as a tool result, when Pi reads it with `get_event` or
`recent_events`. The message that wakes the session carries nothing the
server wrote: only which watch has new events, how many, and their ids.

Receiving an event gives Pi no permission it didn't already have. An event
arrives without anyone asking, though, and Pi runs tool calls without asking
by default, so a server you watch can set work in motion as often as the wake
limit allows. That's why each watch needs your yes.

A watch belongs to the Pi session that set it; another session sees none of
its watches or events. The extension never reads Pi's stored credentials, and
leaves alone servers that sign in through Pi. Details, what is stored, and how
to report a vulnerability are in [`SECURITY.md`](SECURITY.md).

## Spec and conformance

mcp-events implements
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
the Final text as of 24 November 2026, with the client shared by every form
([`../core`](../core)). One step outside it is on by default: servers that
advertise events in the form from before the standard
([Which servers it works with](#which-servers-it-works-with)).
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly.

The clause-by-clause table is in the Claude Code form's
[`docs/conformance.md`](../claude-code/docs/conformance.md), and holds here
because the client is the same. What this form's own tests check, in a real Pi
1.6.0 with its own agent directory and home and a scripted stand-in model:

- the user confirms a watch, the session goes idle, an event arrives, and the
  session wakes by itself and reads it; the wake message carries nothing the
  server sent (`test/wake-test.ts`);
- a declined watch sends nothing to the server (`test/wake-test.ts`);
- against an HTTP server behind a token, `events/list` goes out with the
  credential; behind OAuth, the extension reports that it can't reach it
  (`test/connection-test.ts`, also run on a Pi built with the proposed
  change, with `MCP_PI_PATCHED_CLI`).

## Development

From this folder (`polyfills/events/pi` in the repository):

```bash
(cd ../core && npm ci)    # the shared Events client
npm ci                    # Pi 1.6.0 itself is a devDependency: the tests run it
npm test
npm run typecheck
npm run build             # extension/dist/index.js; a test fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin extension --entry src/index.ts
```

To run the connection test against a Pi built with that change, set
`MCP_PI_PATCHED_CLI` to the build's `packages/coding-agent/dist/cli.js`.

CI: [`pi-events-test.yml`](../../../.github/workflows/pi-events-test.yml).

## Licence

Part of [AgentPolyfill](../../../README.md): MCP extensions for hosts that
haven't shipped them yet.

Apache-2.0. See [`LICENSE`](../../../LICENSE). The bundle includes npm
packages under their own licences:
[`extension/THIRD_PARTY_LICENSES.txt`](extension/THIRD_PARTY_LICENSES.txt).

This is a community project. It isn't affiliated with or endorsed by
Anthropic, OpenAI, Earendil, the Model Context Protocol project, the Agentic
AI Foundation or the Linux Foundation.
