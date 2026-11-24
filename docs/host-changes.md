# What a host needs to expose

A host that lets third-party code extend it is most of the way to letting
that code add MCP extensions. This page describes the remaining gap in two
hosts, Claude Code and OpenAI Codex, and four generic changes that would close
it.

It was written against:
- for Claude Code, the mod API types for Claude Code 2.1.330;
- for Codex, the CLI 0.170.0 (its `app-server` protocol, as `codex app-server generate-json-schema` prints it) and the source at `rust-v0.172.0`.

## What a plugin can do today

In Claude Code, a mod's code runs inside the host. Codex runs no third-party code inside it. A Codex plugin brings MCP servers, skills and hooks, and the host can be driven from outside through `app-server`, a JSON-RPC API (experimental). The Codex column names that API's methods.

| Need | Claude Code (a mod) | Codex (a plugin, or an app-server client) |
|---|---|---|
| Add tools the model can call | `$.tool.register` | An MCP server in the plugin; or `dynamicTools` for an app-server client |
| Draw UI | `ui.render` hooks | No. The desktop app shows a server's MCP App; nothing draws in the terminal. |
| Start a turn in an idle session | `$.prompt.submit` | `codex queue --thread <id> --resume`, or `turn/start`, through the app-server daemon |
| Know which session called | the hook's own session | `_meta.threadId` on every `tools/call` to an MCP server |
| Call a server's tool over the host's connection, with its sign-in | `$.mcp.call(server, tool, args)` | `mcpServer/tool/call` |
| Ask whether the host would use a server | `$.mcp.connect(server)` returns its verdict | `mcpServerStatus/list` (start-up and sign-in state) |
| Read a resource over the host's connection | Indirectly: `$.tool.call` on the built-in `ReadMcpResourceTool`. Text or a saved file, without the resource's `_meta`. | `mcpServer/resource/read`, with `_meta` |
| Send any other MCP method | No | No. The MCP client has a generic `send_custom_request`, but app-server doesn't expose it. |
| See a server's capabilities or the negotiated revision | No | Capabilities (with `extensions`) and `serverInfo`: yes, in `mcpServerStatus/list`. The negotiated revision: not shown. |
| Receive a server's notifications | No | Only from OpenAI's hosted apps server: `mcpServer/event/stream/*` refuses any other ("only supported for hosted apps"). Elicitation requests are relayed (`mcpServer/elicitation/request`). |
| See a tool's `_meta` or `outputSchema`, or a tool result as the server sent it | No | Not checked |
| Declare a client extension to servers | No | Only the app-server's own client (the terminal or desktop app) can, in `initialize`'s `extensions`, which go to every server. A plugin or the config can't. |

Because of the "any other MCP method" row, each polyfill on either host opens a
second connection to the server, configured from the user's MCP settings. That
connection has only the headers in the config. It cannot use the sign-in the
host holds, so servers behind OAuth are out of reach, and a local server is
started twice.

## The four changes

**1. Send any MCP method over the host's connection.**
`$.mcp.request(server, method, params)` returns the raw result. The host does
not need to understand the method; a connection already carries any method
name. The transport sets the standard routing headers for the method, or
accepts them from the caller.

**2. Read what the server advertised.**
The server's capabilities, including `extensions`, and the negotiated protocol
revision. Extensions forbid a client from sending their methods to a server
that has not declared them, so a polyfill has to be able to check.

**3. Deliver server notifications to the plugin.**
Including notifications that arrive on the stream of a request the plugin made.

**4. Raw tool results in hooks, and a way to declare a client extension.**
Hooks see a tool result as the model reads it; some extensions carry data in
`structuredContent` and `_meta`. And some servers offer a feature only to
clients that declare its extension, which today only the host can do.

## What each extension needs

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. Server capabilities | needed | needed | needed | needed: the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, client extension | not needed (declaring is optional) | not needed | both needed | not needed |

Changes 1 and 2 are enough for Events by poll and webhook, and for Skills, on
every server the user has signed in to. With them, the second connection in
those polyfills is deleted.

Server Cards need none of the four to work: a card is a public document read
before any connection, and the server is then added to the host's own
configuration, so the host connects it with its own sign-in. Changes 1 and 2
are only for the spec's SHOULD to check a card against the live server.

## Where Codex stands on the four

Codex already has change 2 and half of change 4, and changes 1 and 3 sit on code it already has.

| Change | Codex today | What would close it |
|---|---|---|
| 1. Any method | Missing. `mcpServer/tool/call` and `mcpServer/resource/read` exist; the client's `send_custom_request(method, params)` is internal. | An app-server method, `mcpServer/request { threadId, server, method, params }`, behind `experimentalApi`, returning the raw result. **This alone brings OAuth servers to the Events and Skills polyfills.** |
| 2. Server capabilities | Present (`mcpServerStatus/list`), apart from the negotiated revision. | Add the negotiated revision. |
| 3. Notifications | Built for one server. `mcpServer/event/stream/start` (`threadId`, `server`, `subscriptionId`, `name`, `arguments`) and its notification work for OpenAI's hosted apps server only. | Accept any configured server. Also forward a server's other notifications (`list_changed`, resource updates) to a client that subscribed. |
| 4. Raw results; declare an extension | Declaring works for the app-server's own client only. | Let a plugin's manifest, or the config, add extension ids to what Codex declares. |

Smaller things that would help on Codex:
- **Scoped access to the daemon.** Today any local process that can reach the app-server daemon's socket can drive every session. A plugin should get a scope: its own threads, its own servers.
- **Plugin hooks outside the desktop app.** A plugin's hooks run only when it was installed by hand in the desktop app.
- **SEP-2640 natively** (`openai/codex` issue #48000), or skills a program can add without writing files (`skills/extraRoots/set` takes folders).
- **The approval mode in each tool call's metadata.** Put the approval policy and reviewer, and whether approvals are bypassed, in `x-codex-turn-metadata`. Then an MCP server can tell a form Codex answered itself (under `--dangerously-bypass-approvals-and-sandbox` it accepts every elicitation) from one a person answered.
- **Headers in `codex mcp add`.** Add `--header` and `--env-header`, and a way to add a server without starting its sign-in, so a plugin can add any remote a Server Card describes without writing the config itself.
- **MCP Apps in the terminal.** `enable_mcp_apps` passes the extension on only where the host declares it, and the terminal doesn't. No plugin can supply this.
- **Start a resumed session's plugin MCP servers when it opens**, as for a new session. Today they start at the first tool call, so the Events polyfill's watches for a resumed session wait for one.
- **Mark a turn started from outside.** `codex queue` input arrives as an input message; a turn an extension starts should reach the model and the UI marked as the extension's, not the person's.

## Questions these changes raise

- **Permissions for a raw `tools/call`.** A general pipe could call a tool
  without the host's permission rules. Either the pipe routes `tools/call`
  through the same checks as a normal tool call, or it refuses that method and
  tools stay on the existing path.
- **Scope.** A plugin could declare in its manifest the extension it
  implements and the method prefixes it will send (`events/`, `skills/`), so
  the grant is visible when the plugin is installed and the pipe is not
  open-ended.
- **Credentials.** The request goes out with the user's sign-in. That is the
  point, and it is also why the scope above matters.
- **On Codex, who may call.** An app-server method is open to whatever can
  reach the socket. A raw request there needs the per-plugin scope above more
  than an in-process API does.

## What these changes do not cover

- Events: a public address for webhook delivery, and sessions that run when
  nobody is at the keyboard.
- Apps: terminal input and drawing limits.
- Anything on hosts with neither an in-process extension layer nor an API
  like Codex's `app-server` (ChatGPT, for one). See the README.
