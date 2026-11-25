# Conformance: the ARD consumer rules, for OpenCode

Every rule ARD v0.91 (a draft) puts on a consumer of MCP Server Cards, and the
rules this plugin adds, as the Claude Code form lists them
([its README](../../claude-code/README.md)), with the OpenCode plugin's state
and where it is tested. The registry client is the Claude Code form's
[`registry.ts`](../../claude-code/mod/hooks/registry.ts), and showing, checking
and adding a server is the Server Cards core, both bundled unchanged; their
rules are tested in the Claude Code form (`mod/tests/registry.test.ts`, and
mcp-server-cards' tests) against the same code. Adding a server follows
[mcp-server-cards for OpenCode's table](../../../server-cards/opencode/docs/conformance.md).

**Where a rule is checked:** `shared`, `e2e`
([`test/e2e.test.ts`](../test/e2e.test.ts): the bundled plugin in OpenCode
2.4.1 against a local web with an `ard.json`, a card, a small MCP server and a
registry), `units` ([`test/units.test.ts`](../test/units.test.ts)), `live`
(a real model; buildkite.com's `ard.json`, and the repository's demo registry,
[`live-run.md`](../../../../tools/opencode/live-run.md)).

**Summary:** 19 rules. 17 met, 1 partly met (R-8, as in the other forms), 1
met with a stated exception (Q-3).

## Discovery

| # | Rule | State | How, and where checked |
|---|---|---|---|
| W-1 | Fetch `https://{domain}/.well-known/ard.json` | met | `shared`; `e2e`; `live` |
| W-2 | Honour `rel="ard"` links | met | `shared` |
| W-3 | `/.well-known/ai-catalog.json` may be read as well | met | `shared` |
| W-4 | An `ard.json` manifest need not carry `specVersion` | met | `e2e` |
| W-5 | An entry carries `url` or `data`, never both | met | `shared` |
| W-6 | The same `identifier` in both documents is one server | met | `shared` |

## Registry search

| # | Rule | State | How, and where checked |
|---|---|---|---|
| R-1 | A registry's base URL gets `/search` appended | met | `units`; `e2e` |
| R-2 | `POST /search` with `query.text`, `filter` and `federation` | met | `shared`; `e2e` |
| R-3 | A referral's `url` is the endpoint itself; one hop | met | `shared`; `e2e` |
| R-4 | A result carries `identifier`; its `url` is the card | met | `shared`; `e2e` |
| R-5 | `score` is relevance, never trust | met | `shared` |
| R-6 | Standard error codes | met | `shared` |
| R-7 | The publisher is the domain in `urn:air:<publisher>:…` | met | `shared` |
| R-8 | A claim to a publisher's name needs that publisher's attestation | partly | Trust manifests aren't verified; a result counts as confirmed only when the publisher's own catalog lists it with a valid card. `shared`; `live` |

## What the plugin adds

| # | Rule | State | How, and where checked |
|---|---|---|---|
| Q-1 | Say where the query went | met | The tool's description, the request and every result name each registry. `e2e` |
| Q-2 | The person chooses the registry | met | None is set by default; with neither a named registry nor `ARD_DISCOVERY_REGISTRY`, nothing is sent. `e2e` |
| Q-3 | Every search is put to the person first, naming the query and the registry | exception | Put to OpenCode's rules as `ard_search` on the registry hosts, nothing saved, and asked by default (the plugin turns OpenCode's default `allow` into `ask`). A registry a referral names is put to them too, before the query goes there; one not allowed gets nothing. **Limit:** OpenCode's TUI shows only "Call tool ard_search": the person reads the query and the first registry on the model's call line, and a referred registry's host is in the request alone, which OpenCode Desktop shows and the TUI doesn't. With `askByDefault: false`, OpenCode's rules alone decide. `e2e` (three cases) |
| Q-4 | A registry's own words on one line, with nothing hidden | met | `shared`; a query or registry name holding a hidden character is refused, `units` |
| P-1 | No referral to a local or private address from a public registry | met | `shared` |
