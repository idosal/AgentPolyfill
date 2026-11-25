# Conformance: ARD and Server Cards client rules, for Antigravity

The Antigravity plugin implements:

- **ARD v0.91**, a draft published by the
  [ards-project](https://github.com/ards-project/ard-spec) on GitHub, outside
  MCP, at commit
  [`f073b1ea9b`](https://github.com/ards-project/ard-spec/tree/f073b1ea9b):
  §5.1 (domain discovery: `ard.json` and `rel="ard"`), §5.3 (registry
  search) and Appendix B (error codes), for MCP Server Cards only. It is not
  an MCP specification.
- MCP Server Cards ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9,
  for the cards it finds. Those rules, with this plugin's bundled code, are in
  [`mcp-server-cards` for Antigravity's table](../../../server-cards/antigravity/docs/conformance.md).

## Client rules

One row for each rule ARD v0.91 puts on a consumer of MCP Server Cards, with
the test in this form's suite that covers it. "shared registry" tests are
[`claude-code/mod/tests/registry.test.ts`](../../claude-code/mod/tests/registry.test.ts);
"shared cards" tests are the Server Cards rule tests from
[`server-cards/claude-code/mod/tests`](../../../server-cards/claude-code/mod/tests);
"adapter" tests are this form's [`adapter.test.ts`](../test/adapter.test.ts).
This form's `npm test` runs all three, built from the same sources as its
committed [`plugin/dist/server.mjs`](../plugin/dist/server.mjs). The search
code is the Codex form's ([`../../codex/src/ard.ts`](../../codex/src/ard.ts)).

### Domain discovery (§5.1)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| W-1 | Fetch `https://{domain}/.well-known/ard.json` | §5.1 (MUST) | adapter R-7; shared cards D-1 D-2 | met |
| W-2 | Honour `rel="ard"` links, in a `Link` header or a `<link>` tag | §5.1 (MUST) | shared cards D-7, D-13, D-15 | met |
| W-3 | `/.well-known/ai-catalog.json` may be read as well | §5.1 (MAY) | shared cards D-1 D-2 | met: always read |
| W-4 | An `ard.json` manifest need not carry an AI Catalog `specVersion` | ARD manifest | adapter R-7; shared cards D-9 | met |
| W-5 | An entry carries `url` or `data`, never both | §4.3 (MUST NOT carry both) | shared cards D-5 | met |
| W-6 | The same `identifier` in `ard.json` and `ai-catalog.json` is one server | AI Catalog | shared cards D-6 | met |

### Registry search (§5.3)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| R-1 | A registry entry's `url` is a base URL, and the client appends `/search` | §5.3 | shared registry R-1 | met |
| R-2 | `POST /search` with `query.text` (required), `filter` and `federation` | §5.3.1, §5.3.2, §5.4 | shared registry R-2 | met: `filter.type` is the Server Card type; `federation` is `"referrals"`, so the client decides which referrals to follow |
| R-3 | A referral's `url` is the complete search endpoint, and the client MUST NOT append `/search` | §5.3 (MUST NOT) | shared registry R-3 | met: one hop, at most three referrals |
| R-4 | A result MUST carry `identifier`; its `url` addresses the artifact (the card), not the ARD entry | §5.3.2 | shared registry R-4 | met: results without one are skipped, and each card is fetched and checked with the Server Cards rules |
| R-5 | `score` is relevance only, and MUST NOT be read as trust | §5.3.2, §5.3.3 (MUST NOT) | shared registry R-5 | met: it orders the results as the registry ranked them, and is used for nothing else |
| R-6 | Standard error codes | Appendix B | shared registry R-6 | met: reported as `HTTP <code> (<errorCode>: <message>)` |
| R-7 | The publisher is the `<publisher>` domain of `urn:air:<publisher>:…` | Appendix C | shared cards O-5 | met |
| R-8 | A claim to a publisher's name needs that publisher's attestation | §4.5.1 | shared cards O-2 to O-4, O-8; adapter R-6 | partly: trust manifests aren't verified. The publisher's own catalogs are read instead, and a result is confirmed only if they list the server (seen live: Hugging Face's registry's results came back marked not confirmed) |

### This plugin's own rules

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| Q-1 | Say where the query went | the polyfills' own | adapter R-3 | met: every result names each registry asked (seen live: "The query text was sent to: huggingface-hf-discover.hf.space") |
| Q-2 | The person chooses the registry | the polyfills' own | adapter R-5 | met: none is set by default; with none named, the hook denies and nothing is sent |
| Q-3 | Every search is put to the person first, naming the query and where it goes | the polyfills' own (security review M2) | adapter R-2, R-3, R-10 | met where the hook's question is shown: `force_ask` whose first line names the endpoints (and that up to three referrals may be followed) and whose second line is the query, and a one-use ticket for them; without it, nothing is sent (seen live, CLI 1.5.17: approved, declined, around the hook). In an editor connected to `agy acp`, which shows only the tool's arguments, the person sees the query and the registry argument, not the endpoints or the referrals |
| Q-4 | What is sent is what was shown | the polyfills' own (R1, C1) | adapter R-4, R-5, R-11 | met: the ticket is for that query and those endpoints; at most 300 characters, one line, no hidden characters or markup |
| V-3 | A registry's own words are shown as one line, with nothing hidden | the polyfills' own | shared registry L-1 to L-4; adapter R-11, R-12 | met: error messages, referrals, result names and descriptions are one line, capped, with control and hidden characters out; a result whose identifier hides a character is skipped |
| P-1 | A public registry can't refer the client to a local or private address | the polyfills' own | shared registry P-1 | met |
| B-1 | Bounds | the polyfills' own | shared registry R-7 | three registries, three referrals, 50 results read per answer, 10 handed on, 512 KiB per answer |
| A-1 | An addition is put to the person, as in `mcp-server-cards` | the polyfills' own | adapter R-6, R-7 | met: the same gate, question and arguments rule (name, URL, header names and file in the call) |
| G-1 | The hook never denies or alters another server's call | the integrator's brief | adapter R-8, R-10 | met: the matcher takes this plugin's eager `ard_search` and `add_mcp_server` only; a lazy call of them gets no ticket and is refused |

## Proof

Run from `polyfills/ard/antigravity`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026 (the builds from `a5bb64ce`), with
Node.js 22.23.1, passed **115 tests**, with none failed or skipped:

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

`agy plugin validate --strict` passes for `plugin/` (Antigravity CLI 1.5.17).

### Live, 25 November 2026

How the runs were made, and the full record:
[the Antigravity live-run record](../../../events/antigravity/docs/live-run.md#ard).

With these builds, in the real CLI 1.5.17 with a real model, against a
registry someone else runs: Hugging Face's own, listed in huggingface.co's AI
Catalog as `application/ai-registry+json`
(`https://huggingface-hf-discover.hf.space`). Approved, the query went to
that registry's `/search` only and three results came back, each marked not
confirmed by its publisher. Declined: nothing sent. Through `call_mcp_tool`:
refused, nothing sent. The same three in the real App 2.35.1, whose card
showed the plugin's whole question (the endpoints, the referrals, the query,
and that the registry sees it). Public registries also answer at
ardregistry.org and ardregistry.net.

With the earlier builds, in CLI 1.5.16: `ard_discover` for buildkite.com read
its `ard.json` (one valid card); a search over `agy acp`, against this
repository's local demo registry, was sent only after the approval and found
Buildkite, confirmed by its publisher.

Not run: an ARD addition in the App (the same add as `mcp-server-cards`, run
there), and the IDE (not supported).

The MCP conformance suite has no ARD or Server Card scenarios.
