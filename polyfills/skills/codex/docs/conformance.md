# Conformance: the Skills extension's client rules, for Codex

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules, whether the Codex plugin meets it, how, and
where that is tested.

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
at commit `2eb3a8e` (12 November 2026), the same revision the Claude Code
adapter implements ([its table](../../claude-code/docs/conformance.md)). The
rule ids are the same in both tables. This page describes version 0.1.5 of the
Codex plugin.

**Status** is one of: **met**; **exception** (met, with a limit stated in the
row); **not met**; **n/a** (the rule governs something this plugin does not do).

**Summary:** 60 rules (R4 and X12 are one row). 52 met, 6 met with a stated
exception (V4, V8, W1, X5, X9, X11), 1 not met (X8), 1 n/a (F1). The one MUST
not met, X8, needs a change in Codex; the row says which.

**Where a rule is checked:**

- `rules`: [`test/client-rules-test.ts`](../test/client-rules-test.ts), the
  plugin's App against a hand-written server that shares no code with it
  (`npm test`).
- `stubs`: [`test/stubs-test.ts`](../test/stubs-test.ts), the SKILL.md files
  Codex lists served skills by.
- `unsafe`: [`test/unsafe-text-test.ts`](../test/unsafe-text-test.ts),
  terminal, direction-changing and invisible characters in what a server sends.
- `helper`: [`test/helper-test.ts`](../test/helper-test.ts), the bundled plugin
  server spoken to as Codex speaks to it, its questions answered as Codex
  answers them.
- `conformance`: the official MCP conformance suite's four SEP-2640 client
  scenarios ([output](evidence/conformance.txt)).
- `real`: every skill and file of Hugging Face's public server
  ([output](evidence/interop-real.txt)).
- `live`: a real Codex session ([`live/`](../live/)).

The logic of the rules (entries, verification, the held entry, limits) is the
shared core, [`../core/src/skills.ts`](../../core/src/skills.ts), which the
Claude Code adapter's tests also check rule by rule. The rows below say what
the Codex adapter adds.

## Capability negotiation and the wire

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C1 | `skills/list` and `skills/get` only after seeing the server's declaration. | met | Also only with the `resources` capability. `rules` C1 (five ways of not declaring it) |
| C2 | No `resources/directory/read` without `directoryRead: true`. | met | `rules` C2 |
| G1 | `skills/get` takes the URI of a skill's `SKILL.md`. | met | `rules` G1 |
| S2 | Pagination with `nextCursor`. | met | `rules` S2. At most 64 pages or 2,000 entries per server |
| S4 | `ttlMs` and `cacheScope` are freshness hints. | met | The listing (and the stubs) are read again after `ttlMs`, at most every ten seconds. `rules` S4 |

## What a skill is

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| F1 | Honour the Agent Skills specification's compatibility mechanisms. | n/a | It defines none yet. Frontmatter is carried and compared whole |
| R1 | Never resolve the authority of a skill URI. | met | A skill URI is handed only to its server; it is never used as a path (the stub's folder is a hash of it). `rules` R1 |
| R2 | A `skill://` URI alone does not make a skill. | met | `rules` R2 |
| S1 | A partial listing is no proof; load by URI alone. | met | `load_skill` takes any server and URI; an unlisted one goes through `skills/get`. `rules` S1 |
| E1 | An entry without a valid `resources` is never loaded. | met | Nor listed in Codex. `rules` E1 |
| E2 | A size mismatch is a verification failure. | met | `rules` E2; `conformance` verify-size |
| E3 | MAY decline `"dynamic"` skills. | met | Loaded, said to be unverifiable, asked about at every load. `rules` E3 |
| L1 | Support 512 resources and 16 MiB. | met | `rules` L1 |
| L2 | Tell the user why a skill past a limit is declined. | met | From the entry alone, in `list_skills` and at `load_skill`; no stub is written for it. `rules` L2 |
| L3 | The size limit applies to what a `"dynamic"` skill retrieves. | met | Core; `rules` E3/L3 |
| M1 | Ignore unknown `io.modelcontextprotocol/` metadata keys. | met | `rules` M1 |
| M2 | `_meta` keys for skill resources use the extension's prefix. | met | The plugin sets none |

## Identity and names

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| U1, U2 | Keep both halves of a skill's identity (server, `uri`) everywhere; never key on the `uri` alone. | met | The registry, the per-thread held entries, the cache, the stored approvals, the stub's path and every tool take the pair. `rules` U1/U2/U3, U1 |
| U3 | A path where skill content is materialised encodes the server identity and the `uri`. | met | No skill content is written. The stubs' paths are `~/.agents/skills/mcp-skills-served/<server>-<hash of its exact name>/<hash of the uri>/SKILL.md`: same-URI skills of two servers land apart, and the server is readable from the path. `rules` U1/U2/U3, `stubs` |
| N1, N2 | Do not assume unique names; disambiguate a collision within a listing. | met | Both are listed; each gets a name with part of its URI's hash (`docs:refunds-1a2b3c`). `rules` N1/N2, `stubs` |
| N3 | Resolve names in a per-origin namespace, by a host-assigned label. | met | Codex lists a served skill as `mcp-skills:<server>:<name>`, with the server's name in your config. `rules` N3/N4/X7 |
| N4 | A served skill never shadows a same-named skill from another origin. | met | Its name always carries the plugin and the server, so it never equals a local skill's name; Codex lists both. `rules` N3/N4/X7 |
| X7 | Identify servers by the host's label, not `serverInfo.name`. | met | `rules` N3/N4/X7 |
| X9 | SHOULD surface collisions to the user. | exception | `list_skills` marks two skills of one server with the same name. A served skill whose name a local skill also has is not flagged; the two names differ in Codex's list (`mcp-skills:hf:pdf` and `pdf`) |

## Reading and verification

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| D1 | A read of a `SKILL.md` by another route is not a load. | met | Only `load_skill` loads. Reading the stub, or Codex's own resource tool, loads nothing and opens nothing. `rules` D1/V4 |
| D2 | Return such content as an ordinary resource read. | met | The plugin does not touch Codex's resource tool |
| D3 | Relative references resolve against the skill's root. | met | `rules` D3 |
| V1, V2 | Verify each file against its digest; never use unverified content. | met | `rules` E2/V1/V2; `conformance` verify-digest; `real` (135 files) |
| V3 | Recover from staleness with `skills/get`. | met | `rules` V3 |
| V4 | While acting on a skill, resolve its files only to the held entry's URIs. | exception | `read_skill_file` resolves against the entry the thread loaded. **Limit:** Codex's own `read_mcp_resource` can read any resource of the server, unverified, and a plugin cannot refuse it; the loaded skill's text says its files are read with `read_skill_file`. `rules` D1/V4, V4/V5/Y1/Y3 |
| V5 | A read of an unlisted file is a verification failure. | met | Not requested at all. `rules` V4/V5/Y1/Y3 |
| V6 | Compare `SKILL.md`'s frontmatter with the entry, field by field. | met | `rules` V6; `conformance` verify-frontmatter |
| V7 | Never retrieve files ahead of need: not on connection, listing, or approval. | met | The stubs are written from the listing alone; the question needs no file. "Show me its SKILL.md first" fetches it because you asked to read it. `rules` V7; `conformance` no-prefetch |
| V8 | SHOULD cache what is retrieved; serve a cached file only for the same digest. | exception | In memory, per session, keyed by server, URI and digest. Nothing on disk, by choice. `rules` V8 |
| V9 | A digest match is not a security boundary. | met | `rules` V9 |
| W1 | Hold the entry from the load until, at the earliest, `SKILL.md` leaves context. | exception | Held per Codex thread for as long as the plugin's server runs (the session). **Limit:** after a resume in a new Codex process, a read asks the model to load the skill again (asked about only if it changed) |
| Y1, Y2, Y3 | A directory read never extends the manifest; a new child is a changed skill. | met | Answered from the held entry. `rules` V4/V5/Y1/Y3 |
| Y4 | Surface `directoryRead` to the model. | met | `list_skill_directory`. `rules` C2/Y4 |

## Security considerations

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| X1 | Treat served skill content as untrusted input. | met | Fenced with a marker made per answer. A skill or file URI holding anything but printable ASCII is refused (control characters from 0.1.1, the rest from 0.1.2; security review SK1, SK4); descriptions lose every default-ignorable code point; the SKILL.md shown to you before a load has control characters removed and each run of hidden (default-ignorable) characters shown with its count (SK6), between marker lines with a per-preview id, each of its lines marked (SK5); a loaded skill or file that holds hidden characters tells the model how many (SK6). `rules` X1/X3/X4, `unsafe` |
| X2 | Treat served skills as a higher-risk surface than tools. | met | A skill needs your own yes before anything of it is fetched |
| X3, X4 | Tag content with its server; never present it as a local skill. | met | The stub's description and body, the question, the loaded text and every file say which server. `rules` X1/X3/X4 |
| X5 | No host-side code execution from a served skill without explicit per-skill approval: (a) declarative fields ignored; (b) the gate applies to code execution while acting on the skill. | exception | (a) No frontmatter field has any effect, and none reaches a stub. (b) A skill is loaded only after you choose "Load it" in Codex's form (or approved it before, unchanged); with nobody to ask, it is not loaded. After the yes, commands go through Codex's approvals as for any skill. **Limit:** the plugin cannot gate Codex's tools itself, so a skill loaded with your yes is not held to more than your Codex approvals. `rules` X5, `helper` |
| X6 | A skill of server A never causes a read against B. | met | `read_skill_file` reads only from the skill's server. `rules` X6 |
| X8 | Gate any cross-origin read behind per-call approval naming both servers. | **not met** | Codex's own `read_mcp_resource` against another server goes past the plugin. Codex hooks can only deny, and a plugin's hooks need your trust again each time its folder changes (the stubs change it). The loaded text tells the model to ask you first. Host change: an "ask" decision for hooks, or a plugin hook that keeps its trust |
| X10 | Never honour frontmatter that widens permissions (`allowed-tools`). | met | `rules` X10/R3, `stubs` |
| X11 | Served resources are not higher-authority; user policy decides whether a skill loads. | exception | Content arrives as a tool result. Codex's per-skill switch is honoured (H1). **Limit:** Codex's MCP tool rules (`enabled_tools`, approval modes) apply to `load_skill` as a whole, not per skill |
| R3 | A nested `SKILL.md` read as a file is plain text. | met | `rules` X10/R3 |
| R4, X12 | A nested skill needs its own consent. | met | Asked about on its own, and the question says it is nested. `rules` R4/X12 |
| X13a | Show the origin server. | met | Everywhere |
| X13b | Let users inspect a skill before it is loaded. | met | "Show me its SKILL.md first" in the question; shown to you, not to the model. `rules` X13 |
| X13c | MAY gate loading per skill. | met | Always |
| X14 | A kept approval is bound to every `uri` and `digest`, revoked when they change; a `"dynamic"` skill cannot be covered. | met | Also bound to where the server is. What is loaded is the set you were asked about. `rules` X14 (two tests), `helper` |
| X15 | A disk cache: integrity, outside every skill-discovery path, origin kept. | met | No skill content is cached on disk. The stubs, which are in a discovery path, hold the listing's name and description and the plugin's own words, and are rewritten from the server's listing at each start. `rules` X15, `stubs` |

## Host integration

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| H1 | (*guideline*) Surface enabled entries in context; let the user inspect and enable or disable each, with provenance. | met | Codex lists them with its skills; Codex's own per-skill switch (`[[skills.config]]`, by the stub's path or name) turns one off, and the plugin then refuses to load or read it. `rules` H1 |

## Rules of the Beta page that SEP-2640 does not state

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C3 | Every request carries the request metadata in `params._meta`. | met | On a 2026-07-28 connection. `rules` C3 |

## The plugin's own server, to Codex

Not rules of the extension, but what makes the rules hold in Codex:

| What | How, and where checked |
|---|---|
| The question is not answered by Codex in your place (in Codex 0.172's source, `codex-mcp/src/elicitation.rs`; full access not tried live) | A form with a required choice; only "Load it" in an accepted form counts. `helper` (decline, empty answer, unknown choice, error, no elicitation) |
| It stands down when Codex declares the extension itself | The stubs are removed and the tools refuse. `helper` |
| The installed folder runs on its own | `helper` (the bundle is what `src/` builds and imports nothing outside the folder), and a live install from the marketplace |
