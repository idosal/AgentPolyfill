# Conformance: ARD and Server Cards client rules, for Antigravity

The Antigravity plugin implements:

- **ARD v0.91** at commit
  [`f073b1ea9b`](https://github.com/ards-project/ard-spec): §5.1 (domain
  discovery: `ard.json` and `rel="ard"`), §5.3 (registry search) and
  Appendix B (error codes), for MCP Server Cards only. ARD is a draft, not an
  MCP specification.
- MCP Server Cards ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9,
  for the cards it finds.

## Client rules

The ARD rules (W-1 to W-6, R-1 to R-8, P-1, B-1) and the Server Cards rules
are the shared ones, with the same code: see the Claude Code forms' tables,
[ARD's](../../claude-code/README.md#client-rules) and
[mcp-server-cards'](../../../server-cards/claude-code/README.md#client-rules).
The search rules are the Codex form's (`../../codex/src/search.ts`), the
gate, host and add tool those of `mcp-server-cards` for Antigravity.

Where Antigravity differs:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| Q-2 | The person chooses the registry | this plugin's own | R-5 | met: none set by default; with none named, the hook denies and nothing is sent |
| Q-3 | Every search is put to the person first, naming the query and the registry | this plugin's own (security review M2) | R-2, R-3, R-10 | met, if the hook runs: `force_ask` naming the endpoints and the query, and a one-use ticket for them. Without it, nothing is sent |
| Q-4 | What is sent is what was shown | this plugin's own (R1, C1) | R-4, R-5, R-11 | met: the ticket is for that query and those endpoints; length, one line, no hidden characters or markup |
| V-3 | No text that displays as something else | the polyfills' own | R-11, R-12 (and the shared X-, C- tests) | met: hidden characters in a query or registry are denied before any question; a registry's text is one line with nothing hidden |
| D-1 | Domain discovery reads `ard.json`, which needs no `specVersion` | §5.1 | R-7 | met |
| H-3 | A search result is confirmed only by its publisher's own catalog | the polyfills' own | R-6 (and the shared O- tests) | met |

## Proof

Run from `polyfills/ard/antigravity`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026, with Node.js 22.23.1, passed
**115 tests**, with none failed or skipped:

- **102 shared rule tests:** ARD's registry client (12, from
  [`claude-code/mod/tests`](../../claude-code/mod/tests)) and the Server
  Cards core's (90, from
  [`server-cards/claude-code/mod/tests`](../../../server-cards/claude-code/mod/tests)),
  built from the same sources as the bundle.
- **13 adapter tests** in [`adapter.test.ts`](../test/adapter.test.ts):
  R-1 to R-12 (the server on stdio and its hook as a command, against a local
  web with an `ard.json` and a registry, and a throwaway `HOME`) and B-1 (the
  bundle is byte-identical to a fresh build, and a copy of `plugin/` alone
  starts).

`agy plugin validate --strict` passes for `plugin/` (Antigravity CLI 1.5.16).

### Live, 25 November 2026

Antigravity CLI v1.5.16 on macOS, with a throwaway `HOME`
([the record](../../../events/antigravity/docs/live-run.md)): `ard_discover`
for buildkite.com read its `ard.json` (one valid card); an `ard_search`
through an editor connected to `agy acp`, against this repository's local
demo registry, was put to the person with the exact query and registry, sent
only after the approval, to 127.0.0.1:9011 only, and found Buildkite,
confirmed by its publisher. Not run: a search in the App (the approval card
there was checked with `mcp-server-cards` and `mcp-skills`), and the IDE's
agent.

The MCP conformance suite has no ARD or Server Card scenarios.
