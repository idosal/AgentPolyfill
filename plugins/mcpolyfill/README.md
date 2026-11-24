# mcpolyfill

Installs every polyfill in the [MCPolyfill](../../README.md) marketplace at
once. It holds no code of its own: it lists each polyfill as a dependency,
and Claude Code installs the dependencies from the same marketplace.

```
/plugin install mcpolyfill --marketplace idosal/MCPolyfill
```

Today that is:

- `mcp-apps-cli`: MCP Apps, app UIs inline in the terminal
  ([README](../../polyfills/claude-code/apps/README.md)).
- `mcp-events`: MCP Events, Claude watches events on your MCP servers and
  reacts when they happen.

Each polyfill is a plugin of its own, so you can disable or uninstall any of
them on its own, or install only the ones you want
(`/plugin install mcp-apps-cli --marketplace idosal/MCPolyfill`).
