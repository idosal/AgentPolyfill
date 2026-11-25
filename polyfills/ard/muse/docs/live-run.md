# Live runs of ard-discovery in Muse Code

Recorded on 25 November 2026 with the real Muse Code 1.4.25 binary on macOS.

**How the runs were set up:**
- **Isolation.** Each ran with `env -i`, and with `HOME`, the XDG folders and
  `TMPDIR` in a scratch folder.
- **Model.** No run used a real model, and there was no `muse login`. The model
  was a stand-in for the Responses API on 127.0.0.1 with a made-up key.
- **Install.** `muse plugins install ard-discovery@agent-polyfill`, then
  `muse plugins approve ard-discovery`, from this branch's worktree, as a local marketplace
  (`muse plugins marketplace add agent-polyfill <the worktree's folder>`).
  Adding the marketplace by its GitHub URL was checked too: Muse fetched it
  with Git and listed the four plugins, but `main` had no Muse manifests yet.
  So an install from GitHub, as the README gives it, can only be checked once
  this is merged.
- **The catalog.** A local catalog on 127.0.0.1 served an `ard.json` with one
  card, beside an AI Catalog with another.

1. **Discovery.** `ard_discover` read both:

   ```text
   Discovery for http://127.0.0.1:8990 (MCP Server Cards, SEP-2127; AI Catalog v0.9; further sources from ard-discovery (ARD v0.91 draft))
   Sources read:
     - http://127.0.0.1:8990/.well-known/ai-catalog.json [ai-catalog]: found (1 entries)
     - http://127.0.0.1:8990/.well-known/ard.json [extra]: found (1 entries)
   MCP servers listed: 2 (2 with a valid Server Card). …
   ```

2. **The command.** `add_mcp_server` for the `ard.json` entry gave the command,
   and wrote nothing: `muse mcp add ard-docs --url http://127.0.0.1:8990/ard/mcp -H 'X-API-Ke…`
   (the card's secret header, as a `${…}` reference).
3. **No search.** The tools Muse offered the model from this plugin were
   `ard_discover` and `add_mcp_server`. There was no `ard_search`.
