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

One row for each rule the specs put on a client, with the test in this form's
suite that covers it. The plugin bundles the shared card, discovery, cache,
configuration, formatting and offer modules
([`../../claude-code/mod/hooks`](../../claude-code/mod/hooks)) and the Codex
form's fetch and checks, built into its committed
[`plugin/dist/server.mjs`](../plugin/dist/server.mjs). "shared" tests are the
90 rule tests from [`claude-code/mod/tests`](../../claude-code/mod/tests),
which this form's `npm test` runs against the same sources; the others are in
[`adapter.test.ts`](../test/adapter.test.ts).

### Discovery (SEP-2127 and the AI Catalog it names)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| D-1 | Attempt `https://{domain}/.well-known/ai-catalog.json` | discovery.md (SHOULD) | shared D-1, D-2, DEF-1 | met |
| D-2 | Honour `rel="ai-catalog"` links, in a `Link` header or a `<link>` tag | AI Catalog, Link Relation Discovery | shared D-7, D-13, D-15, DEF-2 | met |
| D-3 | Select the entries whose `type` is `application/mcp-server-card+json` | discovery.md, step 2 | shared D-3, E-1 | met |
| D-4 | Fetch a `url` entry's card with `Accept: application/mcp-server-card+json` | discovery.md (SHOULD) | shared D-3 | met |
| D-5 | Use a `data` entry's card inline | discovery.md, step 3 | shared D-4 | met |
| D-6 | Exactly one of `url` and `data` per entry | AI Catalog (MUST) | shared D-5, O-1 | met |
| D-7 | Limit nested catalogs; depth 4 is recommended | AI Catalog (SHOULD) | shared D-8 | met: limit 4 |
| D-8 | Read `specVersion` first, and reject an unsupported major version with an informative error | AI Catalog, Consumer Behavior (SHOULD) | shared D-9 | met |
| D-9 | The same `identifier` names the same artifact | AI Catalog | shared D-6 | met |

### The card

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| V-1 | A card conforms to the schema: the v1 `$schema` URL, a reverse-DNS `name`, `version`, a `description` of 100 characters or fewer, remotes, inputs | schema.ts and schema.json | shared V-1 to V-5 | met: an invalid card is refused, never repaired |
| V-2 | `version` is one version, not a range | schema.ts, `ServerCard.version` | shared V-3 | met |
| V-3 | No text that displays as something else | the polyfills' own; SEP-2127: "Clients MUST NOT treat Server Card contents as authoritative" | shared X-1 to X-6, A-21, A-24 to A-26, P-6, P-7, O-9, O-10; adapter P-2, P-5, E-9 | met: controls, direction marks, userinfo and markup in URLs refused; characters that show as nothing taken out of what is shown; a header value that would be written holding one refused |
| I-1 | Inputs: a pre-set `value` can't be changed, `choices` limit the value, `default` fills an unset one, and required inputs are asked for | schema.ts, `Input` | shared A-2, A-4, A-6 | met |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | adapter P-3 | met by refusing: Antigravity's personal file reads no `${VAR}`, so a card that needs a secret isn't added, and no secret is written |
| I-3 | Choose a remote by its `supportedProtocolVersions` | schema.ts, `Remote` | shared A-5 | met |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | adapter P-4 | streamable HTTP met; SSE refused (Antigravity's `serverUrl` is streamable HTTP) |

### Caching and security

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| C-1 | Respect `Cache-Control` | discovery.md (SHOULD) | shared C-1, C-3 | met |
| C-2 | Send the `ETag` back as `If-None-Match`, and accept `304` | discovery.md (SHOULD) | shared C-1, C-2, C-4 | met |
| C-3 | Avoid unnecessary polling | discovery.md (SHOULD) | by design: fetches happen only for a `discover_mcp_servers` call | met |
| S-1 | HTTPS for cards; plain HTTP only for local development | discovery.md, Transport Security | shared S-1, T-1, A-7 | met |
| S-2 | Never treat a card as authoritative for security or access-control decisions | discovery.md (MUST NOT) | by design: a card only fills in an `mcp_config.json` entry; every permission and sign-in decision stays with Antigravity | met |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | discovery.md (SHOULD) | none | not met: the plugin can't send `server/discover` over Antigravity's connection |
| S-4 | Extension information used for a security decision only from a card fetched over HTTPS from the remote's own origin, without a cross-origin redirect | discovery.md (MUST) | shared S-4 | met by never using it: `extensionsInfo` isn't read, shown or acted on |
| S-5 | Don't infer extension support from `extensionsInfo` | discovery.md (MUST NOT) | shared S-4 | met: never read |
| S-6 | Cards and catalogs carry no credentials or private endpoints | discovery.md, Information Disclosure (a MUST on publishers) | shared A-12, A-13, P-1, P-4; adapter P-3 | met on the client side: a card that pre-sets a secret is refused, and so is a public card or catalog that names a local or private address |

### Where Antigravity differs

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | the polyfills' own (security review SC2) | W-4, E-4 | met: a name in `mcp_config.json`, in any case, or a file that can't be read, is refused before the question and again before writing |
| P-2 | A person approves every addition | the polyfills' own (security review SC4) | E-1, E-2, E-3, E-8, E-11, G-1, G-4, G-5, G-7, G-8 | met: `force_ask` whose first two lines name the server, URL, header names and file, and a one-use ticket for that entry (an hour at most, removed when the turn ends). Without the ticket nothing is written; a call through `call_mcp_tool` gets none. Seen live in CLI 1.5.17 (approved, declined, refused) |
| P-3 | Add only what was shown, as shown | the polyfills' own | E-3, E-4, E-7 | met: a card a tool showed in the last hour, at the URL it yields |
| P-4 | What the call's arguments say is what is written | the integrator's brief (an editor over `agy acp` shows only the arguments) | E-10 | met: `name`, `url`, `headers` (names) and `file` must match the entry, at the hook and again at the server |
| G-1 | The hook never denies or alters another server's call | the integrator's brief | G-3, E-5, H-1 | met: the matcher takes this plugin's eager `add_mcp_server` only; anything else, or input it can't read, gets `allow` and nothing else, without opening the state folder |
| N-3 | Values from the person's configuration are never shown | the polyfills' own | W-5 | met: a config that isn't JSON is refused without the parser's message, which can quote the file |
| — | Servers another plugin found (`present_server_cards`) | the Claude Code form's own | — | not in this form: Antigravity's ARD plugin carries its own `add_mcp_server` |

## Proof

Run from `polyfills/server-cards/antigravity`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026 (the builds from `a5bb64ce`), with
Node.js 22.23.1, passed **124 tests**, with none failed or skipped. They need
loopback access for their local web server, and use a throwaway `HOME`.

- **90 shared rule tests:** `card`, `configure`, `discover`, `format` and
  `offer` from [`claude-code/mod/tests`](../../claude-code/mod/tests).
- **34 adapter tests** in [`adapter.test.ts`](../test/adapter.test.ts): the
  plan in Antigravity's terms (P-1 to P-5), the file (W-1 to W-5), the gate
  (G-1 to G-10: tickets, their life, the `Stop` hook, `toolSummary`, the IDE),
  the hook's matcher and eager tool (H-1), the server and its hook run as
  Antigravity runs them, over stdio and as a command (E-1 to E-11, with the
  arguments an editor sees and a lazy call refused), and the bundle (B-1,
  byte-identical to a fresh build; B-2, the manifest meets Antigravity's
  schema and a copy of `plugin/` alone starts).

`agy plugin validate --strict` passes for `plugin/` (Antigravity CLI 1.5.17;
its one note is that there's no logo).

### Live, 25 November 2026

How the runs were made, and the full record:
[the Antigravity live-run record](../../../events/antigravity/docs/live-run.md#server-cards).

With these builds, in the real CLI 1.5.17 with a real model, against neon.com's
published Server Card: an addition approved while `agy mcp add` wrote another
server to the same file (both kept); one declined (nothing written); one
through `call_mcp_tool` (refused, nothing written).

With the earlier builds, in App 2.35.1 and CLI 1.5.16: `discover_mcp_servers`
for neon.com (2 valid cards); an approved addition the App then connected; in
the App the card showed the plugin's whole question and greyed out "always
allow", and **No** wrote nothing; headless `agy -p` denied the call nobody
could answer.

Not run: the App with these builds, the IDE (not supported), and a server
behind a sign-in after an addition.

The MCP conformance suite has no Server Card scenarios.
