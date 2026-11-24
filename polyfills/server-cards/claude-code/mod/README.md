# mcp-server-cards

MCP Server Cards (SEP-2127) for Claude Code. Claude finds the MCP servers a
domain publishes, checks their Server Cards, and lists them under its answer
with an **Add** button. A press adds the server to Claude Code's own MCP
configuration, and Claude Code connects it with its own sign-in. For Agentic
Resource Discovery (`ard.json`, registry search), add the companion plugin
`ard-discovery`, which hands what it finds to this one.

Install it at the prompt of a `claude` session:

```
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

This folder is what Claude Code installs. Setup, settings, limits and safety
are in the polyfill's README:
https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/claude-code

Also available for Codex:
https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex
