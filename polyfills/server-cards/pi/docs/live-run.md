# A live run of mcp-server-cards in Pi

A real Pi and a real model, against neon.com's published AI Catalog and
Server Cards. Asked what Neon publishes, Pi called `discover_mcp_servers`;
asked to add Neon Docs, it called `add_mcp_server`, and the extension asked the
user, naming the URL, the headers, the file it writes and the undo command.
After "Add it", the server was in `mcp.json` (written by Pi's own
`pi mcp add`) and registered for the session.

The question is printed before the line in which Pi says what it will do: the
script prints questions as they come, and the rest after the turn.

Recorded on 24 November 2026 (UTC) with Pi 1.6.0 from this folder's
devDependencies, run in RPC mode by the script below, with its own home and
state folder. The model was `gpt-6.2-sol` through Pi's `openai-codex` provider,
signed in with `/login` in an agent directory of its own; the script never
reads that directory's credentials. The script answers the extension's
questions with the yes it asks for, and prints what Pi did. Local paths are
replaced with `<agent dir>` and `<temp>`; tool results are cut at a few hundred
characters, as the script prints them.


```bash
PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node live/run.ts "What MCP servers does neon.com publish?" "Add Neon Docs."
```

```text
[user] What MCP servers does neon.com publish?

[tool call] discover_mcp_servers {"domain":"neon.com"}

[tool result] Discovery for https://neon.com (MCP Server Cards, SEP-2127; AI Catalog v0.9) Sources read: - https://neon.com/.well-known/ai-catalog.json [ai-catalog]: found (10 entries) - https://neon.com/ [page]: found (1 rel="ai-catalog" link) MCP servers listed: 2 (2 with a valid Server Card). Server Cards are advisory (SEP-2127): Pi checks the real server when it connects. 1. urn:air:neon.com:mcp:neon card: 

[Pi] Neon publishes two MCP servers in its [AI catalog](https://neon.com/.well-known/ai-catalog.json):

| Server | What it does | Endpoint |
|---|---|---|
| **Neon** (`com.neon/mcp`) | Manages Neon projects and Lakebase Postgres databases. | `https://mcp.neon.tech/mcp` |
| **Neon Docs** (`com.neon/docs-mcp`) | Searches and reads Neon documentation. No authentication required. | `https://neon.com/docs/mcp` |

Both use Streamable HTTP and have valid MCP Server Cards.

[user] Add Neon Docs.

[Pi asks the user] neon.com: add the MCP server "neon-docs" to Pi?
It connects to the host neon.com
URL: https://neon.com/docs/mcp
Headers: none
From the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog.
Written to <agent dir>/mcp.json (all your projects).
To undo: pi mcp remove neon-docs
  options: Don't add it | Add it

[user answers] Add it

[Pi] I’ll ask Pi to add **Neon Docs** as `neon-docs`, connecting to `https://neon.com/docs/mcp`.

[tool call] add_mcp_server {"domain":"neon.com","identifier":"urn:air:neon.com:mcp:neon-docs","url":"https://neon.com/docs/mcp","remote":0,"name":"neon-docs"}

[tool result] Added "neon-docs" (https://neon.com/docs/mcp) to <agent dir>/mcp.json with pi mcp add, from the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog. To remove it: pi mcp remove neon-docs Registered with Pi for this session; Pi connects it in the ba

[Pi] Added Neon Docs to Pi as `neon-docs`. No sign-in or reload is required.

[mcp.json after the run] {
  "mcpServers": {
    "neon-docs": {
      "url": "https://neon.com/docs/mcp"
    }
  }
}
```
