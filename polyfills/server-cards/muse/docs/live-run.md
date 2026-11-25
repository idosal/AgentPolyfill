# Live runs of mcp-server-cards in Muse Code

Recorded on 25 November 2026 with the real Muse Code 1.4.25 binary on macOS.

**How every run was set up:**
- **Isolation.** Each ran with `env -i`, and with `HOME`, the XDG folders and
  `TMPDIR` in a scratch folder.
- **Model.** No run used a real model, and there was no `muse login`. The model
  was a stand-in for the Responses API on 127.0.0.1 with a made-up key.
- **Install.** `muse plugins install mcp-server-cards@agent-polyfill`, then
  `muse plugins approve mcp-server-cards`, from this branch's worktree, as a local marketplace
  (`muse plugins marketplace add agent-polyfill <the worktree's folder>`).
  Adding the marketplace by its GitHub URL was checked too: Muse fetched it
  with Git and listed the four plugins, but `main` had no Muse manifests yet.
  So an install from GitHub, as the README gives it, can only be checked once
  this is merged.

## neon.com

1. **Discovery.** The model called `discover_mcp_servers` with `neon.com`:

   ```text
   Discovery for https://neon.com (MCP Server Cards, SEP-2127; AI Catalog v0.9)
   Sources read:
     - https://neon.com/.well-known/ai-catalog.json [ai-catalog]: found (10 entries)
     - https://neon.com/ [page]: found (1 rel="ai-catalog" link)

   MCP servers listed: 2 (2 with a valid Server Card). Server Cards are advisory (SEP-2127): Muse checks the real server when it connects.
   1. urn:air:neon.com:mcp:neon … remote #0: streamable-http https://mcp.neon.tech/mcp
   2. urn:air:neon.com:mcp:neon-docs … remote #0: streamable-http https://neon.com/docs/mcp
   ```

2. **The command.** Then it called `add_mcp_server` for Neon Docs. It was
   read-only, so Muse's judge wasn't asked, and it wrote nothing:

   ```text
   Nothing was written. Muse gives this plugin no way to ask the person first, so they add the server themselves.
   To add "neon-docs", which connects to the host neon.com (https://neon.com/docs/mcp), from the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog, they run this in a terminal, or after ! at the Muse prompt:

   muse mcp add neon-docs --url https://neon.com/docs/mcp
   ```

3. **Run as the person would.** The command added the server (`Added MCP server
   \`neon-docs\` to user settings.`). In the next session Muse connected it
   itself, and offered its tools (`search_docs`, `get_doc`, …).

## A card with a secret header

This was a local catalog on 127.0.0.1, with a card whose header `X-API-Key` is
secret. The command was:

```bash
muse mcp add example-docs --url http://127.0.0.1:8990/mcp -H 'X-API-Key: ${MCP_EXAMPLE_DOCS__X_API_KEY_F42VOWVMFIPB3HAU}'
```

Run as given, it wrote the header as the reference `${MCP_…}`, not as a value.
`muse mcp remove example-docs` undid it.
