# mcp-tasks core

The client side of MCP Tasks (SEP-2663, `io.modelcontextprotocol/tasks`, the
ext-tasks specification at revision 2026-07-28), shared by the Tasks polyfills.
Each host's form bundles it into its own plugin folder. Today there is one form:
[Codex](../codex/README.md).

| File | What it is |
|---|---|
| `src/connection.ts` | A connection of the polyfill's own to one server, on revision 2026-07-28, declaring the extension on every request. `tools/call` and `tasks/*` are framed here, because MCP SDK 2.4.0 rejects a task result; over Streamable HTTP they carry `Mcp-Name: <taskId>`. |
| `src/protocol.ts` | The wire shapes, and the checks made on everything a server sends. |
| `src/runner.ts` | Polls open tasks at the server's interval until each is terminal or cancelled, and says when a task finishes, vanishes, expires or asks for input. |
| `src/store.ts` | Each session's tasks on disk, private to the user. |
| `src/headers-helper.ts` | A server's `http_headers_helper`, run as Codex runs it. |
| `src/untrusted.ts` | How server text is shown, and secrets taken out of logs and answers. |
| `docs/client-rules.md` | Every MUST, SHOULD and MAY the extension puts on a client, with ids. |

Its tests run in the Codex form (`../codex/test/core-test.ts` and the rest).
