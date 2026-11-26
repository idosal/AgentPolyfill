---
description: What makes something a polyfill, how the polyfills plug into each host (Claude Code, Codex, Pi, OpenCode, Antigravity, Copilot CLI, Hermes Agent), where they stop, and the four generic host changes that would remove the limits in each.
---

# How it works

## What makes something a polyfill

1. It implements one published extension, client side, and nothing else: no
   extra protocol and no vendor additions. The extension is an MCP extension,
   or a spec for agents published outside MCP, such as ARD, and is labelled
   as that. The one exception is an earlier form of the same extension that
   servers still speak, listed in the polyfill's README and switched off with
   one setting.
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

For rule 4, no polyfill can detect native support on its own yet, because no
host tells a plugin which extensions its own MCP client supports. So when your
host ships one of these extensions, turn that polyfill off:

- **Claude Code:** disable its plugin (`/plugin disable mcp-events`), or use
  its own setting (`MCP_EVENTS_OFF=1`, or `disabled` in `/config` for Server
  Cards and ARD). Skills was the first case: Claude Code ships it itself now,
  in beta, so [that form was removed](./skills#claude-code).
- **Codex:** remove the plugin
  (`codex plugin remove mcp-events@agent-polyfill`).
- **Pi:** `pi remove git:github.com/idosal/AgentPolyfill` removes Events,
  Skills and Server Cards together and Pi's copy of the repository. For a
  local install, use `pi remove ./polyfills/<form>/pi/extension` from the
  same clone (`events`, `skills`, `server-cards` or `ard`). To turn off one
  form, use its own setting (`MCP_EVENTS_OFF=1`,
  `MCP_SKILLS_OFF=1`, `MCP_SERVER_CARDS_DISABLED=1`, `ARD_DISCOVERY_DISABLED=1`).
- **OpenCode:** remove the plugin (`opencode plugin remove` with the text you
  added it with), or use its own setting (`MCP_EVENTS_OFF=1`,
  `MCP_SKILLS_OFF=1`, `MCP_SERVER_CARDS_DISABLED=1`, `ARD_DISCOVERY_DISABLED=1`,
  or the plugin option `off`).
- **Antigravity:** disable or uninstall the plugin
  (`agy plugin disable mcp-events`), or use its own setting
  (`MCP_EVENTS_OFF=1`, `MCP_SKILLS_DISABLED=1`, `MCP_SERVER_CARDS_DISABLED=1`,
  `ARD_DISCOVERY_DISABLED=1`).
- **Copilot CLI:** disable or uninstall the plugin
  (`copilot plugin disable mcp-events@agent-polyfill`), or use its own
  setting (`MCP_EVENTS_OFF=1`, `MCP_SERVER_CARDS_DISABLED=1`,
  `ARD_DISCOVERY_DISABLED=1`).
- **Hermes:** disable the plugin with `hermes plugins disable <plugin id>`.
  Events already leaves servers with `events: true` to Hermes's own webhook
  delivery, from the next turn after the setting changes.

[Getting started](./getting-started#turning-one-off) has the full list.

Events in OpenCode departs from rule 4. OpenCode's own client takes push
events for its automations, but it doesn't poll or take webhooks, it skips
event types whose schemas it can't check, and a plugin can't ask which ones
it took. So the polyfill watches every event type, push included, and tells
the model to use a watch or an automation for an event type, not both. Its
[README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/README.md#push-and-opencodes-automations)
says why.

## How it works in each host, and where it stops

Each host lets outside code in, in its own way.

- **Claude Code** runs mods inside the host (on by default since 2.1.287). A
  mod can register tools, draw UI, start a turn in an idle session, and call a
  server's tools over Claude Code's own connection.
- **Codex** runs plugins that bring their own MCP server. Every tool call the
  server receives says which session it came from, `codex queue --resume`
  starts a turn in an idle session from outside, and Codex lists the skills a
  plugin's folder holds alongside its own.
- **Pi** loads extensions into its own process. An extension can register
  tools, ask the person in a dialog, block or ask about a tool call (codemode's
  nested calls too), start a turn in an idle session with a message of its
  own, and hand Pi folders of skills to list.
- **OpenCode** runs plugins inside its own server, once per project folder
  (the V2 plugin API, from 2.4). A plugin can add tools, ask through
  OpenCode's permission rules, start a turn in an idle session, add skills to
  OpenCode's list and servers to its MCP servers, and see a tool call before
  it runs.
- **Antigravity** runs plugins that bring their own MCP server and hooks, in
  its App and CLI (`agy`). A `PreToolUse` hook can ask the person in
  Antigravity's approval card, and pass the conversation id to the call,
  which the MCP server isn't told itself. In the App, a plugin's sidecar can
  start a turn in an idle conversation with `agentapi send-message`. The IDE
  documents no plugin hooks, so the forms aren't supported there, and their
  gated calls are refused.
- **GitHub Copilot CLI** runs plugins with MCP servers, and, in experimental
  mode, extensions: a process that joins the session, registers tools, starts
  a turn with `session.send`, opens dialogs, and calls a server's tools or
  reads its resources over Copilot's own connection. VS Code's Copilot harness
  runs the same runtime; Events was checked end to end there.
- **Hermes Agent** runs Python plugins inside the gateway. A plugin can
  register tools and skills, put a tool call to Hermes's own approval, start
  a turn with `ctx.inject_message`, and call a server's tools over Hermes's
  connection. Each form here starts a bundled Node helper for the client
  rules. Events adds poll and push and leaves webhook servers to Hermes.

That's the host half of almost any extension. The protocol half is missing in
each. No host lets a plugin send an extension's own methods, such as
`events/poll` or `skills/list`, over the host's connection, see everything a
server advertised, or receive a server's notifications. So Events, Skills and
Apps each open a second connection of their own, using the headers in your
config. That connection can't use the host's sign-in, which is why those
three can't reach servers behind OAuth, and a local server ends up started
twice.

Server Cards doesn't have this problem. A card is a public document, and the
server it describes goes into the host's own config, so the host connects it
with its own sign-in.

Four small, generic changes would remove the limit, in each host. None of
them names an extension:

| Change | Claude Code today | Codex today | Pi today | OpenCode today | Antigravity today | Copilot CLI today | Hermes today |
|---|---|---|---|---|---|---|---|
| Send any MCP method over the host's connection | missing | missing (its client can, internally) | missing (its client can, internally) | missing (its client sends `events/*` for itself) | missing | missing (tool calls and resource reads only) | missing (its client sends `events/*` for its webhook support) |
| Read what the server advertised | missing | mostly there | missing (its client keeps it) | missing (its client keeps it) | missing | missing (instructions only) | missing |
| Deliver a server's notifications to the plugin | missing | only for OpenAI's hosted apps server | missing | missing (its client takes Events push for its automations only) | missing (none documented) | `list_changed` only | missing |
| Raw tool results; declare a client extension | missing | declaring only by Codex's own client | structured results reach hooks; no tool `_meta`, no declaring | raw results not checked; declaring only by OpenCode's own client, for Events | missing; the App declares the Apps extension itself | raw tool results; declaring only by Copilot itself | `structuredContent` only; no declaring |

The first two are enough for Events (by poll and webhook) and Skills to work
with every server you've signed in to; in Pi, Events also needs Pi's own
client to speak protocol revision 2026-07-28. The rest of this page says what each
change would look like in each host, what each extension needs, and the
questions the changes raise.

## How a plugin plugs in today

The hosts are built differently. In Claude Code, a mod is code that runs
inside the host and calls its API. In Codex, nothing third-party runs inside
the host: a plugin brings MCP servers, skills and hooks, and other programs
can drive Codex from outside through `app-server`, an experimental JSON-RPC
API. The Codex column names that API's methods. In Pi, an extension is
TypeScript that Pi loads into its own process, and Pi's MCP support is itself
a built-in extension, which keeps its connections to itself. In OpenCode, a
plugin's server part runs inside the OpenCode server, once per project folder,
and calls its V2 plugin API (`ctx`); TUI and desktop parts draw in the two
clients. Antigravity is like Codex: a plugin brings MCP servers, skills, hooks
and rules, and in the desktop App, sidecars (background processes the App
runs for the plugin). Copilot runs an *extension* (`extension.mjs`, in a
plugin or a folder of your own) as a child process that joins the session
with `joinSession()` from `@github/copilot-sdk/extension`, which Copilot
provides. Extensions are experimental: they load only with `--experimental`.
The Copilot column names that SDK's calls. Hermes runs a Python plugin in
the gateway; its column names the plugin context and Hermes modules. T3 Code is different again: it
isn't a host plugins load into, but an app that runs Codex, Claude Code and
other agents (OpenCode among them)
for you, so most of its column is "through the agent", and that agent's
column then applies. What it adds of its own is a way to message a thread,
and the thread's id in the environment of the MCP servers Codex starts for
it.

| What a polyfill needs | Claude Code (a mod) | Codex (a plugin, or an app-server client) | Pi (an extension) | OpenCode (a V2 server plugin) | Antigravity (a plugin) | Copilot CLI (an extension, or an MCP server in a plugin) | Hermes Agent (a Python plugin) | T3 Code (an app that runs Codex, Claude Code and other agents; no plugins of its own) |
|---|---|---|---|---|---|---|---|---|
| Add tools the model can call | `$.tool.register` | An MCP server in the plugin, or `dynamicTools` for an app-server client | `pi.registerTool`. Tool names are shared by every extension, and the first one registered under a name wins. | `ctx.tool.transform`, in a namespace of the plugin's (the model sees `<namespace>_<name>`) | An MCP server in the plugin's `mcp_config.json` | `joinSession({ tools })`, or an MCP server in a plugin (not experimental) | `ctx.register_tool` (listed behind Tool Search by default) | Through the agent: a Codex plugin or MCP server, a Claude Code mod. T3 Code adds its own `t3-code` server to every thread. |
| Draw its own UI | `ui.render` hooks | No. The desktop app shows a server's MCP App; nothing draws in the terminal. | Yes: custom components, overlays, `pi.registerToolRenderer`, images (Kitty, iTerm2), and mouse input in its default fullscreen mode | TUI slots and routes (terminal text), and, experimentally, desktop panels with an embedded web view | Only as an MCP App: the App shows a server's views itself (v2.34.0 and later). The CLI and IDE show text. | MCP Apps turned on in VS Code's harness (from its source; not checked there); canvases in graphical hosts, per the SDK's types (not checked); nothing drawn in the terminal | Only in Desktop (`@hermes/plugin-sdk` panes). Elsewhere text, with `ctx.post_message`. | No. It shows a server's MCP App itself. A mod asking for its pane's focus ends the turn. |
| Ask the person | A permission hook that answers "ask" | MCP elicitation, from the plugin's MCP server | `ctx.ui.confirm`, `select`, `input`; relayed to the client in RPC mode, unavailable in print and JSON modes | `ctx.permission.assert`, under OpenCode's permission rules, with actions a plugin names itself. OpenCode's default rule allows every action; the polyfills turn that into `ask` for their own actions with an `evaluate` hook (`ctx.permission.hook`). | A `PreToolUse` hook that answers `force_ask`: Antigravity's approval card, yes or no. Its MCP client declares elicitation but cancels every request (checked). | An extension's `session.ui.select`, `confirm`, `input` (shown in the TUI, during a turn in VS Code; they throw where nobody can be asked); MCP elicitation from a plugin's MCP server, declined in `copilot -p`, even with `--yolo` | Hermes's own approval, from a `pre_tool_call` hook (`{"action": "approve", "message", "rule_key"}`): once, session, always or deny, on the session's surface, failing closed where nobody can answer. `ctx.ask_choice` is for slash commands only. | The agent's approvals, shown in the thread. An MCP elicitation only if T3 Code can answer it with Approve or Decline; any other form is cancelled unseen. |
| Start a turn in an idle session | `$.prompt.submit` | `codex queue --thread <id> --resume`, or `turn/start` through the app-server daemon | `pi.sendMessage(…, { triggerTurn: true })`, shown as the extension's own message | `ctx.session.synthetic` with `resume: true`, stored as synthetic rather than the user's | `agentapi send-message <conversation_id>`, from a plugin's sidecar, in the App only (checked). Sidecars are off until you turn each one on. | `session.send({ prompt, source: "automation-…" })`, marked as carrying no human authority. VS Code's harness shows such a turn only when it carries a `clientTurnId`, and then as a plain message | `ctx.inject_message(text, session_key=…)`, once `allow_gateway_injection` is granted | `t3 thread send <thread> -`, on the machine it runs on, with no sign-in. `codex queue` reaches T3 Code's app server, but the thread doesn't show the turn. |
| Know which session called | The hook runs in that session | `_meta.threadId` on every `tools/call` an MCP server receives | The extension runs in that session (`ctx.sessionManager.getSessionId()`) | The tool executor's `sessionID` | Not for an MCP server. Hooks get `conversationId`, and a `PreToolUse` hook can add it to the call's arguments (`overwrite`). | The extension joins one session (`SESSION_ID`); a tool handler gets `sessionId` | A tool handler gets `session_id`; the session key is `HERMES_SESSION_KEY` (`get_session_env`) | `T3CODE_THREAD_ID` in the environment of Codex's stdio MCP servers (not documented); not set for Claude Code's |
| Know the person wrote | The `prompt.submit` hook | `turn_trigger` in the turn metadata of a tool call | The `input` event, with its source | `ctx.session.hook('prompt')`, which a synthetic message doesn't run | Partly: hooks get `lastUserInput`; a sidecar's message arrives as a system message, not as the person's (checked) | A `user.message` session event with no `source`; a turn an extension starts carries its own | Not directly: `pre_llm_call` sees each turn's message but not who started it, so a plugin's own injected turn and another plugin's look like typed input | No: Codex's turn metadata has no `turn_trigger` there |
| Add skills | A mod can add to the text of the session's skill listing (`prompt.attachment`), as the Skills mod did before it was removed. From 2.1.332 Claude Code lists skills from MCP servers itself, in beta ([changelog](https://code.claude.com/docs/en/changelog)). | A plugin's skills folder, read when the plugin loads; `~/.agents/skills` | `resources_discover` returns skill folders, read at start and at `/reload` | `ctx.skill.transform`, with no file, but with the skill's text given when it is listed | A plugin's `skills/` (read-only, replaced on update); `~/.gemini/config/skills/`, documented as read again before each turn (not checked) | A plugin's `skills` folder; skills an MCP server serves, natively (SEP-2640, declared to every server in 1.0.115's `initialize`; no served skill was listed or loaded) | `ctx.register_skill(name, path)`, listed from the next session when added while Hermes runs | Through the agent; it lists the agent's skills in its composer |
| Gate a tool call | Permission hooks that allow, deny or ask | Hooks that can deny, not ask | `tool_call` handlers that can block, and ask with `ctx.ui`, for the model's calls and codemode's nested calls | `ctx.tool.hook('execute.before')`, which can refuse a call or put it to the permission rules first, for the model's calls and Code Mode's | `PreToolUse` hooks that allow, deny, ask or `force_ask`, and rewrite arguments (`overwrite`). A lazily loaded MCP tool, the default, is seen as `call_mcp_tool`, whatever its server; an eager one as `mcp_<server>_<tool>` (checked). In CLI 1.5.17 a `PreToolUse` hook that fails makes the call fail, and a `force_ask` on the built-in `read_resource` is ignored. | In its default mode, Copilot CLI 1.0.115 asks before each tool call, read-only ones included; VS Code's Copilot harness ran a read-only tool without asking. Assisted mode (an LLM review, which an organisation can make the default) or allow-all approve without the person. An extension's `onPreToolUse` hook can allow, deny or ask (after the elevated-permission question) | `pre_tool_call` can block a call or put it to Hermes's approval, for any tool, the host's own and other plugins' included | Through the agent |
| Add a server | `claude mcp add` | `codex mcp add` | `pi mcp add` (saved), `pi.registerMcpServer` (this session, connected at once) | `ctx.mcp.transform` (in memory; a plugin keeps what it added and adds it again on each load) | `agy mcp add` and `agy mcp remove` (in CLI 1.5.17's own help, not in Antigravity's docs); the App ships no `agy`, so a plugin edits `~/.gemini/config/mcp_config.json` | `copilot mcp add` (saved to `mcp-config.json`), connected after `/mcp reload` or in the next session; an extension can call `session.rpc.mcp.reload` | No `ctx` API. A plugin writes `mcp_servers` in `config.yaml` (`hermes_cli.config`) and Hermes connects it after `/reload-mcp` | Through the agent (`codex mcp add`, `claude mcp add`), then **Restart agent session** |
| Call a server's tool over the host's connection, with its sign-in | `$.mcp.call(server, tool, args)` | `mcpServer/tool/call` | Indirectly: an MCP tool is a Pi tool (`mcp__<server>__<tool>`), callable with `ctx.executeTool` | No | No. Only an MCP App view can call its own server's tools. | `session.rpc.mcp.callTool({ serverName, toolName, arguments })` (experimental) | `ctx.call_mcp(server, tool, args)`, for servers in the plugin's `mcp_allowlist` | Only through the agent (a Claude Code mod's `$.mcp.call`) |
| Ask whether the host would use a server | `$.mcp.connect(server)` | `mcpServerStatus/list` (start-up and sign-in state) | No. An extension reads `mcp.json` itself. | `ctx.mcp.list()` (connected, pending, disabled, failed, needs sign-in) | No | `session.rpc.mcp.listConfigured()` (enabled after trust and policy) and `list()` (status). Not how to reach it | No. A plugin reads `mcp_servers` from `config.yaml`; the reader that renders it as Hermes's client sees it is internal. | No |
| Read a resource over the host's connection | Only indirectly, by calling the built-in `ReadMcpResourceTool`. You get text or a saved file, without the resource's `_meta`. | `mcpServer/resource/read`, with `_meta` | Only indirectly, through Pi's `read_mcp_resource` tool, which leaves out `ui://` resources | No. The model's `opencode_read_mcp_resource` tool reads one; a plugin can only see that call (`ctx.tool.hook`). | No. An App view reads `antigravity-file://` only. | `session.rpc.mcp.resources.read`, `list`, `listTemplates`; `prompts.list`, `get` | Only indirectly, with `ctx.dispatch_tool("mcp__<server>__read_resource", …)`: model-shaped text | No (it reads an MCP App's `ui://` resource itself) |
| Send any other MCP method | No | No. Codex's MCP client has a generic `send_custom_request`, but `app-server` doesn't expose it. | No. Pi's `McpClient` has `request(method, params)`, but the MCP extension doesn't expose its clients. | No. OpenCode's client sends `events/*` for itself. | No | No. `session.mcp.externalClient.exchange` exists, but it's a private, internal transport | No. Hermes's own Events support sends `events/*` over its connection (`session.send_request`), but `ctx` doesn't expose it. | No |
| See what a server advertised | No | Mostly: capabilities (including `extensions`) and `serverInfo` are in `mcpServerStatus/list`. The negotiated protocol revision isn't. | No | No | No | No: `session.rpc.mcp.list` carries a server's status and `instructions` only | No. Held internally, and its MCP SDK drops an `events` capability while parsing. | No |
| Receive a server's notifications | No | Only from OpenAI's hosted apps server. `mcpServer/event/stream/*` refuses any other server. Elicitation requests are relayed. | No | No. OpenCode takes Events push notifications itself, for its automations; a plugin sees only OpenCode's own events (`mcp.tools.changed` and the like). | No. None are documented. | Only `tools`, `resources` and `prompts` `list_changed`, as session events. Elicitation requests are relayed | No. The client's handler is internal and handles `list_changed` only. Form elicitation is native. | No |
| See a tool's `_meta`, its `outputSchema`, or a result as the server sent it | No | Not checked yet | A result's `structuredContent` reaches `tool_result` hooks and codemode; a tool's `_meta` doesn't | Not checked yet | No. `PostToolUse` gets the call and any error, not the result. | `callTool` returns the MCP result; not checked for `_meta` on the model's own calls | Partly: `ctx.call_mcp` returns `structuredContent` | No (it reads `_meta.ui` itself, for MCP Apps) |
| Declare a client extension to servers | No | Only Codex's own client (the terminal or the desktop app) can, and its declaration goes to every server. A plugin or the config can't. | No. Pi's `McpClient` takes capabilities from its caller, but the MCP extension sets none for others. | No. OpenCode's own client declares Events to every server. | No. The App declares the Apps extension itself. | Only Copilot's own runtime (it declares Skills and Tasks to every server). A plugin can't | No: the client's capabilities come from its MCP SDK | No |
| Protocol revision of the host's own connection | 2026-07-28 back to 2024-11-05 | 2025-06-18 (2026-07-28 behind a feature flag that is off) | Up to 2025-11-25 | Not checked yet | Not checked yet | `server/discover` at 2026-07-28 first, then `initialize` at 2025-11-25 (checked in 1.0.115) | 2025-11-25 by handshake first; 2026-07-28 (`server/discover`) only for a server that refuses the handshake, or with `protocol: stateless` on the server | The agent's |

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
- The **Codex** MCP client can send any request
  (`send_custom_request`), but only Codex itself can use it. It could be an
  app-server method such as `mcpServer/request { threadId, server, method, params }`,
  behind `experimentalApi`, returning the raw result.
- The **Pi** MCP client (`McpClient.request()` in
  `pi-mcp`) sends any method, but the built-in MCP extension keeps its clients
  to itself. It could be `pi.getMcpServerSession(name)` in the extension API,
  provided by whichever extension connects MCP servers, as
  `pi.registerMcpServer` is today. It would return a handle whose
  `request(method, params)` goes over Pi's connection with Pi's sign-in, tells
  the caller the request's JSON-RPC id (push notifications are routed by it),
  takes per-request `Mcp-*` routing headers, and refuses `tools/call`, so
  tools stay on Pi's tool pipeline, where permission extensions see them.
- The **OpenCode** MCP client sends `events/*`
  for itself. It could be `ctx.mcp.request({ server, method, params })` beside
  `ctx.mcp.list`, on the connection OpenCode holds, with its sign-in.
- **Antigravity** has nothing like it. Its MCP client is closed, so this
  would be a new plugin API, for example a method a plugin's MCP server or
  sidecar can call.
- **Copilot** exposes two related methods: `session.rpc.mcp.callTool` and
  `resources.read` already go over Copilot's connection "with the existing
  server admission and tool permission checks". A
  `session.rpc.mcp.request({ serverName, method, params })` beside them,
  returning the raw result, would close it.
- **Hermes:** `ctx.call_mcp` calls tools, but a plugin can't send the
  `events/*` requests Hermes already uses for its own webhook delivery.
  A `ctx.mcp_request(server, method, params)` over the native client, behind
  the per-server `mcp_allowlist`, would let Events and Skills use it too.

This change alone brings servers behind OAuth to Events in Claude Code and
Copilot CLI, to Events and Skills in Codex and OpenCode, and to Skills in Pi,
and removes their second connection. In Hermes it would let Events and
Skills use the host's connection too, with capabilities and push notifications
covered by changes 2 and 3.
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
- **OpenCode:** missing. `ctx.mcp.list()` could carry the capabilities,
  `serverInfo` and the negotiated revision, which its client already keeps.
- **Antigravity:** missing.
- **Copilot:** `session.rpc.mcp.list` already has a `serverMetadata` per
  server, holding only `instructions`. Adding `capabilities`, `serverInfo` and
  the revision there would close it.
- **Hermes:** a plugin can't see the server's capabilities, and Hermes's
  SDK drops an `events` capability while parsing. A
  `ctx.mcp_server_info(server)` with capabilities, extensions and the
  negotiated revision would close this gap.

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
- **OpenCode:** missing for plugins. OpenCode's client handles Events push
  notifications itself; a `ctx.mcp` hook for a server's notifications (with
  those on a stream the plugin opened) would close it.
- **Antigravity:** missing, and its MCP client documents no notifications at
  all.
- **Copilot:** the three `list_changed` notifications already reach
  `session.on(...)`. A `session.on("mcp.notification")` for the rest would
  close it.
- **Hermes:** a plugin receives no server notifications. Push needs the
  notifications on its `events/stream` request too; a callback per request,
  or `ctx.mcp_subscribe`, would supply them with change 1.

### 4. Raw tool results, and declaring a client extension

Hooks see a tool result the way the model reads it, but some extensions carry
their data in `structuredContent` and `_meta`. And some servers only offer a
feature to clients that declare its extension, which today only the host can
do.

- **Claude Code:** neither is possible.
- **Codex:** its own client can declare extensions; a plugin can't add to that
  list. Letting a plugin's manifest, or the config, add extension ids would
  close it. Raw results: not checked.
- **Pi:** a result's `structuredContent` already reaches `tool_result` hooks;
  a tool's `_meta` doesn't, and an extension can't add to the capabilities
  Pi's client declares. An extension id in an extension's package manifest,
  added to what Pi's client declares, would close the second.
- **OpenCode:** its own client declares Events; a plugin can't add an
  extension id. A field in a server's configuration, which a plugin's
  `ctx.mcp.transform` could set, would close it. Raw results: not
  checked.
- **Antigravity:** neither. Its App declares `io.modelcontextprotocol/ui`
  itself, and its `PostToolUse` hook gets no result.
- **Copilot:** the same: its runtime declares its own extensions (Skills and
  Tasks in 1.0.115) and a plugin can't add one. `callTool` returns the result
  as the server sent it.
- **Hermes:** `ctx.call_mcp` returns `structuredContent`. Plugins cannot
  declare a client extension; capabilities come from Hermes's MCP SDK.

## What each extension needs

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. What the server advertised | needed | needed | needed | the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, declaring an extension | not needed (declaring is optional) | not needed | both | not needed |

Changes 1 and 2 are enough for Events (by poll and webhook) and for Skills to
work with every server you've signed in to: Events in Claude Code and
Copilot CLI, and both in Codex and OpenCode. In Pi they're enough for Skills; Events also needs
Pi's client to speak 2026-07-28. In Hermes, poll and Skills need the native
request and capability calls; push also needs notifications on its request.
Webhook delivery is already Hermes's own.

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

### In OpenCode

- **Let a plugin give its own permission actions a default.** OpenCode's
  default rule allows every action, so a plugin that asks with
  `ctx.permission.assert` reaches you only if you added an `ask` rule for its
  action. The polyfills ask by default anyway, with an `evaluate` hook that
  turns `allow` into `ask` for their own actions, and follow OpenCode's
  permission events to keep an "Allow always". That hook can't tell
  OpenCode's default from an `allow` rule you wrote, and the plugin keeps a
  copy of each "Allow always" that OpenCode's own list doesn't know about,
  and has to check each request's session against its own project, since
  OpenCode sends every project's permission events to every project's plugins. A
  default a plugin declares for actions it names (`ask` for
  `mcp_skills_load`), below every rule of yours, would do the same with
  neither problem, and leave the decision with your rules.
- **Show a plugin's permission request as it was made, in the TUI.** The
  TUI shows a request for an action it doesn't know as "Call tool `<action>`",
  without its resources or metadata, so the person reads the model's call
  line above it instead (2.4.1, `packages/tui/src/util/permission.ts`). The
  desktop app already shows the resources. Showing them in the TUI too, and a
  `title` or `description` the plugin puts in the metadata in both, would let
  a person see the server, the skill's digest or the URL being approved.
- **Show synthetic messages in the desktop app.** The TUI shows one as an
  entry of its own (its `description`, such as `◈ mcp-events: new events`);
  the desktop app (2.4.1) shows nothing, so a turn an event started appears
  with no visible cause.
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
- **Every event type, and poll and webhook, in OpenCode's own Events client.**
  It takes push only, and skips an event type whose schemas it can't turn into
  a checker (`pattern`, `format` and the SEP's `x-mcp-content` are among what
  makes it skip a type). With every valid schema, poll and
  webhook, and a way to watch for a session, not only an automation, the
  Events polyfill could stand down entirely. Until then a plugin can't ask
  which event types OpenCode accepts (`opencode_list_mcp_events` is the
  model's tool), so the polyfill watches them all.
- **Mark synthetic messages to the model.** A synthetic message is stored as
  synthetic, but reaches the model in the user's role, so the polyfill's own
  first line is what says it isn't the user's.
- **Show MCP Apps.** OpenCode's client has no MCP Apps support. The desktop
  app's experimental panels can embed a web view, but a plugin can't read a
  `ui://` resource or a tool's `_meta` over OpenCode's connection, and there
  is no place to draw in the conversation itself (a tool-result renderer).

### In Antigravity

- **Tell a plugin's MCP server which conversation is calling.** Hooks get
  `conversationId`; an MCP server gets nothing. The polyfills pass it from a
  `PreToolUse` hook to the call through a one-use ticket. A `_meta` field on
  each `tools/call`, as Codex sends `threadId`, would make that unnecessary.
- **Support MCP elicitation,** so a server can ask you something in the
  host's own form. Antigravity's MCP client declares it (`form` and `url`)
  but answers every request with `cancel` without showing anything, in the
  App and the CLI (checked in App v2.35.1 and CLI v1.5.16). Today a polyfill
  asks through a `PreToolUse` hook that answers `force_ask`: a yes or no,
  with no other choices. A hook sees a lazily loaded MCP tool (the default)
  as Antigravity's own `call_mcp_tool`, whatever its server, so the
  polyfills make their gated tools eager, match only those names
  (`mcp_<server>_<tool>`), and refuse a gated call that comes through
  `call_mcp_tool`. A matcher on the server's name would let them stay lazy.
- **Honour a hook's `force_ask` on host tools.** In CLI 1.5.17 (its auto
  mode and its default mode, `request-review`) and App 2.35.1 (its Default
  preset), a `force_ask` on the built-in `read_resource` is ignored: no card,
  and the read goes ahead (checked). That is
  why the Skills polyfill can't meet SEP-2640's X8 in Antigravity.
- **Show a hook's whole question, and pass its `reason` to editors.** The
  App's approval card shows a `force_ask` hook's question; the CLI's shows
  its first two lines and hides the rest; `agy acp` sends an editor only the
  tool's name and arguments.
- **Run plugin hooks in the IDE.** Its hooks page lists workspace and global
  hooks only; the polyfills' approvals and Events delivery rest on a
  plugin's hooks, so the forms aren't supported there, and their gated calls
  are refused.
- **Document plugin `PreInvocation` hooks.** The plugins page lists
  `PreToolUse`, `PostToolUse`, `SessionStart` and `Stop` for plugins. A
  plugin's `PreInvocation` hook runs in CLI 1.5.17 (checked), and Events
  delivers at the next model call through it.
- **Let something other than a sidecar send a message to a conversation.**
  `agentapi send-message` is on a sidecar's `PATH`, in the App only, and
  sidecars are off until you turn each one on. The Conversation Management
  API of App v2.35.0 has no reference page yet. A documented way to post to
  a conversation from the CLI would let Events wake a CLI conversation.
- **Read `${VAR}` in `mcp_config.json`,** as a plugin's own file can for its
  declared `variables`. Then the Server Cards polyfill could add a server
  whose card needs an API key, without ever writing the key.
- **Add a server without editing the file,** from a plugin. CLI 1.5.17 has
  `agy mcp add` and `agy mcp remove` in its own help, not in Antigravity's
  docs, and the App doesn't ship `agy`.
- **Support SEP-2640 natively,** or let a plugin add skills somewhere other
  than your personal skills folder. A plugin's own folder is read-only and is
  replaced on update, so the Skills polyfill writes its entries into
  `~/.gemini/config/skills/`.

### In Copilot CLI

- **Take extensions out of experimental,** or let an MCP server in a plugin
  start a turn. Events needs `session.send`, which only an extension has, so
  it needs experimental mode, while Server Cards and ARD, which are MCP
  servers, don't.
- **Load extensions in ACP sessions.** An editor that drives Copilot over ACP
  (`copilot --acp`) gets no extensions in 1.0.115, so no Events there.
- **Let an extension declare a server's connection details,** or read them:
  `listConfigured` names the servers a session uses but not how to reach them,
  so a polyfill reads Copilot's files itself and can't see servers a plugin
  brings or `--additional-mcp-config` gives. Change 1 would make this moot.
- **Pass an extension the variables a server's `${VAR}` needs,** or let a
  plugin name them in its manifest. Copilot strips sensitive variables from
  extensions (rightly), and `requestedEnvironmentVariables` asks the person,
  so a server whose header names `${GITHUB_TOKEN}` is out of reach. Change 1
  would fix this too.
- **In VS Code's Copilot harness, mark an extension's automation turns as
  such.** A `session.send` with an `automation-…` source shows in the chat
  only when it carries a `clientTurnId`, and then looks like a message the
  person typed. Without the turn id it runs but isn't shown at all, so a
  woken session answers where nobody sees it. The Events polyfill sends one
  with every wake (checked in VS Code 1.147.0).
- **Let a tool ask the person in every mode.** Assisted mode (an LLM review,
  which an organisation can make the default) or allow-all approve calls
  without the person, and VS Code's Copilot harness runs read-only tools
  without asking (Copilot CLI 1.0.115 asked before them). A tool that starts something that runs later by itself, as an
  Events watch does, has to ask again in its own dialog. A tool flag for
  "always ask a person", honoured in every mode short of one you chose to
  allow everything, would put that question in Copilot's own prompt.
- **Let an MCP server ask Copilot to reload its servers.** A server added with
  `copilot mcp add` connects only after `/mcp reload` or in the next session.

### In Hermes

- **Mark a turn a plugin started.** `ctx.inject_message` puts the text in the
  conversation as the user's (another role only gets a `[role]` prefix), and
  hooks can't tell it from typed input. Hermes already marks the turns its
  gateway starts (`display_kind`); the same for a plugin's turn, and the
  turn's origin in `pre_llm_call`, would let Events tell a wake from the
  person writing without relying on a prefix.
- **Scope the injection grant.** `allow_gateway_injection` lets a plugin start
  turns in any session of its profile, chat apps included. A grant limited to
  sessions that called the plugin would be enough for Events.
- **A hook for the gateway starting.** In `register()` a plugin can't tell the
  gateway from a short `hermes` command, so Events resumes saved watches at the
  first session or turn, not when the gateway starts.
- **List skills added at runtime in open sessions.** A skill registered while
  Hermes runs is listed from the next session.
- **An approval with choices of its own,** for a tool. Skills' "show me its
  SKILL.md first" has no place in once / session / always / deny, so the
  question tells you to deny and type `/mcp-skills show`, a step of your own.
- **Add an MCP server and connect it from `ctx`.** Server Cards writes
  `config.yaml` with `hermes_cli.config`, then needs `/reload-mcp`.
- **Say whether approvals are bypassed.** With `--yolo`, `/yolo`, `hermes -z` or
  `approvals.mode: off`, Hermes answers a plugin's approval itself, so the
  forms refuse there each step that needs a person's yes: a watch, a skill
  load (rules X5 and X8), a registry search and a server addition.
  Telling that takes the test Hermes's approval gate uses
  (`tools.approval._yolo_active()`, which covers `hermes -z`, and
  `approval_context._get_approval_mode()`, with
  `tools.approval.is_approval_bypass_active_for_session` for the named
  session), none of it on Hermes's published
  plugin API, so where it can't be evaluated the forms refuse too. The
  approval mode in hook arguments, or a published call, would do.
- **A hook when the MCP configuration reloads.** The forms read `mcp_servers`
  again at each turn and tool call, so a change (`events: true`, a server
  removed) takes effect at the next turn, not at `/reload-mcp`.
- **List the MCP servers to a plugin.** No plugin call does. The forms read
  `mcp_servers` from `config.yaml` as written (`read_raw_config`) and leave
  alone an entry that takes `${VAR}` from `.env`, where Hermes keeps secrets.
  `ctx.mcp_request` (change 1) would make both unnecessary: the plugin names a
  server, and Hermes connects with its own configuration and secrets.

### In T3 Code

T3 Code passes MCP through to the agent it runs, so the four changes are the
agents' to make. These are T3 Code's own, and [T3 Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md)
has the details:

- **Show an MCP elicitation form as the server wrote it.** T3 Code shows a
  form only when it can answer it with Approve or Decline, and cancels any
  other without showing it (`CodexMcpElicitation.ts`). The confirmations of
  the Codex Skills, Server Cards and ARD forms ("Load it", "Add it", "Send the
  search") are cancelled that way, so those steps never happen in T3 Code.
  Showing a form's fields and returning what the person picks would fix it;
  at the least, a form it can't show should leave a notice in the thread.
- **Document `T3CODE_THREAD_ID`, and set it for every provider's MCP
  servers.** Codex's stdio servers get it; Claude Code's don't. It's how a
  server knows which thread it serves, which the T3 Events form needs; with
  it set for Claude Code, the same server would serve Claude Code threads.
- **Show a turn something else started.** A turn Codex starts from its own
  queue (as `codex queue` puts one there) runs in T3 Code's app server but
  doesn't appear in the thread. A turn a Claude Code mod starts in an idle
  session (`$.prompt.submit`) wasn't checked.
- **Let a mod's pane fail softly.** When a Claude Code mod asks for its
  pane's focus, T3 Code ends the turn. Answering the request as "nowhere to
  show it" would let the mod say so and carry on.

## Questions these changes raise

- **Permissions.** A general pipe could call `tools/call` and skip the host's
  permission rules. Either the pipe sends `tools/call` through the same checks
  as any tool call, or it refuses that method and tools stay on the path they
  use today.
- **Scope.** A plugin could declare in its manifest which extension it
  implements and which method prefixes it will send (`events/`, `skills/`).
  Then you see the grant when you install it, and the pipe isn't open-ended.
- **Credentials.** Requests use the host’s authenticated connection. Restrict that access
  to the servers and methods granted to the plugin.
- **Who may call, in Codex.** An app-server method is open to anything that
  can reach the socket, so a raw request there needs a per-plugin scope even
  more than an in-process API does.
- **Who may call, in Pi.** Every extension runs in Pi's process with the
  user's permissions, so a session API like change 1's doesn't create a new
  trust boundary. It does let any extension send other methods to any
  configured server with the user's sign-in, which a manifest-declared scope
  would narrow.
- **Who may call, in OpenCode.** Every plugin runs in OpenCode's server with
  the user's permissions, as in Pi, so change 1 creates no new trust
  boundary. It would let any plugin send other methods to any configured
  server with the user's sign-in, which a scope declared by the plugin would
  narrow.
- **Who may call, in Copilot.** An extension already gets an elevated-permission
  question before it may skip tool prompts or register hooks. A raw MCP pipe
  is the same kind of grant, and could be asked the same way, naming the
  method prefixes.

- **Grants, in Hermes.** `ctx.call_mcp` already uses a per-server
  `mcp_allowlist`. The same scope on a general request call would let
  Events and Skills use Hermes's connection without reading its secrets.

## What these changes don't cover

- **Events:** a public address for webhook delivery, and sessions that run
  when nobody is at the keyboard.
- **Apps:** what a terminal can draw and which input it passes on.
- **MCP Apps in Antigravity's CLI and IDE,** which show text only. The App
  supports MCP Apps itself, so there is no Apps polyfill for Antigravity.
- **Hosts with no extension layer and no API like Codex's `app-server`**
  (ChatGPT is one). See [Other hosts](#other-hosts).

This page follows
[`docs/host-changes.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/host-changes.md)
in the repository.

## Other hosts

We haven't found a documented way for third-party code to send requests over
the host's MCP connection in Cursor or in VS Code's own chat, and ChatGPT runs
no third-party code on the client side. (VS Code's Copilot harness is another
matter: it runs Copilot CLI's runtime, and the Copilot forms run there.) For those, the only polyfill would be a
gateway: an MCP server that presents an extension as plain tools. That's a
weaker form (for Events, the model would have to poll, and nothing would wake
it), and none is shipped here.
Bringing a polyfill to another host is
[welcome](./build-a-polyfill#an-existing-polyfill-in-another-host).
