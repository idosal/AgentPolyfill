# agent-polyfill

Install the Claude Code plugin bundle, then start a new session:

```text
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

- [`mcp-apps-cli`](../../polyfills/apps/claude-code/) — Render interactive MCP Apps in the terminal.
- [`mcp-events`](../../polyfills/events/claude-code/) — Watch and receive MCP events.
- [`mcp-server-cards`](../../polyfills/server-cards/claude-code/) — Discover and add MCP servers by domain.

Each plugin can also be installed or disabled individually.
[ARD discovery](../../polyfills/ard/claude-code/) is installed separately.

## Upgrading from 0.2.0

Claude Code supports MCP Skills natively from 2.1.332 (beta). Version 0.3.0
removed `mcp-skills` from the bundle. Check `/plugin` after updating. If the old
plugin is still installed, run `/plugin uninstall mcp-skills@agent-polyfill`.
See [migration and local data cleanup](../../polyfills/claude-code/skills/README.md).
