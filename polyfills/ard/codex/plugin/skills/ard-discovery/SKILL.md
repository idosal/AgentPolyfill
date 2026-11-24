---
name: ard-discovery
description: Find MCP servers through Agentic Resource Discovery (ARD), by a domain's ard.json or by searching an ARD registry for a task. Use when the person asks to find an MCP server that can do something, asks what a domain lists through ARD, or a task needs a capability no tool in this session has and the person has not named a service.
---

# Finding MCP servers through ARD

The `ard-discovery` MCP server has three tools.

1. **`ard_discover(domain)`** reads the domain's `/.well-known/ard.json`, `/.well-known/ai-catalog.json` and their `rel` links, and checks each Server Card they list. It is read-only and sends no query.
2. **`ard_search(query, registry?)`** sends `query` to an ARD registry, a service someone else runs. Codex shows the person a form first, naming the registry and the exact query, with a required choice. Only their **Send the search** sends; anything else, or no form, sends nothing.
3. **`add_mcp_server(...)`** adds a server one of them showed in this session, after the person approves it in a form. It takes the same arguments as in `mcp-server-cards`.

How to use them:

- Prefer `ard_discover` when the person names a company or domain: it sends nothing but plain GETs to that domain.
- Use `ard_search` only for a task with no named service. Write the query in plain words on one line, under 300 characters, with no `` ` ``, `<`, `>` or square brackets, with nothing private in it: the registry sees it.
- Report which registry answered. Its order is its relevance ranking, not a judgement of trust. Say which results their publisher confirms ("CONFIRMED") and which it doesn't.
- To add one, tell the person which server it is, the URL it connects to and whether its publisher confirms it, then call `add_mcp_server` with its `identifier` and that URL (and `domain` only for a server `ard_discover` found).
- After the add, pass on the undo command, any environment variable to set, and `codex mcp login <name>` if the server needs a sign-in.
