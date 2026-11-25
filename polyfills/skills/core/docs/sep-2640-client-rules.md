# The Skills extension's client rules (SEP-2640), with their ids

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules and gives each an id. It says nothing about any
host: whether a form meets a rule, how, and where that is tested is in that
form's own conformance page, which uses these ids:
[Codex](../../codex/docs/conformance.md), [Pi](../../pi/docs/conformance.md),
[OpenCode](../../opencode/docs/conformance.md), [Hermes](../../hermes/docs/conformance.md).

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
in `modelcontextprotocol/modelcontextprotocol`, at commit `2eb3a8e`
(12 November 2026). Every sentence of it that binds a client or host is below,
including the few in its "Implementation Guidelines", which the SEP calls
recommendations, not part of the normative specification (marked *guideline*).
Rules that bind only a server, an SDK or an intermediary are left out. The
extension's Beta page in `modelcontextprotocol/ext-skills` states the same
client rules; where it adds one, that is said at the end.

There are 60 rules below (R4 and X12 are one row). C3, at the end, comes from
the Beta page: it is a rule of that base revision, so it is not counted in the
60.

## Capability negotiation and the wire

| Id | Rule |
|---|---|
| C1 | A client issues `skills/list` and `skills/get` only after seeing the server's declaration ("Backward Compatibility"). |
| C2 | Clients MUST NOT call `resources/directory/read` against a server that has not declared `directoryRead: true`. |
| G1 | `skills/get`: `params.uri` MUST be the URI of a skill's `SKILL.md`. |
| S2 | Pagination: when the result includes `nextCursor`, the client passes it back to retrieve the next page. |
| S4 | `ttlMs` and `cacheScope` on `skills/list` (2026-07-28 and later) have the base protocol's semantics: a freshness hint, not an integrity property. |

## What a skill is

| Id | Rule |
|---|---|
| F1 | Clients MUST honor any backwards-compatibility mechanisms of the Agent Skills specification, and SHOULD keep supporting it as it was before an incompatible change. |
| R1 | Clients MUST NOT attempt DNS or network resolution of the authority of a skill URI. |
| R2 | A host MUST NOT conclude that a resource is a skill merely because its URI carries a particular scheme. |
| S1 | Hosts MUST NOT treat an empty or partial listing as proof that a server has no skills, and MUST support loading a skill given only its URI. |
| E1 | An entry with no `resources`, or any value other than an array or `"dynamic"`, is invalid, and hosts MUST NOT load it. |
| E2 | A read whose byte length differs from the entry's `size` is a verification failure equivalent to a digest mismatch. |
| E3 | Hosts MAY decline to load a `"dynamic"` skill. |
| L1 | Hosts MUST support skills up to and including 512 resources and 16 MiB. |
| L2 | A host that declines a skill past a limit SHOULD tell the user why, rather than fail on a later read. |
| L3 | For a `"dynamic"` skill the host applies the total-size limit to what it retrieves, and MAY stop. |
| M1 | Implementations SHOULD ignore `metadata` keys under `io.modelcontextprotocol/` that they do not recognize. |
| M2 | Implementations that use `_meta` keys for skill resources SHOULD use the `io.modelcontextprotocol.skills/` prefix. |

## Identity and names

| Id | Rule |
|---|---|
| U1 | Hosts MUST preserve both halves of a skill's identity (server identity, `uri`) wherever a skill is recorded or addressed: registry, persisted approvals, cache, and any tool or path through which the model reaches it. |
| U2 | Hosts MUST NOT key any of these on the `uri` alone. |
| U3 | Any path at which a host materializes skill content MUST encode the server identity. |
| N1 | Hosts MUST NOT assume name uniqueness. |
| N2 | When two entries in one listing collide on `name`, hosts MUST disambiguate them rather than silently discarding or preferring one. |
| N3 | Hosts MUST resolve names within a per-origin namespace, identifying servers by a host-assigned label. |
| N4 | An MCP-served skill MUST NOT silently shadow, replace, intercept, or be substituted for a same-named skill from any other origin, including the host's filesystem skills. |
| X7 | Hosts MUST identify servers by a host-assigned label, not the server's self-reported `serverInfo.name`. |
| X9 | Hosts SHOULD surface collisions to the user. |

## Reading and verification

| Id | Rule |
|---|---|
| D1 | Hosts MUST NOT treat a `resources/read` of a `SKILL.md` that arrives by any other route as a load: it grants no approval, opens no window, and confers no standing on the skill's files. |
| D2 | Content obtained that way SHOULD be returned as any other resource read, not as a loaded skill. |
| D3 | A relative reference resolves against the skill's root, as a filesystem path would; a nested skill's against its own root. |
| V1 | When a host retrieves a file listed in a skill's `resources`, it MUST verify the content against that entry's digest. |
| V2 | On a mismatch hosts MUST NOT use the unverified content. |
| V3 | To recover from staleness, the host calls `skills/get` (or `skills/list`) and proceeds from the current `resources` set. |
| V4 | While acting on a skill, a host MUST resolve reads of the skill's files only to URIs listed in the held entry's `resources`. |
| V5 | A host MUST treat a read of an unlisted file within the skill as a verification failure. |
| V6 | After fetching a `SKILL.md` for which it holds an entry, hosts MUST parse its YAML frontmatter and compare it field by field with the entry's; on any discrepancy the skill MUST NOT be loaded. |
| V7 | Hosts MUST NOT retrieve a skill's files ahead of need: not on connection, on listing, or at approval; assembling the registry reads only the listing (*guideline*, restating the rule). |
| V8 | Hosts SHOULD cache what they retrieve; a cached file is served only if its digest matches the current entry. |
| V9 | Hosts MUST NOT treat a digest match as a security boundary. |
| W1 | A host is acting on a skill from the load until, at the earliest, its `SKILL.md` leaves context; hosts MAY hold the window open longer but not shorter. |
| Y1 | While acting under the held entry, the host MUST NOT read a child a directory read newly lists, and MUST NOT surface it as a file of the skill. |
| Y2 | Hosts SHOULD present this as a skill that has changed and needs re-approval, rather than as a read error. |
| Y3 | Hosts MUST NOT treat the directory result as extending the manifest. |
| Y4 | (*guideline*) When the server declares `directoryRead`, the host SHOULD surface this capability to the model. |

## Security considerations

| Id | Rule |
|---|---|
| X1 | Hosts MUST treat MCP-served skill content as untrusted model input. |
| X2 | Hosts MUST treat MCP-served skills as a higher-risk surface than remote tool invocation. |
| X3 | Hosts MUST tag MCP-served skill content with its originating server identity at the point it enters model context. |
| X4 | Hosts MUST NOT present an MCP-served skill to the model as indistinguishable from a local filesystem skill. |
| X5 | Hosts MUST NOT allow MCP-served skill content to cause host-side code execution without explicit per-skill user approval: (a) declarative fields are ignored or approval-gated; (b) the same gate applies to code-execution tool calls issued while the model is acting on an MCP-served skill. |
| X6 | Hosts MUST bind resource reads to the skill's originating server: a skill served by A MUST NOT cause a `resources/read` against B. |
| X8 | Any cross-origin read MUST be gated behind explicit per-call user approval naming both servers. |
| X10 | Hosts MUST NOT honor frontmatter fields that widen the model's tool or filesystem permissions; `allowed-tools` MUST be ignored unless the user approved that grant for that skill; approval of a skill never extends to another `SKILL.md`'s frontmatter. |
| X11 | Hosts MUST NOT treat skill resources as higher-authority than other context. Explicit user policy governs whether a skill is loaded at all. |
| R3 | A nested `SKILL.md` read as a supporting file is ordinary markdown, and hosts MUST NOT act on its frontmatter. |
| R4, X12 | Activating a nested skill requires fresh, explicit user consent; approval of the enclosing skill does not substitute. |
| X13a | Hosts SHOULD indicate which server a skill originates from when presenting it. |
| X13b | Hosts SHOULD let users inspect a skill's content before it is loaded into model context. |
| X13c | Hosts MAY gate loading behind per-skill or per-server user approval. |
| X14 | A persisted per-skill approval MUST be bound to the entry's `resources` set (every `uri` and `digest`) and treated as revoked when a later entry advertises a different set; a `"dynamic"` skill cannot be covered by one. |
| X15 | Disk cache: integrity (host-only location or re-hash on access), a location outside every skill-discovery path, MCP origin kept after restart; SHOULD remove a server's cached content when the server is removed. |

## Host integration

| Id | Rule |
|---|---|
| H1 | (*guideline*) The host surfaces the `name` and `description` of each *enabled* registry entry in the model's context, with its identity; the host's UI presents the same merged list for user inspection and per-skill enable/disable, with provenance shown ("Hosts: End-to-End Integration", Context). |

## Rules of the Beta page that SEP-2640 does not state

The extension's Beta page (`specification/beta/skills.mdx` in
`modelcontextprotocol/ext-skills`, at `1631b3f`) specifies the extension against
base revision 2026-07-28 and adds one client rule:

| Id | Rule |
|---|---|
| C3 | Every request MUST include the required request metadata in `params._meta`. |
