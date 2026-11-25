# A live run of ard-discovery in Pi

A real Pi and a real model. First, by domain: asked what buildkite.com lists
in its `ard.json`, Pi called `ard_discover`. Then a registry search against
the repository's demo registry (`polyfills/ard/claude-code/demo/registry.mjs`,
on this machine, so the query went nowhere else): the model first asked in the
chat whether it could send the query; told yes, it called `ard_search`, and
the extension asked the user, naming the registry and the exact query, before
anything was sent. The registry's log showed one search. The model asked again
in the chat before adding a result, and the run ended there; adding goes
through the same code as the Server Cards form, whose live run adds a server.

The script is the Server Cards form's (`../server-cards/pi/live/run.ts`), with
`PI_LIVE_EXTENSION` naming this form's bundle.

Recorded on 24 November 2026 (UTC) with Pi 1.6.0 from this folder's
devDependencies, run in RPC mode by the script below, with its own home and
state folder. The model was `gpt-6.2-sol` through Pi's `openai-codex` provider,
signed in with `/login` in an agent directory of its own; the script never
reads that directory's credentials. The script answers the extension's
questions with the yes it asks for, and prints what Pi did. Local paths are
replaced with `<agent dir>` and `<temp>`; tool results are cut at a few hundred
characters, as the script prints them.


The agent folder is a throwaway one, never your own: make it with
`node ../server-cards/pi/live/run.ts --new-agent-dir <path>`, sign in to it (`PI_CODING_AGENT_DIR=<path> pi`,
then `/login`), then run. The script refuses any other folder, writes `mcp.json`
only where a live run left the one there, and prints servers by name and
address only ([`live/agent-dir.ts`](../../../server-cards/pi/live/agent-dir.ts)). Afterwards, sign out with
`PI_CODING_AGENT_DIR=<path> pi auth logout <provider>` and delete the folder.

```bash
PI_LIVE_EXTENSION=$PWD/extension/dist/index.js PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node ../server-cards/pi/live/run.ts "What does buildkite.com list in its ard.json?" "Search the registry at http://127.0.0.1:9011 for an MCP server that can check why a CI build failed."
```

## Run 1

```text
[user] What does buildkite.com list in its ard.json?

[tool call] ard_discover {"domain":"buildkite.com"}

[tool result] Discovery for https://buildkite.com (MCP Server Cards, SEP-2127; AI Catalog v0.9; further sources from ard-discovery (ARD v0.91 draft)) Sources read: - https://buildkite.com/.well-known/ai-catalog.json [ai-catalog]: found (1 entries) - https://buildkite.com/.well-known/ard.json [extra]: found (1 entries) - https://buildkite.com/ [page]: absent (no rel="ai-catalog" or rel="ard" link) MCP servers li

[Pi] Buildkite’s [`ard.json`](https://buildkite.com/.well-known/ard.json) lists one entry: the **Buildkite MCP server**, which connects AI clients to Buildkite workflows and CI/CD data.

- **ID:** `urn:air:buildkite.com:mcp:buildkite`
- **Server Card:** https://mcp.buildkite.com/mcp/server-card
- **Endpoint:** https://mcp.buildkite.com/mcp (Streamable HTTP)

[user] Search the registry at http://127.0.0.1:9011 for an MCP server that can check why a CI build failed.

[Pi] May I send the query “Check why a CI build failed” to the ARD registry at `http://127.0.0.1:9011`?

[mcp.json after the run] {
  "mcpServers": {}
}
```

## Run 2

```text
[user] Search the registry at http://127.0.0.1:9011 for an MCP server that can check why a CI build failed.

[Pi] May I send the query “check why a CI build failed” to the ARD registry at `http://127.0.0.1:9011`?

[user] Yes, send that search.

[Pi asks the user] 127.0.0.1:9011: send this search to http://127.0.0.1:9011/search, and to up to three registries it refers to?
Query: "check why a CI build failed"
A registry is a service someone else runs, and it sees the query.
  options: Don't send it | Send the search

[user answers] Send the search

[tool call] ard_search {"query":"check why a CI build failed","registry":"http://127.0.0.1:9011"}

[tool result] Registry search for "check why a CI build failed" (ARD v0.91 §5.3). The query text was sent to: 127.0.0.1:9011. Registries asked: - http://127.0.0.1:9011/search: 2 results MCP servers found by the ARD registry at 127.0.0.1:9011: 2 (2 with a valid Server Card, 2 confirmed by their publisher). What says who stands behind a server is whether the publisher's own domain lists it, not the finder's order

[Pi] The **Buildkite MCP Server** is the best match if your CI runs on Buildkite. It can investigate failed builds, read job logs, and identify flaky tests. Endpoint: `https://mcp.buildkite.com/mcp`.

The registry at `http://127.0.0.1:9011` also returned the **Netlify MCP Server**, which is more relevant to Netlify deploy failures. Both servers are listed in their publishers’ own catalogs. The registry ranks by relevance, not trust.

[user] Add the best match.

[Pi] May I add the publisher-confirmed **Buildkite MCP Server** as `buildkite`? It connects to `https://mcp.buildkite.com/mcp` with no custom headers. You can undo this by removing the `buildkite` entry from Pi’s MCP configuration.

[mcp.json after the run] {
  "mcpServers": {}
}
```
