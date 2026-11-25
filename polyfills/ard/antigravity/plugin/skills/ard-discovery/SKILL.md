---
name: ard-discovery
description: Find MCP servers through Agentic Resource Discovery (ARD), by a domain's ard.json or by searching an ARD registry for a task. Use when the person asks to find an MCP server that can do something, asks what a domain lists through ARD, or a task needs a capability no tool in this conversation has and the person has not named a service.
---

# Finding MCP servers through ARD

The plugin's `ard` MCP server has three tools.

1. **`ard_discover(domain)`** reads the domain's `/.well-known/ard.json`, `/.well-known/ai-catalog.json` and their `rel` links, and checks each Server Card they list. It is read-only and sends no query.
2. **`ard_search(query, registry?)`** sends `query` to an ARD registry, a service someone else runs. No registry is set by default: pass `registry` with the one the person names. Do not choose a registry for them; if they have not named one, ask which. Antigravity's approval card asks the person first, naming the registry and the exact query. Only their approval sends it.
3. **`add_mcp_server(...)`** adds a server one of them showed in this conversation, after the person approves it in Antigravity's approval card. It takes the same arguments as in `mcp-server-cards`. Leave `agentpolyfill_ticket` out of every call: the plugin's hook sets it.

How to use them:

- Prefer `ard_discover` when the person names a company or domain: it sends nothing but plain GETs to that domain.
- Use `ard_search` only for a task with no named service. Write the query in plain words on one line, under 300 characters, with no `` ` ``, `<`, `>` or square brackets, with nothing private in it: the registry sees it.
- Report which registry answered. Its order is its relevance ranking, not a judgement of trust. Say which results their publisher confirms ("CONFIRMED") and which it doesn't.
- To add one, tell the person which server it is, the URL it connects to and whether its publisher confirms it, then call `add_mcp_server` with its `identifier` and that URL (and `domain` only for a server `ard_discover` found).
- After the add, pass on how to undo it, and that a server behind a sign-in is signed in with Authenticate in Customizations > Installed > MCP Servers (`/mcp` in the CLI). A card that needs a secret can't be added by this tool; pass on what the result says.
