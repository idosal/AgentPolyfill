# mcp-events for Antigravity

Antigravity can watch events on your MCP servers: “tell me when a deploy
fails.” New events reach the conversation at its next model call. In the
Antigravity App, an optional sidecar can also wake the conversation.

This plugin implements the client side of MCP Events,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
the **Final text as of 24 November 2026**, the same revision as
[the Codex form](../codex/README.md). It bundles the same [Events client](../core).

**Run live on 25 November 2026,** in Antigravity App v2.35.1 and CLI v1.5.16
on macOS, against Mastra's Events server (the [demo](../claude-code/demo)):
a watch by push, the event delivered at the CLI conversation's next turn, and
an idle App conversation woken by the sidecar, which then answered from the
event. [docs/live-run.md](docs/live-run.md) has the record, and
[What the live run showed](#what-the-live-run-showed) what is still open.

## Install

From a checkout of this repository:

```bash
agy plugin install ./polyfills/events/antigravity/plugin
```

`plugin/` is the whole installation: the committed bundle, manifests, hooks,
skill and sidecar definition. No npm install is needed to use it. Node 20 or
newer must be on Antigravity's PATH; webhook delivery through a relay needs
Node 22 or newer. Restart the conversation after installation.

No marketplace entry is added by this change. The installed folder is read-only
and replaced on updates; all writable state lives elsewhere.

### Enable idle wakes in the App

Sidecars are off by default. To turn this one on, merge this entry into
`~/.gemini/config/config.json`, keeping any other settings:

```json
{
  "sidecars": {
    "mcp-events/wake": { "enabled": true }
  }
}
```

The plugin never edits that file. No `projectId` is needed: this sidecar sends
to existing conversations and never creates one. The App starts and restarts
it. It runs `agentapi send-message <conversation_id> <prompt>` using the
`agentapi` executable the App puts on its PATH, with no shell.

The sidecar uses `../../dist/server.mjs` relative to its own directory, the
documented cwd. `${PLUGIN_ROOT}` expansion is documented for MCP server
definitions, not for `sidecar.json`.

Ask “what are you watching?” `list_watches` reports whether the sidecar has a
recent heartbeat and can find `agentapi`. That is evidence the worker is
running, not proof that the App accepted a particular message. Its last
send failure is also reported. Without the sidecar — including CLI and IDE —
events wait for the conversation's next model call.

## Try it

Add an Events server to `mcpServers` in
`~/.gemini/config/mcp_config.json`. For example, merge in this public demo:

```json
{
  "mcpServers": {
    "feeds": { "serverUrl": "https://event-feeds.idosalomon.workers.dev/mcp" }
  }
}
```

Restart the plugin, then ask:

> Give me a demo button and tell me what I type when I press it.

The server's own `new_demo_button` tool makes a private button page. Antigravity
can then use `list_event_types` and `watch_event` to watch it. Press the button.
With the enabled App sidecar, a plugin message should start a turn. Otherwise,
send another message yourself: `PreInvocation` announces what arrived.
Ask for `get_event` or `recent_events` to read the payload. To stop, ask
“stop watching the demo button.”

The live run used the local [deploys demo](../claude-code/demo) instead
(Mastra's own Events implementation), added with the CLI's
`agy mcp add --header "Authorization: Bearer <token>" deploys http://127.0.0.1:4010/mcp`:

> Using the mcp-events tools, watch deploy.finished on the deploys MCP server.
> Note for the watch: when a deploy fails, tell me in one line which service
> failed and why. Then stop and wait.

Press **Deploy a bad commit** on the demo's page, and leave the conversation
alone. With the sidecar on, it answers by itself a few seconds later.

| You say | Tool |
|---|---|
| “What can you watch?” | `list_event_types` |
| “Tell me when a ticket comes in.” | `watch_event` |
| “What are you watching?” | `list_watches` |
| “Show me that event.” | `get_event`, `recent_events` |
| “Stop watching tickets.” | `unwatch_event` |

Starting and stopping watches use Antigravity's normal MCP approval. The
four reading tools are marked read-only. The plugin adds no approval prompt
and never auto-approves a call.

## How the parts fit

```text
PreToolUse -- conversation UUID + one-use ticket --> Events MCP server
                                                        |
your configured MCP servers -- push / poll / webhook --> store
                                                        |    |
                          next PreInvocation <----------+    +--> wake request
                            announces batch                       |
                                                                App sidecar
                                                          wake budget -> agentapi
```

- **Conversation identity.** Antigravity's MCP calls carry no documented
  conversation id. The `PreToolUse` hook does receive it. The shared
  server-cards gate writes a private ticket bound to this tool and these
  arguments and merges its name into `agentpolyfill_ticket`. The server
  redeems it once, within 24 hours (the call may wait that long on Antigravity's own approval card). Missing tickets, changed arguments,
  another tool's ticket and non-UUID ids are refused. `_meta`, tool arguments,
  workspace paths and transcript filenames are never used to guess identity.
- **Server discovery.** The first valid tool call reads the configured
  servers and opens a separate connection to each. Local `command`, `args`,
  `env`, `cwd`, and remote `serverUrl`/`url` with plain `headers` work. Values
  are literal; no `${VAR}` expansion or header-helper command is added.
  Relative `cwd` is resolved beside the configuration file.
- **Servers left alone.** `disabled: true`, any `authProviderType` or `oauth`
  field, and a server that requests sign-in are listed with reasons under
  `unavailable`. The plugin never reads Antigravity's OAuth token store or
  any other host's credentials. Servers supplied by other plugins or project
  scopes aren't read. The plugin excludes itself.
- **Watches.** Each conversation owns its watches, cursors and events.
  Core's process claim allows only one server process to run its watches.
  A second process can list them and take over after the owner ends. On
  resume, call `list_watches` to restart saved watches from their cursors.
- **Delivery in a run.** The shared client stores an event before acknowledging
  it upstream. `PreInvocation` takes an undelivered batch, wraps core's
  summary in one `systemMessage` step, explicitly labels it server data,
  writes JSON to stdout, then advances `delivered.pos`. An overlapping hook
  process cannot inject the same batch. Nothing new means `{}`. Malformed
  input or a state error also produces JSON and exit zero.
- **Idle wake.** The server leaves a coalesced request on disk. The sidecar
  reads it and core's wake budget before running `agentapi`. The prompt
  contains no server text; the next `PreInvocation` supplies the summary.
  Waking and delivering have separate positions, so an accepted wake does
  not claim that the hook injected the data. A wake is recorded before
  sending, and an interrupted or ambiguous send counts once across restarts.

### Webhooks and relays

Push and poll need no relay. Webhook-only servers need an authenticated
connection and a public HTTPS callback. The shared client verifies signatures,
timestamps and replay state before accepting a delivery. Set up a relay using
the [existing relay instructions](../claude-code/mod/relay/README.md). Put its
private `{ "url": "https://...", "accessKey": "..." }` settings in
`~/.gemini/agentpolyfill/mcp-events/relay.json` (mode 0600), or explicitly
set `MCP_EVENTS_RELAY_FILE` to a relay file you already use.

`MCP_EVENTS_RELAY=public` opts in to the author's public relay. Event payloads
pass through it and remain there until collected, for up to 24 hours.
Each watch using it says so. The relay cannot forge signed deliveries.
Alternatively, set `MCP_EVENTS_PUBLIC_URL` and `MCP_EVENTS_RECEIVER_PORT` for
your own forwarder. The plugin opens only a local receiver.

## Settings and state

Everything the plugin writes is under `stateDir('mcp-events')`:
`~/.gemini/agentpolyfill/mcp-events`, or
`$AGENTPOLYFILL_STATE_DIR/mcp-events`. This directory is 0700 and files are
private to the user. Give the server, hooks and sidecar the same HOME and
state-root override.

Put settings in `settings.json` there, with string values, for example:

```json
{ "MCP_EVENTS_PRE_STANDARD": "off", "MCP_EVENTS_WAKES_PER_HOUR": "10" }
```

The corresponding environment variables override file settings. Restart the
plugin and sidecar after changing configuration. An unreadable settings file
stands down. The log is `mcp-events.log`, bounded and scrubbed of known secrets.
`threads/<uuid>/` holds watches; `sessions/<uuid>/` holds events and delivery
and wake positions. Removing a watch does not erase its stored events.

| Setting | Meaning |
|---|---|
| `MCP_EVENTS_OFF=1` | Stand down: no tools, upstream connections, injections or wakes. |
| `MCP_EVENTS_PRE_STANDARD` | `off` is strict SEP-3415; unset accepts the earlier top-level `events` capability; a comma-separated list allows it only for named servers. |
| `MCP_EVENTS_SERVERS`, `MCP_EVENTS_SKIP` | Only these names, or never these names. |
| `MCP_EVENTS_CONFIG` | Another JSON file with `mcpServers`, instead of the personal configuration. |
| `MCP_EVENTS_BATCH_MS` | Coalesce wakes for this many milliseconds; default 1000. |
| `MCP_EVENTS_WAKE_GAP_S` | Least gap between wakes started by one watch; default 60. Zero removes it. |
| `MCP_EVENTS_WAKES_PER_HOUR` | Wakes per conversation per hour; default 30. Zero removes the cap. One additional notice says waking is paused. |
| `MCP_EVENTS_MIN_POLL_MS` | Poll floor; default 1000. |
| `MCP_EVENTS_CONNECT_TIMEOUT_MS` | Initial connection timeout; default 10000. |
| `MCP_EVENTS_RELAY`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_RELAY_FILE` | Relay selection and its private settings. |
| `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | Your own public forwarder to the local receiver. |

After the hourly notice, waking pauses for an hour. Hooks and tool calls do
not reset the budget: Antigravity supplies no documented turn trigger that
reliably distinguishes a person's message from an `agentapi` message.
Events remain available on the next model call throughout the pause.

`MCP_EVENTS_STATE`, Codex settings and `MCP_EVENTS_WAKE_VALUES` aren't used.
Payload text always stays out of injected summaries and wake prompts.

### Stand-down

Antigravity provides no Events support signal this plugin can detect. When
the host supports Events itself, disable/remove this plugin, or put
`{ "MCP_EVENTS_OFF": "1" }` in its settings and restart both server and
sidecar. Disable `mcp-events/wake` in the App configuration too. Running
native Events and this plugin together can produce duplicate subscriptions.

## Limits and the host changes that would close them

| Limit | Antigravity change needed |
|---|---|
| Every tool needs a hook ticket, carried in from the `PreToolUse` hook through `overwrite` (checked live). A missing hook makes the call fail closed. Each lazily loaded MCP call in Antigravity (`call_mcp_tool`, any server's) starts the hook once. | A conversation UUID visible to MCP servers on each call. |
| Idle wakes work only through an enabled App sidecar, and reach only the App's conversations. | A documented send-message API available outside sidecars. |
| The IDE's hooks page lists no plugin-level hooks; if the IDE doesn't run a plugin's hooks, every Events call there is refused (no ticket) and nothing is injected. Not checked live. | Plugin hooks in the IDE. |
| CLI and IDE wait for the next model call. | Sidecar support in the CLI and IDE, or an equivalent managed background worker. |
| This is a second MCP client; a local server may run twice. Native sign-in is unavailable. | Forward MCP notifications to plugins and allow custom requests over the host's own approved connection. |
| It cannot inspect the result of another tool to discover an event handle or correlate its output. | Tool output in `PostToolUse`. |
| Watches need a running MCP server; the sidecar only wakes, it does not receive upstream events. Reopening waits for a plugin tool call. | A documented persistent plugin-client lifecycle and resume callback with conversation identity. |
| Injection uses a system-message container, though its contents are explicitly marked as data. Antigravity labels it "injected by a PreInvocation hook". A wake arrives as a system message (`sender=system`, "Message from System" in the App), never as your input. | A plugin event channel marked as untrusted data in both UI and model context. |
| Hooks have no acknowledgment that an injected step actually reached model history. A crash after stdout but before recording delivery can repeat a batch; a host discarding successful stdout can miss the announcement. | A durable injection acknowledgment/idempotency key. Stored events remain readable today. |
| A timed-out, nonzero or interrupted `agentapi` send counts as handed over even if no turn started. | A documented idempotent send receipt. The next model call still receives the stored batch. |
| Automatic native-support stand-down is unavailable. | A host capability query for Events. |

Core also bounds an event to 256 KiB, a remote response to 4 MiB and a
conversation's spool to 64 MiB. A full spool stops taking events; it does not
acknowledge discarded data. Core's replay and crash limits apply as documented
in the [Codex README](../codex/README.md#limits). State is retained until the
person removes it; this form does not automatically prune conversations.

## What differs from Codex

The MCP transport front and tool schemas are imported from the Codex form;
core owns the client, watchers, store, formatting, redaction and wake gate.
No shared source is copied or modified. This adapter sets
`configureHost(ANTIGRAVITY)` and supplies Antigravity's own words.

| | Codex | Antigravity |
|---|---|---|
| Servers | `config.toml` | `~/.gemini/config/mcp_config.json` |
| Conversation | `_meta.threadId` | UUID ticket from `PreToolUse` |
| In-run delivery | Queue message | One `PreInvocation` step per new batch |
| Idle wake | `codex queue --resume` | App sidecar's `agentapi send-message` |
| Wake budget reset | Person's turn metadata or an hour | An hour; no guessed turn origin |
| State | `$CODEX_HOME/mcp-events` | `stateDir('mcp-events')` |
| No-Events discovery cache | One day | Once per server process; no persistent negative cache |
| Verified in a real host | Codex TUI | App v2.35.1 and CLI v1.5.16 (macOS) |

## Spec and conformance

The shared client's [clause table](../claude-code/docs/conformance.md) covers
the 86 client clauses of SEP-3415. The earlier top-level `events` capability
is a documented exception to CAP-2/CAP-4; `MCP_EVENTS_PRE_STANDARD=off`
removes it. No Events methods, fields or capabilities are invented here.
The conversation ticket is a local adapter-tool argument, never an upstream
Events parameter.

[docs/conformance.md](docs/conformance.md) maps this form's tests and separates
local checks from the upstream suite. [docs/interop.md](docs/interop.md) gives
the runnable local external-server procedure. The upstream conformance suite
hasn't been run against this form.

### What the live run showed

Checked on 25 November 2026 ([docs/live-run.md](docs/live-run.md)):

1. `agy plugin validate --strict` passes (it counts the sidecar), and
   `agy plugin install` installs the plugin.
2. **Tool names.** Antigravity loads MCP tools lazily by default, and a hook
   then sees `call_mcp_tool` with `ServerName` (`mcp-events_events`),
   `ToolName` and `Arguments`; only an eager tool is `mcp_<server>_<tool>`.
   The first run found the hook matching the eager names only, so every call
   was refused (failing closed, as intended). The gate now takes both forms
   and checks `ServerName`. `allow` keeps Antigravity's own MCP approval
   ("Allow using this MCP tool?"), and `overwrite` reaches the server; the
   tool result starts with Antigravity's note that a hook changed
   `Arguments`.
3. **Next-turn delivery (CLI).** One `agy` process, two turns: a watch by push
   on Mastra's server, a failing deploy, then the second turn's
   `PreInvocation` step carried the event, once, labelled by Antigravity as
   injected by a hook.
4. **Idle wake (App).** With `mcp-events/wake` enabled, the App ran the
   sidecar with its own Node (no Node on `PATH` needed for it) and `agentapi`
   on its `PATH`. A failing deploy 3.5 s later: the sidecar's
   `agentapi send-message` woke the idle conversation, the hook delivered the
   batch, and the agent read the event and the server's deploy log (each
   through Antigravity's approval) and answered in one line, as the watch's
   note asked.
5. Hooks also get the conversation id as `ANTIGRAVITY_CONVERSATION_ID` in
   their environment.
6. **Only the App's conversations can be woken.** A CLI conversation was at
   first told idle wakes were available, because the App's sidecar was
   running. The hook now records where a conversation lives, and a CLI or IDE
   conversation is told it can't be woken and is never sent a wake.
7. **Stand-down, isolation, restarts.** `MCP_EVENTS_OFF=1` left no tools and
   no injections. A second conversation saw none of the first's events.
   After an App restart an old watch stays dormant until that conversation
   calls the plugin again; then the events missed in between arrive at its
   next turn, from the server's cursor.
8. Antigravity's MCP client declares elicitation but answers every request
   with `cancel`, so the hook is the only way to reach the person.

9. **A wake during a running turn** is held by the App and put into that turn
   at its next model call, with the hook's batch: no separate turn, the event
   once. A ticket now waits up to 24 hours for Antigravity's own approval
   card (the live run found 15 minutes too short).

Not checked yet: the IDE's agent (it stayed signed out), and a webhook watch
(the demo server refused a plain `http` local callback; it needs an https
address). Details:
[docs/live-run.md](docs/live-run.md#second-pass-later-the-same-night).

## Development

This work reused dependencies already installed in `events/codex`,
`events/core` and `server-cards/antigravity`; npm did not download anything.
For a fresh checkout, install the pinned dependencies in those folders first.
The build and typecheck deliberately use Codex's installed esbuild/TypeScript.

```bash
cd polyfills/events/antigravity
npm run build       # committed plugin/dist/server.mjs and license notices
npm run typecheck
npm test            # bundled tests, temporary HOME, loopback only
npm run check       # byte-identical fresh bundle and notices
node build.mjs --out /tmp/events-build
```

The tests import the shared clause, hardening, recovery and relay suites;
their lifecycle cases use this adapter's harness. The nine Codex end-to-end
spec cases are adapted to the real gate, bundle, sidecar and invocation hook.
The adapter tests cover configuration, tickets, isolation, hook JSON,
matchers, wake budgets, crash recovery and a standalone installed copy.
Property-fuzz and hosted-server runs are not part of this form's local suite.

## Licence

Apache-2.0, part of [AgentPolyfill](../../../README.md). See
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt) for bundled
dependencies. This community plugin is not affiliated with Google or the MCP
project.
