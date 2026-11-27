---
name: server-cards
description: Connect Muse to a company's or product's MCP server by its domain, using MCP Server Cards (SEP-2127). Use when the person asks to connect Muse to a service by name or website, asks what MCP servers a domain publishes, or a task needs a service that has no tools in this session and the person names its site.
---

# Connecting Muse to an MCP server by its domain

The `mcp-server-cards` MCP server has two tools, and neither writes anything.

1. **`discover_mcp_servers(domain)`** reads the domain's AI Catalog (`/.well-known/ai-catalog.json` and `rel="ai-catalog"` links), fetches each Server Card it lists and checks it against the schema.
2. **`add_mcp_server(domain, identifier, url, remote?, name?, values?)`** checks one server shown in this session and gives the `muse mcp add` command that adds it. Give the person the command to review and run: in a terminal, or after `!` at the Muse prompt.

How to use them:

- Run `discover_mcp_servers` for the domain the person names. Use the company's own domain (`neon.com`, `buildkite.com`).
- Tell the person what it found: each server's title, the URL it connects to, and whether the card was refused and why. A card is the publisher's claim, not a check of the server.
- To add one, say which server and URL, then call `add_mcp_server` with the same `domain`, the entry's `identifier`, the remote number, and as `url` the "connects to" URL where the result shows one, else the remote's URL. Don't pass a URL from anywhere else.
- If the card asks for a non-secret input (a tenant, a region), ask the person and pass it in `values`. Never ask for a secret's value: the command names an environment variable, which the result names, and the person sets it.
- Show the person the command exactly as the result gives it, with the host it connects to. Don't run it yourself: running it is the person's yes.
- Pass on the rest of the result: the undo command (`muse mcp remove <name>`), any environment variable to set, and `muse mcp login <name>` if the server asks for a sign-in. A new Muse session connects the server.
