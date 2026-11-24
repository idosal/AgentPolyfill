# Conformance: the Skills extension's client rules, one by one

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules, whether this mod meets it, how, and where that
is tested.

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
in `modelcontextprotocol/modelcontextprotocol`, at its latest change (commit
`2eb3a8e`, 12 November 2026). Every sentence of it that binds a client or host
is below, including the few in its "Implementation Guidelines", which the SEP
calls recommendations, not part of the normative specification (marked
*guideline*). Rules that bind only a server, an SDK or an intermediary are left
out. The extension's Beta page in `modelcontextprotocol/ext-skills` states the
same client rules; where it adds one, that is said at the end. This page
describes version 0.3.2 of the mod.

**Status** is one of: **met**; **exception** (met, with a limit stated in the
row, caused by the host or chosen and documented); **not met**; **n/a** (the
rule governs something this mod does not do, and the row says why).

**Summary:** 60 rules. 54 met, 3 met with a documented exception (V8, W1, X8),
0 not met, 3 n/a (F1, U3, X15). Every MUST is met or, for W1 and X8, met with
the limit stated in its row.

**Where a rule is checked:**

- `rules`: [`test/client-rules-test.ts`](../test/client-rules-test.ts), against a
  hand-written server that shares no code with the mod (`npm test`).
- `property`: [`test/property-test.ts`](../test/property-test.ts), properties
  checked on generated inputs, and exhaustively where the domain is finite
  (`npm test`).
- `model`: the model of the approval and gate state machine
  ([`docs/verification.md`](verification.md)), explored in full to its bound
  (`npm test`).
- `gates`: [`mod/hooks/gates.test.ts`](../mod/hooks/gates.test.ts), the mod's
  hooks running in Claude Code's own test kit (`npm run test:mod`).
- `disable`: [`test/enable-disable-test.ts`](../test/enable-disable-test.ts),
  the helper's half of per-skill enable and disable, against a hand-written
  server (`npm test`).
- `conformance`: the official MCP conformance suite's four client scenarios
  for SEP-2640 ([output](evidence/conformance.txt)). The suite has no others.
- `real`: every skill and file of two real public servers, Hugging Face and
  TogoMCP ([output](evidence/interop-real.txt)).
- `live`: real Claude Code 2.1.329 sessions, interactive
  ([`live/runs/`](../live/runs/)) and unattended
  ([output](evidence/headless.txt)).

Where the specification can be read two ways, the stricter reading was taken,
with a few exceptions made so that servers in use work. Both are listed at the
end.

## Capability negotiation and the wire

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C1 | A client issues `skills/list` and `skills/get` only after seeing the server's declaration ("Backward Compatibility"). | met | Nothing `skills/*` is sent unless `capabilities.extensions["io.modelcontextprotocol/skills"]` is an object and the server also declares `resources`. `rules` C1 (four ways of not declaring it, on both kinds of connection) |
| C2 | Clients MUST NOT call `resources/directory/read` against a server that has not declared `directoryRead: true`. | met | `rules` C2 |
| G1 | `skills/get`: `params.uri` MUST be the URI of a skill's `SKILL.md`. | met | Anything else is refused before a request. `rules` G1 |
| S2 | Pagination: when the result includes `nextCursor`, the client passes it back to retrieve the next page. | met | `rules` S2. The mod stops at 64 pages or 2,000 entries per server, says so, and a skill beyond that still loads by URI |
| S4 | `ttlMs` and `cacheScope` on `skills/list` (2026-07-28 and later) have the base protocol's semantics: a freshness hint, not an integrity property. | met | The listing is read again only after `ttlMs` has run out (and not more than every ten seconds); content is verified whatever the listing's age. `rules` S4 |

## What a skill is

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| F1 | Clients MUST honor any backwards-compatibility mechanisms of the Agent Skills specification, and SHOULD keep supporting it as it was before an incompatible change. | n/a | No incompatible change to the Agent Skills specification exists, and it defines no such mechanism yet. Frontmatter is carried and compared whole, whatever fields it has |
| R1 | Clients MUST NOT attempt DNS or network resolution of the authority of a skill URI. | met | A skill URI is only ever passed to the server it came from. The Skills logic imports no I/O at all. `rules` R1 |
| R2 | A host MUST NOT conclude that a resource is a skill merely because its URI carries a particular scheme. | met | A skill is what a server's `skills/list` or `skills/get` says is one. `rules` R2. This is also why nothing is offered as a skill on a server the mod cannot send `skills/get` to (see "Which servers work" in the README) |
| S1 | Hosts MUST NOT treat an empty or partial listing as proof that a server has no skills, and MUST support loading a skill given only its URI. | met | `load_skill` takes a server and a URI; a pair never listed is looked up with `skills/get`. `rules` S1 |
| E1 | An entry with no `resources`, or any value other than an array or `"dynamic"`, is invalid, and hosts MUST NOT load it. | met | `rules` E1; `property` (generated and damaged entries) |
| E2 | A read whose byte length differs from the entry's `size` is a verification failure equivalent to a digest mismatch. | met | Size is checked before the digest. `rules` E2; `conformance` verify-size; `property` |
| E3 | Hosts MAY decline to load a `"dynamic"` skill. | met | The mod loads them, says the content cannot be verified, still compares frontmatter, and asks at every load. `rules` E3, V6 |
| L1 | Hosts MUST support skills up to and including 512 resources and 16 MiB. | met | `rules` L1 lists a 512-file skill and reads a 16 MiB skill whole |
| L2 | A host that declines a skill past a limit SHOULD tell the user why, rather than fail on a later read. | met | Declined from the entry alone, with the count or size. `rules` L2; `property` (declined exactly past either limit) |
| L3 | For a `"dynamic"` skill the host applies the total-size limit to what it retrieves, and MAY stop. | met | `rules` E3/L3 |
| M1 | Implementations SHOULD ignore `metadata` keys under `io.modelcontextprotocol/` that they do not recognize. | met | `rules` M1 |
| M2 | Implementations that use `_meta` keys for skill resources SHOULD use the `io.modelcontextprotocol.skills/` prefix. | met | The mod sets no `_meta` key of its own anywhere, and gives none a meaning |

## Identity and names

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| U1 | Hosts MUST preserve both halves of a skill's identity (server identity, `uri`) wherever a skill is recorded or addressed: registry, persisted approvals, cache, and any tool or path through which the model reaches it. | met | The registry, the held entries, the in-memory cache and the stored approvals are keyed by the pair; every tool takes the pair. `rules` U1/U2, `gates` X14 |
| U2 | Hosts MUST NOT key any of these on the `uri` alone. | met | `rules` U1/U2: the same URI on two servers |
| U3 | Any path at which a host materializes skill content MUST encode the server identity. | n/a | Nothing is materialized: no cache directory, no mount. `rules` X14/X15 |
| N1 | Hosts MUST NOT assume name uniqueness. | met | Names are labels; nothing is looked up by name. `rules` N1/N2 |
| N2 | When two entries in one listing collide on `name`, hosts MUST disambiguate them rather than silently discarding or preferring one. | met | Both are listed, each with its URI. `rules` N1/N2 |
| N3 | Hosts MUST resolve names within a per-origin namespace, identifying servers by a host-assigned label. | met | Every listed skill is named with the server's name in the user's own config. `rules` N3 |
| N4 | An MCP-served skill MUST NOT silently shadow, replace, intercept, or be substituted for a same-named skill from any other origin, including the host's filesystem skills. | met | Served skills are never resolved by the Skill tool or `/name`: they are loaded only by server and URI, from a separately headed part of the listing. `rules` N3, `gates` X3 |
| X7 | Hosts MUST identify servers by a host-assigned label, not the server's self-reported `serverInfo.name`. | met | `rules` N3/X7: the server calls itself "Trusted Local Skills" and that name appears nowhere |
| X9 | Hosts SHOULD surface collisions to the user. | met | `/mcp-skills` marks a name served twice by one server, a name two servers serve, and a served name that a local skill or command also has. `rules` N1/U1, `gates` X9 |

## Reading and verification

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| D1 | Hosts MUST NOT treat a `resources/read` of a `SKILL.md` that arrives by any other route as a load: it grants no approval, opens no window, and confers no standing on the skill's files. | met | Only `load_skill` loads. Claude Code's own resource tool is left to work as it does, and what it reads opens nothing. `rules` D1, `gates` D1 |
| D2 | Content obtained that way SHOULD be returned as any other resource read, not as a loaded skill. | met | The mod does not touch it, with one exception that V4 requires (below) |
| D3 | A relative reference resolves against the skill's root, as a filesystem path would; a nested skill's against its own root. | met | `rules` D3; `property` (no generated reference resolves outside the skill) |
| V1 | When a host retrieves a file listed in a skill's `resources`, it MUST verify the content against that entry's digest. | met | `rules` V1, E2; `conformance` verify-digest, verify-size; `real` (173 files); `property` (accepted exactly when size and digest match) |
| V2 | On a mismatch hosts MUST NOT use the unverified content. | met | The read fails; none of the content is shown or kept. `rules` V1/V2; `model` Verified |
| V3 | To recover from staleness, the host calls `skills/get` (or `skills/list`) and proceeds from the current `resources` set. | met | On a load, once, automatically; for a file of a loaded skill, by loading the skill again. `rules` V3, Y1; `model` |
| V4 | While acting on a skill, a host MUST resolve reads of the skill's files only to URIs listed in the held entry's `resources`. | met | `read_skill_file` resolves against the held entry. A read of a loaded skill's own files through Claude Code's generic resource tool is refused and pointed at `read_skill_file`. `rules` V4/V5, `gates` V4 |
| V5 | A host MUST treat a read of an unlisted file within the skill as a verification failure. | met | Not requested at all. `rules` V4/V5 |
| V6 | After fetching a `SKILL.md` for which it holds an entry, hosts MUST parse its YAML frontmatter and compare it field by field with the entry's; on any discrepancy the skill MUST NOT be loaded. | met | `rules` V6 (seven cases, and for `"dynamic"`); `conformance` verify-frontmatter; `real` (30 skills' frontmatter); `property` (any field changed or added is refused) |
| V7 | Hosts MUST NOT retrieve a skill's files ahead of need: not on connection, on listing, or at approval; assembling the registry reads only the listing (*guideline*, restating the rule). | met | `rules` V7; `conformance` no-prefetch |
| V8 | Hosts SHOULD cache what they retrieve; a cached file is served only if its digest matches the current entry. | exception | Kept in the helper's memory for the session, keyed by server, URI and digest, at most 64 MiB. Nothing is kept across sessions, by choice: a cache on disk carries the duties of X15, and a skill's files are fetched again in the next session. `rules` V8 |
| V9 | Hosts MUST NOT treat a digest match as a security boundary. | met | A match changes nothing about how the content is treated, and the model is told what it does and does not show. `rules` V9 |
| W1 | A host is acting on a skill from the load until, at the earliest, its `SKILL.md` leaves context; hosts MAY hold the window open longer but not shorter. | exception | Held until the conversation is cleared, which is longer; a skill loaded unapproved stays unapproved for all of that time, however often it is loaded again with a yes. After a resume or a reload the loaded skills, and whether each was approved, are read back from the conversation. **Limit:** that read covers the main conversation's newest 4,096 messages, so a skill that only a subagent loaded, or one loaded further back than that, is missed after a resume. `gates` W1 (five tests), `model` (the limit, modelled, opens the gate: the model shows exactly this case) |
| Y1 | While acting under the held entry, the host MUST NOT read a child a directory read newly lists, and MUST NOT surface it as a file of the skill. | met | For a skill with a manifest, a directory is answered from the held entry, as the specification allows, so the server's live listing is never shown. `rules` Y1/Y3 |
| Y2 | Hosts SHOULD present this as a skill that has changed and needs re-approval, rather than as a read error. | met | "…the skill has changed on the server since: load the skill again…". `rules` Y1 |
| Y3 | Hosts MUST NOT treat the directory result as extending the manifest. | met | `rules` Y1/Y3 |
| Y4 | (*guideline*) When the server declares `directoryRead`, the host SHOULD surface this capability to the model. | met | `list_skill_directory`, routed to `resources/directory/read` for a `"dynamic"` skill on such a server, and answered from the entry for a skill with a manifest. A loaded dynamic skill's text names the tool when the server lists directories. `rules` C2, Y4 |

## Security considerations

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| X1 | Hosts MUST treat MCP-served skill content as untrusted model input. | met | Content is shown as data from its server, inside a fence whose marker is made per answer; a description is one bounded line. `rules` X1; `property` (no generated text closes its fence) |
| X2 | Hosts MUST treat MCP-served skills as a higher-risk surface than remote tool invocation. | met | A skill needs the person's own yes before it is loaded, which no rule for a tool gives, and loading one changes what Claude Code asks about from then on (X8); calling a server's tool does neither |
| X3 | Hosts MUST tag MCP-served skill content with its originating server identity at the point it enters model context. | met | The listing, a loaded skill and every file read name the server. `rules` N3/X3, `live` |
| X4 | Hosts MUST NOT present an MCP-served skill to the model as indistinguishable from a local filesystem skill. | met | Its own heading in the skill listing, its own loading tool. `rules` N3/X4, `gates` X3 |
| X5 | Hosts MUST NOT allow MCP-served skill content to cause host-side code execution without explicit per-skill user approval: (a) declarative fields are ignored or approval-gated; (b) the same gate applies to code-execution tool calls issued while the model is acting on an MCP-served skill. | met | (a) No frontmatter field is given effect. (b) A skill is put to the person before it is loaded, by Claude Code's own permission dialog; an allow rule for the tool or auto mode's classifier does not answer it. With the person's yes, the skill's text enters context and commands run under their usual permissions. Where nobody can be asked, the skill may load unapproved, and then the mod refuses every tool call except Claude Code's reading and searching tools (`Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `TodoWrite`, `ToolSearch`, `ListMcpResourcesTool`, `AskUserQuestion`) and the mod's own: a command, and also a file write or edit (a file written now can be code run later), a subagent, another server's tool, and any tool the mod does not know. Such a skill stays unapproved until the conversation is cleared, even if it is loaded again later with a yes (0.3.0 let the later yes lift the gate: found by the model, fixed in 0.3.1). **Limit:** bypass-permissions mode was not tested; see [SECURITY.md](../SECURITY.md). `gates` X5 (eleven tests) and W1, `model` Gate, `live` (interactive: asked once, then a command unasked; headless: `Write`, `Edit`, `Bash` and `Agent` refused, `Read` allowed) |
| X6 | Hosts MUST bind resource reads to the skill's originating server: a skill served by A MUST NOT cause a `resources/read` against B. | met | `read_skill_file` reads only from the server a skill was loaded from. `rules` U1, X6 |
| X8 | Any cross-origin read MUST be gated behind explicit per-call user approval naming both servers. | exception | While a served skill is loaded, Claude Code's `ReadMcpResourceTool` and `ReadMcpResourceDirTool` against any other server (compared by exact name: `acme.prod` and `acme_prod` are two servers) are put to the person, with both servers named, or refused where nobody can be asked. **Limit:** a resource read that another mod makes with `$.tool.call` passes no permission check, so no hook of this mod sees it. Tested in the test kit, not in a live session. `gates` X6/X8, `model` CrossServerRead |
| X10 | Hosts MUST NOT honor frontmatter fields that widen the model's tool or filesystem permissions; `allowed-tools` MUST be ignored unless the user approved that grant for that skill; approval of a skill never extends to another `SKILL.md`'s frontmatter. | met | Ignored, with no way to approve it. `rules` X10, R3 |
| X11 | Hosts MUST NOT treat skill resources as higher-authority than other context. Explicit user policy governs whether a skill is loaded at all. | met | A loaded skill arrives as a tool result, marked as a server's content. Loading needs the person's yes (X5), and a deny rule of theirs for the tool still refuses it. `gates` X5 |
| R3 | A nested `SKILL.md` read as a supporting file is ordinary markdown, and hosts MUST NOT act on its frontmatter. | met | `rules` R3 |
| R4, X12 | Activating a nested skill requires fresh, explicit user consent; approval of the enclosing skill does not substitute. | met | Every skill has its own approval, keyed by its own URI: a nested skill is asked about like any other, and the question says it is nested. `rules` R4, `gates` R4 |
| X13a | Hosts SHOULD indicate which server a skill originates from when presenting it. | met | Everywhere it is shown: the listing, the approval, the panel, the loaded text |
| X13b | Hosts SHOULD let users inspect a skill's content before it is loaded into model context. | met | `/mcp-skills show <skill>` opens the skill's `SKILL.md`, verified, in a panel the person reads and the model does not; nothing is loaded or approved by it. The approval dialog says so. `rules` X13, `gates` X13, `live` |
| X13c | Hosts MAY gate loading behind per-skill or per-server user approval. | met | Per skill, always (X5) |
| X14 | A persisted per-skill approval MUST be bound to the entry's `resources` set (every `uri` and `digest`) and treated as revoked when a later entry advertises a different set; a `"dynamic"` skill cannot be covered by one. | met | The stored approval holds a hash over every file's URI and digest, and a fingerprint of the server's address or command. At every load the server's current entry is hashed again; a different set, or a server at another address, is asked about anew ("has changed since you approved it"), and the skill is loaded only as the set that was approved. A `"dynamic"` skill is asked about at every load and nothing is stored for it. At most 2,000 approvals are kept (the oldest go); a yes that cannot be kept still loads the skill it was given for. `rules` X14 (three tests), `gates` X14 (eight tests), `model` ApprovedContent, KeptIsConsented, NoKeptYesForDynamic; `property` (the hash changes with any URI or digest, and not with order) |
| X15 | Disk cache: integrity (host-only location or re-hash on access), a location outside every skill-discovery path, MCP origin kept after restart; SHOULD remove a server's cached content when the server is removed. | n/a | No skill content is written to disk. What is kept in memory goes with the session. `rules` X15 |

## Host integration

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| H1 | (*guideline*) The host surfaces the `name` and `description` of each *enabled* registry entry in the model's context, with its identity; the host's UI presents the same merged list for user inspection and per-skill enable/disable, with provenance shown ("Hosts: End-to-End Integration", Context). | met | `/mcp-skills` lists every served skill with its server; `/mcp-skills show` opens one for inspection; `/mcp-skills disable <skill>` and `enable <skill>` turn one off and on, keyed by its identity (server and `SKILL.md` URI, U1), kept in the mod's store (at most 2,000) and shared by every session. A disabled skill is left out of the listing and `list_skills`, refused at `load_skill`'s permission check and again when any of the mod's tools runs for it (the store is read for each), and its server is asked nothing about it. Enabling is honoured only from the person's own input, and approves nothing. Disabling takes nothing back from a conversation that loaded the skill (W1). `gates` H1 (twelve tests), `disable` (seven), `model` DisabledNeverReaches |

## Rules of the Beta page that SEP-2640 does not state

The extension's Beta page (`specification/beta/skills.mdx` in
`modelcontextprotocol/ext-skills`, at `1631b3f`) specifies the extension against
base revision 2026-07-28 and adds one client rule:

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C3 | Every request MUST include the required request metadata in `params._meta`. | met | On a 2026-07-28 connection the MCP SDK adds it; `rules` C3 reads it off the wire for all four methods. It is a rule of that base revision, so it is not counted in the summary above |

## Features a client can have, and which this one has

| Feature (SEP-2640) | Here | If not, why |
|---|---|---|
| Listing with `skills/list`, every page | yes | |
| Loading a skill by its URI alone, through `skills/get` (listed or not, from server instructions, the user, another skill) | yes | |
| Verified reads of `SKILL.md` and supporting files (size, digest, frontmatter) | yes | |
| Directory listing with `resources/directory/read` where declared | yes | |
| `"dynamic"` skills | yes, asked about at every load | |
| Nested skills, each activated on its own approval | yes | |
| Freshness hints (`ttlMs`, `cacheScope`) | yes | |
| Origin shown to the model and the person; inspection before loading | yes | |
| Per-skill approval bound to content | yes | |
| A cache of verified files | in memory, for the session | A disk cache brings X15's duties; not built (V8) |
| Per-skill enable and disable in the host's list (*guideline*) | yes, `/mcp-skills disable` and `enable` (H1) | |
| Skills of servers behind an OAuth sign-in, claude.ai connectors and plugins' servers | no | Claude Code gives a mod no way to send `skills/*` over its own connection, nor the server's capabilities ([host-changes.md](host-changes.md), changes 1 and 2) |
| A served skill as a `/name` command | no | Left out so that no served skill can stand in for a local one by name (N4); `/mcp-skills use <name>` instead |

## Where the stricter reading was taken

1. **`resources` capability.** A declaring server "MUST also declare the
   `resources` capability". One that does not is treated as not having declared
   the extension.
2. **Entries.** An entry is refused if its name breaks the Agent Skills naming
   rule, its description is empty or over 1,024 characters, a file is listed
   twice, lies outside the skill, or carries a malformed digest. The
   specification puts these duties on the server; the mod does not load what
   breaks them. All 30 skills on the two real servers pass.
3. **Approval is required, not optional.** The specification lets a host load
   a skill without asking (X13c: it "MAY gate loading") and gate only code
   execution. The mod asks before loading, so that nothing a server wrote is
   acted on before a person agreed.
4. **The server is part of what was approved.** An approval does not carry
   over to a server of the same name at another address.
5. **Window.** The acting window ends only when the conversation is cleared,
   not at compaction, and a skill loaded unapproved stays unapproved for all of
   it.
6. **Limits.** The mod accepts skills up to the two limits and declines larger
   ones, though a host MAY accept more.

## Where it is lenient, on purpose

1. **Revision.** SEP-2640 ties no client rule to a protocol revision. The mod
   honours the declaration on whichever revision the connection settles on,
   including the `initialize` answer of a revision before 2026-07-28. Servers
   in use do this, and the official conformance suite's own SEP-2640 client
   scenarios advertise the extension on both.
2. **Cache hints.** A `skills/list` or `skills/get` result without `ttlMs` and
   `cacheScope` (which a server on 2026-07-28 or later carries) is accepted and
   treated as "do not reuse". Several servers listed in
   `ext-skills/docs/implementations.md` omit them, and nothing a client must
   do depends on them.
3. **Reads are not asked about.** Reading a file of a loaded skill, and
   listing, go ahead without a permission question unless a rule of the
   person's or their organisation's asks for one, as Claude Code's own
   resource read does. They are reads from the skill's own server, checked
   against its manifest.
