---
title: MCP Tasks
description: Run a long MCP tool in the background and return to it when it finishes or needs input.
---

# MCP Tasks

Start a tool on a configured MCP server, continue the conversation while it runs,
and return to the task when it finishes or needs your input. AgentPolyfill
implements the client side of [SEP-2663](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/seps/2663-tasks-extension.md)
for MCP revision 2026-07-28. The server also needs to advertise the extension.

## Install

### Codex

```sh
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-tasks@agent-polyfill
```

Requires Codex 0.172+ and Node 20+. For a local checkout, pass its path to
`codex plugin marketplace add`. [Codex setup and limits](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/codex).

### Pi

Install the AgentPolyfill Pi package, or install Tasks on its own from a clone.

```sh
pi install git:github.com/idosal/AgentPolyfill
# From a checkout, just Tasks
pi install ./polyfills/tasks/pi/extension
```

Requires Pi 1.6+ and Node 22+. [Pi setup and limits](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/pi).

### T3 Code with Pi

Install the Pi Tasks extension in the Pi profile that T3 Code uses and choose Pi
as the thread’s provider. T3 displays start approvals and task questions in its
composer. Keep the session open to receive the result in the same thread.
[T3 setup and walkthrough](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/t3).

### GitHub Copilot CLI

Experimental CLI 1.0.115 and 1.0.116 start and poll tasks natively. The plugin
stays idle unless you set `MCP_TASKS_FALLBACK=1` in a profile that needs it.

```sh
copilot plugin marketplace add idosal/AgentPolyfill
copilot plugin install mcp-tasks@agent-polyfill
copilot --experimental
```

Requires Copilot CLI 1.0.115+ and Node 20+. [Copilot setup and limits](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/copilot).

### OpenCode

For OpenCode 2.4.1+, add the absolute path of
`polyfills/tasks/opencode/plugin` from your checkout to the `plugins` array
in OpenCode's configuration. Open a terminal session or the project in Desktop (verified on 2.4.2).
[OpenCode setup and limits](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/opencode).

### Hermes

Enable the local `mcp-tasks` plugin and name its allowed servers. In the gateway,
use `/mcp-tasks servers` to discover them. Its viewer shows the complete start
request and asks you to confirm typed task answers.
[Hermes setup and limits](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/hermes).

## Try it

Ask which of your MCP servers can run tasks. If a server offers a task-capable
tool, ask the agent to start it and review the server, tool and arguments in
the approval dialog. You can check its status or cancel it with the task ID.

The plugin makes a separate connection to each eligible MCP server. That
connection cannot reuse your host's OAuth sign-in.
