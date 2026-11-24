# Resource links core

The client side of resource links in tool results (**MCP 2025-11-25, Server >
Tools > Tool Result > Resource Links**, the same text as 2025-06-18), without
a host. One adapter uses it today:

- [`../codex`](../codex/): `mcp-resource-links` for Codex, a plugin.

Claude Code handles resource links itself, so it has no adapter
([why](../claude-code/README.md)).

| File | What it is |
|---|---|
| [`src/links.ts`](src/links.ts) | Which blocks in a tool result are links; whether a link may be read, and from which server (`decide`); and what the model is given (`present`), within the limits. No I/O. |
| [`src/untrusted.ts`](src/untrusted.ts) | Server text as one bounded line. |
| [`test/fixture-links-server.ts`](test/fixture-links-server.ts) | A hand-written MCP server whose tools return links: text, image, binary, very large, for the user only, to another server, to nothing. The host probes in [`../probe`](../probe/) and the adapter's tests run against it. It shares no code with `src/`. |

The rules are in [`../DESIGN.md`](../DESIGN.md), and tested through the
adapter (`npm test` in [`../codex`](../codex/)).

```bash
npm ci
npm run typecheck
```
