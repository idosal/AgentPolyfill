# mcp-events for T3 Code

In a [T3 Code](https://github.com/pingdotgg/t3code) thread, Codex can watch
events on your MCP servers ("tell me when a deploy fails") and act when one
fires, even after the thread has gone idle, its agent session has closed, or
T3 Code has restarted.

Also available for: [Claude Code](../claude-code/README.md),
[Codex](../codex/README.md). Why T3 Code gets a form of its own, and what the
other polyfills do there, is in [T3 Code](../../../docs/t3-code.md).

This server implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which T3 Code doesn't support as a
client. Details are in [Spec and conformance](#spec-and-conformance).

## Install

It isn't published yet, so it runs from a clone of this repository. With
Node 22.18 or newer for the build (the server itself runs on Node 20 or
newer):

```bash
git clone https://github.com/idosal/AgentPolyfill
cd AgentPolyfill/polyfills/events/t3
```

The built server is committed: `plugin/dist/server.js`, about 0.6 MB, with
nothing else to install. Add it to Codex, the agent T3 Code runs:

```bash
codex mcp add mcp-events-t3 -- node "$PWD/plugin/dist/server.js"
```

Then, in T3 Code, use **Restart agent session** from the command palette in a
thread that is already open, or start a new thread. That's all for a T3 Code
that uses your usual Codex home (`~/.codex`) and T3 Code home (`~/.t3`).

If your T3 Code's Codex provider has a **CODEX_HOME path** of its own, or T3
Code runs with a `T3CODE_HOME` of its own, the server has to see them, and
Codex passes a server only a few variables. Add them to the server's table in
that `config.toml`:

```toml
[mcp_servers.mcp-events-t3]
command = "node"
args = ["/path/to/AgentPolyfill/polyfills/events/t3/plugin/dist/server.js"]
env_vars = ["CODEX_HOME", "T3CODE_HOME"]
```

You need:

- **T3 Code 0.1.11 or newer**, with a Codex provider.
- **The `t3` command** on the PATH Codex runs with, which T3 Code's
  [install script](https://github.com/pingdotgg/t3code#command-line) puts
  there. Or set `MCP_EVENTS_T3_BIN` in the server's `env` to its full path.
  Without it, events are still stored, but no thread is woken.
- **Node 20 or newer** on that PATH.

To remove it, run `codex mcp remove mcp-events-t3`, then
`node plugin/dist/server.js --stop`, and delete `~/.codex/mcp-events-t3`.

It doesn't need the [mcp-events plugin for Codex](../codex/README.md). If you
have that too, see [Beside the Codex plugin](#beside-the-codex-plugin).

## Try it

The fixture server of this repository's tests is enough. In another clone of
the repository or the same one, with Node 22.18 or newer, add it to Codex
(paths are examples):

```bash
codex mcp add tickets --env FIXTURE_UPSTREAM=/tmp/tickets.jsonl -- node --no-warnings /path/to/AgentPolyfill/polyfills/events/claude-code/test/fixture-events-server.ts
```

In a T3 Code thread with Codex, ask:

> Watch new high-priority tickets on the tickets server, and summarize each in
> one line.

Then make a ticket:

```bash
echo '{"eventId":"t1","name":"ticket.created","timestamp":"2026-11-25T00:00:00Z","data":{"id":"T-1","priority":"high","title":"Checkout returns 500"}}' >> /tmp/tickets.jsonl
```

Within a few seconds the thread gets a message that starts with
`[mcp-events]`, reads the ticket, and summarizes it. That works whether the
thread was idle, its session closed, or T3 Code was restarted in between. The
run in [`docs/live-run.md`](docs/live-run.md) stops T3 Code entirely before
the event arrives.

## How it works

```
your MCP server (SEP-3415) ──events/stream · events/poll · webhooks──►  watcher (server.js --watcher)
                                                                           one per Codex home; runs every
                                                                           thread's watches; every event
                                                                           on disk before it is acknowledged
T3 Code thread ─► Codex ─► server.js (one per thread, T3CODE_THREAD_ID) ─► │  local socket
                                                                           │
T3 Code ◄── t3 thread send <thread> - ("[mcp-events] …" on stdin) ─────────┘  starts a turn in that thread
```

- **Which thread.** T3 Code tells every stdio MCP server Codex starts for a
  thread which thread it is, in `T3CODE_THREAD_ID`. A watch belongs to that
  thread. Started anywhere else (the Codex TUI, `codex exec`), the server
  offers no tools at all.
- **Why a watcher.** T3 Code closes a thread's agent session when the thread
  has been idle for a while, and Codex stops the servers it started for the
  thread with it. So the server only passes calls on; the watcher, which it
  starts the first time it's needed, runs the watches and outlives the
  sessions. It ends by itself when no thread has a watch and nothing has asked
  for a minute. When it starts again it resumes every saved watch at once.
- **Finding servers.** The watcher reads the MCP servers in Codex's
  `config.toml` when it starts, connects to each once, and keeps those that
  offer events. After you add or change a server, run
  `node plugin/dist/server.js --stop`: the next call starts the watcher with
  the new configuration.
- **Watching.** A watch is one subscription. The delivery mode follows the
  SEP's guidance: webhook where a relay is set up, then push
  (`events/stream`), then poll (`events/poll`).
- **Waking the thread.** Each event is written to disk first. Then the
  watcher runs `t3 thread send <thread> -`, T3 Code's own command for
  messaging a thread from its machine, with the message on standard input. An
  idle thread starts a turn with it at once; a busy one gets it as its next
  turn; nothing is interrupted. T3 Code reopens the agent's session if it had
  closed it, and the turn runs in the thread's own permission mode. If T3 Code
  isn't running, the wake is tried again, at growing intervals up to five
  minutes, until it is.
- **The message.** Its first line says it's from the polyfill, not typed by
  you. The rest names the server and event type, gives the new events' ids,
  and repeats the note saved with the watch. It carries nothing the server
  wrote: the agent reads what happened with `get_event`.

### What the agent can do with it

| You say | The agent uses |
|---|---|
| "What can you watch on my servers?" | `list_event_types` |
| "Tell me when a high-priority ticket comes in." | `watch_event` |
| "What are you watching?" | `list_watches` |
| "Show me that last event in full." | `get_event`, `recent_events` |
| "Stop watching tickets." | `unwatch_event` |

`watch_event` and `unwatch_event` change something, so they go through
Codex's approval in a thread whose mode asks. The other four only read.

### Which servers it works with

As the Codex form: servers that implement SEP-3415 (and, by default, the form
from before the standard), over stdio or Streamable HTTP, with credentials in
their configuration (`http_headers`, `http_headers_helper`, or a variable that
reaches the server). Not a server you sign in to through Codex
(`codex mcp login`, OAuth): Codex keeps that sign-in to itself, and this
server never reads it. The rules are in the Codex form's README:
[Servers that need credentials](../codex/README.md#servers-that-need-credentials)
and [Servers that need sign-in](../codex/README.md#servers-that-need-sign-in).

Webhook delivery needs a relay, set up as for the other forms
([the Codex form's README](../codex/README.md#webhook-delivery-the-relay)).

### Where it runs

| | Tools | An event wakes the thread |
|---|---|---|
| A T3 Code thread with Codex | Yes | Yes (tested live: [`docs/live-run.md`](docs/live-run.md)) |
| A T3 Code thread with Claude Code | No: T3 Code doesn't tell Claude Code's servers which thread they serve. Use the [Claude Code mod](../claude-code/README.md); its limits in T3 Code are in [T3 Code](../../../docs/t3-code.md) | |
| A T3 Code thread with another agent | Not tested | |
| Codex outside T3 Code | No tools: use the [Codex plugin](../codex/README.md) | |

Tested live with T3 Code 0.1.11 and Codex 0.172.0 on macOS. The tests run on
Linux and macOS in CI, including the wake against the real `t3` command.
Windows hasn't been tried.

### Beside the Codex plugin

The [mcp-events plugin for Codex](../codex/README.md) and this server read the
same `config.toml`, so with both installed a T3 Code thread has two sets of
the same six tools. Don't use the plugin's in T3 Code. It wakes a session with
`codex queue`, meant for Codex's own app-server daemon, and T3 Code runs an
app server of its own. In our run, T3 Code's app server took the queued
message and ran a turn with it that the T3 Code thread never showed. Remove
the plugin if you use Codex only through T3 Code; otherwise, ask for the
`mcp-events-t3` tools by name.

### If something doesn't work

- Ask "what can you watch?" A server you expected that is missing is listed
  under `unavailable`, with the reason.
- `list_watches` says when waking the thread last failed, and why.
- The log is `~/.codex/mcp-events-t3/mcp-events.log`, for the servers and the
  watcher both. Tokens are removed from it.
- If the tools are missing in a T3 Code thread, check that `codex mcp list`
  shows `mcp-events-t3`, and restart the thread's agent session.

## Settings

Environment variables, in the server's `env` table in `config.toml`. The
watcher takes them from the server that starts it; after changing one, run
`--stop`.

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Installed, and doing nothing. |
| `MCP_EVENTS_T3_BIN` | The full path of `t3` (or of the `t3` package's `dist/bin.mjs`). Default: the first `t3` on PATH, then where T3 Code's installer puts it. |
| `MCP_EVENTS_PRE_STANDARD` | As in the other forms: `off` refuses servers that advertise events only in the form from before the standard; a comma-separated list allows that form for those servers only. |
| `MCP_EVENTS_SERVERS` / `MCP_EVENTS_SKIP` | Only these server names, or never these. |
| `MCP_EVENTS_CONFIG` | A servers file of your own instead of `config.toml`. |
| `MCP_EVENTS_BATCH_MS`, `MCP_EVENTS_WAKE_GAP_S`, `MCP_EVENTS_WAKES_PER_HOUR`, `MCP_EVENTS_WAKE_VALUES`, `MCP_EVENTS_MIN_POLL_MS` | As in the other forms ([Claude Code form's settings](../claude-code/README.md#settings)). |
| `MCP_EVENTS_RELAY=public`, `MCP_EVENTS_RELAY_URL`, `MCP_EVENTS_RELAY_ACCESS_KEY`, `MCP_EVENTS_PUBLIC_URL` | Webhook delivery, as in the other forms. |
| `MCP_EVENTS_STATE` | Where watches and events are kept. Default `$CODEX_HOME/mcp-events-t3`. |

### When T3 Code supports Events itself

Remove the server (above). It can't stand down by itself: nothing tells an
MCP server what T3 Code's own client supports.

## Limits

- **Codex threads only**, until T3 Code passes `T3CODE_THREAD_ID` to Claude
  Code's servers too. `T3CODE_THREAD_ID` itself isn't in T3 Code's user docs
  yet: T3 Code sets it to tell which thread a process belongs to, which is how
  this server uses it. If T3 Code changes it, this server offers no tools, and
  says why in its log.
- **The wake shows as a message in the thread**, as everything sent with
  `t3 thread send` does. Its first line says it's from the polyfill, and T3
  Code tells the agent, on a line of its own before it, that the message
  "came through T3 Code's tools, not from the user typing in this chat".
- **Waking that stops for the hour stays stopped for the hour.** T3 Code
  doesn't tell an MCP server who started a turn, so writing to the thread
  doesn't lift the pause, as it does in the Codex form.
- **A new server needs `--stop`** before the watcher sees it.
- **Not checked live:** the approval prompt for `watch_event` in a thread
  whose mode asks (the live run's thread was in Full access, the isolated
  install's default); a T3 Code environment on another machine (the server and
  `t3` then run there, which should work the same); Windows.
- What every host would need to change for this to need no second connection
  is in [What hosts would need to change](../../../docs/host-changes.md).

## Security

[SECURITY.md](SECURITY.md) has the model, what is stored, and the watcher's
socket.

## Spec and conformance

SEP-3415, Final (as of 24 November 2026), through the shared client in
[`../core`](../core). Beyond the spec, and listed as the contract asks:

- **The form from before the standard** (a top-level `events` capability) is
  accepted by default, as in the other forms. `MCP_EVENTS_PRE_STANDARD=off`
  keeps to the SEP exactly.

Nothing else is added: no methods, fields or capabilities of its own.

### Proof

- `test/spec-test.ts`: the client rules this form wires up, end to end
  through the server and the watcher, against the fixture server (written by
  hand from the SEP, sharing no code with the client): nothing sent to a
  server without the extension, the pre-standard switch, unsubscribing, and
  each event handed to the thread once across a restart.
- The shared client's clause-by-clause tests run in `mcp-events-test.yml`.
- `test/server-test.ts`: the server and the watcher (watches outliving the
  server, one watcher for many threads, resuming after a restart, T3 Code not
  running, a thread T3 Code no longer knows).
- `test/t3-cli-test.ts`: the wake against the real `t3` 0.1.11 in a throwaway
  home.
- [`docs/live-run.md`](docs/live-run.md): a real run in T3 Code 0.1.11 with
  Codex 0.172.0.

## Development

```bash
(cd ../core && npm ci) && (cd ../codex && npm ci) && npm ci
npm run typecheck
npm test
npm run build     # rewrites plugin/dist/server.js; commit it
node ../../../tools/bundle-notices.mjs . --plugin plugin --entry src/server.ts
```

`T3_CLI=<path to t3's dist/bin.mjs> npm test` also runs the test against the
real `t3`. The server reuses two files of the Codex form, unchanged: its stdio
MCP server (`../codex/src/mcp-server.ts`) and its `config.toml` reader
(`../codex/src/codex-config.ts`).

## Licence

Apache-2.0. The bundle's third-party notices are in
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt).
