# What a host needs to expose

A host that lets third-party code run inside it is most of the way to letting
that code add MCP extensions. This page describes the remaining gap in Claude
Code, and four generic changes that would close it. It was written against the
mod API types for Claude Code 2.1.330.

## What a mod can do today

| Need | Today |
|---|---|
| Add tools the model can call | `$.tool.register` |
| Draw UI | `ui.render` hooks |
| Start a turn in an idle session | `$.prompt.submit` |
| Call a server's tool over Claude Code's connection, with its sign-in | `$.mcp.call(server, tool, args)` |
| Ask whether Claude Code would use a server | `$.mcp.connect(server)` returns its verdict |
| Read a resource over Claude Code's connection | Indirectly: `$.tool.call` on the built-in `ReadMcpResourceTool`. Text or a saved file, without the resource's `_meta`. |
| Send any other MCP method | No |
| See a server's capabilities or the negotiated revision | No |
| Receive a server's notifications | No |
| See a tool's `_meta` or `outputSchema`, or a tool result as the server sent it | No |

Because of the last four rows, each polyfill opens a second connection to the
server, configured from the user's MCP settings. That connection has only the
headers in the config. It cannot use the sign-in Claude Code holds, so servers
behind OAuth are out of reach, and a local server is started twice.

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

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps |
|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools |
| 2. Server capabilities | needed | needed | needed |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates |
| 4. Raw results, client extension | not needed (declaring is optional) | not needed | both needed |

Changes 1 and 2 are enough for Events by poll and webhook, and for Skills, on
every server the user has signed in to. With them, the second connection in
those polyfills is deleted.

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

## What these changes do not cover

- Events: a public address for webhook delivery, and sessions that run when
  nobody is at the keyboard.
- Apps: terminal input and drawing limits.
- Anything on hosts with no in-process extension layer. See the README.
