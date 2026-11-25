# What hosts would need to change

Claude Code, Codex and Pi all let outside code extend them. That gets a
polyfill most of the way: it can add tools, react to what happens in a
session, and wake a session that has gone idle. What none of them lets a
plugin do is speak an extension's own protocol over the host's connection to
a server. This page explains that gap, the four small changes that would close
it in each host, and what each extension needs from them.

None of the changes names an extension. They are generic, and any future
extension would use them the same way.

We checked Claude Code against the mod API types in 2.1.330, Codex against
CLI 0.170.0 (its `app-server` protocol, as
`codex app-server generate-json-schema` prints it) and its source at
`rust-v0.172.0`, and Pi against 1.6.0 (its extension API types, its built-in
MCP extension's source, and the Pi forms' tests, run in Pi itself).

## How a plugin plugs in today

The hosts are built differently. In Claude Code, a mod is code that runs
inside the host and calls its API. In Codex, nothing third-party runs inside
the host: a plugin brings MCP servers, skills and hooks, and other programs
can drive Codex from outside through `app-server`, an experimental JSON-RPC
API. The Codex column names that API's methods. In Pi, an extension is
TypeScript that Pi loads into its own process, and Pi's MCP support is itself
a built-in extension, which keeps its connections to itself.

| What a polyfill needs | Claude Code (a mod) | Codex (a plugin, or an app-server client) | Pi (an extension) |
|---|---|---|---|
| Add tools the model can call | `$.tool.register` | An MCP server in the plugin, or `dynamicTools` for an app-server client | `pi.registerTool`. Tool names are shared by every extension, and the first one registered under a name wins. |
| Draw its own UI | `ui.render` hooks | No. The desktop app shows a server's MCP App; nothing draws in the terminal. | Yes: custom components, overlays, `pi.registerToolRenderer`, images (Kitty, iTerm2), and mouse input in its default fullscreen mode |
| Ask the person | A permission hook that answers "ask" | MCP elicitation, from the plugin's MCP server | `ctx.ui.confirm`, `select`, `input`; relayed to the client in RPC mode, unavailable in print and JSON modes |
| Start a turn in an idle session | `$.prompt.submit` | `codex queue --thread <id> --resume`, or `turn/start` through the app-server daemon | `pi.sendMessage(…, { triggerTurn: true })`, shown as the extension's own message |
| Know which session called | The hook runs in that session | `_meta.threadId` on every `tools/call` an MCP server receives | The extension runs in that session (`ctx.sessionManager.getSessionId()`) |
| Know the person wrote | The `prompt.submit` hook | `turn_trigger` in the turn metadata of a tool call | The `input` event, with its source |
| Add skills | The Skills mod lists served skills in Claude's skill listing ([Skills form](../polyfills/skills/claude-code/README.md)) | A plugin's skills folder, read when the plugin loads; `~/.agents/skills` | `resources_discover` returns skill folders, read at start and at `/reload` |
| Gate a tool call | Permission hooks that allow, deny or ask | Hooks that can deny, not ask | `tool_call` handlers that can block, and ask with `ctx.ui`, for the model's calls and codemode's nested calls |
| Add a server | `claude mcp add` | `codex mcp add` | `pi mcp add` (saved), `pi.registerMcpServer` (this session, connected at once) |
| Call a server's tool over the host's connection, with its sign-in | `$.mcp.call(server, tool, args)` | `mcpServer/tool/call` | Indirectly: an MCP tool is a Pi tool (`mcp__<server>__<tool>`), callable with `ctx.executeTool` |
| Ask whether the host would use a server | `$.mcp.connect(server)` | `mcpServerStatus/list` (start-up and sign-in state) | No. An extension reads `mcp.json` itself. |
| Read a resource over the host's connection | Only indirectly, by calling the built-in `ReadMcpResourceTool`. You get text or a saved file, without the resource's `_meta`. | `mcpServer/resource/read`, with `_meta` | Only indirectly, through Pi's `read_mcp_resource` tool, which leaves out `ui://` resources |
| Send any other MCP method | No | No. Codex's MCP client has a generic `send_custom_request`, but `app-server` doesn't expose it. | No. Pi's `McpClient` has `request(method, params)`, but the MCP extension doesn't expose its clients. |
| See what a server advertised | No | Mostly: capabilities (including `extensions`) and `serverInfo` are in `mcpServerStatus/list`. The negotiated protocol revision isn't. | No |
| Receive a server's notifications | No | Only from OpenAI's hosted apps server. `mcpServer/event/stream/*` refuses any other server. Elicitation requests are relayed. | No |
| See a tool's `_meta`, its `outputSchema`, or a result as the server sent it | No | Not checked yet | A result's `structuredContent` reaches `tool_result` hooks and codemode; a tool's `_meta` doesn't |
| Declare a client extension to servers | No | Only Codex's own client (the terminal or the desktop app) can, and its declaration goes to every server. A plugin or the config can't. | No. Pi's `McpClient` takes capabilities from its caller, but the MCP extension sets none for others. |
| Protocol revision of the host's own connection | 2026-07-28 back to 2024-11-05 | 2025-06-18 (2026-07-28 behind a feature flag that is off) | Up to 2025-11-25 |

Muse Code (Meta's terminal agent, checked at 1.4.25) is built like Codex: a
plugin brings MCP servers, skills and hooks shaped like Claude Code's, and its
own forms of these polyfills live in the Codex plugin folders. It has none of
the protocol rows above, and less of the host ones: its MCP client declares no
capabilities, and it gives plugins only a tool result's text. A server learns
its session from `MUSE_SESSION_ID`. A plugin can't start a turn by default.
And nothing a plugin does can put a question to the person, because a hook's
`ask` goes to Muse's approval judge, a model. Its lines are below, and
[AgentPolyfill in Muse Code](muse.md) has the details.

The row that matters most is "send any other MCP method". Because no host
has it, each polyfill that speaks an extension's protocol (Events, Skills,
Apps) opens a second connection to the server, built from your MCP settings.
That connection only has the headers written in your config. It can't use the
sign-in the host holds, so servers behind OAuth are out of reach, and a local
server ends up started twice.

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
  app-server method such as `mcpServer/request { threadId, server, method, params }`,
  behind `experimentalApi`, returning the raw result.
- **Pi** has the hard part too. Its MCP client (`McpClient.request()` in
  `pi-mcp`) sends any method, but the built-in MCP extension keeps its clients
  to itself. It could be `pi.getMcpServerSession(name)` in the extension API,
  provided by whichever extension connects MCP servers, as
  `pi.registerMcpServer` is today. It would return a handle whose
  `request(method, params)` goes over Pi's connection with Pi's sign-in, tells
  the caller the request's JSON-RPC id (push notifications are routed by it),
  takes per-request `Mcp-*` routing headers, and refuses `tools/call`, so
  tools stay on Pi's tool pipeline, where permission extensions see them.

This change alone brings servers behind OAuth to Events and Skills in Claude
Code and Codex, and to Skills in Pi, and removes their second connection.
Events in Pi also needs Pi's client to speak protocol revision 2026-07-28,
which SEP-3415 is defined for ([In Pi](#in-pi)).

### 2. Read what the server advertised

The server's capabilities, including `extensions`, and the protocol revision
the two sides agreed on. Extensions forbid a client from sending their methods
to a server that hasn't declared them, so a polyfill has to be able to check.

- **Claude Code:** missing.
- **Codex:** almost there. `mcpServerStatus/list` has the capabilities and
  `serverInfo`; adding the negotiated revision would finish it.
- **Pi:** missing. Its client already keeps the negotiated revision, the
  capabilities as the server sent them, and `serverInfo`; the session handle
  of change 1 could expose them.

### 3. Deliver a server's notifications to the plugin

Including notifications that arrive on the stream of a request the plugin
made. Events needs this for push delivery, and Apps for `list_changed` and
resource updates.

- **Claude Code:** missing.
- **Codex:** built, but for one server. `mcpServer/event/stream/start` and its
  notification work only for OpenAI's hosted apps server. Accepting any
  configured server, and forwarding a server's other notifications to a client
  that asked for them, would close it.
- **Pi:** missing. Its client has `onNotification(method, listener)`; the
  session handle could pass it on, and keep it across reconnects.

### 4. Raw tool results, and declaring a client extension

Hooks see a tool result the way the model reads it, but some extensions carry
their data in `structuredContent` and `_meta`. And some servers only offer a
feature to clients that declare its extension, which today only the host can
do.

- **Claude Code:** neither is possible.
- **Codex:** its own client can declare extensions; a plugin can't add to that
  list. Letting a plugin's manifest, or the config, add extension ids would
  close it. Raw results we haven't checked yet.
- **Pi:** a result's `structuredContent` already reaches `tool_result` hooks;
  a tool's `_meta` doesn't, and an extension can't add to the capabilities
  Pi's client declares. An extension id in an extension's package manifest,
  added to what Pi's client declares, would close the second.

## What each extension needs from them

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. What the server advertised | needed | needed | needed | the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, declaring an extension | not needed (declaring is optional) | not needed | both | not needed |

Changes 1 and 2 are enough for Events (by poll and webhook) and for Skills to
work with every server you've signed in to, in Claude Code and Codex. In Pi
they're enough for Skills; Events also needs Pi's client to speak 2026-07-28.

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

### In Pi

- **Speak protocol revision 2026-07-28.** SEP-3415 Events is defined for it
  and later only, so even with change 1 Events can't use Pi's connection
  while Pi's client stops at 2025-11-25. The Pi form falls back to its own
  connection, which can't use Pi's sign-in.
- **Say whether a tool name is taken.** `pi.registerTool` keeps the first
  tool registered under a name and drops a later one without a word. The ARD
  and Server Cards forms each name their add tool differently to work side
  by side. A warning, or a namespace per extension, would make a clash
  visible.
- **Let an extension's skills be turned off one by one.** Pi has a `skills`
  setting for paths, but nothing to switch off one skill an extension's
  `resources_discover` folder holds. The Skills form offers a server-level
  `skip` instead.
- **Re-read extension skill folders without a `/reload`.** Skills a server
  adds mid-session are listed only after `/reload`, since Pi reads skill
  folders at start. An event an extension can fire to have them read again
  would list them at once.
- **Mark a turn an extension started, to the model.** `pi.sendMessage` shows
  the message as the extension's own in Pi, but the model receives it in the
  user's turn, so the polyfill's first line has to say who sent it.
- **Give extensions the servers as Pi reads them.** An extension that reaches
  Pi's servers has to read `mcp.json` itself and repeat Pi's checks of each
  entry, and can tell whether Pi's MCP support runs in a session only from
  where the `/mcp` command comes from. A call that returns the entries Pi
  accepted for the session, or none when its MCP support is off, would
  replace both. With change 1 neither is needed.
- **Keep `ui://` resources and tool `_meta` for extensions.** Pi leaves out
  MCP Apps resources because it doesn't render them. An extension that
  renders them needs them, and the tool's `_meta.ui`; with change 1 it can
  read both itself.
- **Pi reads `~/.agents/skills` from `HOME`, whatever its agent directory.**
  Worth a line in Pi's docs: running Pi with its own agent directory
  (`PI_CODING_AGENT_DIR`) still lists the user's own skills.

### In Muse Code

- **Let a plugin ask the person.** Muse's MCP client offers no elicitation.
  A tool call that isn't read-only goes to the approval judge, a model that may
  approve it with nobody asked. A hook's `ask` goes there too, and the card,
  when there is one, names the tool, not its arguments or the hook's reason.
  Elicitation in the client, or a hook `ask` that always reaches the person and
  shows the reason, would let Skills, Server Cards and ARD ask as they do
  elsewhere. Today Skills takes a typed phrase, Server Cards and ARD hand the
  person a command to run, and ARD drops registry search.
- **A turn from outside.** The session-protocol terminal is behind two
  undocumented launch gates (`MUSE_EXPERIMENTAL_TUI_MSP_CLIENT`,
  `MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS`). With them on, any local process can
  attach and start turns, with no consent step. Turning it on by default with a
  consent step, or giving a session's own plugins a verified sender for
  `muse session-message send` (refused today as `sender_unverified`), would
  give Events real wake.
- **The four changes above, in Muse's session protocol.** A generic MCP request
  next to `mcpServer/readInventory`, the server's capabilities and
  notifications, and a tool result's `structuredContent` and `_meta` passed to
  hooks.
- **Pass a plugin's server the variables it names.** Muse starts plugin servers
  and hooks with a cleared environment, so a polyfill's settings and a server's
  header secrets can't reach them.
- **Start a plugin's server in the plugin's folder, or allow `cwd`.** Muse starts
  it in the session's workspace and refuses `cwd`. So a Codex-format plugin
  whose `.mcp.json` names `./dist/helper.js` closes at startup, with "the
  transport closed unexpectedly" and none of the server's output. Muse could
  also record a server's standard error.

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
- **Who may call, in Pi.** Every extension runs in Pi's process with the
  user's permissions, so a session API like change 1's doesn't create a new
  trust boundary. It does let any extension send other methods to any
  configured server with the user's sign-in, which a manifest-declared scope
  would narrow.

## What these changes don't cover

- **Events:** a public address for webhook delivery, and sessions that run
  when nobody is at the keyboard.
- **Apps:** what a terminal can draw and which input it passes on.
- **Hosts with no extension layer and no API like Codex's `app-server`**
  (ChatGPT is one). See the [README](../README.md#other-hosts).
