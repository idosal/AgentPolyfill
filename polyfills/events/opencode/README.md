# mcp-events for OpenCode

OpenCode can watch events on your MCP servers ("tell me when a deploy fails")
and act when one fires, even while the session sits idle with nobody typing.

Also available for Claude Code ([mcp-events for Claude Code](../claude-code/README.md))
and Codex ([mcp-events for Codex](../codex/README.md)).

This plugin implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), by push, poll or webhook. OpenCode
2.4 has part of Events itself: its MCP client takes events by push
(`events/stream`) for its automations, which can start a prompt in a session
when one arrives. It doesn't poll, it doesn't take webhooks, and it skips any
event type whose schemas it can't turn into a checker, valid SEP-3415 schemas
among them. So this plugin watches every event type, and names OpenCode's
automations as the alternative for push. Details are in
[Spec and conformance](#spec-and-conformance).

## Install

The plugin isn't on npm yet. From a clone of this repository, add its folder
to `plugins` in your OpenCode configuration (`~/.config/opencode/opencode.json`
for every project, or a project's `opencode.json`):

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/events/opencode/plugin"]
}
```

The folder is one bundled file, [`plugin/server.js`](plugin/), and its
licence notices. Nothing else is downloaded. OpenCode loads it the next time
it opens the project.

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1). OpenCode
runs the plugin itself, so you don't need Node.

To remove it, take the entry out of `plugins`.

## Try it

Add an MCP server that offers events by poll or webhook to your OpenCode
configuration, then ask OpenCode:

> Which events can my MCP servers report?

and then, for one of them:

> Tell me when a high-priority ticket is created.

OpenCode calls `mcp_events_watch_event`. When the next event comes, the
session wakes by itself with a message from the plugin that starts with
`[mcp-events]`, reads the event with `mcp_events_get_event`, and does what
the watch's note says.

To be asked before each watch starts, add this to your OpenCode
configuration. OpenCode's own default allows every action, so without a rule
like it you aren't asked (see [Permissions](#permissions)):

```jsonc
{
  "permissions": [
    { "action": "mcp_events_watch", "resource": "*", "effect": "ask" },
    { "action": "mcp_events_unwatch", "resource": "*", "effect": "ask" }
  ]
}
```

## How it works

### What OpenCode can do with it

Six tools, in OpenCode's `mcp_events` namespace:

| Tool | What it does |
|---|---|
| `mcp_events_list_event_types` | What each server can report, and how. |
| `mcp_events_watch_event` | Starts a watch for this session, with a note saying what to do when it fires. |
| `mcp_events_unwatch_event` | Stops one. |
| `mcp_events_list_watches` | This session's watches. |
| `mcp_events_get_event` | One event, in full, as a tool result. |
| `mcp_events_recent_events` | The latest few, one line each. |

### How the parts fit together

- **Loading.** OpenCode loads the plugin into its server once per project
  folder. It reads your MCP servers from OpenCode's own configuration, through
  `ctx.mcp.transform` (a transform that only reads, never changes a server),
  and connects to each one the first time one of its tools is called.
- **A watch belongs to a session.** A tool call tells the plugin which session
  it's from, and the watch is that session's.
- **Permissions.** Starting or stopping a watch is put to OpenCode's
  permission rules first, with `ctx.permission.assert`, as the actions
  `mcp_events_watch` and `mcp_events_unwatch` on `<server>:<event type>`.
- **Events.** The shared Events client ([`../core`](../core)) polls, or takes
  signed webhooks, and stores every event on disk before it acknowledges it.
- **Waking.** The plugin hands the session a message with
  `ctx.session.synthetic`, which OpenCode admits to the session's inbox marked
  as synthetic, not typed by you. With `resume: true`, an idle session starts
  a turn with it. The message gives the new events' ids, the watch and its
  note, and none of what the server sent.
- **Restarts.** Watches are kept on disk, with their cursors. When OpenCode
  next opens the project, the plugin resumes them, and events from the
  meantime arrive once.

### Which servers it works with

Every server in your OpenCode configuration that declares the Events
extension. A local server (`type: "local"`) is started a second time, for the
plugin's own connection. A remote server works with the headers in its
OpenCode configuration.

A server OpenCode signs in to with OAuth (`opencode mcp auth`) doesn't work:
OpenCode doesn't give a plugin its sign-in, or any way to send `events/*`
requests over its own connection. The plugin never reads OpenCode's stored
credentials. `mcp_events_list_event_types` names each server it left alone,
and why.

### Webhook delivery

As in the other forms: through a relay of your own, the public relay (opt-in,
`MCP_EVENTS_RELAY=public`), or a forwarder of your own
(`MCP_EVENTS_PUBLIC_URL`). The [Claude Code form's README](../claude-code/README.md)
describes each. Set the variables in the environment OpenCode starts in.

### Push, and OpenCode's automations

An event type a server offers by push is watched by push (`events/stream`),
as the SEP's order of delivery modes says. OpenCode's own automations take
push events too, for the event types its client accepts, and the plugin says
so when it lists event types or watches one by push: a watch, or an automation
with an event trigger (`automation_create`), not both, or each event reaches
the session twice. The plugin doesn't leave push to OpenCode, because
OpenCode's client skips event types whose schemas it can't check: in a run,
it skipped both of the fixture server's types, whose payload schemas use
`pattern`, `format` and the SEP's `x-mcp-content`.

## Permissions

OpenCode decides, with its own rules and its own prompt. The plugin asks and
never answers. OpenCode's shipped default allows every action, so with no
rule for `mcp_events_watch` a watch starts without a prompt, as any tool call
does in OpenCode by default. Add the `ask` rules in [Try it](#try-it) to be
asked. "Allow always" saves an approval for that server and event type.

What OpenCode does about an event goes through your rules too. Receiving one
grants nothing.

## Settings

| Variable | What it does |
|---|---|
| `MCP_EVENTS_OFF=1` | Do nothing, without being uninstalled. The plugin option `{"off": true}` does the same. |
| `MCP_EVENTS_STATE` | Where the plugin keeps its state. Default: `~/.local/share/opencode/mcp-events` (`$XDG_DATA_HOME/opencode/mcp-events`). |
| `MCP_EVENTS_WAKE_GAP_S`, `MCP_EVENTS_WAKES_PER_HOUR` | How often events may wake a session: once a minute per watch, 30 times an hour, by default. |
| `MCP_EVENTS_PRE_STANDARD` | As in the other forms: `off` to use only servers that advertise events as SEP-3415 says. |
| `MCP_EVENTS_RELAY`, `MCP_EVENTS_PUBLIC_URL`, `MCP_EVENTS_RECEIVER_PORT` | Webhook delivery. |

### When OpenCode supports more of Events itself

The plugin checks for OpenCode's own Events tool (`opencode_list_mcp_events`)
when it loads, and names OpenCode's automations as the alternative for push
when it's there. If OpenCode comes to watch every event type for a session,
by push, poll and webhook, turn the plugin off with `MCP_EVENTS_OFF=1`, or
remove it.

## Limits

- **Servers behind OAuth.** See [Which servers it works with](#which-servers-it-works-with).
- **Two ways to take push events.** OpenCode's automations and this plugin's
  watches both take push events; the plugin tells the model to use one or the
  other. It can't tell which event types OpenCode's own client accepts: a plugin
  can't ask, and `opencode_list_mcp_events` is the model's tool.
- **Watches resume when OpenCode opens the project.** OpenCode loads a
  project's plugins when something uses that project (the TUI, the desktop
  app, or a client of its server). Until then a saved watch doesn't run.
  Events from the meantime aren't lost: they arrive when it resumes.
- **The wake reaches the model as a user message.** OpenCode stores it as
  synthetic, but sends it to the model in the user's role. Its first line says
  it was sent by the plugin, not typed by you.
- **A second connection.** A local server that offers events runs twice.
- **Tried live** with a real model (one of OpenCode's free ones) against the
  fixture server: an event woke the idle session, and the model did what the
  note said ([`live-run.md`](../../../tools/opencode/live-run.md)). CI runs
  the tests on Linux and macOS.
- **OpenCode's TUI shows little in the prompt.** In OpenCode 2.4.1's TUI, a
  permission prompt for a plugin's own action says only "Call tool
  mcp_events_watch". The details are on the model's call line just above it, and
  "Always allow" lists the pattern it would save. Checked in the TUI
  ([`live-run.md`](../../../tools/opencode/live-run.md#in-opencodes-tui)).
- **In OpenCode Desktop** (2.4.1, tried live): the plugin runs in the app's
  own server, and the permission prompt names the action and the server and
  event type. An event woke the idle session and the model answered, but the
  app shows no entry for the wake message itself, so the turn starts with no
  visible cause (the TUI shows it as `◈ mcp-events: new events`).
- **Tried live against public infrastructure:** AgentPolyfill's event-feeds
  server by poll (a demo button pressed woke the session), and a webhook
  through the public relay
  ([`live-run.md`](../../../tools/opencode/live-run.md#public-infrastructure)).
- **Not tried yet:** Windows by hand (CI runs the tests there).

[What hosts would need to change](../../../docs/host-changes.md) covers these
gaps for each host.

## Security

An event is data from a server you configured. Its payload reaches the model
only as a tool result, and the wake message carries none of it. Watches are
put to OpenCode's permission rules. Wakes are capped. The plugin never reads
OpenCode's stored credentials. [`SECURITY.md`](SECURITY.md) has the full
account.

## Spec and conformance

The plugin implements the client side of
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
Final as of 24 November 2026, through the shared client in [`../core`](../core),
bundled unchanged. Every client rule is implemented once, there; the
clause-by-clause table is the Claude Code form's
[`docs/conformance.md`](../claude-code/docs/conformance.md), and its interop
and conformance-suite runs drive the same client. One step outside the SEP is
on by default, as in the other forms: servers that advertise events in the
form from before the standard. `MCP_EVENTS_PRE_STANDARD=off` turns it off.

What is different in OpenCode:

| Clause | In OpenCode |
|---|---|
| PUSH-* | The shared client's, as in the other forms: one `events/stream` per watch, on the plugin's own connection. OpenCode's own connection opens its own streams, for its automations only. |
| SEC-3, SEC-4 (receipt is not authorization; policy between receipt and action) | OpenCode's permission rules, for what the model does after a wake, and for the watch itself. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-opencode`). OpenCode's own connection declares it too, for push. |

### Checked end to end in OpenCode

[`test/e2e.test.ts`](test/e2e.test.ts) runs the plugin in OpenCode 2.4.1, in a
throwaway home, against the Claude Code form's fixture events server (written
from the SEP, sharing no code with the client), with a scripted model:

- the six tools reach the model, and the fixture's event types are listed from
  OpenCode's own MCP configuration;
- a watch is put to OpenCode's permission rules; rejected, nothing is watched;
- approved, the watch polls, and an event wakes the idle session with a
  synthetic `[mcp-events]` message that holds no payload; the model reads the
  event with `get_event`;
- `unwatch_event` is asked about too;
- after OpenCode restarts, the watch resumes from its cursor, and an event
  from while it was down wakes the session once;
- an event type offered by push is watched by push, and an event wakes the
  session, with OpenCode's automations named as the alternative;
- a webhook-only event type is watched by webhook, to the plugin's receiver
  inside OpenCode's server, and a signed delivery wakes the session;
- a server that answers 401 is named as needing a sign-in, and the header in
  its configuration appears in no tool result, log line or model request.

## Development

From this folder (`polyfills/events/opencode` in the repository):

```bash
(cd ../../../tools/opencode && npm ci)   # the pinned OpenCode the tests run
(cd ../core && npm ci)                   # the shared Events client
npm ci
npm test                                 # Node 22.18 or newer
npm run typecheck
npm run build                            # plugin/server.js; npm run check fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin plugin --entry src/plugin.ts --bundle server.js
```

- [`plugin/`](plugin/) is what OpenCode loads: the bundle and its licence notices.
- `src/` is what is specific to OpenCode: the part of its plugin API used
  (`opencode.ts`), reading its MCP configuration (`config.ts`), sessions and
  waking (`sessions.ts`), the plugin (`plugin.ts`) and what it says
  (`words.ts`). The rest is [`../core`](../core).
- [`../../../tools/opencode`](../../../tools/opencode) is the test kit shared by
  the OpenCode forms. CI: [`opencode-events-test.yml`](../../../.github/workflows/opencode-events-test.yml).

## Licence

Apache-2.0, as the rest of the repository.
