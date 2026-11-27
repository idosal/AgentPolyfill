# MCP Tasks for OpenCode

Run a long tool on a configured MCP server and return to it when it completes
or asks for input. The plugin implements the client side of
[SEP-2663](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/seps/2663-tasks-extension.md)
at MCP revision 2026-07-28.

## Install

Requires OpenCode 2.4.1 or newer. Clone AgentPolyfill and add the full path to
the plugin folder to the `plugins` array in OpenCode's configuration.

```json
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/tasks/opencode/plugin"]
}
```

Open the project in the terminal or in OpenCode Desktop. For Desktop, the global
OpenCode configuration can load the plugin for every project. Remove the entry to uninstall.

## Use

Ask OpenCode which MCP servers offer Tasks. When it starts a task, the
active frontend shows the server, tool and arguments before the approval choice.
The session gets a follow-up when the task completes or needs input. When a
task asks for input, answer in the dialog using the displayed JSON fields.

- Approval or input needs a terminal or a focused Desktop window displaying the exact session. Desktop uses its experimental GUI plugin entry point and native confirm and text dialogs. Switching sessions invalidates a pending answer. A disconnected frontend leaves the question unanswered.
- The tool shows text and text resources. Binary result blocks are omitted.
- The plugin uses a separate connection to an enabled MCP server and does
  not read OpenCode's stored sign-in. Stdio servers run a second process.
  Reload the plugin after adding or changing an MCP server.
- Set `MCP_TASKS_OFF=1` before starting OpenCode to disable Tasks in the
  plugin. Task state lives under `opencode/mcp-tasks/` in the XDG state
  directory, with a separate folder for each location.

## Verification

The shared protocol and FastMCP checks are listed in the
[client conformance table](../codex/docs/conformance.md). The OpenCode
integration test uses a pinned OpenCode server and an isolated tool fixture.
It checks the exact question, one-time session-scoped replies, decline, wake,
and the structured answer received by the server. The real 2.4.1 terminal
also exercised decline, approval, wake, and a typed answer that reached the
server in `tasks/update`. Desktop 2.4.2 also exercised decline, approval,
notification, a typed JSON answer and the final greeting in the original thread. Run `npm ci` in
`../core`, `../../../tools/opencode` and here, then `npm run typecheck`,
`npm run build` and `npm test`.
