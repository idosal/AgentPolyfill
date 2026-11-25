# SEP-2640 client rules in Antigravity

Revision: **Final, commit `2eb3a8e`**, [published specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md).
Rule IDs follow the [Codex table](../../codex/docs/conformance.md). This table
describes Antigravity adapter 0.1.0. It does not claim full conformance.

“Met” describes this adapter's tested behavior. “Limit” identifies a host or
implementation boundary; “not met” is an unmet rule. The live runs in
Antigravity (below, and [the record](../../../events/antigravity/docs/live-run.md#skills))
showed the host delivering the hooks, the tool names and `overwrite` as this
table assumes.

Test references:

- **rules**: [client-rules.test.ts](../test/client-rules.test.ts), ported
  from Codex and run against this adapter and its real gate handlers.
- **adapter**: [adapter.test.ts](../test/adapter.test.ts), configuration,
  discovery folders, hook/ticket behavior and the installed bundles.
- **verification**: [verification.test.ts](../test/verification.test.ts),
  additional integrity, freshness, limits and unsafe text checks.

The fixture is the hand-written server in
[`../core/test-fixtures`](../../core/test-fixtures), with no core
implementation imports. The runtime imports and bundles the
shared core and reusable Codex functions; no copy of the core is maintained.

## Capability negotiation and representation

| ID | Client rule | Status and evidence |
|---|---|---|
| C1 | Send Skills requests only after a declaration, with resources. | Met. rules C1 checks missing, misplaced, invalid and legacy declarations. The hook checks the declaration on its independent connection too. |
| C2 | Require `directoryRead: true` before directory requests. | Met. rules C2, C2/Y4. |
| G1 | `skills/get` takes a SKILL.md URI. | Met. rules G1; adapter E-6. |
| S2 | Read pagination cursors. | Met. rules S2. Core bounds listings at 64 pages / 2,000 entries per server; a later skill remains loadable by URI. |
| S4 | Treat TTL and cache scope as freshness hints. | Met. rules S4. Listings refresh after TTL with a ten-second floor. Loads get fresh metadata regardless of TTL. No cross-user content cache. |
| F1 | Follow Agent Skills compatibility mechanisms. | N/a: none defined at this revision. Frontmatter is preserved and compared. |
| R1 | Never resolve a skill URI authority. | Met. rules R1. Only the origin server receives that URI. |
| R2 | A `skill://` URI alone is not a skill. | Met. rules R2; an entry from the declaring server is required. |
| S1 | Support skills absent from a partial listing by URI. | Met. rules S1. Hook and server use `skills/get`. |
| E1 | Refuse invalid/missing `resources`. | Met. rules E1. No stub, approval or content. |
| E2 | Treat size mismatch as verification failure. | Met. rules E2/V1/V2. |
| E3 | MAY decline dynamic content. | Met. Accepted within limits, called unverifiable, asked about on every load; rules E3. |
| L1 | Support 512 resources and 16 MiB per skill. | Met. shared core, rules L1/L2. |
| L2 | Explain a limit refusal. | Met. rules L1/L2, adapter E-6; refused from metadata before file retrieval. |
| L3 | Bound dynamic retrieval by total size. | Met. verification L3 exercises cumulative reads beyond 16 MiB. |
| M1 | Ignore unknown reserved metadata keys. | Met. rules M1. |
| M2 | Use the extension prefix for resource metadata. | Met: adapter adds no resource `_meta` keys. Core/wire only supplies protocol metadata. |

## Identity and names

| ID | Client rule | Status and evidence |
|---|---|---|
| U1, U2 | Key identity by server and URI. | Met. rules U1/U2/U3, U1; approvals, shared metadata, held entries and every file call keep both. |
| U3 | Materialized paths encode origin and URI. | Met. No content materialized; even metadata stubs encode both. adapter S-1/S-2. |
| N1, N2 | Do not assume unique names; disambiguate. | Met. rules N1/N2. URI hashes distinguish same-name entries. |
| N3 | Use host-assigned per-origin namespaces. | Met. rules N3/N4/X7. Exact config label determines identity; readable folder labels are shortened, hashes preserve exact labels. |
| N4 | Never shadow another origin's skill. | Met within generated names: each has the plugin prefix and origin/URI hashes. A deliberately identically named local folder is in the plugin's documented reserved shape. rules N3/N4/X7, adapter S-1. |
| X7 | Use the host label, not `serverInfo.name`. | Met. rules N3/N4/X7. |
| X9 | SHOULD surface name collisions. | Limit. Same-server collisions are marked in `list_skills` (rules N1/N2); local skill collisions are not inspected. Host needs to expose its full namespace. |

## Reading, caching and verification

| ID | Client rule | Status and evidence |
|---|---|---|
| D1 | Reading SKILL.md through another route does not load it. | Met. rules D1/V4, X10/R3. Only a gated load creates a held entry. |
| D2 | Such reads are ordinary resource reads. | Met. The plugin does not alter host resource tools; nested file text is explicitly ordinary supporting content. rules X10/R3. |
| D3 | Resolve relative references against the skill root. | Met. rules D3 refuses traversal and other roots. |
| V1, V2 | Verify digests before using files; discard mismatches. | Met. rules E2/V1/V2. Nothing of failed text is returned. |
| V3 | Recover from stale listings with `skills/get`. | Met. rules V3; this adapter refreshes metadata before the question and again before content. Core also guards retry against the expected manifest. |
| V4 | Read only the held manifest's URIs. | Limit. Enforced by this plugin, per conversation: rules D1/V4 and V4/V5/Y1/Y3, verification W1/V4/Y2. Other host resource tools cannot be constrained by this adapter without active-skill provenance. |
| V5 | An unlisted file is a verification failure. | Met. rules V4/V5/Y1/Y3; no upstream request for that file. |
| V6 | Compare all frontmatter fields with the entry. | Met. shared core and rules V6. |
| V7 | Fetch files lazily, never at connection/listing/approval. | Met. rules V7, adapter E-1/E-2/E-4. Hook metadata contains no file text. |
| V8 | SHOULD cache retrieved files only for the same digest. | Limit. In-memory cache per conversation, no persistent content cache. rules V8, verification W1/V4/Y2. Host lifecycle support would preserve it safely across process restarts. |
| V9 | Digest match means consistency, not trust. | Met. rules V9 and shared content formatting. |
| W1 | Hold the loaded entry while SKILL.md remains in context. | Limit. Held per ticket-identified conversation while this MCP process lives. verification W1/V4/Y2. On restart, further reads fail until another gated load; host context lifecycle support is needed. |
| Y1, Y2, Y3 | Directory reads cannot extend a held manifest. | Met. rules V4/V5/Y1/Y3 and verification W1/V4/Y2; static directories are synthesized from that entry. |
| Y4 | Surface directory support to the model. | Met. rules C2/Y4 and the `list_skill_directory` tool. |

## Security and consent

| ID | Client rule | Status and evidence |
|---|---|---|
| X1 | Treat server content as untrusted. | Met. rules X1/X3/X4; verification X1. Descriptions are cleaned; content is origin-tagged and fenced with random markers, hidden characters are counted. |
| X2 | Treat skills as higher risk than ordinary tools. | Met. A new version requires `force_ask` before any text read; adapter E-1/E-2. |
| X3, X4 | Tag origin and distinguish from local skills. | Met. rules X1/X3/X4, adapter S-1. |
| X5 | Ignore permission-widening fields; require explicit per-skill consent before execution on its behalf. | Limit. Loading requires consent and frontmatter grants nothing (rules X5, X10/R3). Subsequent actions use host permissions; the plugin cannot enforce stricter execution policy across host tools. Native skill provenance is needed. |
| X6 | A's skill does not read from B. | Met within the plugin. rules X6; identity includes server on every call. |
| X8 | Gate cross-origin reads with per-call consent naming both origins. | **Not met in the CLI.** Once a conversation holds a served skill, the hook answers `force_ask` to Antigravity's `read_resource` from any other server, naming both (shared-fixes X8, through the bundle's hook). In CLI 1.5.17 the CLI shows no question for that answer and the read goes ahead (seen live: the hook's `force_ask` logged, the other server served the read 0.6 s later). The App is still to check. It can't tell which skill caused a read, as in Pi and OpenCode. Host change: honour `force_ask` for every tool, or expose active-skill provenance on resource reads. |
| X10 | Never honor `allowed-tools` or equivalent permission grants. | Met. rules X10/R3; stubs have only name and description. |
| X11 | Served resources gain no authority; user policy decides loading. | Limit. Content is a tool result; host rules can govern the tools, and plugin settings can exclude servers (verification Settings skip). No effective per-skill policy API is available; hiding a local stub does not revoke a load. |
| R3 | Reading nested SKILL.md as a file is not activation. | Met. rules X10/R3. |
| R4, X12 | Nested skills need separate approval. | Met. rules R4/X12. The question identifies nesting when the catalog contains the outer skill. |
| X13a | Show the origin server. | Met. rules X13a/c and X1/X3/X4. |
| X13b | SHOULD allow inspection before loading. | **Not met** as a private in-host preview. The yes/no card offers origin, URI, description, counts, and the option to decline and inspect publisher source outside the model. rules X13a/c verifies no preview text escapes. A private preview surface or elicitation is needed. |
| X13c | MAY gate loading per skill. | Met. All loads require a ticket, including previously approved versions. adapter E-1/E-2. |
| X14 | Persist approval only for the complete set of addresses/digests; revoke on change; exclude dynamic skills. | Met. rules X14, verification X14, adapter E-1/E-4. Also bound to server location; question and load metadata must agree. Dynamic loads always ask. Approval is saved only after successful verification. |
| X15 | Keep disk content caches outside discovery, preserving origin and integrity. | Met by not having one. rules X15, adapter S-1/S-2: only catalog metadata and plugin-authored stubs, no skill file content. |

## Host integration and protocol metadata

| ID | Client rule | Status and evidence |
|---|---|---|
| H1 | Guideline: surface enabled skills, provenance, inspection and enable/disable. | Limit. Stubs expose served skills; tests verify shape, not live host discovery. Server allow/skip settings work, but per-skill host policy and private inspection need host APIs. |
| C3 | Beta-page rule: request metadata on 2026-07-28. | Met. rules C3 checks protocol version and this adapter's clientInfo on Skills/resource requests. |

## Adapter checks and external evidence

The hook tests use the actual shared gate without modifications. The matcher
test checks the eager names, `read_resource`, and excludes `call_mcp_tool`
and other plugin/key namespaces. The server refuses a missing, expired,
replayed or mismatched ticket. A hook input it can't read gets `allow` and
nothing else, with exit zero (in CLI 1.5.17 a hook that exits non-zero fails
the call); the plugin's own call then carries no ticket and the server
refuses it. Supporting reads get `allow` tickets, never plugin questions.
What Antigravity itself does with these answers is in the live section.

`B-1` compares the committed bundle with a fresh build. `B-2` checks manifest
fields and copies only `plugin/` to a temporary folder, then lists tools and
loads verified content through that copy's hook and server.

## Proof

Run from `polyfills/skills/antigravity`, with Node.js 22.18 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026 (the builds from `a5bb64ce`), with
Node.js 22.23.1, passed **69 tests**, with none failed or skipped: 37
client-rule tests (`client-rules.test.ts`), 19 adapter tests
(`adapter.test.ts`: config, placeholders, the gate, the matcher, the bundle),
8 verification tests (`verification.test.ts`) and 5 in `shared-fixes.test.ts`
(media types, control characters, secrets cleaned then scrubbed in the
question, placeholders, listings and answers, URL query values, placeholder
permissions, and rule X8). `agy plugin validate --strict` passes for `plugin/`.

### Live, 25 November 2026

How the runs were made: [the record](../../../events/antigravity/docs/live-run.md#how-the-runs-were-made).

With these builds, in the real Antigravity CLI 1.5.17 with a real model,
against a local skills server (this repository's fixture, serving one skill
in three versions):

- a new skill's load asked (the card showed the question's first two lines);
  approved, its text came back verified;
- the server then served a changed version: the load asked again;
- an unchanged approved version got only Antigravity's own question;
- a declined load: the server got no file read;
- a load through `call_mcp_tool`: refused, no ticket;
- rule X8: as in the table, the hook asked and the CLI didn't show it.

With the earlier builds, in App 2.35.1 and CLI 1.5.16, against Hugging Face's
public MCP server (`https://huggingface.co/mcp`, no account, a server this
project didn't write): `list_skills` wrote 25 placeholder folders, and a fresh
conversation found the right one by itself; a headless load nobody could
answer was denied; a load approved over `agy acp`, and one in the App's card
(which showed the plugin's question), came back verified.

Not run: the App with these builds; the IDE (not supported).

### Upstream suite

The MCP conformance suite's four Skills client scenarios
(`sep-2640-client-no-prefetch`, `-verify-digest`, `-verify-size`,
`-verify-frontmatter`), at `c8625de3118c2d5dc0561696cddeb0baaf124f2c` (the
revision the other forms used), run on 25 November 2026 and again with the
builds from `a5bb64ce`: **all four pass**. The suite's client is
`test/interop.ts`, which runs this form's hook handlers in-process (a
`force_ask` taken as the person's yes) and this form's MCP server code; it
isn't Antigravity. In the three verify
scenarios the suite serves a tampered `SKILL.md`; the plugin refuses each (a
digest mismatch, a size mismatch, a frontmatter mismatch) and loads nothing.
The record is [evidence/conformance.txt](evidence/conformance.txt).

The first run failed the three verify scenarios before testing anything: the
plugin read a skill's entry with `skills/get` only, and the suite's fixture
answers `skills/list` alone. It now takes the entry from the server's listing,
as the core's load does, and asks `skills/get` only for a skill the listing
doesn't hold.

```bash
CONFORMANCE_DIR=<checkout of modelcontextprotocol/conformance at c8625de, dependencies installed> bash test/conformance.sh
```
