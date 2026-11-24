# agent-polyfill

Installs every polyfill in the [AgentPolyfill](../../README.md) marketplace at
once. It holds no code of its own: it lists each polyfill as a dependency,
and Claude Code installs the dependencies from the same marketplace.

```
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

Today that is:

- `mcp-apps-cli`: MCP Apps, app UIs inline in the terminal
  ([README](../../polyfills/apps/claude-code/README.md)).
- `mcp-events`: MCP Events, Claude watches events on your MCP servers and
  reacts when they happen
  ([README](../../polyfills/events/claude-code/README.md)).
- `mcp-skills`: MCP Skills, skills served by your MCP servers are listed for
  Claude and loaded when a task needs one
  ([README](../../polyfills/skills/claude-code/README.md)).

Each polyfill is a plugin of its own, so you can disable or uninstall any of
them on its own, or install only the ones you want
(`/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill`).
