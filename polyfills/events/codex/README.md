# mcp-events for Codex

Codex can watch events on your MCP servers ("tell me when a deploy fails")
and act when one fires, even while the session sits idle with nobody typing.

Also available for Claude Code, Pi and OpenCode: [mcp-events for Claude Code](../claude-code/README.md), [mcp-events for Pi](../pi/README.md), [mcp-events for OpenCode](../opencode/README.md).
The same plugin folder also holds the Muse Code form, with its own manifest and bundles: [mcp-events for Muse Code](../muse/README.md).

This plugin implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which Codex doesn't support for your
own servers yet. Details are in [Spec and conformance](#spec-and-conformance).

## Install

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-events@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace,
and the second installs the plugin. The install is one small folder,
[`plugin/`](plugin/), of about 0.6 MB. Nothing else is downloaded.

You need:

- **Codex 0.170 or newer**, and 0.172 or newer for an event to wake your
  session ([Where it runs](#where-it-runs)).
- **Node 20 or newer** on the PATH Codex runs with. Webhook delivery through a
  relay needs Node 22 or newer.

To remove it, run `codex plugin remove mcp-events@agent-polyfill`.

## In Muse Code

This folder also holds the Muse Code form: its own manifest
(`.muse-plugin/plugin.json`) and bundles (`muse/`), built from
[`../muse`](../muse) with this form's sources unchanged. This form's bundle is
the same with or without it, and Codex doesn't read the Muse manifest or
anything in `muse/`: installed into a throwaway Codex home, the plugin gives
Codex the same skills, MCP server and tools as without them, and no hooks
([`tools/muse/codex-ignores-muse.mjs`](../../../tools/muse/codex-ignores-muse.mjs),
run with Codex 0.172.0). [mcp-events for Muse Code](../muse/README.md) has the
install steps, what works differently there and why, its limits, and its
security notes.

## Try it

A demo server with events is hosted for anyone to try, with no sign-in. Add it
to Codex:

```bash
codex mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

Start `codex` in a folder and ask:

> Give me a demo button and tell me what I type when I press it.

Codex makes a private button page with the server's `new_demo_button` tool,
gives you its link, and watches it. Open the link, type a message and press
the button. A few seconds later the idle session gets a message that starts
with `[mcp-events]`, reads the event, and tells you what you typed. That is
the run recorded in [`docs/live-run.md`](docs/live-run.md).

The same server also offers `hn.comment` (new comments in a Hacker News
thread), `hn.story`, `npm.release`, `github.release` and `usgs.earthquake`,
all delivered by poll.

To stop: "Stop watching the demo button."

## How it works

### From install to the first event

Here is every step and question between the install line and an event waking
your session, and what happens when something is missing or you say no.

1. **Install** (above). Neither command asks anything.
2. **Node 20 or newer.** Codex doesn't need Node itself, so check with
   `node --version`. Without it, Codex reports that the `mcp-events` server
   failed to start, and nothing else happens.
3. **An MCP server with events in your Codex configuration.** That is, a
   server added with `codex mcp add`, or a `[mcp_servers.<name>]` table in
   `~/.codex/config.toml` (or under `$CODEX_HOME`), and not switched off. A
   server you sign in to through Codex (`codex mcp login`, OAuth) doesn't work
   ([Servers that need sign-in](#servers-that-need-sign-in)).
4. **Ask for a watch**, in plain words. Starting and stopping a watch go
   through Codex's approval, like any tool that changes something. In the
   default mode Codex asks you, or, with `approvals_reviewer = "auto_review"`,
   its reviewer decides. If you say no, nothing is watched. Reading what
   happened (`get_event`, `recent_events`, `list_watches`,
   `list_event_types`) is marked read-only, so Codex does it without asking.
   That matters for a session that wakes while you're away.
5. **Waking.** When an event arrives, the plugin runs
   `codex queue --thread <this session> --message "[mcp-events] …" --resume`.
   A session open in the Codex TUI starts a turn with it as soon as it's idle.
   This uses the Codex app-server daemon, which the TUI starts by itself
   (`daemon_auto_start`, a stable feature, on by default; `codex features list`
   shows it). If you run Codex without the daemon (`--no-daemon`, or with `-c`
   overrides or `--profile`, which make the TUI run its own server), see
   [Where it runs](#where-it-runs).
   The plugin wakes a session only once a turn you started in Codex's own app
   has called one of its tools. That is how it knows the wake will be shown
   ([Where it runs](#where-it-runs)). Asking for the watch is such a turn.
6. **A server that delivers only by webhook** also needs a relay: a public
   https address that holds deliveries
   ([Webhook delivery](#webhook-delivery-the-relay)). Without one, a watch on
   such a server is refused, with a message that lists the choices. Push and
   poll need no relay.

### What Codex can do with it

The plugin gives Codex six tools. You don't call them yourself: you ask in
plain words.

| You say | Codex uses |
|---|---|
| "What can you watch on my servers?" | `list_event_types` |
| "Tell me when a high-priority ticket comes in." | `watch_event` |
| "What are you watching?" | `list_watches` |
| "Show me that last event in full." | `get_event`, `recent_events` |
| "Stop watching tickets." | `unwatch_event` |

A watch belongs to the Codex session that set it, and is kept on disk with its
cursor. Events that came while the session was closed arrive when the watch
starts again, if the server kept them. A resumed session's watches start at
its first call of one of these tools ([Limits](#limits)).

### How the parts fit together

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
  session's id (`_meta.threadId`). That id says whose a watch is, and where
  its wake goes.
- **Finding servers.** The first time a tool is called, the helper reads the
  MCP servers in Codex's configuration, connects to each once, and keeps the
  ones that offer events. A server found without events isn't asked again for
  a day.
- **Watching.** A watch is one subscription. The delivery mode follows the
  SEP's guidance: webhook where a relay is set up, then push
  (`events/stream`), then poll (`events/poll`).
- **Waking Codex.** Each event is written to disk first. Then the session is
  handed a message with `codex queue`. Its first line says it's from the
  plugin, not typed by you. The rest names the server and event type, gives
  the new events' ids, and repeats the note Codex saved with the watch. It
  carries nothing the server wrote: Codex reads what happened with
  `get_event`.
- **One process per session** runs its watches. If the same session is open
  twice, the second lists them, and takes over if the first goes.
- **Lifetime.** Codex starts the helper with the session, as a child of the
  app server that runs it. It stops the helper when the session is unloaded,
  about a minute after you close it.

### Which servers it works with

- **Servers that implement the Events extension** (SEP-3415), over stdio or
  Streamable HTTP, with push, poll or webhook delivery.
- **Servers that speak the form from before the standard**, which is what
  ChatGPT reads. They advertise events as a top-level `events` capability
  instead of the extension. The plugin uses these by default, as the Claude
  Code form does. Strictly, the SEP says a client must not send `events/*` to
  a server that hasn't advertised the extension, so this is a step outside
  it. `MCP_EVENTS_PRE_STANDARD=off` keeps to the SEP exactly.
- **Servers that need credentials**, when the credential is in the server's
  configuration ([below](#servers-that-need-credentials)).

### Servers that need credentials

The plugin works with a server whose credential is in its configuration:
`http_headers`, `http_headers_helper`, or a variable named by
`env_http_headers` or `bearer_token_env_var` that reaches the helper.

That last condition matters. Codex passes a plugin's server only the variables
the plugin names: here `CODEX_HOME` and the plugin's own `MCP_EVENTS_*`. So a
server whose token comes from `bearer_token_env_var` or `env_http_headers` is
left out, with the reason, unless that variable reaches the helper. To use
such a server, put the header in `http_headers` or `http_headers_helper`, or
run the helper as an MCP server of your own, with `env_vars` naming the
variable.

### Servers that need sign-in

It doesn't work with a server you sign in to through Codex (`codex mcp login`,
OAuth, `auth = "chatgpt"`). Codex keeps that sign-in to itself, and gives a
plugin no way to send `events/*` over its own connection. The plugin never
reads Codex's stored credentials. `list_event_types` lists such a server under
`unavailable`, with the reason.

### Webhook delivery: the relay

Push and poll need no setup. A server that delivers only by webhook needs a
public https address, which Codex on your machine doesn't have. A relay is
that address. It keeps each delivery until the plugin collects it: at once
while the session is open, and on its next start otherwise.

#### Your own relay (recommended)

This is a small Cloudflare Worker on your own account, the same one the
Claude Code form uses. One relay serves both. From a clone of this
repository, with Node 22.18 or newer:

```bash
cd polyfills/events/claude-code/mod/relay
npm install && npx wrangler login && npm run setup
```

It writes `~/.mcp-events/relay.json`, which the plugin reads.

#### The public relay (opt-in)

It's run by Ido Salomon, the author of this plugin, at
`https://mcp-events-public-relay.idosalomon.workers.dev`. It's off unless you
set `MCP_EVENTS_RELAY=public` in the environment Codex starts from.

- **Event payloads pass through it**, and are stored there until collected,
  for about a day at most.
- It can't create or alter an event.
- Each watch that uses it says so.

#### A forwarder of your own

Set `MCP_EVENTS_PUBLIC_URL` (and `MCP_EVENTS_RECEIVER_PORT`) to forward to
the plugin's local receiver.

The relay's own documentation is in
[`../claude-code/mod/relay/README.md`](../claude-code/mod/relay/README.md).

### Where it runs

| | Tools | An event wakes the session |
|---|---|---|
| The Codex TUI (`codex`), with the app-server daemon (the default) | Yes | Yes |
| `codex --remote <app server>` | Yes | Yes, with `MCP_EVENTS_CODEX_REMOTE` set to the same address (tested: [`docs/live-run.md`](docs/live-run.md)) |
| `codex exec` | Yes | No: the session, and the helper with it, end with the run |
| The TUI without the daemon (`--no-daemon`, `-c`, `--profile`) | Yes | Not tested. `codex queue` then has no daemon to resume the session on, so the message is expected to wait in its queue |
| The ChatGPT desktop app (Work chats) | Yes: a watch is set and stores its events | No: its chats are not local Codex sessions, which is all `codex queue` reaches. Ask for `recent_events` |
| T3 Code, or another app that runs Codex through an app server of its own | Yes: a watch is set and stores its events | No: the plugin can't tell that the app would show the wake, so it doesn't wake the session there. `list_watches` says so. In T3 Code, [mcp-events for T3 Code](../t3/README.md) wakes a thread instead ([Limits](#limits)) |
| The IDE extension | Not tested | Not tested |

It's tested live in the Codex TUI 0.172.0 on macOS. The tests also run on
Linux in CI. Windows hasn't been tried. On Windows the plugin runs only
`codex.exe`, or Node with an npm install's `codex.js`, never npm's `codex.cmd`
([`SECURITY.md`](SECURITY.md)). Without either, it can't wake a session.

### If something doesn't work

- Ask Codex "what can you watch?" If a server you expected is missing, it's
  listed under `unavailable`, with the reason.
- `list_watches` says when waking the session last failed, and why.
- The log is `~/.codex/mcp-events/mcp-events.log`. Tokens are removed from it.
- `codex mcp list` shows whether Codex sees the `mcp-events` server.

For bugs and questions, [open an issue](https://github.com/idosal/AgentPolyfill/issues)
that names `mcp-events` for Codex, with your Codex version, your operating
system and the relevant lines of the log. For a security problem, see
[`SECURITY.md`](SECURITY.md) instead.

### What differs between Claude Code and Codex

Both forms share the same Events client ([`../core`](../core)). Where they
differ:

| | Claude Code | Codex |
|---|---|---|
| What runs | A mod: a hooks module inside Claude Code, and a helper process it starts | A plugin: a helper that Codex starts as an MCP server for each session |
| Needs | Claude Code 2.1.326 or newer; Node 20 or newer, or Bun | Codex 0.170 or newer (0.172 or newer to wake a session); Node 20 or newer on the PATH Codex runs with |
| No Node on the machine | `/mcp-events setup` fetches Bun (macOS and Linux) | Codex reports that the `mcp-events` server failed to start; the plugin downloads nothing |
| Who a watch belongs to | The project folder. One session per project runs the watches | The Codex session that set it (`_meta.threadId`). One process per session runs them |
| Asking before a tool runs | Claude Code asks the first time Claude uses each tool, in the default permission mode | `watch_event` and `unwatch_event` go through Codex's approval; the four tools that only read run without asking |
| How a wake arrives | `$.prompt.submit`, shown as "Prompt from the mcp-events plugin" | `codex queue --thread <id> --message "[mcp-events] …" --resume`, an input message whose first line says it's from the plugin |
| After 30 wakes in an hour | Not woken again until you send a message | Not woken again for an hour, or until you write and Codex calls one of the plugin's tools in that turn (this needs Codex 0.172's turn metadata) |
| Servers it reads | Claude Code's configuration scopes, and only servers Claude Code itself uses in the session | `[mcp_servers.*]` in `config.toml`; not a project's `.codex/config.toml`, and not servers other plugins bring |
| Servers it can't reach | `/mcp` OAuth sign-in, and claude.ai connectors | `codex mcp login`, OAuth, `auth = "chatgpt"`; and tokens in variables that don't reach the helper |
| Setting up your own relay | `/mcp-events:relay-setup` inside Claude Code, or by hand | By hand, from a clone. The same relay serves both forms |
| A session you come back to | Watches pick up when Claude Code starts in the project again | A resumed session's watches start at its first call of one of the plugin's tools |
| One prompt, then exit | `claude -p`: tools work, no wake | `codex exec`: tools work, no wake |
| Where state is kept | The plugin's data folder | `$CODEX_HOME/mcp-events` |
| Tested live | Claude Code on macOS | The Codex TUI 0.172.0 on macOS |

## Settings

Settings are environment variables, in the environment Codex's app server
runs with. The plugin passes on only these. For the daemon, that is the
environment it was started from, so run `codex app-server daemon restart`
after a change. You don't need any of them to start.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Installed, and doing nothing (no tools). |
| `MCP_EVENTS_PRE_STANDARD` | `off` refuses servers that advertise events only in the form from before the standard. A comma-separated list of server names allows that form for those servers only. |
| `MCP_EVENTS_SERVERS` / `MCP_EVENTS_SKIP` | Only these server names, or never these. |
| `MCP_EVENTS_CONFIG` | A servers file of your own (TOML `[mcp_servers.*]`, or JSON `{"mcpServers": …}`) instead of `config.toml`. |
| `MCP_EVENTS_CODEX_BIN` | The full path of the `codex` to run `codex queue` with. Default: the first on the PATH, then where Codex's installers put it. |
| `MCP_EVENTS_CODEX_REMOTE` | The app server to queue wakes on (`ws://…`, `unix://…`), for Codex run with `--remote`. |
| `MCP_EVENTS_BATCH_MS` | How long the plugin waits after an event before waking, so a burst is one message. Default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | The least time between two wakes one watch starts, in seconds. Default 60; 0 for none. |
| `MCP_EVENTS_WAKES_PER_HOUR` | How many times events may wake a session in an hour. Default 30; 0 for no limit. |
| `MCP_EVENTS_WAKE_VALUES=1` | Put a few short payload fields into the wake message. Off by default, because it puts text a server wrote into the conversation. |
| `MCP_EVENTS_MIN_POLL_MS` | The least time between two polls of one watch. Default 1000. |
| `MCP_EVENTS_RELAY=public`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_RELAY_FILE` | The relay ([Webhook delivery](#webhook-delivery-the-relay)). |
| `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | A forwarder of your own to the local receiver. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default `$CODEX_HOME/mcp-events`. |

### When Codex supports Events itself

This plugin is a stopgap. Codex supports Events today only for OpenAI's own
hosted apps server. Once it handles them for your servers, remove this plugin
(`codex plugin remove mcp-events@agent-polyfill`) or set `MCP_EVENTS_OFF=1`.
Running both would show each event twice. The plugin can't stand down by
itself: Codex gives a plugin no way to see what its own MCP client supports.

## Limits

The changes both hosts would need are in
[What hosts would need to change](../../../docs/host-changes.md).

- **No interactive OAuth** ([Servers that need sign-in](#servers-that-need-sign-in)).
  The change in Codex that would remove this: a way for a plugin to send
  `events/*`, or any MCP request, over Codex's own, signed-in connection. One
  way is to expose its client's `send_custom_request` through the app server.
- **It needs an open session.** Nothing starts Codex when an event arrives and
  no session is open. (`codex queue --resume` would resume a closed session in
  the daemon, but by then no helper is running to receive the event.)
- **A resumed session's watches wait for a tool call.** Codex starts a resumed
  session's MCP servers only when one of their tools is first called. Until
  then nothing runs the session's watches. They start again, from their
  cursors, the moment Codex calls any of this plugin's tools in that session.
  The plugin asks Codex to call `list_watches` after a resume, and asking
  "check my watches" also does it. Seen live: asked "What are you watching?",
  Codex answered from memory and called nothing. The change in Codex: start a
  resumed session's plugin servers when it opens, as for a new session.
- **A wake only where Codex's own app shows it.** `codex queue` runs the wake
  in whichever app server has the session open. Codex's own TUI shows that
  turn. An app that runs Codex through an app server of its own, as T3 Code
  does, may not show a turn it didn't start. In T3 Code, the turn ran and was
  never shown. So the plugin wakes a session only while the latest of the
  session's turns that called its tools was one you started in Codex's own
  app.
  - **How it tells.** Codex sends what started each turn with every call
    (`x-codex-turn-metadata.turn_trigger`, from the app's `turnTrigger`).
    These count, each where it is set (Codex 0.172):
    - `user`, typed in the TUI (`codex-rs/tui/src/chatwidget/input_submission.rs`);
    - `composer`, sent in the ChatGPT desktop app. It's the app's default
      for a message, read from the installed app and from its sessions'
      records, not run with this version;
    - `exec`, a `codex exec` run (`codex-rs/exec/src/lib.rs`);
    - `realtime`, voice (`codex-rs/core/src/session/realtime_handoff.rs`).
  - **What stops the wakes.** Any other call. That covers a turn that names
    nothing, as another app's app server sends (T3 Code sets no trigger) and
    a Codex before 0.172 does. It also covers a trigger the plugin doesn't
    count: a goal, an automation, a review, or an app's own name for its
    turns. The session then isn't woken until your next turn. Its watches
    still store every event, `list_watches` and `watch_event` say why, and
    `recent_events` reads what came.
  - **What leaves it as it was.** Only a turn the queue started, which Codex
    marks `queue` in any app server (`codex-rs/ext/queue/src/service.rs`).
  - **When waking starts again.** Once a turn you start in Codex's own app
    calls one of the plugin's tools, what waited is handed over.
  - **What it can't tell apart.** An app that marks its own turns `user`,
    as the TUI does, is taken for Codex's own.
  - **In T3 Code** this form doesn't wake a thread. Use
    [mcp-events for T3 Code](../t3/README.md) there, which wakes a thread
    through T3 Code itself, as a message the thread shows. The change in
    Codex that would remove this limit is a turn metadata field naming the
    app the session is open in, or a `codex queue` that doesn't leave a
    message for an app server whose app may not show it.
- **The ChatGPT desktop app.** In the ChatGPT desktop app, a watch records
  events but can't wake the chat: its threads aren't local Codex sessions
  that `codex queue` can reach. Ask for recent events. Waking works in the
  Codex TUI (and `codex exec` resumes). The first wake that fails this way is
  the last one tried for that chat, and `list_watches` says why.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. A session is woken at most 30 times in an hour. Then it's
  told once that events are waiting, and isn't woken again for an hour, or
  until, sooner, you write to it and Codex calls one of the plugin's tools in
  that turn. Telling that you wrote depends on the turn metadata Codex 0.172
  sends with each call (`turn_trigger`: `user`, `composer`, `exec`, or
  `realtime`). With an
  older Codex, or a turn it marks otherwise, the pause ends only after its
  hour. With the session open in two windows, only a turn in the window that
  runs its watches counts. That's the window whose `list_watches` shows them
  active; the other shows them as `elsewhere`. Nothing is dropped:
  `recent_events` lists what waited. Two [settings](#settings) change the
  numbers.
- **The wake is an input message.** Codex has no separate channel for a
  plugin's message, so it appears in the conversation like something typed,
  with a first line saying it's from the plugin. The change in Codex: a turn
  started by an extension, marked as such to the model and in the UI.
- **Credentials from environment variables** reach the plugin only if the
  plugin names them ([Servers that need credentials](#servers-that-need-credentials)).
- **Only `config.toml`'s servers.** Servers from a project's
  `.codex/config.toml`, and those other plugins bring, aren't read.
- **A second connection.** The helper opens its own connection to each server
  that offers events, so a local (stdio) server runs twice.
- **After a crash or a hung `codex queue`, an event can be announced twice,
  or not at all.** From a server, an event stored just before a crash can come
  again and be stored twice. To Codex, stored events are handed over at most
  once: if the plugin stops while `codex queue` runs, or `codex queue` doesn't
  answer within a minute, they count as announced, and may not have been. That
  holds with the session open in two windows too. Either way they're stored,
  and `recent_events` lists them.
- **Sizes.** One event is at most 256 KiB, one answer from a remote server
  4 MiB, and one session's stored events 64 MiB.
- **Managed machines.** Where your organisation manages Codex's MCP servers,
  the plugin connects to nothing. On macOS and Linux it looks at `/etc/codex`
  (and, on macOS, managed-preferences profiles). On Windows it looks at
  `%ProgramData%\OpenAI\Codex\requirements.toml`. A Windows policy set only in
  the registry or by MDM isn't detected.
- **One forwarder port.** With `MCP_EVENTS_PUBLIC_URL` and a fixed
  `MCP_EVENTS_RECEIVER_PORT`, only the first session to open the receiver gets
  the port. Webhook watches in a second session fail until it's free. A relay
  has no such limit.
- **Experimental parts of Codex.** The app server is marked experimental in
  Codex's CLI. `codex queue` and `daemon_auto_start` aren't. Nothing needs to
  be turned on.

## Security

An event is data from a server you configured. What the server sent reaches
Codex only as a tool result, when Codex reads it with `get_event` or
`recent_events`.

The message that wakes the session carries nothing the server wrote: only
which watch has new events, how many, and their ids.

Receiving an event gives Codex no permission it didn't already have. Keep in
mind that an event arrives without anyone asking. So in a session that
approves actions without asking, a server you watch can set work in motion, as
often as the [wake limit](#limits) allows.

A watch belongs to the Codex session that set it, and another session sees
none of its watches or events. Starting and stopping a watch go through
Codex's approval. The plugin never reads Codex's stored credentials, and it
leaves alone servers that sign in through Codex. Details, what is stored, and
how to report a vulnerability are in [`SECURITY.md`](SECURITY.md).

## Spec and conformance

mcp-events implements
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
the Final text as of 24 November 2026. One step outside it is on by default:
servers that advertise events in the form from before the standard
([Which servers it works with](#which-servers-it-works-with)).
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly.

### Proof

- [`docs/conformance.md`](docs/conformance.md) covers the SEP's client rules,
  which the shared client meets, and which of them this form's tests check end
  to end. The clause-by-clause table is in the Claude Code form's
  [`docs/conformance.md`](../claude-code/docs/conformance.md), since both forms
  run the same client. The upstream conformance suite's Events client
  scenarios (its open pull request #541) pass 17 of 17, against the shared
  client and end to end through the bundled helper (`npm run conformance`,
  `npm run conformance:helper`).
- [`docs/interop.md`](docs/interop.md) records runs against servers others
  wrote: hookbench's reference server (7 of 7), Hookdeck's Outpost demo
  against its own mock Outpost (4 of 4), and this repository's event-feeds
  (3 of 3). mcp-mailbox is a relay, not an Events server, and wasn't run.
- [`docs/live-run.md`](docs/live-run.md) records a watch made from a real
  Codex session, a button press, and the idle session waking and answering.
  Then the same session is resumed and woken again.
- **Formal model.** The wake rules (only the person's own turn lifts the
  pause, the pause lifting after its hour, a chat `codex queue` can't reach)
  are model-checked with TLC, and simulated with Quint, by reading this code.
  From 0.1.3 that includes the hand-over rule: each hand-over is recorded
  before `codex queue` runs, and counted once. The model covers one session,
  one watch and one helper process at a time:
  [`../claude-code/model/README.md`](../claude-code/model/README.md#wakecodexqnt-how-often-events-wake-a-codex-session).

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

- [`plugin/`](plugin/) is what gets installed, all of it: the manifest
  (`.codex-plugin/plugin.json`), the server's entry (`.mcp.json`), the bundled
  helper (`dist/helper.js`) and a skill.
- `src/` is what is specific to Codex: reading `config.toml`
  (`codex-config.ts`), the MCP server Codex starts (`mcp-server.ts`,
  `helper.ts`), sessions (`threads.ts`, `meta.ts`), waking (`waker.ts`) and
  what it says (`words.ts`). The rest is [`../core`](../core).
- `test/` runs the helper as Codex does, with a stand-in `codex`, against the
  Claude Code form's fixture events server. That server was written from the
  SEP and shares no code with the client. `test/interop/run.ts` runs the
  interop. CI: [`codex-events-test.yml`](../../../.github/workflows/codex-events-test.yml).
- To release, change the version in `plugin/.codex-plugin/plugin.json`,
  `package.json` and `src/version.ts`, rebuild, and merge to `main`.

## Licence

Part of [AgentPolyfill](../../../README.md): MCP extensions for hosts that
haven't shipped them yet.

Apache-2.0. See [`LICENSE`](../../../LICENSE). The bundled helper includes npm
packages under their own licences:
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt).

This is a community project. It isn't affiliated with or endorsed by
Anthropic, OpenAI, the Model Context Protocol project, the Agentic AI
Foundation or the Linux Foundation. Claude and Claude Code are trademarks of
Anthropic, PBC. OpenAI and Codex are trademarks of OpenAI.
