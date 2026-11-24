# mcp-server-cards

MCP Server Cards (SEP-2127) for Claude Code: Claude finds the MCP servers a domain publishes, checks their Server Cards, and lists them under its answer with an **Add** button. A press adds the server to Claude Code's own MCP configuration, and Claude Code connects it with its own sign-in. With the `ard` setting on (off by default: it adds parts of the Agentic Resource Discovery draft), Claude can also search a registry for a server that can do a task.

Install it at the prompt of a `claude` session:

```
/plugin install mcp-server-cards --marketplace idosal/MCPolyfill
```

This folder is what Claude Code installs. Setup, settings, limits and safety are in the polyfill's README:
https://github.com/idosal/MCPolyfill/tree/main/polyfills/claude-code/server-cards
