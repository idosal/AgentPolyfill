# Conformance: the ARD client rules, for Pi

This Pi extension implements the MCP Server Card consumer side of **ARD
v0.91**, a draft, pinned to commit `f073b1ea9b`: §5.1 (domain discovery),
§5.3 (registry search) and Appendix B (error codes). ARD is not an MCP
specification. The pin is recorded in the [README](../README.md#spec-and-conformance);
[`src/index.ts`](../src/index.ts) identifies the implementation as the v0.91
draft and supplies its `ard.json` and `rel="ard"` discovery sources.

Card checking follows SEP-2127, ext-server-card at `28db12c9b4`, and AI
Catalog v0.9 at `19208af2f8`, as described in the
[Server Cards Pi form](../../../server-cards/pi/README.md#spec-and-conformance).

## Client rules

The [ARD client rules](../../claude-code/README.md#client-rules) and
[Server Cards client rules](../../../server-cards/claude-code/README.md#client-rules)
describe the shared behavior. Pi imports the registry client and address
rules from [`ard/claude-code/mod/hooks`](../../claude-code/mod/hooks), and
the card, catalog, cache, configuration, formatting and publisher checks
from [`server-cards/claude-code/mod/hooks`](../../../server-cards/claude-code/mod/hooks).
It reuses the [Server Cards Pi host and add flow](../../../server-cards/pi/src).

For domain discovery, the shared code covers W-1 to W-6: both well-known
catalogs, `rel="ard"` links, manifests without `specVersion`, exactly one
of `url` and `data`, and deduplication by identifier. The shared discovery
tests are D-1 D-2, D-5, D-6, D-7 and D-9. Registry tests R-1 to R-7 cover
endpoint construction, the POST body, referrals, result selection, relevance
ordering, errors and bounds; P-1 covers private referral addresses. Publisher
tests O-2 to O-5 and O-8 cover the catalog confirmation used for R-7 and R-8
of the ARD rule table. Test IDs and rule IDs are separate: registry test R-7,
for example, tests bounds, not the publisher identifier rule.

These tests run against Pi's committed
[`extension/dist/index.js`](../extension/dist/index.js).
[`build.mjs`](../build.mjs) selects the shared test files; the
[shared build helper](../../../server-cards/pi/build.mjs) redirects their
source imports to that bundle. It also runs the Server Cards Pi adapter and
network tests against the ARD bundle. The shared configuration tests still
exercise the shared planner; Pi's CLI arguments and writes are checked by
the Pi adapter and RPC tests.

The rows below describe Pi's consent and host behavior, and the limits that
qualify the shared rules. Q-1 to Q-6 use the numbering in the
[Codex ARD table](../../codex/README.md#client-rules); its Q-6 is Q-4 in the
Claude Code ARD table. Other IDs are qualified by their rule table.

Tests marked **Pi** are in [`test/ard.test.ts`](../test/ard.test.ts).
**Registry** means [`registry.test.ts`](../../claude-code/mod/tests/registry.test.ts),
**adapter** means [`adapter.test.ts`](../../../server-cards/pi/test/adapter.test.ts),
and **network** means [`network.test.ts`](../../../server-cards/pi/test/network.test.ts).
Shared card test filenames refer to
[`server-cards/claude-code/mod/tests`](../../../server-cards/claude-code/mod/tests).
All of these run in this form's suite.

| Rule | Pi status | How | Tests run against the Pi bundle |
|---|---|---|---|
| Q-1: Say where the query went | met | The answer lists each contacted endpoint and its result or failure. The search description warns that the query goes to a third party and that ranking is relevance, not trust. | Registry R-3 records the contacted endpoints; Pi A-10 checks a displayed failure. The complete displayed endpoint list is checked in `src/index.ts`, without a dedicated Pi assertion. |
| Q-2: The person chooses the registry | met | No registry is supplied by default. A `registry` argument takes precedence over `ARD_DISCOVERY_REGISTRY`. With neither, Pi refuses before asking or making a request. | Pi A-1; A-4 searches an explicitly named registry. Setting and override precedence are checked in `registrySetting` and `tools`, without a dedicated precedence test. |
| Q-3: Every search is put to the person first, naming the query and the registry | met | `ctx.ui.select` names the normalized endpoints and query, and says up to three referrals may also receive it. **Don't send it** is first; only **Send the search** permits the POST. The call is refused with no UI, or on decline, close, a different answer, dialog failure or cancellation. Resolving a registry named by domain can make catalog GETs before consent; those carry no query. `ard_search` is marked as not read-only (`readOnlyHint: false`), since it sends the person's words to a third party, and Pi's permission extensions read that hint. | Pi A-1, A-2, A-4; adapter P-5 tests failure and cancellation in the shared `askPerson` helper. The real search RPC cases are listed below. Domain resolution before consent is checked in code, not a dedicated Pi test. |
| Q-4: What is sent is what was shown | met | The query is trimmed, then shown and sent whole, with a limit of 300 characters. Controls, line breaks, invisible and direction marks, backticks, angle brackets and square brackets are refused. The registry argument or setting is trimmed, limited to 200 characters and refused if it contains whitespace or hidden characters. Tag characters, variation selectors and soft hyphens are included in the hidden-character check. | Pi A-2, A-3, A-9, A-11; A-4 checks the exact POST body. The full-length accepted query and registry-setting rejection paths are checked in code, not separate boundary tests. |
| Q-5: The query goes only where the form said | met | A search redirect cannot change origin or turn the POST into a GET. Same-origin 307/308 redirects preserve the request. Referrals are separate searches under the allowance stated in the question. | Network F-5; registry R-3. |
| Q-6: A registry's own words are shown as one line, with nothing hidden | met | Registry error text, rejected referral text, result names and descriptions have hidden characters replaced and whitespace collapsed, with length caps. An identifier containing a control or hidden character is skipped. | Pi A-10, A-12; registry L-1 to L-4. |
| Server Cards V-3: No text that displays as something else | met | Registry endpoints with markup or userinfo are refused before the question. Shared card and catalog checks reject misleading URLs. The Pi adapter also refuses misleading header markup and hidden header values; displayed card text passes the shared plain-text filter. | Pi A-3; adapter P-3, P-10, P-11; `card.test.ts` X-4, X-5; `discover.test.ts` P-6, P-7; `offer.test.ts` O-9, O-10. |
| ARD B-1: Bounds | met | At most three initial registries and three referrals, one hop; 50 results read per answer and ten handed on. Responses are capped at 512 KiB; a parsed card is limited to 64 KiB. Fetches follow at most five redirects. Publisher checking stops after five valid results with a publisher domain. Catalog discovery limits nesting to depth four, reads at most 200 entries, fetches at most 20 card URLs and follows at most three catalog links from a page. | Registry R-3, R-7; network F-4, F-6; `offer.test.ts` O-7; `discover.test.ts` D-8, D-12, D-14. The three-referral, five-publisher-check, 200-entry and 20-card caps are checked in code; these tests do not exercise each cap. |
| ARD P-1: A public registry can't refer the client to a local or private address | exception | Literal private addresses and private host spellings are refused, including at document redirects. DNS resolution is not checked, so a public hostname resolving to a private address is not covered. Closing that gap needs address checks in the fetch adapter. | Registry P-1; network F-1 to F-3. No DNS-resolution test. |
| ARD R-8: A claim to a publisher's name needs that publisher's attestation | exception | Confirmation uses the publisher's own catalogs, including `ard.json`, and only a matching identifier with a valid card confirms a result. That publisher's card is then shown and added. Trust manifests and signatures are not verified; catalog confirmation is the implemented limit. Unconfirmed results and their add questions say so. | `offer.test.ts` O-2 to O-4, O-8; Pi A-4 checks the unconfirmed add question. No signature-verification test. |
| Server Cards P-2: A person approves every addition | met | `ard_add_mcp_server` has its own **Add it** question, separate from search consent. It names the host, URL, headers, user `mcp.json` file and undo command. Only a valid card shown in this session with the matching planned URL can be added. Acceptance runs Pi's own `mcp add`, then registers the server for the session. | Pi A-1, A-4; adapter P-4 to P-6, P-9; the real RPC cases below. |
| Server Cards P-1: Never replace a server the person has | exception | Existing names and unreadable configuration are refused before and after consent, and concurrent adds through this session are blocked. A name that differs from one of the person's only in `-` and `_` counts as theirs. The final check and CLI write are separate operations; another process can still race them. An atomic add-if-absent operation is needed to close that limit. | Adapter P-6, P-7, P-12. No test proves exclusion of an external process between the final check and write. |
| Server Cards I-2: Handle `isSecret` values securely | exception | Secret headers use generated `${VAR}` references; model-supplied secret values are ignored. URL secrets are refused because Pi expands environment variables in headers, not URLs. | Adapter P-2, P-3, P-9; `RPC: secret header stays a reference in mcp.json; Pi expands it only when connecting`. |
| Server Cards I-3: Choose a remote by its `supportedProtocolVersions` | met | The shared planner uses Pi's protocol-version list, and refuses a remote with no compatible version. | Adapter P-1, P-3; the accepted discovery RPC case below checks Pi's `initialize` version. |
| Server Cards I-4: Transport `streamable-http` or `sse` | exception | The Pi adapter accepts Streamable HTTP and refuses SSE, because its Pi integration connects Streamable HTTP servers only. SSE needs host and adapter support. | Adapter P-1, P-3; accepted RPC additions connect to the local Streamable HTTP fixture. |
| Server Cards S-3: Check the card's claims against the live connection, preferring the runtime values | not met | The adapter saves and registers the server but does not compare its card with live `server/discover` values. It would need that comparison through Pi's connection and to prefer runtime values. | None. Observing `initialize` and `tools/list` in the RPC tests does not test card comparison. |
| Server Cards H-1 to H-3: a hand-over's entries, who stands behind a server, and confirmation by the publisher's catalog | n/a, as rules of a hand-over | This form has no hand-over tool. The publisher confirmation of R-8 above uses the same shared offer reader. | `offer.test.ts` O-1 to O-5, O-8. |
| Server Cards H-4: Only another plugin can hand cards over | n/a | This form has no `present_server_cards` tool. Discovery and search call the shared modules directly and keep their checked cards in the Pi session. | Pi A-1 checks the three exposed tool names; the direct calls are in `src/index.ts`. |

The add tool is named `ard_add_mcp_server` because Pi shares tool names across
extensions and keeps the first registration under a name. The Server Cards
Pi form registers `add_mcp_server`. ARD's distinct name keeps its add tool
attached to the cards its own session showed. Pi A-1 checks the name;
`src/index.ts` and the Server Cards Pi `addTool` implement it. Pi 1.6.0's
`ExtensionRunner.getAllRegisteredTools` confirms the first-registration
behavior. The suite does not load both forms together to test coexistence.

## Proof

`npm test` in `polyfills/ard/pi` runs **140 tests**. Checked with Node.js
22.22.1 and Pi 1.6.0. The suite needs permission to listen on loopback. The
count is:

| Tests | Count |
|---|---:|
| Shared ARD registry: R-1 to R-7, P-1, L-1 to L-4 | 12 |
| Shared Server Cards core: `card.test.ts` (14), `configure.test.ts` (26), `discover.test.ts` (35), `format.test.ts` (5), `offer.test.ts` (10) | 90 |
| Server Cards Pi adapter P-1 to P-13 and network F-1 to F-6 | 19 |
| Pi `ard.test.ts`: A-1 to A-4, A-9 to A-12, and three registry RPC cases | 11 |
| Pi `rpc.test.ts`: three discovery/add cases, one print/JSON case and one secret-header case | 5 |
| Pi `lifecycle.test.ts` | 2 |
| Pi `bundle.test.ts` | 1 |
| Total | 140 |

There are no A-5 to A-8 tests in Pi's `ard.test.ts`. The shared tests keep
their original IDs and names; they are not the Claude Code registration or
UI tests.

The real host tests run **Pi 1.6.0**, pinned in
[`package.json`](../package.json). Their
[local fixture](../../../server-cards/pi/test/harness.ts) serves both
well-known catalogs, a card, a registry endpoint and MCP. No model account or
external registry is needed for these tests.

- In `ard.test.ts`, `RPC ARD registry search and addition: yes`,
  `RPC ARD registry search and addition: no search`, and
  `RPC ARD registry search and addition: no add` check the search question,
  accepted and declined searches, a separate add question, and whether
  `mcp.json` was written. The accepted addition waits for Pi's `tools/list`
  request. A-4 separately asserts the exact search POST body, including
  `query.text`, the Server Card filter, `federation: "referrals"` and
  `pageSize: 10`.
- In [`rpc.test.ts`](../test/rpc.test.ts),
  `RPC: ard_discover then add, answer Add it; actual Pi CLI and connection`,
  `RPC: ard_discover then add, answer Don't add it; actual Pi CLI and connection`,
  and `RPC: ard_discover then add, answer undefined; actual Pi CLI and connection`
  load a copy of `extension/` on its own. They check acceptance, decline and
  closing the question. Acceptance writes the configuration and
  connects without a reload; the test checks Pi's `initialize` request uses
  protocol version `2025-11-25` and waits for `tools/list`. Decline and close
  leave no configuration file or MCP connection.
- `real Pi print/JSON mode refuses addition because nobody can be asked`
  checks an actual noninteractive Pi run. Search without UI is covered by
  A-2 and the shared helper, not a separate real print-mode search test.
- `RPC: secret header stays a reference in mcp.json; Pi expands it only when connecting`
  checks that the file and question retain the reference while the local
  MCP connection receives the test value.
- [`lifecycle.test.ts`](../test/lifecycle.test.ts) contains
  `stand-down: the actual factory registers nothing when disabled` and
  `a session_start clears previously shown cards, including resume and fork`.
  The latter invokes the handler directly; it is not a real resume/fork run.
- [`bundle.test.ts`](../test/bundle.test.ts) contains
  `bundle: committed extension/dist/index.js is byte-identical to a fresh build`.
  It builds into a temporary directory and checks the extension manifest too.

### Not checked

Checked in Pi 1.6.0: reading buildkite.com's published `ard.json` and AI
Catalog, and a search of the repository's local demo registry. The accepted
additions above are against a local MCP fixture.

No independent public-registry interoperability check or upstream conformance
pass is claimed for Pi. The registry and MCP server in the tests are
repository fixtures. Not checked: an addition outside the local fixtures, or
OAuth sign-in. No live card comparison,
DNS-resolution protection, atomic CLI add-if-absent, or automatic detection
of native ARD support is implemented or tested. The row-specific test limits
above also apply; a passing total does not establish those missing checks.
