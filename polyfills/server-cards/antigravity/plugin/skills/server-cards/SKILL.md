---
name: server-cards
description: Connect Antigravity to a company's or product's MCP server by its domain, using MCP Server Cards (SEP-2127). Use when the person asks to connect Antigravity to a service by name or website, asks what MCP servers a domain publishes, or a task needs a service that has no tools in this conversation and the person names its site.
---

# Connecting Antigravity to an MCP server by its domain

The plugin's `cards` MCP server has two tools.

1. **`discover_mcp_servers(domain)`** reads the domain's AI Catalog (`/.well-known/ai-catalog.json` and `rel="ai-catalog"` links), fetches each Server Card it lists and checks it against the schema. It is read-only.
2. **`add_mcp_server(domain, identifier, url, remote?, name?, values?)`** adds one server shown in this conversation to `~/.gemini/config/mcp_config.json`. Antigravity's approval card asks the person first, naming the server, its URL, its headers, the file and how to undo it. Only their approval adds it.

How to use them:

- Run `discover_mcp_servers` for the domain the person names. Use the company's own domain (`neon.com`, `buildkite.com`).
- Tell the person what it found: each server's title, the URL it connects to, and whether the card was refused and why. A card is the publisher's claim, not a check of the server.
- To add one, say which server and URL, then call `add_mcp_server` with the same `domain`, the entry's `identifier`, the remote number, and as `url` the "connects to" URL where the result shows one, else the remote's URL. Don't pass a URL from anywhere else, and leave `agentpolyfill_ticket` out: the plugin's hook sets it.
- If the card asks for a non-secret input (a tenant, a region), ask the person and pass it in `values`. Never ask for a secret's value. A card that needs a secret can't be added by this tool; pass on what the result says about adding it by hand.
- After the add, pass on what the result says: how to undo it, and that a server behind a sign-in is signed in with Authenticate in Customizations > Installed > MCP Servers (`/mcp` in the CLI).
- If the person declines, don't ask again unless they bring it up.
