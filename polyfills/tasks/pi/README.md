# MCP Tasks for Pi

Run a configured MCP server's long tool call as a task. Pi asks before starting it, follows it while the session is open, and starts a follow-up turn when the task finishes or needs input.

Implements the client side of `io.modelcontextprotocol/tasks` ([SEP-2663](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/seps/2663-tasks-extension.md)) for [MCP 2026-07-28](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md). The [client rules and checks](docs/conformance.md) cover the shared protocol and the Pi adapter.

## Install

Requires Pi 1.6 and Node 22 or newer. From a checkout containing this extension:

```bash
pi install ./polyfills/tasks/pi/extension
```

For a single run, use `pi -e ./polyfills/tasks/pi/extension`. Keep the checkout while the local package is installed. Remove it from that checkout with `pi remove ./polyfills/tasks/pi/extension`.

## Use

Configure a Tasks-capable server in Pi's built-in MCP settings. Ask Pi which servers can run tasks, or use `list_task_servers`. `start_task` shows the server, tool and arguments for your approval. `get_task`, `get_task_result`, `provide_task_input`, and `cancel_task` act on a task from the current session. `list_tasks` shows the tasks belonging to that session.

The extension handles discovery, task-aware tool calls, polling, results and cancellation. It uses Pi's existing dialogs and session messages for approvals, in-task questions and wakes. It creates no dashboard, remote service, or automatic server configuration.

## Servers and limits

- The Tasks client opens a separate connection to an eligible Pi MCP server. Stdio servers run a second process. OAuth, Pi provider credentials and header command substitutions are unavailable on that connection.
- Pi must expose the tool through its callable MCP catalog. An approval shows the exact arguments on a separate connection. Pi's permissions for an ordinary call to the original tool do not run for that separate call.
- The extension polls. After a restart it resumes saved tasks when the session opens, and holds wakes until the person starts a turn. A closed session does not poll.
- In-task questions use Pi dialogs. The extension presents supported form schemas and validates the JSON entered by the person. Sampling, roots, URL forms, unsupported form fields and input before a task exists are outside this adapter's input surface.
- The real-host checks use Pi 1.6.0 with a stdio server and a separate FastMCP 4.2.6 server over Streamable HTTP. See the [verification status](docs/conformance.md) for RPC and terminal coverage.
- Set `MCP_TASKS_OFF=1` before starting Pi to disable registration and connections. Pi 1.6.0's public extension API does not expose native Tasks negotiation. Pi's `--no-mcp` also prevents this extension from connecting.
- The extension stores task state in `mcp-tasks/` in Pi's agent directory. Set `MCP_TASKS_STATE` to use another directory. Uninstalling leaves that state behind.

## Development

```bash
(cd ../core && npm ci)
(cd ../../events/pi && npm ci)
npm ci
npm run typecheck
npm run build
npm test
```

To run HTTP interop, install the hash-pinned dependencies in
[`../codex/test/interop/requirements.txt`](../codex/test/interop/requirements.txt)
into a Python environment, then run `MCP_TASKS_INTEROP_PYTHON=/path/to/python npm run interop`.

The installable bundle is in `extension/dist/index.js`. [Security and data handling](SECURITY.md) describes the separate connection and what is stored.
