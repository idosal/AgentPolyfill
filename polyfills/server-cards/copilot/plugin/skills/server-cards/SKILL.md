---
name: server-cards
description: Connect Copilot to a company's or product's MCP server by its domain, using MCP Server Cards (SEP-2127). Use when the person asks to connect Copilot to a service by name or website, asks what MCP servers a domain publishes, or a task needs a service that has no tools in this session and the person names its site.
---

# Connecting Copilot to an MCP server by its domain

The `mcp-server-cards` MCP server has two tools.

1. **`discover_mcp_servers(domain)`** reads the domain's AI Catalog (`/.well-known/ai-catalog.json` and `rel="ai-catalog"` links), fetches each Server Card it lists and checks it against the schema. It is read-only.
2. **`add_mcp_server(domain, identifier, url, remote?, name?, values?)`** adds one server shown in this session to Copilot's MCP configuration. Copilot shows the person a form first, naming the server, its URL, its headers, the file written and the undo command, with a required choice. Only their **Add it** adds; anything else, or no form, writes nothing.

How to use them:

- Run `discover_mcp_servers` for the domain the person names. Use the company's own domain (`neon.com`, `buildkite.com`).
- Tell the person what it found: each server's title, the URL it connects to, and whether the card was refused and why. A card is the publisher's claim, not a check of the server.
- To add one, say which server and URL, then call `add_mcp_server` with the same `domain`, the entry's `identifier`, the remote number, and as `url` the "connects to" URL where the result shows one, else the remote's URL. Don't pass a URL from anywhere else.
- If the card asks for a non-secret input (a tenant, a region), ask the person and pass it in `values`. Never ask for a secret's value: the configuration holds a `${VAR}` reference to an environment variable, which the result names, and the person sets it.
- After the add, pass on what the result says: the undo command (`copilot mcp remove <name>`), any environment variable to set, and that `/mcp reload` (or a new session) connects the server, with `/mcp auth <name>` if it asks for a sign-in.
- If the person declines the form, don't ask again unless they bring it up.
