# agent-polyfill

Installs every MCP polyfill in the [AgentPolyfill](../../README.md)
marketplace for Claude Code at once. It holds no code of its own: it lists
each polyfill as a dependency, and Claude Code installs the dependencies from
the same marketplace.

```
/plugin install agent-polyfill --marketplace idosal/AgentPolyfill
```

Today that is:

- `mcp-apps-cli`: MCP Apps, app UIs inline in the terminal
  ([README](../../polyfills/apps/claude-code/README.md)).
- `mcp-events`: MCP Events, Claude watches events on your MCP servers and
  reacts when they happen
  ([README](../../polyfills/events/claude-code/README.md)).
- `mcp-server-cards`: MCP Server Cards, Claude finds the MCP servers a domain
  publishes and adds the one you pick
  ([README](../../polyfills/server-cards/claude-code/README.md)).

Each polyfill is a plugin of its own, so you can disable or uninstall any of
them on its own, or install only the ones you want
(`/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill`).

## Skills is no longer in the bundle

Up to version 0.2.0 the bundle also installed `mcp-skills`. From 0.3.0 it
doesn't, and the marketplace no longer lists it: Claude Code lists skills from
MCP servers itself, in beta from 2.1.332
([changelog](https://code.claude.com/docs/en/changelog)).

If you installed it before, by name or through this bundle, remove it with
`/plugin uninstall mcp-skills@agent-polyfill`. Whether Claude Code removes a
plugin by itself when a bundle stops depending on it isn't known here, so
look in `/plugin` after updating. What it kept on your machine, and how to
remove that, is in
[`polyfills/claude-code/skills`](../../polyfills/claude-code/skills/README.md).
