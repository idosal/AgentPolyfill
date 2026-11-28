---
name: ard-discovery
description: Find MCP servers through Agentic Resource Discovery (ARD), by a domain's ard.json. Use when the person asks what MCP servers a domain lists through ARD, or asks to connect Muse to a service by its domain and its AI Catalog lists nothing.
---

# Finding MCP servers through ARD

The `ard-discovery` MCP server has two tools, and neither writes anything.

1. **`ard_discover(domain)`** reads the domain's `/.well-known/ard.json`, `/.well-known/ai-catalog.json` and their `rel` links, and checks each Server Card they list. It sends no query.
2. **`add_mcp_server(...)`** checks a server `ard_discover` showed in this session and gives the `muse mcp add` command that adds it, which the person runs themselves (in a terminal, or after `!` at the Muse prompt). It takes the same arguments as in `mcp-server-cards`.

Searching an ARD registry for a task (`ard_search` in other hosts) is not offered in Muse: a search sends the person's words to a service someone else runs. This adapter only looks up domains the person names. If the person wants a server for a task and names no service, say so and ask which company or domain to look at.

How to use them:

- Run `ard_discover` for the domain the person names: it sends nothing but plain GETs to that domain.
- Use the MCP server count from the lookup. A single server can list several connection addresses. Present these as choices under its name. A result is the publisher's claim, not a check of the server.
- To add one, call `add_mcp_server` with its `domain`, `identifier` and the URL it connects to, then show the person the command exactly as the result gives it. Don't run it yourself: running it is the person's yes.
- Pass on the rest: the undo command (`muse mcp remove <name>`), any environment variable to set, and `muse mcp login <name>` if the server needs a sign-in.
