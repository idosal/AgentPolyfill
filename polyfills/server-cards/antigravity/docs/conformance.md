# Conformance: the Server Cards client rules, for Antigravity

The Antigravity plugin implements the client side of MCP Server Cards,
against the revisions named in its [README](../README.md#spec-and-conformance):

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final.
- [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card/tree/28db12c9b4),
  commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- [AI Catalog](https://github.com/Agent-Card/ai-catalog/tree/19208af2f8), v0.9
  release candidate, commit `19208af2f8`, which SEP-2127 names for domain
  discovery.

## Client rules

The full [client rules table](../../claude-code/README.md#client-rules) gives
the source and tests for D-1 to D-9, V-1 to V-3, C-1 to C-3, S-1 to S-6 and
I-1 to I-4. Those shared rules carry over because this plugin bundles the same
card, discovery, cache, configuration, formatting and offer modules (and the
Codex form's fetch and checks), and runs the same 90 rule tests, built from
the same sources as its committed
[`plugin/dist/server.mjs`](../plugin/dist/server.mjs).

Where Antigravity differs:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | the polyfills' own (security review SC2) | W-4, E-4 | met: a name in `mcp_config.json`, in any case, or a file that can't be read, is refused before the question and again before writing |
| P-2 | A person approves every addition | the polyfills' own (security review SC4) | E-1, E-2, E-3, E-8, G-1, G-4, G-5, G-7 | met, if the hook runs: `force_ask` with the server, URL, headers, file and undo, and a one-use ticket for that entry (4 hours). Without the ticket nothing is written. Checked live: the App's card shows the question; a decline writes nothing |
| P-3 | Add only what was shown, as shown | the polyfills' own | E-3, E-4, E-7 | met: a card a tool showed in the last hour, at the URL it yields |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | P-3 | met by refusing: a card that needs a secret isn't added, and no secret is written |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | P-4 | streamable HTTP met; SSE refused (`serverUrl` is streamable HTTP) |
| V-3 | No text that displays as something else | the polyfills' own | P-2, P-5, E-9 (and the shared X-, C- tests) | met: markup and hidden characters as in the shared rules; a header value that would be written holding a hidden character is refused |
| N-3 | Values from the person's configuration are never shown | the polyfills' own | W-5 | met: a config that isn't JSON is refused without the parser's message, which can quote the file |

## Proof

Run from `polyfills/server-cards/antigravity`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026, with Node.js 22.23.1, passed
**119 tests**, with none failed or skipped. They need loopback access for
their local web server, and use a throwaway `HOME`.

- **90 shared rule tests:** `card`, `configure`, `discover`, `format` and
  `offer` from [`claude-code/mod/tests`](../../claude-code/mod/tests).
- **29 adapter tests** in [`adapter.test.ts`](../test/adapter.test.ts):
  the plan in Antigravity's terms (P-1 to P-5), the file (W-1 to W-5), the
  gate (G-1 to G-7), the hook's matcher (H-1), the server and its hook run as
  Antigravity runs them, over stdio and as a command (E-1 to E-9), and the
  bundle (B-1, byte-identical to a fresh build; B-2, the manifest meets
  Antigravity's schema and a copy of `plugin/` alone starts).

`agy plugin validate --strict` passes for `plugin/` (Antigravity CLI 1.5.16;
its one note is that there's no logo).

### Live, 25 November 2026

In Antigravity App v2.35.1 and CLI v1.5.16 on macOS, with a throwaway `HOME`
([the record](../../../events/antigravity/docs/live-run.md)):

- `discover_mcp_servers` for neon.com: 2 valid cards.
- An approved addition (over `agy acp`) wrote `"neon-docs": {"serverUrl":
  "https://neon.com/docs/mcp"}`; the App then connected it.
- In the App, the approval card showed the plugin's whole question and greyed
  out "always allow"; choosing **No** wrote nothing, and the agent was told.
- In headless `agy -p`, nobody can answer `force_ask`: the call was denied.

Not run: the IDE's agent, and a server behind a sign-in after an addition.

The MCP conformance suite has no Server Card scenarios.
