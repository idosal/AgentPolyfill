# ard-discovery

Agentic Resource Discovery (ARD v0.91 draft) for Claude Code: Claude finds MCP servers in a domain's `/.well-known/ard.json` and `rel="ard"` links, or by searching an ARD registry. A search sends your query text to that registry (by default Hugging Face Discover). What it finds is checked, shown with an **Add** button and added by `mcp-server-cards`, which is installed with it as a dependency.

Install it at the prompt of a `claude` session:

```
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

This folder is what Claude Code installs. Setup, settings, limits and safety are in the plugin's README:
https://github.com/idosal/AgentPolyfill/tree/main/polyfills/claude-code/ard
