# Conformance: the Server Cards client rules, for OpenCode

Every rule the specs put on a client, whether the OpenCode plugin meets it,
and where it is tested. The specs are the ones the Claude Code form follows
([its README](../../claude-code/README.md#spec-and-conformance)):

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final (the extension's stage is Beta);
- [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card)
  at `28db12c9b4`: `schema.ts` and `docs/discovery.md`;
- the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9 at
  `19208af2f8`.

The rule ids are the Claude Code form's. The reading, checks and wording are
the shared modules in [`../claude-code/mod/hooks`](../../claude-code/mod/hooks),
bundled unchanged, and fetching is the Codex form's
[`fetch.ts`](../../codex/src/fetch.ts), also bundled; their rules are tested,
rule by rule, by the Claude Code form's 110 tests (`claude plugin test mod`)
against that same code.

**Where a rule is checked:** `shared` (the Claude Code form's `mod/tests`, and
for fetching the Codex form's `test/adapter.test.ts`), `e2e`
([`test/e2e.test.ts`](../test/e2e.test.ts): the bundled plugin in OpenCode
2.4.1, in a throwaway home, against a local web with a catalog, cards and a
small MCP server), `units` ([`test/units.test.ts`](../test/units.test.ts)), and
`live` (a real model and neon.com's catalog,
[`live-run.md`](../../../../tools/opencode/live-run.md)).

**Summary:** 28 rules. 26 met, 1 met with a stated exception (I-4), 1 not met
(S-3). S-3 (a SHOULD: check a card against the live server) needs a change in
OpenCode.

## Discovery

| # | Rule | State | How, and where checked |
|---|---|---|---|
| D-1 | Attempt `https://{domain}/.well-known/ai-catalog.json` | met | `shared`; `e2e`; `live` |
| D-2 | Honour `rel="ai-catalog"` links | met | `shared` |
| D-3 | Select entries of type `application/mcp-server-card+json` | met | `shared`; `e2e` |
| D-4 | Fetch a `url` entry's card with `Accept: application/mcp-server-card+json` | met | `shared` |
| D-5 | Use a `data` entry's card inline | met | `shared` |
| D-6 | Exactly one of `url` and `data` per entry | met | `shared` |
| D-7 | Limit nested catalogs (depth 4) | met | `shared` |
| D-8 | Read `specVersion` first; reject an unsupported major version | met | `shared` |
| D-9 | The same `identifier` names the same artifact | met | `shared` |

## Cards

| # | Rule | State | How, and where checked |
|---|---|---|---|
| V-1 | A card conforms to the schema; an invalid card is refused, never repaired | met | `shared`; `e2e` (three valid cards) |
| V-2 | `version` is one version, not a range | met | `shared` |
| V-3 | No text that displays as something else | met | `shared` (control, direction and hidden characters; markup in URLs; a user before the host); a written header value with a character that shows as nothing is refused, `units` |
| I-1 | Inputs: pre-set values, choices, defaults, required inputs asked for | met | `shared` |
| I-2 | Handle `isSecret` values securely | met | A secret never passes through the model or the plugin: a card that needs one isn't added, and the answer gives the entry for `opencode.json` with `{env:VAR}`. `units`; `e2e` |
| I-3 | Choose a remote by its `supportedProtocolVersions` | met | `shared`, with the revisions the shared modules list |
| I-4 | Transport `streamable-http` or `sse` | exception | Streamable HTTP met. An SSE remote is refused: OpenCode 2.4.1 connects remote servers over streamable HTTP. `units` |

## The person decides, and what is added

| # | Rule | State | How, and where checked |
|---|---|---|---|
| P-1 | Never replace a server the person has | met | A name OpenCode's configuration has, from any source, is refused before the question and again after. `e2e` |
| P-2 | A person approves every addition | met | Put to OpenCode's rules as `mcp_server_cards_add` on `<name>=<url>`, nothing saved, and asked by default: the plugin turns OpenCode's default `allow` into `ask` for its own two actions. A configured `deny` is final; nobody present is a no. With `askByDefault: false`, OpenCode's rules alone decide. `e2e` ("an add is put to OpenCode's permission rules", "asks by default"); `live` |
| P-3 | Add only what was shown, as shown | met | A card a discovery showed in this session, at the URL it yields. `e2e` |

## Caching, transport and trust

| # | Rule | State | How, and where checked |
|---|---|---|---|
| C-1 | Respect `Cache-Control` | met | `shared`; in memory, for the OpenCode server's life |
| C-2 | Send the `ETag` back as `If-None-Match`, accept `304` | met | `shared` |
| C-3 | Avoid unnecessary polling | met | Fetches happen only for a tool call |
| S-1 | HTTPS for cards; plain HTTP only for local development | met | For every redirect hop too. `shared` (the Codex form's fetch) |
| S-2 | Never treat a card as authoritative for security or access-control decisions | met | A card only fills in a server entry; permissions and sign-in stay OpenCode's |
| S-3 | Check the card against the live connection, preferring runtime values | **not met** | That needs `server/discover` over OpenCode's connection, which a plugin can't send. Host change: a raw MCP request for plugins ([host changes](../../../../docs/host-changes.md)) |
| S-4 | Extension information relied on for security only from a same-origin HTTPS card | met | Never relied on. `shared` |
| S-5 | Don't infer extension support from `extensionsInfo` | met | Never read. `shared` |
| S-6 | Cards and catalogs carry no credentials or private endpoints | met | A card that pre-sets a secret is refused; a public card may not name a private address. `shared` |
