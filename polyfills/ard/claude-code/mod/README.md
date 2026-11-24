# ard-discovery

Agentic Resource Discovery (ARD v0.91, a draft) for Claude Code. Claude finds
MCP servers in a domain's `/.well-known/ard.json` and `rel="ard"` links, or by
searching an ARD registry. A search sends your query text to that registry,
and Claude Code asks you before each one. No registry is set by default: you
name one in the request, or set one with the `registry` setting. What it finds
is checked, shown with an **Add** button and added by `mcp-server-cards`,
which is installed with it as a dependency.

Install it at the prompt of a `claude` session:

```
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

This folder is what Claude Code installs. Setup, settings, limits and safety
are in the plugin's README:
https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code

Also available for Codex:
https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex
