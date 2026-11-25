# Conformance: the Skills extension's client rules, for OpenCode

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules, whether the OpenCode plugin meets it, how, and
where that is tested.

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
at commit `2eb3a8e` (12 November 2026), the revision the Claude Code and Codex
forms implement ([Claude Code's table](../../claude-code/docs/conformance.md),
[Codex's](../../codex/docs/conformance.md)). The rule ids are the same in all
three. This page describes version 0.1.0 of the OpenCode plugin, on OpenCode
2.4.1.

**Status** is one of: **met**; **exception** (met, with a limit stated in the
row); **not met**; **n/a** (the rule governs something this plugin does not do).

**Summary:** 60 rules (R4 and X12 are one row). 54 met, 4 met with a stated
exception (V8, W1, X5, X9), 1 not met (X13b), 1 n/a (F1). The one rule not met,
X13b (a SHOULD: let users inspect a skill before it loads), needs a change in
OpenCode; the row says which. Where a row's "met" rests on the plugin asking by
default, the plugin option `askByDefault: false` (or
`MCP_SKILLS_ASK_BY_DEFAULT=0`) hands the decision to OpenCode's rules alone,
whose shipped default allows every action; the rows say so.

**Where a rule is checked:**

- `e2e`: [`test/e2e.test.ts`](../test/e2e.test.ts), the bundled plugin in
  OpenCode 2.4.1, in a throwaway home, against the Claude Code form's
  hand-written fixture server (which shares no code with the client), with a
  scripted model.
- `units`: [`test/units.test.ts`](../test/units.test.ts), what OpenCode lists
  and what the model reads, without OpenCode.
- `core`: the shared core, [`../core/src/skills.ts`](../../core/src/skills.ts),
  bundled unchanged; its rules are tested rule by rule in the Claude Code and
  Codex forms (`test/client-rules-test.ts`, `test/hardening-test.ts`), against
  the same code.
- `live`: OpenCode 2.4.1 with a real model, against Hugging Face's public
  server, over its API, in its TUI and in OpenCode Desktop
  ([`live-run.md`](../../../../tools/opencode/live-run.md)).

The rows below say what the OpenCode adapter adds.

## Capability negotiation and the wire

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C1 | `skills/list` and `skills/get` only after seeing the server's declaration. | met | Also only with the `resources` capability. `core`; `e2e` (the fixture's servers, and one with no Skills extension: "no Skills extension" in the log) |
| C2 | No `resources/directory/read` without `directoryRead: true`. | met | `core` |
| G1 | `skills/get` takes the URI of a skill's `SKILL.md`. | met | `core` |
| S2 | Pagination with `nextCursor`. | met | `core`. At most 64 pages or 2,000 entries per server |
| S4 | `ttlMs` and `cacheScope` are freshness hints. | met | The listing is read again after `ttlMs` (at most every ten seconds) when `list_skills` is called, and OpenCode's skill list is rebuilt when it changed |

## What a skill is

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| F1 | Honour the Agent Skills specification's compatibility mechanisms. | n/a | It defines none yet. Frontmatter is carried and compared whole |
| R1 | Never resolve the authority of a skill URI. | met | A skill URI is handed only to its server; it is never a path. OpenCode lists the skill at `skill://mcp-skills:<server>:<name>/SKILL.md`, OpenCode's form for a skill with no folder, built from the server and name, not the URI. `core` |
| R2 | A `skill://` URI alone does not make a skill. | met | `core` |
| S1 | A partial listing is no proof; load by URI alone. | met | `load_skill` takes any server and URI; an unlisted one goes through `skills/get`. `core` |
| E1 | An entry without a valid `resources` is never loaded. | met | Nor listed in OpenCode. `core` |
| E2 | A size mismatch is a verification failure. | met | `core` |
| E3 | MAY decline `"dynamic"` skills. | met | Loaded, said to be unverifiable; its request saves no approval, so with an `ask` rule (or by default) it is asked about at every load. `core` |
| L1 | Support 512 resources and 16 MiB. | met | `core` |
| L2 | Tell the user why a skill past a limit is declined. | met | From the entry alone, in `list_skills` and at `load_skill`; it is not added to OpenCode's list. `core` |
| L3 | The size limit applies to what a `"dynamic"` skill retrieves. | met | `core` |
| M1 | Ignore unknown `io.modelcontextprotocol/` metadata keys. | met | `core` |
| M2 | `_meta` keys for skill resources use the extension's prefix. | met | The plugin sets none |

## Identity and names

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| U1, U2 | Keep both halves of a skill's identity (server, `uri`) everywhere; never key on the `uri` alone. | met | The registry, the per-session held entries, OpenCode's skill id (`mcp-skills:<server>:<name>`), the permission resource (`<server>:<uri>@<digest>`) and every tool take the pair. `core`; `e2e` (the resource) |
| U3 | A path where skill content is materialised encodes the server identity and the `uri`. | met | No skill content is written anywhere: OpenCode's skill list holds the plugin's note, in memory |
| N1, N2 | Do not assume unique names; disambiguate a collision within a listing. | met | Both are listed; the second gets part of its URI's hash in its id (`mcp-skills:docs:guide-1a2b3c`). `units` |
| N3 | Resolve names in a per-origin namespace, by a host-assigned label. | met | `mcp-skills:<server>:<name>`, with the server's name in your OpenCode configuration. `e2e` |
| N4 | A served skill never shadows a same-named skill from another origin. | met | Its id always carries the plugin and the server, and the plugin never sets an id OpenCode already has. `e2e` |
| X7 | Identify servers by the host's label, not `serverInfo.name`. | met | `core`; `e2e` |
| X9 | SHOULD surface collisions to the user. | exception | `list_skills` marks two skills of one server with the same name. `units`. A served skill whose name a local skill also has is not flagged; their ids differ in OpenCode's list |

## Reading and verification

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| D1 | A read of a `SKILL.md` by another route is not a load. | met | Only `load_skill` loads. OpenCode's own skill tool returns the plugin's note, and its resource tool loads nothing. `e2e` |
| D2 | Return such content as an ordinary resource read. | met | The plugin does not change OpenCode's resource tool (its hook only asks first, for another server: X8) |
| D3 | Relative references resolve against the skill's root. | met | `core` |
| V1, V2 | Verify each file against its digest; never use unverified content. | met | `core`; `e2e` (the loaded text and a file say they matched); `live` |
| V3 | Recover from staleness with `skills/get`. | met | `core` |
| V4 | While acting on a skill, resolve its files only to the held entry's URIs. | met | `read_skill_file` resolves against the entry the session loaded. OpenCode's own resource read of a file inside a loaded skill's folder, from the skill's server, is refused (a `tool` hook) with a pointer to `read_skill_file`, in the session, its subagents and after a restart; nothing is sent to the server. `e2e` |
| V5 | A read of an unlisted file is a verification failure. | met | Not requested at all. `core` |
| V6 | Compare `SKILL.md`'s frontmatter with the entry, field by field. | met | `core`; `e2e` |
| V7 | Never retrieve files ahead of need: not on connection, listing, or approval. | met | OpenCode's list is built from `skills/list` alone; a rejected load fetches nothing. `e2e` (no `resources/read` before a load is allowed) |
| V8 | SHOULD cache what is retrieved; serve a cached file only for the same digest. | exception | In memory, per session, keyed by server, URI and digest. Nothing on disk, by choice. `core` |
| V9 | A digest match is not a security boundary. | met | The loaded text says so. `core` |
| W1 | Hold the entry from the load until, at the earliest, `SKILL.md` leaves context. | exception | Held in memory per OpenCode session, for up to 64 sessions at once (past that the oldest is let go), while the plugin runs. **Limit:** after OpenCode restarts, or for a session let go, a file read asks the model to load the skill again (asked about unless "Allow always" covers it as it is). Which skills a session loaded is kept on disk, so V4 and X8 still hold for it |
| Y1, Y2, Y3 | A directory read never extends the manifest; a new child is a changed skill. | met | Answered from the held entry. `core` |
| Y4 | Surface `directoryRead` to the model. | met | `list_skill_directory`, and `list_skills` says which servers list directories. `core` |

## Security considerations

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| X1 | Treat served skill content as untrusted input. | met | Fenced with a marker made per answer; a skill or file URI holding anything but printable ASCII is refused; a description OpenCode lists loses every control and invisible character and any markup; a file's media type is printed only when the whole of it is one; a loaded skill or file that holds hidden characters tells the model how many. `core`; `units` |
| X2 | Treat served skills as a higher-risk surface than tools. | met | A load is put to OpenCode's rules before anything of the skill is fetched, and asks by default where OpenCode's rules would allow it: only "Allow always" for that exact skill as it is, or `askByDefault: false`, skips the question. A configured `deny` is final. `e2e` ("asks by default") |
| X3, X4 | Tag content with its server; never present it as a local skill. | met | OpenCode's list (`[MCP server "<server>", not a local skill]`), the note, the permission request, the loaded text and every file say which server. `e2e`; `units` |
| X5 | No host-side code execution from a served skill without explicit per-skill approval: (a) declarative fields ignored; (b) the gate applies to code execution while acting on the skill. | exception | (a) No frontmatter field has any effect, and none reaches OpenCode's list. (b) A skill is loaded only once OpenCode allows `mcp_skills_load` for it, which asks by default; nobody present (an unattended run) is a no. **Limit:** after the load, what the skill tells the model to do goes through OpenCode's rules as for any skill, and OpenCode's shipped rules allow shell commands: in a live run with them, the model ran a command a loaded skill described, without a prompt (`live`) |
| X6 | A skill of server A never causes a read against B. | met | `read_skill_file` reads only from the skill's server. `core` |
| X8 | Gate any cross-origin read behind per-call approval naming both servers. | met | Once a session (or a subagent of it) has loaded a served skill, OpenCode's resource read for another server, by either of its names and also from a Code Mode program, is put to OpenCode's rules as `mcp_skills_cross_server` on `<skill servers>-><server>:<uri>`, per call (nothing saved), and asks by default. Kept across restarts. With `askByDefault: false`, OpenCode's rules alone decide. `e2e` (four cases), `live` |
| X10 | Never honour frontmatter that widens permissions (`allowed-tools`). | met | `core`; the plugin passes no frontmatter to OpenCode |
| X11 | Served resources are not higher-authority; user policy decides whether a skill loads. | met | Content arrives as a tool result. OpenCode's rules decide, per skill (`<server>:<uri>@<digest>`); a `deny` rule is final |
| R3 | A nested `SKILL.md` read as a file is plain text. | met | `core` |
| R4, X12 | A nested skill needs its own consent. | met | Its own request, naming the skill it is inside (`metadata.nestedIn`, and the note). `e2e` |
| X13a | Show the origin server. | met | Everywhere |
| X13b | Let users inspect a skill before it is loaded. | **not met** | OpenCode's permission request has no place for text the person reads and the model doesn't, and a plugin has no other way to show it. The request carries the skill's name, URI, digest and size. Host change: a preview on a permission request, or session forms offered to plugins |
| X13c | MAY gate loading per skill. | met | Always, per skill |
| X14 | A kept approval is bound to every `uri` and `digest`, revoked when they change; a `"dynamic"` skill cannot be covered. | met | The saved pattern is `<server>:<uri>@sha256:<manifest digest>`, the manifest covering every file; a generated skill saves none. `e2e` ("Allow always", then a load in another session isn't asked; the server changes a file and it is asked again) |
| X15 | A disk cache: integrity, outside every skill-discovery path, origin kept. | met | No skill content is cached on disk |

## Host integration

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| H1 | (*guideline*) Surface enabled entries in context; let the user inspect and enable or disable each, with provenance. | met | OpenCode lists them with its skills, marked with their server. A `deny` rule for `mcp_skills_load` on `<server>:<uri>@*` turns one off (a `skill` deny rule takes it out of the list). `e2e` |

## Rules of the Beta page that SEP-2640 does not state

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C3 | Every request carries the request metadata in `params._meta`. | met | On a 2026-07-28 connection. `core` |

## What makes the rules hold in OpenCode

| What | How, and where checked |
|---|---|
| A load, a cross-server read: OpenCode's rules, asked by default | `ctx.permission.assert`; an `evaluate` hook turns `allow` into `ask` for these two actions only, except for patterns the person chose "Allow always" for. `e2e` ("asks by default") |
| Nobody answers in your place | The plugin never replies to a permission request; OpenCode denies an `ask` nobody is present to answer |
| It stands down | OpenCode 2.4.1 has no SEP-2640 support to detect; `MCP_SKILLS_OFF=1` or the option `off` turns the plugin off. `e2e` |
| The installed folder runs on its own | `units` (the bundle is what `src/` builds, and loads with nothing outside it) |
