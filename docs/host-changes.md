# What hosts would need to change

Claude Code, Codex and OpenCode all let outside code extend them. That gets a
polyfill most of the way: it can add tools, react to what happens in a
session, and wake a session that has gone idle. What none of them lets a
plugin do is speak an extension's own protocol over the host's connection to a
server. This page explains that gap, the four small changes that would close
it in each host, and what each extension needs from them.

None of the changes names an extension. They are generic, and any future
extension would use them the same way.

We checked Claude Code against the mod API types in 2.1.330, Codex
against CLI 0.170.0 (its `app-server` protocol, as
`codex app-server generate-json-schema` prints it) and its source at
`rust-v0.172.0`, and OpenCode against the V2 plugin API of 2.4.1
(`@opencode/plugin`'s declarations, a running OpenCode, and its source on
`dev` at `b0cda20`).

## How a plugin plugs in today

The three hosts are built differently. In Claude Code, a mod is code that
runs inside the host and calls its API. In Codex, nothing third-party runs
inside the host: a plugin brings MCP servers, skills and hooks, and other
programs can drive Codex from outside through `app-server`, an experimental
JSON-RPC API. The Codex column names that API's methods. In OpenCode, a
plugin's server part runs inside the OpenCode server, once per project
folder, and calls its V2 plugin API (`ctx`); TUI and desktop parts draw in
the two clients.

| What a polyfill needs | Claude Code (a mod) | Codex (a plugin, or an app-server client) | OpenCode (a V2 server plugin) |
|---|---|---|---|
| Add tools the model can call | `$.tool.register` | An MCP server in the plugin, or `dynamicTools` for an app-server client | `ctx.tool.transform` |
| Draw its own UI | `ui.render` hooks | No. The desktop app shows a server's MCP App; nothing draws in the terminal. | TUI slots and routes (terminal text), and, experimentally, desktop panels with an embedded web view |
| Start a turn in an idle session | `$.prompt.submit` | `codex queue --thread <id> --resume`, or `turn/start` through the app-server daemon | `ctx.session.synthetic` with `resume: true`, stored as synthetic rather than the user's |
| Know which session called | The hook runs in that session | `_meta.threadId` on every `tools/call` an MCP server receives | The tool executor's `sessionID` |
| Ask the person | Claude Code's permission dialog, from a hook | MCP elicitation, from the plugin's MCP server | `ctx.permission.assert`, under OpenCode's permission rules, with actions a plugin names itself. OpenCode's default rule allows every action. |
| Call a server's tool over the host's connection, with its sign-in | `$.mcp.call(server, tool, args)` | `mcpServer/tool/call` | No |
| Ask whether the host would use a server | `$.mcp.connect(server)` | `mcpServerStatus/list` (start-up and sign-in state) | `ctx.mcp.list()` (connected, pending, disabled, failed, needs sign-in) |
| Read a resource over the host's connection | Only indirectly, by calling the built-in `ReadMcpResourceTool`. You get text or a saved file, without the resource's `_meta`. | `mcpServer/resource/read`, with `_meta` | No. The model's `opencode_read_mcp_resource` tool reads one; a plugin can only see that call (`ctx.tool.hook`). |
| Send any other MCP method | No | No. Codex's MCP client has a generic `send_custom_request`, but `app-server` doesn't expose it. | No |
| See what a server advertised | No | Mostly: capabilities (including `extensions`) and `serverInfo` are in `mcpServerStatus/list`. The negotiated protocol revision isn't. | No |
| Receive a server's notifications | No | Only from OpenAI's hosted apps server. `mcpServer/event/stream/*` refuses any other server. Elicitation requests are relayed. | No. OpenCode takes Events push notifications itself, for its automations; a plugin sees only OpenCode's own events (`mcp.tools.changed` and the like). |
| See a tool's `_meta`, its `outputSchema`, or a result as the server sent it | No | Not checked yet | Not checked yet |
| Declare a client extension to servers | No | Only Codex's own client (the terminal or the desktop app) can, and its declaration goes to every server. A plugin or the config can't. | No. OpenCode's own client declares Events to every server. |
| Add a server to the host's configuration | `claude mcp add` | `codex mcp add`, or `config/value/write` | `ctx.mcp.transform` (in memory; a plugin keeps what it added and adds it again on each load) |
| Add a skill | The hooks module adds served skills to Claude's skill listing | A `SKILL.md` in a skill folder, listed from the next turn | `ctx.skill.transform`, with no file, but with its text given up front |

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
- **OpenCode** has the hard part too: its MCP client already sends `events/*`
  for itself. It could be `ctx.mcp.request({ server, method, params })` beside
  `ctx.mcp.list`, on the connection OpenCode holds, with its sign-in.

This change alone brings servers behind OAuth to Events and Skills, in every
host, and removes their second connection.

### 2. Read what the server advertised

The server's capabilities, including `extensions`, and the protocol revision
the two sides agreed on. Extensions forbid a client from sending their methods
to a server that hasn't declared them, so a polyfill has to be able to check.

- **Claude Code:** missing.
- **Codex:** almost there. `mcpServerStatus/list` has the capabilities and
  `serverInfo`; adding the negotiated revision would finish it.
- **OpenCode:** missing. `ctx.mcp.list()` could carry the capabilities,
  `serverInfo` and the negotiated revision, which its client already keeps.

### 3. Deliver a server's notifications to the plugin

Including notifications that arrive on the stream of a request the plugin
made. Events needs this for push delivery, and Apps for `list_changed` and
resource updates.

- **Claude Code:** missing.
- **OpenCode:** missing for plugins. OpenCode's client handles Events push
  notifications itself; a `ctx.mcp` hook for a server's notifications (with
  those on a stream the plugin opened) would close it.
- **Codex:** built, but for one server. `mcpServer/event/stream/start` and its
  notification work only for OpenAI's hosted apps server. Accepting any
  configured server, and forwarding a server's other notifications to a client
  that asked for them, would close it.

### 4. Raw tool results, and declaring a client extension

Hooks see a tool result the way the model reads it, but some extensions carry
their data in `structuredContent` and `_meta`. And some servers only offer a
feature to clients that declare its extension, which today only the host can
do.

- **Claude Code:** neither is possible.
- **Codex:** its own client can declare extensions; a plugin can't add to that
  list. Letting a plugin's manifest, or the config, add extension ids would
  close it. Raw results we haven't checked yet.
- **OpenCode:** its own client declares Events; a plugin can't add an
  extension id. A field in a server's configuration, which a plugin's
  `ctx.mcp.transform` could set, would close it. Raw results we haven't
  checked yet.

## What each extension needs from them

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. What the server advertised | needed | needed | needed | the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, declaring an extension | not needed (declaring is optional) | not needed | both | not needed |

Changes 1 and 2 are enough for Events (by poll and webhook) and for Skills to
work with every server you've signed in to, in any of the hosts.

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

### In OpenCode

- **Let a plugin give its own permission actions a default.** OpenCode's
  default rule allows every action, so a plugin that asks with
  `ctx.permission.assert` reaches you only if you added an `ask` rule for its
  action. A default a plugin declares for actions it names (`ask` for
  `mcp_skills_load`), below every rule of yours, would make the Skills,
  Server Cards and ARD polyfills ask by default, as they do in the other
  hosts, and leave the decision with your rules.
- **Show a plugin's permission request as it was made.** The TUI shows a
  request for an action it doesn't know as "Call tool <action>", without its
  resources or metadata, so the person reads the model's call line above it
  instead (2.4.1, `packages/tui/src/util/permission.ts`). Showing the
  resources, and a `title` or `description` the plugin puts in the metadata,
  would let a person see the server, the skill's digest or the URL being
  approved.
- **Let a plugin show the person something the model doesn't see,** before
  they decide: a preview attached to a permission request, or the session
  forms OpenCode's client API has (`session.form.create`) offered to plugins.
  The Skills polyfill could then show a skill's `SKILL.md` before it loads.
- **Let a skill's text come at load time.** `ctx.skill.transform` takes a
  skill's text when the skill is listed. A plugin-supplied loader, run by
  OpenCode's `skill` tool when the skill is loaded, would let a served skill
  load in one step, after the plugin's question, with nothing fetched before.
- **Start a project's plugins when the server starts,** for projects with
  work waiting, or give a plugin a supported way to ask for that (as
  OpenCode's automations keep a project running). Today a project's plugins
  load when something uses that project, so Events watches resume only when
  the project is opened again.
- **Have the MCP configuration during setup.** While a project's plugins are
  set up, `ctx.mcp.transform`'s editor lists no servers yet; they appear once
  OpenCode applies its configuration (`mcp.status.changed`). Applying it
  before plugin setup, or documenting that event as the signal, would remove
  the wait.
- **Poll and webhook delivery in OpenCode's own Events client.** It takes push
  only. With poll and webhook too, the Events polyfill could stand down
  entirely, and every event type would go through automations.
- **Mark synthetic messages to the model.** A synthetic message is stored as
  synthetic, but reaches the model in the user's role, so the polyfill's own
  first line is what says it isn't the user's.
- **Show MCP Apps.** OpenCode's client has no MCP Apps support. The desktop
  app's experimental panels can embed a web view, but a plugin can't read a
  `ui://` resource or a tool's `_meta` over OpenCode's connection, and there
  is no place to draw in the conversation itself (a tool-result renderer).

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
- **Hosts with no extension layer and no API like Codex's `app-server`
  or OpenCode's plugins**
  (ChatGPT is one). See the [README](../README.md#other-hosts).
