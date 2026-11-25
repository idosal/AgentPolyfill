# mcp-events for GitHub Copilot CLI

Copilot can watch events on your MCP servers ("tell me when a deploy fails")
and act when one fires, even while the session sits idle with nobody typing.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md).

This plugin implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which Copilot doesn't support yet.
Details are in [Spec and conformance](#spec-and-conformance).

## Install

```bash
copilot plugin marketplace add idosal/AgentPolyfill
```

```bash
copilot plugin install mcp-events@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace
(Copilot reads its `.github/plugin/marketplace.json`), and the second installs
the plugin. The install is one folder, [`plugin/`](plugin/), of about 0.6 MB:
a manifest and one JavaScript file. Nothing else is downloaded.

You need:

- **GitHub Copilot CLI 1.0.115 or newer**, with **experimental mode on**. The
  plugin is a Copilot *extension*, and Copilot loads extensions only in
  experimental mode: start it with `copilot --experimental`, or run
  `/settings experimental on` once.
- Nothing else. Copilot runs the extension with its own copy of Node, so you
  don't need Node on the machine. (A local MCP server you configured may need
  it, as it does for Copilot.)

To remove it, run `copilot plugin uninstall mcp-events@agent-polyfill`.

## Try it

A demo server with events is hosted for anyone to try, with no sign-in. Add it
to Copilot:

```bash
copilot mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

Start `copilot --experimental` in a folder and ask:

> Give me a demo button and tell me what I type when I press it.

Copilot makes a private button page with the server's `new_demo_button` tool,
gives you its link, and watches it. Open the link, type a message and press
the button. A few seconds later the idle session starts a turn by itself,
reads the event, and tells you what you typed.

To stop: "Stop watching the demo button."

## How it works

### From install to the first event

1. **Install** (above). Neither command asks anything.
2. **Experimental mode.** Without it Copilot doesn't load extensions, and the
   plugin does nothing.
3. **The first session after the install,** Copilot asks once whether the
   extension may have elevated permissions: "skip tool permission prompts,
   register hooks". The plugin needs both: the four tools that only read run
   without a prompt (below), and a hook gives the session its instructions
   when it starts. Choose **Yes**, or **Yes, and always allow** for that
   folder. **No** keeps the extension from loading, and nothing else happens.
4. **An MCP server with events in your Copilot configuration.** That is a
   server in `~/.copilot/mcp-config.json` (what `copilot mcp add` writes), or
   in a trusted project's `.mcp.json` or `.github/mcp.json`, and not switched
   off. A server you sign in to through Copilot (`/mcp auth`, OAuth) doesn't
   work ([Servers that need sign-in](#servers-that-need-sign-in)).
5. **Ask for a watch**, in plain words. Copilot asks before `watch_event` and
   `unwatch_event` run, as for any tool that changes something ("Run
   extension tool watch_event", with **Yes**, **Yes, and approve for the rest
   of the session**, **No**). If you say no, nothing is watched.
6. **Waking.** When an event arrives, the plugin hands the session a message
   with `session.send`, Copilot's own API for an extension. An idle session
   starts a turn with it at once; a busy one when its turn ends.
7. **A server that delivers only by webhook** also needs a relay: a public
   https address that holds deliveries ([Webhook delivery](#webhook-delivery-the-relay)).
   Without one, a watch on such a server is refused, with a message that lists
   the choices. Push and poll need no relay.

### What Copilot can do with it

The plugin gives Copilot six tools. You don't call them yourself: you ask in
plain words.

| You say | Copilot uses |
|---|---|
| "What can you watch on my servers?" | `list_event_types` |
| "Tell me when a high-priority ticket comes in." | `watch_event` |
| "What are you watching?" | `list_watches` |
| "Show me that last event in full." | `get_event`, `recent_events` |
| "Stop watching tickets." | `unwatch_event` |

A watch belongs to the Copilot session that set it, and is kept on disk with
its cursor. When you resume that session (`copilot --resume`), its watches
start again by themselves, and events that came while it was closed arrive, if
the server kept them.

### How the parts fit together

```
your MCP server (SEP-3415) ──events/stream · events/poll──────────────►  extension (plugin/extensions/mcp-events/extension.mjs):
        │                                                                 │  Copilot starts it for the session in the
        └─signed webhooks──►  relay (your Cloudflare Worker) ──WebSocket─►│  foreground. The Events client, one connection
                              holds deliveries, no signing secret         │  per server, one subscription per watch;
                                                                          │  every event on disk before it is acknowledged
Copilot ── tool calls (joinSession tools) ──────────────────────────────► │
  ▲                                                                       │
  └── session.send({ source: "automation-mcp-events", mode: "enqueue" }) ─┘  wakes the session when it is idle
```

- **Which session.** Copilot starts one extension process for the session in
  the foreground and tells it the session's id. A watch belongs to that
  session.
- **Finding servers.** Copilot tells the extension which MCP servers the
  session uses, whether each is on (after folder trust, your settings and
  your organisation's policy) and where each comes from, but not how to reach
  them. So the first time a tool is called, the extension reads how from the
  file Copilot names for that server (your `mcp-config.json`, or the trusted
  project's file), connects to each of those servers once, and keeps the ones
  that offer events. A server found without events isn't asked again for a
  day. If Copilot can't say which servers the session uses, the extension
  connects to none, rather than guess at trust and policy.
- **When Copilot stops using a server** during the session (`/mcp disable`,
  or it's gone after `/mcp reload`), the extension lets it go too: its watches
  stop and wait, saved, their webhook subscriptions are ended on the server,
  nothing more from it is stored, and its connection closes. A server Copilot
  takes back up is used again from the next session.
- **Watching.** A watch is one subscription. The delivery mode follows the
  SEP's guidance: webhook where a relay is set up, then push
  (`events/stream`), then poll (`events/poll`).
- **Waking Copilot.** Each event is written to disk first. Then the session is
  handed a message with `session.send`, as an *automation* turn: Copilot's SDK
  says such a turn "carries no human authority". Its first line says it's from
  the plugin, not typed by you. The rest names the server and event type,
  gives the new events' ids, and repeats the note Copilot saved with the
  watch. It carries nothing the server wrote: Copilot reads what happened with
  `get_event`.
- **Lifetime.** Copilot stops the extension (SIGTERM) when the session ends,
  is cleared (`/clear`) or is replaced, and the watches stop with it. They
  start again when the session is resumed.

### Which servers it works with

- **Servers that implement the Events extension** (SEP-3415), over stdio or
  Streamable HTTP, with push, poll or webhook delivery.
- **Servers that speak the form from before the standard**, which is what
  ChatGPT reads: they advertise events as a top-level `events` capability
  instead of the extension. The plugin uses these by default, as the other
  forms do. Strictly, the SEP says a client must not send `events/*` to a
  server that hasn't advertised the extension, so this is a step outside it.
  `MCP_EVENTS_PRE_STANDARD=off` keeps to the SEP exactly.
- **Servers that need credentials**, when the credential is in the server's
  configuration: a `headers` entry, which may name an environment variable as
  `${VAR}`, as Copilot allows ([below](#servers-that-need-credentials)).

### Servers that need credentials

The extension expands variables in a server's URL, headers, command,
arguments, environment and folder the way Copilot 1.0.115 does (seen live):
`$VAR`, `${VAR}`, and `${VAR:-default}`; an unset `$VAR` stays as written.
Whatever a variable or a default put in is taken out of the log and of every
tool result, wherever it landed (values shorter than eight characters
excepted, which would scrub ordinary words too). A default that holds another
variable (`${A:-${B}}`) isn't supported: that server is left out, with the
reason. But Copilot strips sensitive variables
(`GITHUB_TOKEN`, for one) from every extension it starts, so a server whose
header names one of those is left out, with the reason. Put such a token in
the header itself, or in a variable Copilot doesn't strip.

### Servers that need sign-in

It doesn't work with a server you sign in to through Copilot (`/mcp auth`,
OAuth). Copilot keeps that sign-in to itself, and gives an extension no way to
send `events/*` over its own connection. The plugin never reads Copilot's
stored credentials (the keychain, `~/.copilot/mcp-oauth-config/`).
`list_event_types` lists such a server under `unavailable`, with the reason.

### Webhook delivery: the relay

Push and poll need no setup. A server that delivers only by webhook needs a
public https address, which Copilot on your machine doesn't have. A relay is
that address. It keeps each delivery until the plugin collects it: at once
while the session is open, and when it is next resumed otherwise.

The relay is the same small Cloudflare Worker the Claude Code and Codex forms
use, and one relay serves all three. See the Codex form's
[Webhook delivery](../codex/README.md#webhook-delivery-the-relay) for your own
relay (recommended), the opt-in public relay (`MCP_EVENTS_RELAY=public`), and
a forwarder of your own (`MCP_EVENTS_PUBLIC_URL`). The plugin reads
`~/.mcp-events/relay.json`, which the relay's setup writes.

### Where it runs

| | Tools | An event wakes the session |
|---|---|---|
| The Copilot CLI TUI (`copilot --experimental`) | Yes | Yes (tested: [`docs/live-run.md`](docs/live-run.md)) |
| `copilot -p` | Yes (your own and plugin extensions load in prompt mode) | No: the session, and the extension with it, end with the prompt |
| `copilot --acp` (an editor driving Copilot over ACP) | No: Copilot 1.0.115 doesn't load extensions in ACP sessions | No |
| VS Code's Copilot harness | Yes (tested in VS Code 1.147: [`docs/live-run.md`](docs/live-run.md#in-vs-code)) | Yes: the plugin's message shows in the chat, then the turn ([below](#vs-code)) |
| The GitHub Copilot app, other SDK hosts | Only where the host turns extensions on | Not tested |

It's tested live in Copilot CLI 1.0.115 on macOS, with no GitHub sign-in: a
model on this machine stood in for Copilot's. It's also tested in VS Code
1.147.0's Copilot harness, signed in, with GitHub's Claude Haiku 4.5
([`docs/live-run.md`](docs/live-run.md)). The tests also run on Linux in CI.
Windows hasn't been tried.

### VS Code

VS Code's Copilot harness runs the same runtime as Copilot CLI, and this
plugin works there. Seen in VS Code 1.147.0, signed in to GitHub
([`docs/live-run.md`](docs/live-run.md#in-vs-code)):

- **It loads the plugin from `~/.copilot`,** as Copilot CLI installed it, when
  `chat.canvases.enabled` is on (the default). The setting is named after
  canvases, but it turns on the runtime's whole extension system.
- **It asks once per chat** whether the extension may load with "skip tool
  permission prompts, register hooks", when you send the chat's first
  message. **Allow Once** is enough.
- **A wake shows.** When an event arrives, the plugin's message appears in
  the chat ("Sent by the mcp-events plugin, not typed by the user", which
  watch, how many events, their ids), and then the turn it starts: the model
  reads the event with `get_event` and answers. VS Code shows a turn an
  extension starts only when it carries a `clientTurnId`, so every wake
  carries one. Without it, VS Code runs the turn and shows none of it.
- **A chat you open and close without a message** starts the extension, which
  then stops. VS Code prepares a session for each new chat ahead of time, and
  the extension's join waits for the first message. If the chat is closed
  first, the join is refused, and the log says "Copilot did not let this
  extension join the session".
- **It needs a GitHub Copilot sign-in.** VS Code's harness has no offline
  mode (from its source).
- **A form from an extension** is shown during a turn and declined while the
  session is idle (from VS Code's source). This plugin asks nothing through
  forms.

### If something doesn't work

- Check experimental mode is on (`/settings experimental on`), and that
  `/extensions manage` lists `mcp-events` as running.
- Ask Copilot "what can you watch?" If a server you expected is missing, it's
  listed under `unavailable`, with the reason.
- `list_watches` says when waking the session last failed, and why.
- The log is `~/.copilot/mcp-events/mcp-events.log`. Tokens are removed from it.

For bugs and questions, [open an issue](https://github.com/idosal/AgentPolyfill/issues)
that names `mcp-events` for Copilot, with your Copilot version, your operating
system and the relevant lines of the log. For a security problem, see
[`SECURITY.md`](SECURITY.md) instead.

### What differs between the forms

All three share the same Events client ([`../core`](../core)). This form also
shares the Codex form's session code (`../codex/src/threads.ts`): the watches,
the hand-over and the wake limits are the same code.

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| What runs | A mod inside Claude Code, and a helper process | A helper Codex starts as an MCP server for each session | An extension Copilot starts for the session in the foreground |
| Needs | Claude Code 2.1.326+; Node 20+ or Bun | Codex 0.170+; Node 20+ | Copilot CLI 1.0.115+ in experimental mode; no Node of your own |
| Who a watch belongs to | The project folder | The Codex session (`_meta.threadId`) | The Copilot session the extension joined |
| Asking before a tool runs | The first time Claude uses each tool | `watch_event`, `unwatch_event` go through Codex's approval | The same two through Copilot's tool prompt; once, the elevated-permissions question |
| How a wake arrives | `$.prompt.submit` | `codex queue --thread <id> … --resume`, an input message | `session.send`, an automation turn |
| After 30 wakes in an hour | Not woken again until you send a message | Not again for an hour, or until your own turn calls a plugin tool | Not again until you send a message (Copilot marks the plugin's own messages, so yours are told apart) |
| Servers it reads | Claude Code's scopes, and only servers it uses | `config.toml` | The servers Copilot says it uses, read from `mcp-config.json` and trusted workspace files |
| Servers it can't reach | `/mcp` OAuth, claude.ai connectors | `codex mcp login`, OAuth; tokens in variables it isn't given | `/mcp auth`, OAuth; servers from plugins or `--additional-mcp-config`; tokens in variables Copilot strips |
| A session you come back to | Picks up when Claude Code starts in the project | Starts at the first call of a plugin tool | Starts when the session is resumed |
| One prompt, then exit | `claude -p`: tools, no wake | `codex exec`: tools, no wake | `copilot -p`: tools, no wake |
| Where state is kept | The plugin's data folder | `$CODEX_HOME/mcp-events` | `$COPILOT_HOME/mcp-events` |

## Settings

Settings are environment variables, in the environment Copilot starts in. You
don't need any of them to start.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Installed, and doing nothing (no tools, no hooks). |
| `MCP_EVENTS_PRE_STANDARD` | `off` refuses servers that advertise events only in the form from before the standard. A comma-separated list of server names allows that form for those servers only. |
| `MCP_EVENTS_SERVERS` / `MCP_EVENTS_SKIP` | Only these server names, or never these. |
| `MCP_EVENTS_CONFIG` | A servers file of your own (`{"mcpServers": …}`) instead of Copilot's. |
| `MCP_EVENTS_BATCH_MS` | How long the plugin waits after an event before waking, so a burst is one message. Default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | The least time between two wakes one watch starts, in seconds. Default 60; 0 for none. |
| `MCP_EVENTS_WAKES_PER_HOUR` | How many times events may wake a session in an hour. Default 30; 0 for no limit. |
| `MCP_EVENTS_WAKE_VALUES=1` | Put a few short payload fields into the wake message. Off by default, because it puts text a server wrote into the conversation. |
| `MCP_EVENTS_MIN_POLL_MS` | The least time between two polls of one watch. Default 1000. |
| `MCP_EVENTS_RELAY=public`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_RELAY_FILE` | The relay ([Webhook delivery](#webhook-delivery-the-relay)). |
| `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | A forwarder of your own to the local receiver. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default `$COPILOT_HOME/mcp-events`. |

### When Copilot supports Events itself

This plugin is a stopgap. Once Copilot handles Events itself, uninstall it
(`copilot plugin uninstall mcp-events@agent-polyfill`), turn it off in
`/extensions manage`, or set `MCP_EVENTS_OFF=1`. Running both would show each
event twice. The plugin can't stand down by itself: Copilot gives an extension
no way to see what its own MCP client declares to a server. Copilot 1.0.115
declares `io.modelcontextprotocol/skills` and `io.modelcontextprotocol/tasks`,
and nothing for Events.

## Limits

The changes a host would need are in
[What hosts would need to change](../../../docs/host-changes.md).

- **Experimental mode only.** Copilot loads extensions only in experimental
  mode, and marks the extension API experimental: it may change in any
  release. The change in Copilot: extensions out of experimental, or an MCP
  method an MCP server could use to start a turn (below).
- **No interactive OAuth** ([Servers that need sign-in](#servers-that-need-sign-in)).
  Copilot's extension API can call a server's *tools* and read its
  *resources* over Copilot's own, signed-in connection
  (`session.rpc.mcp.callTool`, `resources.read`), but not send any other
  method. The change in Copilot: a `session.rpc.mcp.request({ serverName,
  method, params })` that passes any MCP request through, with the admission
  and permission checks `callTool` already has.
- **A second connection.** Because of that, the extension opens its own
  connection to each server that offers events, so a local (stdio) server
  runs twice. The same change removes it.
- **It can't see what a server advertised.** `session.rpc.mcp.list` gives a
  server's status and instructions, not its capabilities, so the extension
  connects once to find out. The change in Copilot: the server's
  `capabilities` (with `extensions`) and `serverInfo` in `session.mcp.list`.
- **No push over Copilot's connection.** Copilot passes an extension only the
  `list_changed` notifications. The change in Copilot: a
  `session.on("mcp.notification")` for a server's other notifications.
- **A server switched back on mid-session** is used again only from the next
  session: the extension lets a server go when Copilot stops using it, but
  doesn't connect anew while a session runs.
- **Some servers aren't read:** ones a plugin brings, ones given for one run
  (`--additional-mcp-config`), the built-in GitHub server, and ones whose
  token is in a variable Copilot strips from extensions. Each is listed under
  `unavailable` with the reason. The connection change above would remove all
  of these.
- **It needs an open session.** Nothing starts Copilot when an event arrives
  and no session is open. When you resume it, its watches pick up from their
  cursors.
- **One session at a time per process.** Copilot starts one extension process
  for the session in the foreground. A session you leave by `/clear` or by
  switching sessions stops its watches until it is resumed.
- **In VS Code, a wake looks like a message in the chat** ([VS Code](#vs-code)):
  only its first line says the plugin sent it. The change in VS Code: mark an
  extension's automation turns as such.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. A session is woken at most 30 times in an hour. Then it's
  told once that events are waiting, and isn't woken again until you send a
  message. Nothing is dropped: `recent_events` lists what waited.
- **An event type whose name isn't a plain name** (letters, digits and
  `._:/-`, as `ticket.created`) is named in the wake only as "an event type
  whose name is not a plain name": the name is the server's text, and the wake
  starts a turn. `list_watches` gives it, as a tool result.
- **After a crash, or a `session.send` that Copilot never answers, an event
  can be announced twice, or not at all.** Stored events are handed over at
  most once: if the plugin stops while `session.send` runs, or Copilot doesn't
  answer within a minute, they count as announced, and may not have been. With
  the same session open in two terminals, the second takes over if the first
  ends while handing over, and may hand those events over again. Either way
  they're stored, and `recent_events` lists them.
- **Sizes.** One event is at most 256 KiB, one answer from a remote server
  4 MiB, and one session's stored events 64 MiB.

### Skills and Apps in Copilot

There is no Copilot form of the Skills or Apps polyfills, on purpose:

- **Skills over MCP (SEP-2640) is native.** Copilot CLI 1.0.115 declares
  `io.modelcontextprotocol/skills` to every server by default (seen live), and
  VS Code 1.147's Copilot harness turns it on by default
  (`chat.agentHost.mcpSkills.enabled`). A polyfill would be a second client.
- **MCP Apps is native where it can be drawn.** VS Code's Copilot harness
  enables it for every session. The CLI's terminal draws no app and doesn't
  declare `io.modelcontextprotocol/ui`; the runtime has it behind a flag for
  graphical hosts. The Claude Code Apps polyfill draws apps in a terminal with
  Claude Code's own UI hooks, which Copilot's extensions don't have.
- Copilot also loads Claude Code plugins, but a Claude Code *mod* (this
  repository's Claude Code forms) runs nothing there: its hooks are Claude
  Code modules.

## Security

An event is data from a server you configured. What the server sent reaches
Copilot only as a tool result, when Copilot reads it with `get_event` or
`recent_events`. The message that wakes the session carries nothing the server
wrote: only which watch has new events, how many, and their ids. It goes in as
an automation turn, which Copilot gives no human authority.

Receiving an event gives Copilot no permission it didn't already have. Keep in
mind that an event arrives without anyone asking. So in a session that allows
tools without asking (`--allow-all-tools`, `--yolo`), a server you watch can
set work in motion, as often as the [wake limit](#limits) allows.

A watch belongs to the Copilot session that set it, and another session sees
none of its watches or events. Starting and stopping a watch go through
Copilot's tool prompt. The plugin never reads Copilot's stored credentials,
and it leaves alone servers that sign in through Copilot. Details, what is
stored, and how to report a vulnerability are in [`SECURITY.md`](SECURITY.md).

## Spec and conformance

mcp-events implements
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
the Final text as of 24 November 2026. One step outside it is on by default:
servers that advertise events in the form from before the standard
([Which servers it works with](#which-servers-it-works-with)).
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly.

### Proof

- [`docs/conformance.md`](docs/conformance.md): which of the SEP's client rules
  this form's tests check end to end. The clause-by-clause table is the Claude
  Code form's [`docs/conformance.md`](../claude-code/docs/conformance.md), since
  all forms run the same client. The upstream conformance suite's Events
  client scenarios (its open pull request #541) pass 17 of 17, end to end
  through the bundled extension (`npm run conformance`).
- [`docs/interop.md`](docs/interop.md): runs against servers others wrote.
  hookbench's reference server passes 7 of 7, and this repository's
  event-feeds 3 of 3.
- [`docs/live-run.md`](docs/live-run.md): the real Copilot CLI TUI, on this
  machine with no sign-in. A watch is set through Copilot's tool prompt, an
  event is emitted while the session is idle, and the session wakes and reads
  it. The same in VS Code 1.147.0's Copilot harness, signed in, with GitHub's
  Claude Haiku 4.5: the wake and its turn show in the chat.
- **The wake model.** The hand-over and the wake limits are the Codex form's
  code, which is model-checked with TLC
  ([`../claude-code/model/README.md`](../claude-code/model/README.md#wakecodexqnt-how-often-events-wake-a-codex-session)).
  Two things differ here, and the model doesn't cover them: what counts as you
  writing (a `user.message` with no automation source, which is simpler and
  sooner than Codex's turn metadata), and the wake (`session.send`, whose
  "no answer" counts as handed over, as a `codex queue` timeout does).

## Development

From this folder (`polyfills/events/copilot` in the repository):

```bash
(cd ../core && npm ci)    # the shared Events client
npm ci
npm test                  # Node 22.18 or newer runs the TypeScript tests
npm run typecheck
npm run build             # plugin/extensions/mcp-events/extension.mjs; a test fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin plugin --entry src/extension.ts --bundle plugin/extensions/mcp-events/extension.mjs
```

- [`plugin/`](plugin/) is what gets installed, all of it: the manifest
  (`plugin.json`, which names `extensions/`), the bundled extension and the
  licences of what it bundles.
- `src/` is what is specific to Copilot: joining the session and the tools
  (`main.ts`, `extension.ts`), which servers to read (`copilot-config.ts`),
  waking and who counts as you (`waker.ts`) and what it says (`words.ts`). The
  rest is [`../core`](../core) and the Codex form's `threads.ts`.
- `test/` runs the extension as Copilot does, with a stand-in for
  `@github/copilot-sdk/extension` (`test/fake-sdk/`) that the tests drive,
  against the Claude Code form's fixture events server (written from the SEP,
  sharing no code with the client). `test/interop/run.ts` runs the interop,
  `test/conformance-driver.ts` the upstream suite, and `test/live/run.sh` the
  live run in the real TUI. CI:
  [`copilot-events-test.yml`](../../../.github/workflows/copilot-events-test.yml).
- To release, change the version in `plugin/plugin.json`, `package.json`,
  `src/version.ts` and `.github/plugin/marketplace.json`, rebuild, and merge to
  `main`.

## Licence

Part of [AgentPolyfill](../../../README.md): MCP extensions for hosts that
haven't shipped them yet.

Apache-2.0. See [`LICENSE`](../../../LICENSE). The bundled extension includes
npm packages under their own licences:
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt).

This is a community project. It isn't affiliated with or endorsed by GitHub,
Microsoft, Anthropic, OpenAI, the Model Context Protocol project, the Agentic
AI Foundation or the Linux Foundation. GitHub Copilot is a trademark of
GitHub, Inc.
