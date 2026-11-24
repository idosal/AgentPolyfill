---
description: What makes something a polyfill, how the polyfills plug into Claude Code and Codex, where they stop, and the four generic host changes that would remove the limits in both.
---

# How it works

## What makes something a polyfill

1. It implements one published extension, client side, and nothing else: no
   extra protocol and no vendor additions. The one exception is an earlier
   form of the same extension that servers still speak, listed in the
   polyfill's README and switched off with one setting.
2. It names the spec revision it implements.
3. Every client rule in the spec has a test, and it runs against servers
   someone else wrote.
4. It stands down once the host supports the extension itself.
5. It says plainly what it can't do in each host, and what the host would
   need to change.

The full text is in
[`docs/polyfill-contract.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/polyfill-contract.md).

Events uses the exception in rule 1: by default it also talks to servers that
advertise events in the form from before SEP-3415.
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly.

For rule 4, no polyfill can detect native support on its own yet, because
neither host tells a plugin which extensions its own MCP client supports. So
when your host ships one of these extensions, turn that polyfill off. In
Claude Code, disable its plugin (`/plugin disable mcp-events`), or use its own
setting (`MCP_EVENTS_OFF=1`, `MCP_SKILLS_OFF=1`, or `disabled` in `/config`
for Server Cards and ARD). In Codex, remove the plugin
(`codex plugin remove mcp-events@agent-polyfill`).
[Getting started](./getting-started#turning-one-off) has the full list.

## How it works in each host, and where it stops

Both hosts let outside code in, in different ways.

- **Claude Code** runs mods inside the host (on by default since 2.1.287). A
  mod can register tools, draw UI, start a turn in an idle session, and call a
  server's tools over Claude Code's own connection.
- **Codex** runs plugins that bring their own MCP server. Every tool call the
  server receives says which session it came from, `codex queue --resume`
  starts a turn in an idle session from outside, and Codex lists the skills a
  plugin's folder holds alongside its own.

That's the host half of almost any extension. The protocol half is missing in
both. Neither host lets a plugin send an extension's own methods, such as
`events/poll` or `skills/list`, over the host's connection, see everything a
server advertised, or receive a server's notifications. So Events, Skills and
Apps each open a second connection of their own, using the headers in your
config. That connection can't use the host's sign-in, which is why those
three can't reach servers behind OAuth, and a local server ends up started
twice.

Server Cards doesn't have this problem. A card is a public document, and the
server it describes goes into the host's own config, so the host connects it
with its own sign-in.

Four small, generic changes would remove the limit, in both hosts. None of
them names an extension:

| Change | Claude Code today | Codex today |
|---|---|---|
| Send any MCP method over the host's connection | missing | missing (its client can, internally) |
| Read what the server advertised | missing | mostly there |
| Deliver a server's notifications to the plugin | missing | only for OpenAI's hosted apps server |
| Raw tool results; declare a client extension | missing | declaring only by Codex's own client |

The first two are enough for Events (by poll and webhook) and Skills to work
with every server you've signed in to. The rest of this page says what each
change would look like in each host, what each extension needs, and the
questions the changes raise.

## How a plugin plugs in today

The two hosts are built differently. In Claude Code, a mod is code that runs
inside the host and calls its API. In Codex, nothing third-party runs inside
the host: a plugin brings MCP servers, skills and hooks, and other programs
can drive Codex from outside through `app-server`, an experimental JSON-RPC
API. The Codex column names that API's methods.

We checked Claude Code against the mod API types in 2.1.330, and Codex
against CLI 0.170.0 (its `app-server` protocol, as
`codex app-server generate-json-schema` prints it) and its source at
`rust-v0.172.0`.

| What a polyfill needs | Claude Code (a mod) | Codex (a plugin, or an app-server client) |
|---|---|---|
| Add tools the model can call | `$.tool.register` | An MCP server in the plugin, or `dynamicTools` for an app-server client |
| Draw its own UI | `ui.render` hooks | No. The desktop app shows a server's MCP App; nothing draws in the terminal. |
| Start a turn in an idle session | `$.prompt.submit` | `codex queue --thread <id> --resume`, or `turn/start` through the app-server daemon |
| Know which session called | The hook runs in that session | `_meta.threadId` on every `tools/call` an MCP server receives |
| Call a server's tool over the host's connection, with its sign-in | `$.mcp.call(server, tool, args)` | `mcpServer/tool/call` |
| Ask whether the host would use a server | `$.mcp.connect(server)` | `mcpServerStatus/list` (start-up and sign-in state) |
| Read a resource over the host's connection | Only indirectly, by calling the built-in `ReadMcpResourceTool`. You get text or a saved file, without the resource's `_meta`. | `mcpServer/resource/read`, with `_meta` |
| Send any other MCP method | No | No. Codex's MCP client has a generic `send_custom_request`, but `app-server` doesn't expose it. |
| See what a server advertised | No | Mostly: capabilities (including `extensions`) and `serverInfo` are in `mcpServerStatus/list`. The negotiated protocol revision isn't. |
| Receive a server's notifications | No | Only from OpenAI's hosted apps server. `mcpServer/event/stream/*` refuses any other server. Elicitation requests are relayed. |
| See a tool's `_meta`, its `outputSchema`, or a result as the server sent it | No | Not checked yet |
| Declare a client extension to servers | No | Only Codex's own client (the terminal or the desktop app) can, and its declaration goes to every server. A plugin or the config can't. |

The row that matters most is "send any other MCP method". Because neither host
has it, each polyfill that speaks an extension's protocol (Events, Skills,
Apps) opens that second connection, built from your MCP settings.

## The four changes

### 1. Send any MCP method over the host's connection

The polyfill names the server, the method and the params, and gets back the
raw result. The host doesn't need to understand the method: a connection
already carries any method name. The transport sets the standard routing
headers for the method, or takes them from the caller.

- **Claude Code** has nothing like it today. It could be
  `$.mcp.request(server, method, params)` next to the existing `$.mcp.call`.
- **Codex** already has the hard part. Its MCP client can send any request
  (`send_custom_request`), but only Codex itself can use it. It could be an
  app-server method such as
  `mcpServer/request { threadId, server, method, params }`, behind
  `experimentalApi`, returning the raw result.

This change alone brings servers behind OAuth to Events and Skills, in both
hosts, and removes their second connection.

### 2. Read what the server advertised

The server's capabilities, including `extensions`, and the protocol revision
the two sides agreed on. Extensions forbid a client from sending their methods
to a server that hasn't declared them, so a polyfill has to be able to check.

- **Claude Code:** missing.
- **Codex:** almost there. `mcpServerStatus/list` has the capabilities and
  `serverInfo`; adding the negotiated revision would finish it.

### 3. Deliver a server's notifications to the plugin

Including notifications that arrive on the stream of a request the plugin
made. Events needs this for push delivery, and Apps for `list_changed` and
resource updates.

- **Claude Code:** missing.
- **Codex:** built, but for one server. `mcpServer/event/stream/start` and its
  notification work only for OpenAI's hosted apps server. Accepting any
  configured server, and forwarding a server's other notifications to a
  client that asked for them, would close it.

### 4. Raw tool results, and declaring a client extension

Hooks see a tool result the way the model reads it, but some extensions carry
their data in `structuredContent` and `_meta`. And some servers only offer a
feature to clients that declare its extension, which today only the host can
do.

- **Claude Code:** neither is possible.
- **Codex:** its own client can declare extensions; a plugin can't add to that
  list. Letting a plugin's manifest, or the config, add extension ids would
  close it. Raw results we haven't checked yet.

## What each extension needs

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. What the server advertised | needed | needed | needed | the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, declaring an extension | not needed (declaring is optional) | not needed | both | not needed |

Changes 1 and 2 are enough for Events (by poll and webhook) and for Skills to
work with every server you've signed in to, in either host.

Server Cards doesn't need any of the four to work. A card is a public document
you read before connecting, and the server it describes is added to the host's
own configuration, so the host connects it with its own sign-in. Changes 1 and
2 would only let it do something the spec recommends: check a card against
the live server.

## Smaller things that would help

### In Claude Code

- **Keep embedded resources whole.** When a tool result holds an
  `EmbeddedResource`, hooks, `$.mcp.call` and the model all receive it
  flattened to text. Its MIME type is lost, and so is
  `annotations.audience`, so content a server marked for the user only still
  reaches the model.
- **Let a registered tool return more than text.** A tool a mod registers can
  only answer in text today, so structured answers have to be written out as
  JSON.
- **Make tools added mid-session callable right away.** Today a server's new
  tools need a reconnect first (anthropics/claude-code#66084).

### In Codex

- **Give plugins a scope on the daemon.** Any local process that can reach the
  app-server socket can drive every session. A plugin should only reach its
  own threads and its own servers.
- **Run plugin hooks everywhere.** A plugin's hooks run only when it was
  installed by hand in the desktop app.
- **Support SEP-2640 natively** (openai/codex#48000), or at least let a
  program add skills without writing files. A plugin's skills are read once,
  when the plugin loads, so skills a plugin writes show up from the next
  session. Re-reading them on `skills/changed`, or letting
  `skills/extraRoots/set` cover plugins, would list them right away.
- **Let a PreToolUse hook ask, not only deny,** and keep hook trust when a
  plugin writes files into its own folder. Either one would let the Skills
  polyfill ask you before a skill from one server reads a resource from
  another (SEP-2640's X8).
- **Pass a plugin's MCP server the variables it needs.** It only sees a fixed
  few, so servers whose token lives in `bearer_token_env_var` or
  `env_http_headers` are out of reach. Change 1 would fix this too.
- **Tell a tool call which approval mode is on.** Put the approval policy, and
  whether approvals are bypassed, in `x-codex-turn-metadata`. Then a server
  could tell a form you answered from one Codex answered on its own.
- **Accept headers in `codex mcp add`** (`--header`, `--env-header`), plus a
  way to add a server without starting its sign-in. Then a plugin could add
  any server a Server Card describes without writing the config file itself.
- **Show MCP Apps in the terminal.** `enable_mcp_apps` only passes the
  extension on where the host declares it, and the terminal doesn't. No plugin
  can add this.
- **Start a resumed session's plugin servers when it opens,** as for a new
  session. Today they start at the first tool call, so Events' watches for a
  resumed session wait until then.
- **Start a plugin's MCP servers when a session opens on a running daemon,**
  as for the daemon's first session, or give a plugin a supported way to ask
  for that. Today the daemon starts a plugin's local server whose tool list it
  kept from an earlier session only at that server's first tool call. So the
  Skills polyfill can't write its skill entries when the session opens, and
  you have to ask once to list the served skills. Marking the server required
  starts it, but then no session opens while it can't start.
- **Mark a turn that something else started.** Input from `codex queue`
  arrives looking like the person typed it. A turn an extension starts should
  reach the model and the UI marked as the extension's.

## Questions these changes raise

- **Permissions.** A general pipe could call `tools/call` and skip the host's
  permission rules. Either the pipe sends `tools/call` through the same checks
  as any tool call, or it refuses that method and tools stay on the path they
  use today.
- **Scope.** A plugin could declare in its manifest which extension it
  implements and which method prefixes it will send (`events/`, `skills/`).
  Then you see the grant when you install it, and the pipe isn't open-ended.
- **Credentials.** Requests go out with your sign-in. That's the point, and
  it's also why the scope above matters.
- **Who may call, in Codex.** An app-server method is open to anything that
  can reach the socket, so a raw request there needs a per-plugin scope even
  more than an in-process API does.

## What these changes don't cover

- **Events:** a public address for webhook delivery, and sessions that run
  when nobody is at the keyboard.
- **Apps:** what a terminal can draw and which input it passes on.
- **Hosts with no extension layer and no API like Codex's `app-server`**
  (ChatGPT is one). See [Other hosts](#other-hosts).

This page follows
[`docs/host-changes.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/host-changes.md)
in the repository.

## Other hosts

We haven't found a documented way for third-party code to send requests over
the host's MCP connection in Cursor or VS Code, and ChatGPT runs no
third-party code on the client side. For those, the only polyfill would be a
gateway: an MCP server that presents an extension as plain tools. That's a
weaker form (for Events, the model would have to poll, and nothing would wake
it), and none is built here yet. Bringing a polyfill to another host is
[welcome](./build-a-polyfill#an-existing-polyfill-in-another-host).
