# Conformance: the ARD client rules, for Copilot

This Copilot plugin implements the MCP Server Card consumer side of **ARD
v0.91**, a draft, pinned to commit `f073b1ea9b`: §5.1 (domain discovery),
§5.3 (registry search) and Appendix B (error codes). ARD isn't an MCP
specification. The pin is recorded in the [README](../README.md#spec-and-conformance).

Card checking follows SEP-2127, ext-server-card at `28db12c9b4`, and AI
Catalog v0.9 at `19208af2f8`, as described in the
[Server Cards Copilot form](../../../server-cards/copilot/docs/conformance.md).

## Client rules

The [ARD client rules](../../claude-code/README.md#client-rules) and
[Server Cards client rules](../../../server-cards/claude-code/README.md#client-rules)
describe the shared behaviour. The tools are the Codex form's
([`codex/src/ard.ts`](../../codex/src/ard.ts)), with Copilot's name and the
Server Cards Copilot form's add tool, which writes with `copilot mcp add`
([`src/main.ts`](../src/main.ts)). The registry client and address rules come
from [`ard/claude-code/mod/hooks`](../../claude-code/mod/hooks); the card,
catalog, cache, configuration, formatting and publisher checks from
[`server-cards/claude-code/mod/hooks`](../../../server-cards/claude-code/mod/hooks).

The shared tests run against this plugin's committed
[`plugin/dist/server.mjs`](../plugin/dist/server.mjs) ([`build.mjs`](../build.mjs)
selects them): ARD's registry tests (R-1 to R-7, P-1, L-1 to L-4) and the
Server Cards core's 90.

The rows below are Copilot's consent and host behaviour, and the limits that
qualify the shared rules. Q-1 to Q-6 follow the
[Codex ARD table](../../codex/README.md#client-rules). Tests marked **A-** are
in [`test/adapter.test.ts`](../test/adapter.test.ts) (the bundled server over
stdio as Copilot starts it, with a stand-in `copilot` and a local registry on
127.0.0.1); **Registry** means
[`registry.test.ts`](../../claude-code/mod/tests/registry.test.ts); **C-** and
**E-** are the [Server Cards Copilot tests](../../../server-cards/copilot/test/adapter.test.ts),
whose add flow this plugin bundles.

| Rule | Copilot status | How | Tests |
|---|---|---|---|
| Q-1: Say where the query went | met | The answer lists each endpoint contacted and its result or failure. The search tool's description says the query goes to a third party and that a registry's order is relevance, not trust. | Registry R-3; A-5, A-16 |
| Q-2: The person chooses the registry | met | No registry ships with the plugin. A `registry` argument comes before `ARD_DISCOVERY_REGISTRY`. With neither, the search is refused before any form or request, and Copilot is told to ask the person. | A-7 |
| Q-3: Every search is put to the person first, naming the query and the registry | met | Copilot's tool prompt before `ard_search` runs (unless the person allowed it), then the plugin's MCP elicitation form naming the endpoints and the exact query, and saying up to three referrals may receive it too. **Don't send it** comes first; only **Send the search** sends. No form support, decline, close, or a missing or different choice sends nothing. Copilot declines forms where nobody can be asked (`copilot -p`, with `--yolo` too, seen with the Server Cards form). `ard_search` is marked not read-only, since it sends the person's words to a third party: VS Code's Copilot harness ran a read-only tool without asking (`discover_mcp_servers`, from the Server Cards plugin; Copilot CLI 1.0.115 asked before it), and a search must not be one of them. `ard_search` itself was never run in VS Code. | A-3, A-4, A-11, A-19 |
| Q-4: What is sent is what was shown | met | The query is trimmed, shown and sent whole, at most 300 characters. Control characters, line breaks, direction marks, characters that show as nothing (tag characters, variation selectors, a soft hyphen, a blank Braille pattern: the shared `HIDDEN` set), backticks, angle brackets and square brackets are refused. A registry, named or set, is at most 200 characters, with no whitespace or hidden characters, and names no user before its host. | A-4, A-6, A-9, A-10, A-12, A-15, A-17 |
| Q-5: The query goes only where the form said | met | A search is never redirected to another origin, nor turned into a GET. Referrals are separate searches under the allowance the form states. | Registry R-3; F-5 in the [Codex form's tests](../../../server-cards/codex/test/adapter.test.ts), same fetch module |
| Q-6: A registry's own words are shown as one line, with nothing hidden | met | A registry's error text, a referral it won't follow, and result names and descriptions are one line, with hidden characters out and lengths capped. A result whose identifier holds a control or hidden character is skipped. | A-16, A-18; Registry L-1 to L-4 |
| Server Cards V-3: No text that displays as something else | met | A result whose card URL or remote URL holds Markdown is refused and never put in a form. The add flow's checks are the Server Cards Copilot form's: header markup and duplicates refused, a header value with hidden characters refused, shown text filtered. | A-8, A-10; C-5, C-8, C-9, E-10 |
| ARD B-1: Bounds | met | At most three registries and three referrals, one hop; 50 results read per answer and ten handed on. Answers capped, at most five redirects (the shared fetch module). | Registry R-7; F-4, F-6 in the Codex form, same module |
| ARD P-1: A public registry can't refer the client to a local or private address | exception | Literal private addresses and private host spellings are refused, at referrals and redirects. A public name that resolves to a private address isn't caught (no DNS check). | Registry P-1; F-1 to F-3 in the Codex form. No DNS-resolution test |
| ARD R-8: A claim to a publisher's name needs that publisher's attestation | exception | A result is confirmed only when its publisher's own catalog (including `ard.json`) lists the same identifier with a valid card; that card is the one shown and added. Unconfirmed results and their add form say so. Trust manifests and signatures aren't verified. | A-5; shared O-2 to O-4, O-8 in [offer.test.ts](../../../server-cards/claude-code/mod/tests/offer.test.ts) |
| Server Cards P-1 to P-5: never replace a server, a person approves every addition, add only what was shown, nothing read as an option, one value per header | met | `add_mcp_server` is the Server Cards Copilot form's: its own form, separate from the search's, naming the server, host, URL, headers, file and undo, then `copilot mcp add` with no shell. Only a card this session showed (by `ard_discover` or `ard_search`), at the URL it gives. | A-2, A-5; C-7, C-8, E-3 to E-5, E-9 |
| Server Cards I-2 to I-4 | met | As in the Server Cards Copilot form: secrets as `${VAR}` references named per card, Copilot's protocol revisions, streamable HTTP and SSE. | C-1 to C-3, C-6, E-6 |
| Server Cards S-3: Check the card's claims against the live connection | not met | As in every form: no `server/discover` comparison over Copilot's connection. | None |
| Server Cards H-1 to H-4 | n/a | There is no `present_server_cards` tool: discovery and search call the shared modules directly. | A-1 checks the three tools |

The plugin works alone. With `mcp-server-cards` installed too, each plugin has
its own `add_mcp_server`; Copilot keeps them apart by server name, and each
adds only what its own session showed.

Stand-down is manual: `ARD_DISCOVERY_DISABLED=1` registers no tools (A-14),
and `copilot plugin disable ard-discovery@agent-polyfill` stops the plugin.

## Against someone else's server (contract rule 3)

- **Domain discovery: met.** `ard_discover` read buildkite.com's own
  published `ard.json` and AI Catalog, which Buildkite wrote, in Copilot CLI
  1.0.115 (below).
- **Registry search: not met.** It has been run only against this
  repository's own [demo registry](../../claude-code/README.md#demo-registry),
  on 127.0.0.1, in the tests and in Copilot. No public ARD registry that takes
  an unauthenticated search was found, as for the other forms. The registry
  client is the shared one, whose rules the shared registry tests cover.

## Proof

Run from `polyfills/ard/copilot`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026, with Node.js 22.23.1, passed **124
tests**, none failed or skipped. The tests need loopback access.

| Tests | Count |
|---|---:|
| Shared ARD registry: R-1 to R-7, P-1, L-1 to L-4 | 12 |
| Shared Server Cards core: `card`, `configure`, `discover`, `format`, `offer` | 90 |
| This form: A-1 to A-20 | 20 |
| Bundle: the committed bundle is what the sources build; the installed folder | 2 |
| Total | 124 |

**In Copilot itself** ([the record](live-run.md)), 25 November 2026, Copilot CLI 1.0.115 on macOS, with an
isolated `HOME` and `COPILOT_HOME`, no GitHub sign-in, and a scripted stand-in
model on this machine (it called the tools the script named; it wasn't a model
choosing them):

- Installed from a clone of this repository as a marketplace, beside
  `mcp-events` and `mcp-server-cards`; uninstalled the same way (what stays
  behind is in the [README](../README.md#uninstall)).
- `ard_discover` for buildkite.com read `ai-catalog.json` and `ard.json` (one
  entry each) and returned Buildkite's valid card.
- In the TUI, against the [demo registry](../../claude-code/README.md#demo-registry)
  on 127.0.0.1, so no query left the machine: Copilot's tool prompt, then the
  form. **Send the search** posted the query, and the result listed Buildkite
  and Netlify, both confirmed by their publishers.
- A search with no registry named or set was refused, naming
  `ARD_DISCOVERY_REGISTRY`, and nothing was sent.

**In VS Code's Copilot harness** (VS Code 1.147.0, in the throwaway VS Code profile of [mcp-events' VS Code run](../../../events/copilot/docs/live-run.md#in-vs-code)), the plugin's MCP
server was started and connected. No search or add was run through it there.
The add form is the Server Cards form, which VS Code showed and answered in
that harness (the [Server Cards Copilot proof](../../../server-cards/copilot/docs/conformance.md#proof));
the search form is the same kind of request (an MCP elicitation form).

What this evidence doesn't establish:

- A search sent to a public registry from Copilot, or an add through
  `ard_search` in Copilot itself (both covered by the tests over stdio).
- A search or an add through this plugin in VS Code.
- An install from GitHub, which works only once the plugin is on the
  repository's default branch.
- A DNS check, trust manifests or signatures (ARD P-1 and R-8 above).
- An upstream conformance pass: the MCP conformance suite has no Server Card
  or ARD scenarios.
