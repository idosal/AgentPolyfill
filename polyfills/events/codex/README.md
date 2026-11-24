# mcp-events for Codex: MCP Events in Codex

A Codex plugin that lets Codex watch events on your MCP servers ("tell me
when a deploy fails") and act when one fires, even while the session sits
idle with nobody typing. It adds the client side of the MCP **Events**
extension, [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which Codex does not support for
your own servers yet.

It is the Codex form of [`mcp-events`](../claude-code) for Claude Code, and
shares its Events client ([`../core`](../core)).

## Install

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-events@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace,
the second installs the plugin (one small folder, [`plugin/`](plugin/), about
0.6 MB; nothing else is downloaded). It needs **Codex 0.170 or newer** and
**Node 20 or newer** on the PATH Codex runs with. To remove it:
`codex plugin remove mcp-events@agent-polyfill`.

## Try it

A demo server with events is hosted for anyone to try, with no sign-in. Add
it to Codex:

```bash
codex mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

Start `codex` in a folder and ask:

> Give me a demo button and tell me what I type when I press it.

Codex makes a private button page with the server's `new_demo_button` tool,
gives you its link, and watches it. Open the link, type a message and press
the button: a few seconds later the idle session gets a message that starts
with `[mcp-events]`, reads the event, and tells you what you typed. That is
the run recorded in [`docs/live-run.md`](docs/live-run.md).

To stop: "Stop watching the demo button."

## From install to the first event

1. **Install** (above). Neither command asks anything.
2. **Node 20 or newer.** Codex does not need Node itself, so check with
   `node --version`. Without it, Codex reports that the `mcp-events` server
   failed to start, and nothing else happens.
3. **An MCP server with events in your Codex configuration**: added with
   `codex mcp add`, or a `[mcp_servers.<name>]` table in
   `~/.codex/config.toml` (or `$CODEX_HOME`), not switched off. A server you
   sign in to through Codex (`codex mcp login`, OAuth) does not work
   ([Which servers it works with](#which-servers-it-works-with)).
4. **Ask for a watch**, in plain words. Starting and stopping a watch go
   through Codex's approval, like any tool that changes something: in the
   default mode Codex asks you (or, with `approvals_reviewer = "auto_review"`,
   its reviewer decides). Say no and nothing is watched. Reading what
   happened (`get_event`, `recent_events`, `list_watches`,
   `list_event_types`) is marked read-only, so Codex does it without asking,
   which matters for a session that wakes while you are away.
5. **Waking.** When an event arrives, the plugin runs `codex queue --thread
   <this session> --message "[mcp-events] …" --resume`. A session open in the
   Codex TUI starts a turn with it as soon as it is idle. This uses the
   Codex app-server daemon, which the TUI starts by itself
   (`daemon_auto_start`, a stable feature, on by default: `codex features
   list` shows it). If you run Codex without the daemon (`--no-daemon`, or
   with `-c` overrides or `--profile`, which make the TUI run its own server),
   see [Where it runs](#where-it-runs).
6. **A server that delivers only by webhook** also needs a relay, a public
   https address that holds deliveries
   ([Webhook delivery](#webhook-delivery-the-relay)). Without one, a watch on
   such a server is refused with a message that lists the choices. Push and
   poll need no relay.

## What Codex can do with it

The plugin gives Codex six tools. You do not call them yourself; you ask in
plain words.

| You say | Codex uses |
|---|---|
| "What can you watch on my servers?" | `list_event_types` |
| "Tell me when a high-priority ticket comes in." | `watch_event` |
| "What are you watching?" | `list_watches` |
| "Show me that last event in full." | `get_event`, `recent_events` |
| "Stop watching tickets." | `unwatch_event` |

A watch belongs to the Codex session that set it, and is kept on disk with
its cursor. Events that came while the session was closed arrive when the
watch starts again, if the server kept them
([Limits](#limits): a resumed session's watches start at its first call of
one of these tools).

## How it works

```
your MCP server (SEP-3415) ──events/stream · events/poll─────────────────►  helper (plugin/dist/helper.js), an MCP server
        │                                                                    │  Codex starts for each session: the Events
        └─signed webhooks──►  relay (your Cloudflare Worker) ──WebSocket───► │  client, one connection per server, one
                              holds deliveries, no signing secret            │  subscription per watch; every event on
                                                                             │  disk before it is acknowledged
Codex  ── tools/call (_meta.threadId = this session) ──────────────────────► │
  ▲                                                                          │
  └── codex queue --thread <session> --message "[mcp-events] …" --resume ────┘  wakes the session when it is idle
```

- **Which session.** Every call Codex makes to an MCP server carries the
  session's id (`_meta.threadId`). That is whose a watch is, and where its
  wake goes.
- **Finding servers.** The first time a tool is called, the helper reads the
  MCP servers in Codex's configuration, connects to each once, and keeps the
  ones that offer events. A server found without events is not asked again
  for a day.
- **Watching.** A watch is one subscription. The delivery mode follows the
  SEP's guidance: webhook where a relay is set up, then push
  (`events/stream`), then poll (`events/poll`).
- **Waking Codex.** Each event is written to disk, then the session is handed
  a message with `codex queue`. Its first line says it is from the plugin,
  not typed by you; the rest names the server and event type, gives the new
  events' ids, and repeats the note Codex saved with the watch, and carries
  nothing the server wrote. Codex reads what happened with `get_event`.
- **One process per session** runs its watches. If the same session is open
  twice, the second lists them, and takes over if the first goes.
- **Lifetime.** Codex starts the helper with the session, as a child of the
  app server that runs it, and stops it when the session is unloaded (about a
  minute after you close it).

## Which servers it works with

- **Servers that implement the Events extension** (SEP-3415), over stdio or
  Streamable HTTP, with push, poll or webhook delivery.
- **Servers that speak the form from before the standard** (a top-level
  `events` capability, which ChatGPT reads), by default, as the Claude Code
  form does. Strictly the SEP says a client must not send `events/*` to a
  server that has not advertised the extension, so this is a step outside it;
  `MCP_EVENTS_PRE_STANDARD=off` keeps to the SEP exactly.
- **Servers that need credentials**, when the credential is in the server's
  configuration: `http_headers`, `http_headers_helper`, or a variable named by
  `env_http_headers` or `bearer_token_env_var` that reaches the helper (see
  Limits).

It does **not** work with a server you sign in to through Codex (`codex mcp
login`, OAuth, `auth = "chatgpt"`): Codex keeps that sign-in to itself, and
gives a plugin no way to send `events/*` over its own connection. The
plugin never reads Codex's stored credentials. Such a server is listed by
`list_event_types` under `unavailable`, with the reason.

## Webhook delivery: the relay

Push and poll need no setup. A server that delivers only by webhook needs a
public https address, which Codex on your machine does not have. A relay is
that address: it keeps each delivery until the plugin collects it, at once
while the session is open and on its next start otherwise.

- **Your own relay (recommended):** a small Cloudflare Worker on your own
  account, the same one the Claude Code form uses (one relay serves both).
  From a clone of this repository, with Node 22.18 or newer:

  ```bash
  cd polyfills/events/claude-code/mod/relay
  npm install && npx wrangler login && npm run setup
  ```

  It writes `~/.mcp-events/relay.json`, which the plugin reads.
- **The public relay (opt-in):** run by Ido Salomon, the author of this
  plugin, at `https://mcp-events-public-relay.idosalomon.workers.dev`. Off
  unless you set `MCP_EVENTS_RELAY=public` in the environment Codex starts
  from. Event payloads pass through it and are stored there until collected
  (about a day at most); it cannot create or alter an event. Each watch that
  uses it says so.
- **A forwarder of your own:** `MCP_EVENTS_PUBLIC_URL` (and
  `MCP_EVENTS_RECEIVER_PORT`), to the plugin's local receiver.

Webhook delivery through a relay needs Node 22 or newer. The relay's own
documentation: [`../claude-code/mod/relay/README.md`](../claude-code/mod/relay/README.md).

## Where it runs

| | Tools | An event wakes the session |
|---|---|---|
| The Codex TUI (`codex`), with the app-server daemon (the default) | Yes | Yes |
| `codex --remote <app server>` | Yes | Yes, with `MCP_EVENTS_CODEX_REMOTE` set to the same address (tested: [`docs/live-run.md`](docs/live-run.md)) |
| `codex exec` | Yes | No: the session, and the helper with it, end with the run |
| The TUI without the daemon (`--no-daemon`, `-c`, `--profile`) | Yes | Not tested. `codex queue` then has no daemon to resume the session on, so the message is expected to wait in its queue |
| The Codex desktop app, the IDE extension | Not tested | Not tested |

Tested live in the Codex TUI 0.172.0 on macOS. The tests also run on Linux in
CI; Windows has not been tried. On Windows the plugin runs only `codex.exe`,
or Node with an npm install's `codex.js`, never npm's `codex.cmd`
([`SECURITY.md`](SECURITY.md)); without either it cannot wake a session.

## Limits

- **No interactive OAuth**, as above. The change in Codex that would remove
  this: a way for a plugin to send `events/*` (or any MCP request) over
  Codex's own, signed-in connection, such as exposing its client's
  `send_custom_request` through the app server.
- **A resumed session's watches wait for a tool call.** Codex starts a
  resumed session's MCP servers only when one of their tools is first called.
  Until then nothing runs the session's watches. They start again, from their
  cursors, the moment Codex calls any of this plugin's tools in that session
  (the plugin asks Codex to call `list_watches` after a resume; asking "check
  my watches" also does it). Seen live: asked "What are you watching?", Codex
  answered from memory and called nothing. The change in Codex: start a
  resumed session's plugin servers when it opens, as for a new session.
- **It needs an open session.** Nothing starts Codex when an event arrives
  and no session is open. (`codex queue --resume` would resume a closed
  session in the daemon, but by then no helper is running to receive the
  event.)
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute; a session is woken at most 30 times in an hour, then told
  once that events are waiting, and not woken again for an hour, or until,
  sooner, you write to it and Codex calls one of the plugin's tools in that
  turn. Telling that you wrote depends on the turn metadata Codex 0.172 sends
  with each call (`turn_trigger`: `user`, `exec`, or voice); with an older
  Codex, or a turn it marks otherwise, the pause ends only after its hour.
  Nothing is dropped: `recent_events` lists what waited. Two settings below
  change the numbers.
- **The wake is an input message.** Codex has no separate channel for a
  plugin's message, so it appears in the conversation like something typed,
  with a first line saying it is from the plugin. The change in Codex: a
  turn started by an extension, marked as such to the model and in the UI.
- **Credentials from environment variables.** Codex passes a plugin's server
  only the variables the plugin names (here `CODEX_HOME` and its own
  `MCP_EVENTS_*`). A server whose token comes from `bearer_token_env_var` or
  `env_http_headers` is left out, with the reason, unless that variable
  reaches the helper. Put the header in `http_headers` or
  `http_headers_helper`, or run the helper as an MCP server of your own with
  `env_vars` naming the variable.
- **Only `config.toml`'s servers.** Servers from a project's
  `.codex/config.toml`, and those other plugins bring, are not read.
- **A second connection.** The helper opens its own connection to each server
  that offers events, so a local (stdio) server runs twice.
- **Delivery is at least once.** After a crash at the wrong moment an event
  can be announced twice.
- **Sizes.** One event is at most 256 KiB, one answer from a remote server
  4 MiB, one session's stored events 64 MiB.
- **Managed machines.** Where your organisation manages Codex's MCP servers,
  it connects to nothing: on macOS and Linux it looks at `/etc/codex`
  (and, on macOS, managed-preferences profiles), on Windows at
  `%ProgramData%\OpenAI\Codex\requirements.toml`. A Windows policy set only in
  the registry or by MDM is not detected.
- **One forwarder port.** With `MCP_EVENTS_PUBLIC_URL` and a fixed
  `MCP_EVENTS_RECEIVER_PORT`, only the first session to open the receiver gets
  the port; webhook watches in a second session fail until it is free. A relay
  has no such limit.
- **Experimental parts of Codex.** The app server is marked experimental in
  Codex's CLI; `codex queue` and `daemon_auto_start` are not. Nothing needs to
  be turned on.

## Security

An event is data from a server you configured. What the server sent reaches
Codex only as a tool result, when Codex reads it with `get_event` or
`recent_events`. The message that wakes the session carries nothing the
server wrote: only which watch has new events, how many, and their ids.
Receiving an event gives Codex no permission it did not already have. Keep in
mind that an event arrives without anyone asking, so in a session that
approves actions without asking, a server you watch can set work in motion,
as often as the wake limit allows. Details, what is stored, and how to report
a vulnerability: [`SECURITY.md`](SECURITY.md).

## Settings

Environment variables, in the environment Codex's app server runs with (the plugin
passes on only these; for the daemon that is the environment it was started
from, so run `codex app-server daemon restart` after a change). None is
needed to start.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Installed, and doing nothing (no tools). |
| `MCP_EVENTS_PRE_STANDARD` | `off` refuses servers that advertise events only in the form from before the standard; a comma-separated list allows that form for those servers only. |
| `MCP_EVENTS_SERVERS` / `MCP_EVENTS_SKIP` | Only these server names, or never these. |
| `MCP_EVENTS_CONFIG` | A servers file of your own (TOML `[mcp_servers.*]`, or JSON `{"mcpServers": …}`) instead of `config.toml`. |
| `MCP_EVENTS_CODEX_BIN` | The full path of the `codex` to run `codex queue` with. Default: the first on the PATH, then where Codex's installers put it. |
| `MCP_EVENTS_CODEX_REMOTE` | The app server to queue wakes on (`ws://…`, `unix://…`), for Codex run with `--remote`. |
| `MCP_EVENTS_BATCH_MS` | How long the plugin waits after an event before waking, so a burst is one message. Default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | The least time between two wakes one watch starts, in seconds. Default 60; 0 for none. |
| `MCP_EVENTS_WAKES_PER_HOUR` | How many times events may wake a session in an hour. Default 30; 0 for no limit. |
| `MCP_EVENTS_WAKE_VALUES=1` | Put a few short payload fields into the wake message. Off by default: it puts text a server wrote into the conversation. |
| `MCP_EVENTS_MIN_POLL_MS` | The least time between two polls of one watch. Default 1000. |
| `MCP_EVENTS_RELAY=public`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_RELAY_FILE` | The relay, as above. |
| `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | A forwarder of your own to the local receiver. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default `$CODEX_HOME/mcp-events`. |

## If something does not work

- Ask Codex "what can you watch?" A server you expected that is missing is
  listed under `unavailable`, with the reason.
- `list_watches` says when waking the session last failed, and why.
- The log is `~/.codex/mcp-events/mcp-events.log`; tokens are removed from it.
- `codex mcp list` shows whether Codex sees the `mcp-events` server.

Bugs and questions: [open an issue](https://github.com/idosal/AgentPolyfill/issues)
that names `mcp-events` for Codex, with your Codex version, your operating
system and the relevant lines of the log.

## When Codex supports Events itself

Codex supports Events today only for OpenAI's own hosted apps server. Once it
handles them for your servers, remove this plugin (`codex plugin remove
mcp-events@agent-polyfill`) or set `MCP_EVENTS_OFF=1`; running both would
show each event twice. It cannot stand down by itself: Codex gives a plugin
no way to see what its own MCP client supports.

## Proof and conformance

- [`docs/live-run.md`](docs/live-run.md): a watch made from a real Codex
  session, a button press, and the idle session waking and answering; then
  the same session resumed and woken again.
- [`docs/interop.md`](docs/interop.md): runs against servers others wrote:
  hookbench's reference server (7 of 7), Hookdeck's Outpost demo against its
  own mock Outpost (4 of 4), and this repository's event-feeds (3 of 3).
  mcp-mailbox is a relay, not an Events server, and was not run.
- [`docs/conformance.md`](docs/conformance.md): the SEP's client rules, which
  the shared client meets (the clause-by-clause table is the Claude Code
  form's), and which of them this form's tests check end to end. The
  upstream conformance suite's Events client scenarios (its open pull request
  #541) pass 17 of 17, against the shared client and end to end through the
  bundled helper (`npm run conformance`, `npm run conformance:helper`).

## Development

From this folder (`polyfills/events/codex` in the repository):

```bash
(cd ../core && npm ci)    # the shared Events client
npm ci
npm test                  # Node 22.18 or newer runs the TypeScript tests
npm run typecheck
npm run build             # plugin/dist/helper.js; a test fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin plugin   # plugin/THIRD_PARTY_LICENSES.txt
```

- [`plugin/`](plugin/) is what gets installed, and all of it: the manifest
  (`.codex-plugin/plugin.json`), the server's entry (`.mcp.json`), the
  bundled helper (`dist/helper.js`) and a skill.
- `src/` is what is specific to Codex: reading `config.toml`
  (`codex-config.ts`), the MCP server Codex starts (`mcp-server.ts`,
  `helper.ts`), sessions (`threads.ts`, `meta.ts`), waking (`waker.ts`) and
  what it says (`words.ts`). The rest is [`../core`](../core).
- `test/` runs the helper as Codex does, against the Claude Code form's
  fixture events server (written from the SEP, sharing no code with the
  client), with a stand-in `codex`; `test/interop/run.ts` runs the interop.
  CI: [`codex-events-test.yml`](../../../.github/workflows/codex-events-test.yml).
- To release, change the version in `plugin/.codex-plugin/plugin.json`,
  `package.json` and `src/version.ts`, rebuild, and merge to `main`.

## Licence

Apache-2.0. See [`LICENSE`](../../../LICENSE). The bundled helper includes
npm packages under their own licences:
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt).
