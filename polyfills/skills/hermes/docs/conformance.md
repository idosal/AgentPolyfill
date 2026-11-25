# Conformance: the Skills extension's client rules, for Hermes

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules, whether the Hermes plugin meets it, how, and
where that is tested.

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
at commit `2eb3a8e` (12 November 2026), the revision the other forms
implement. The rule ids, and each rule's text in full, are in
[the shared rule list](../../core/docs/sep-2640-client-rules.md); the rows
here shorten the text. This page describes version 0.1.0 of the Hermes plugin,
on Hermes Agent v0.23.4.

**Status** is one of: **met**; **exception** (met, with a limit stated in the
row); **not met**; **n/a** (the rule governs something this plugin does not do).

**Summary:** 60 rules (R4 and X12 are one row). 53 met, 6 met with a stated
exception (D2, V8, W1, X5, X9, X13b), none not met, 1 n/a (F1).

**Where a rule is checked:**

- `rules`: the Codex form's [`test/client-rules-test.ts`](../../codex/test/client-rules-test.ts),
  its App against a hand-written server that shares no code with it. This
  form's helper runs that App as it is, so these tests check this form's
  client logic (`cd ../codex && npm test`, 81 tests).
- `helper`: [`test/helper-test.ts`](../test/helper-test.ts), the bundled
  helper spoken to as the Python half speaks to it, against the fixture
  skills server.
- `plugin`: [`test/test_plugin.py`](../test/test_plugin.py), the Python half
  with a stand-in `ctx`.
- `e2e`: [`test/e2e_test.py`](../test/e2e_test.py), the plugin in Hermes
  v0.23.4, installed from its release tag.
- `conformance`: the official MCP conformance suite's four SEP-2640 client
  scenarios (`main` at `96a6f94`), through the bundled helper
  ([`test/conformance/run.sh`](../test/conformance/run.sh)): 4 of 4. The
  suite is someone else's code; the script gives it only the system's basics
  and a temporary `HOME`.
- `real`: Hugging Face's public server, through Hermes
  ([`test/interop_huggingface.py`](../test/interop_huggingface.py)): 4 of 4.

Where a row says "as in Codex", the rule is met by the shared client logic
([`../../codex/src/app.ts`](../../codex/src/app.ts) over
[`../../core`](../../core)) and is checked by `rules`; the Codex form's
[conformance page](../../codex/docs/conformance.md) has the detail.

## Capability negotiation and the wire

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C1 | `skills/list` and `skills/get` only after seeing the server's declaration. | met | As in Codex. `rules` C1 |
| C2 | No `resources/directory/read` without `directoryRead: true`. | met | As in Codex. `rules` C2 |
| G1 | `skills/get` takes the URI of a skill's `SKILL.md`. | met | As in Codex. `rules` G1 |
| S2 | Pagination with `nextCursor`. | met | As in Codex. `rules` S2 |
| S4 | `ttlMs` and `cacheScope` are freshness hints. | met | The listing is read again after `ttlMs`, at most every ten seconds; the stubs follow from the next session. `rules` S4, `e2e` "always covers one version only" |

## What a skill is

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| F1 | Honour the Agent Skills specification's compatibility mechanisms. | n/a | It defines none yet |
| R1 | Never resolve the authority of a skill URI. | met | As in Codex. A stub's folder is named from the server label and skill name, never from the URI's authority. `rules` R1 |
| R2 | A `skill://` URI alone does not make a skill. | met | As in Codex. `rules` R2 |
| S1 | A partial listing is no proof; load by URI alone. | met | `load_skill` takes any server and URI. `rules` S1 |
| E1 | An entry without a valid `resources` is never loaded. | met | Nor listed in Hermes. `rules` E1 |
| E2 | A size mismatch is a verification failure. | met | `rules` E2; `conformance` verify-size |
| E3 | MAY decline `"dynamic"` skills. | met | Loaded, said to be unverifiable, and asked about at every load (its approval key holds a fresh nonce). `helper` "X14: a \"dynamic\" skill cannot be covered by a kept approval" |
| L1 | Support 512 resources and 16 MiB. | met | `rules` L1, `helper` "L1, lazy retrieval" |
| L2 | Tell the user why a skill past a limit is declined. | met | From the entry alone, in `list_skills` and before Hermes's question; no stub is written for it. `rules` L2 |
| L3 | The size limit applies to what a `"dynamic"` skill retrieves. | met | As in Codex. `rules` E3/L3 |
| M1 | Ignore unknown `io.modelcontextprotocol/` metadata keys. | met | `rules` M1 |
| M2 | `_meta` keys for skill resources use the extension's prefix. | met | The plugin sets none |

## Identity and names

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| U1, U2 | Keep both halves of a skill's identity (server, `uri`) everywhere; never key on the `uri` alone. | met | The registry, each session's held entries, the approval keys (a digest of where the server is, the URI and the manifest), what the Python half records for X8, and every tool take the pair. `rules` U1/U2/U3, `helper` X14 (three tests), "approval keys keep the whole identity, whatever the URI's length" |
| U3 | A path where skill content is materialised encodes the server identity. | met | No skill content is written. A stub (the plugin's own words and the listing's name and description) is at `$HERMES_HOME/mcp-skills/stubs/<server>-<name>[-<hash>]/SKILL.md`. `helper` "L1, lazy retrieval" |
| N1, N2 | Do not assume unique names; disambiguate a collision within a listing. | met | Both are listed, each with part of its URI's hash in its name. `helper` "no stub can take another skill's name" |
| N3 | Resolve names in a per-origin namespace, by a host-assigned label. | met | Hermes lists a served skill as `mcp-skills:<server>-<name>`, with the server's name in your config. `e2e` "listed … loaded after approval" |
| N4 | A served skill never shadows a same-named skill from another origin. | met | Its name always carries the plugin's namespace and the server, so it never equals a local skill's name, and no stub can take another's name. `helper` "no stub can take another skill's name" |
| X7 | Identify servers by the host's label, not `serverInfo.name`. | met | `rules` N3/N4/X7 |
| X9 | SHOULD surface collisions to the user. | exception | As in Codex: `list_skills` marks two skills of one server with the same name; a served skill whose name a local skill also has is not flagged, and the two names differ in Hermes's list |

## Reading and verification

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| D1 | A read of a `SKILL.md` by another route is not a load. | met | Only `load_skill` loads. Hermes's own `skill_view` of a stub reads the plugin's stub, not the skill. `rules` D1/V4 |
| D2 | Return such content as an ordinary resource read. | exception | Hermes's generic resource tool (`mcp__<server>__read_resource`) is refused for a served skill's files rather than returning them: it would neither ask nor check digests (V4). Other resources read as usual. `plugin` "not read past load_skill" |
| D3 | Relative references resolve against the skill's root. | met | `rules` D3 |
| V1, V2 | Verify each file against its digest; never use unverified content. | met | `rules` E2/V1/V2; `conformance` verify-digest; `real`; `helper` "a SKILL.md that does not match its digest is not shown" |
| V3 | Recover from staleness with `skills/get`. | met | `rules` V3 |
| V4 | While acting on a skill, resolve its files only to the held entry's URIs. | met | `read_skill_file` resolves against the entry the session loaded. Hermes's generic resource tool is refused for any file of a listed skill, any `skill://` URI, and any file under a skill the session loaded by its URI alone. `rules` D1/V4, `plugin` V4 |
| V5 | A read of an unlisted file is a verification failure. | met | Not requested at all. `rules` V4/V5/Y1/Y3 |
| V6 | Compare `SKILL.md`'s frontmatter with the entry, field by field. | met | `rules` V6; `conformance` verify-frontmatter |
| V7 | Never retrieve files ahead of need: not on connection, listing, or approval. | met | Stubs come from the listing alone; Hermes's question needs no file. `/mcp-skills show` fetches the `SKILL.md` because you asked to read it. `rules` V7; `conformance` no-prefetch; `helper` "asking fetches nothing"; `e2e` "declined load fetches nothing" |
| V8 | SHOULD cache what is retrieved; serve a cached file only for the same digest. | exception | As in Codex: in memory, per helper, keyed by server, URI and digest. Nothing on disk, by choice |
| V9 | A digest match is not a security boundary. | met | `rules` V9 |
| W1 | Hold the entry from the load until, at the earliest, `SKILL.md` leaves context. | exception | Held per Hermes session while the helper runs. **Limit:** when the helper starts again (a gateway restart, or a change in the servers it may use), `read_skill_file` asks the model to load the skill again, and Hermes asks you unless you approved that version for the session or always. What the session loaded is kept across that (`ctx.state`), so X8 and V4 still hold |
| Y1, Y2, Y3 | A directory read never extends the manifest; a new child is a changed skill. | met | `rules` V4/V5/Y1/Y3 |
| Y4 | Surface `directoryRead` to the model. | met | `list_skill_directory`. `rules` C2/Y4 |

## Security considerations

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| X1 | Treat served skill content as untrusted input. | met | As in Codex: fenced with a per-answer marker, unprintable URIs refused, descriptions cleaned. A stub's description has no angle brackets, so it can't open or close a tag of Hermes's system prompt. `rules` X1/X3/X4, `helper` "a description cannot open or close a tag of the system prompt" |
| X2 | Treat served skills as a higher-risk surface than tools. | met | A skill needs your own yes through Hermes's approval before anything of it is fetched; none is loaded where Hermes approves without asking, or where the plugin can't tell. `e2e` "declined load fetches nothing", "X5: no load where Hermes approves without asking" |
| X3, X4 | Tag content with its server; never present it as a local skill. | met | The stub, the question, the loaded text and every file say which server; the name carries `mcp-skills:` and the server. `rules` X1/X3/X4 |
| X5 | No host-side code execution from a served skill without explicit per-skill approval: (a) declarative fields ignored; (b) the gate applies to code execution while acting on the skill. | exception | (a) No frontmatter field has any effect, and none reaches a stub. (b) A skill is loaded only after you answer Hermes's approval for it (or approved that version before); with nobody to ask, Hermes fails closed; with `--yolo`, a session's `/yolo`, `hermes -z` or `approvals.mode: off`, the plugin refuses the load before Hermes is asked. After the yes, commands go through Hermes's approvals as for any skill. **Limits:** a skill loaded with your yes is held to no more than your Hermes approvals; unattended approve modes (`approvals.cron_mode: approve` and the like) approve loads as you set them to; telling `/yolo` uses a check that isn't on Hermes's published plugin API (README, "Hermes calls it uses"). `plugin` "X5, X8 refused where Hermes approves without asking", "telling that Hermes approves without asking"; `e2e` "X5: no load where Hermes approves without asking" (`approvals.mode: off`; `--yolo` and `/yolo` go through the same Hermes check, not run separately) |
| X6 | A skill of server A never causes a read against B. | met | `read_skill_file` reads only from the skill's server. `rules` X6 |
| X8 | Gate any cross-origin read behind per-call approval naming both servers. | met | The `pre_tool_call` hook puts every `mcp__<server>__read_resource` call against another server, while the session holds a skill, to Hermes's approval, naming both servers, with a fresh key per call so no kept answer covers another. Through Tool Search's `tool_call` too (Hermes runs the hook per entry). Fails closed: if what the session loaded can't be read or saved, or the call names no session, every resource read is asked about; where Hermes approves without asking, such reads are refused. The tool's name is matched to its server as Hermes names it (shortened past 64 characters); where it can't be placed surely, the read is asked about. Hermes reads resources only through that tool (it doesn't follow resource links on its own). `plugin` (eight tests: the question, what a session loaded outliving a restart, a key per read, fails closed, no session key, refused in YOLO, reads matched as Hermes names its tools, a failed save), `e2e` "cross-server resource read is asked every time", "a long server name is asked about too". Not tested through Tool Search: that rests on Hermes running `pre_tool_call` for each `tool_call` entry, read in its source, not run here |
| X10 | Never honour frontmatter that widens permissions (`allowed-tools`). | met | `rules` X10/R3; no frontmatter reaches a stub |
| X11 | Served resources are not higher-authority; user policy decides whether a skill loads. | met | Content arrives as a tool result. Hermes's per-skill switch (`skills.disabled`, by the `mcp-skills:` name) is honoured: such a skill is refused and none of its files read. `plugin`, `e2e` "disabled refused" |
| R3 | A nested `SKILL.md` read as a file is plain text. | met | `rules` X10/R3 |
| R4, X12 | A nested skill needs its own consent. | met | Asked about on its own, and the question says it is nested. `rules` R4/X12 |
| X13a | Show the origin server. | met | Everywhere: the stub's description starts with its server, and Hermes's question names it. `helper` "L1, lazy retrieval", `e2e` "listed, loaded after approval and files read" (the question's text) |
| X13b | Let users inspect a skill before it is loaded. | exception | Hermes's question ends with `/mcp-skills show <server> <uri>`. That command shows you the `SKILL.md`, checked against its digest; a slash command's answer goes to you and not into the conversation, so the model doesn't see it. **Limit:** it's a step of your own (deny, type it, ask again), because Hermes's approval offers fixed answers; and for a generated (`"dynamic"`) skill, the load generates it again, so what loads may differ from what you read. `helper` X13b (two tests), `plugin` X13b, `e2e` "X13b: read first with the command, the model never sees it". That the model never sees the answer is tested through the TUI gateway's `command.dispatch`; other surfaces (Desktop, chat apps) weren't tried |
| X13c | MAY gate loading per skill. | met | Always: each load is put to Hermes's approval with a key of its own. `e2e` "always covers one version only", "declined load fetches nothing" |
| X14 | A kept approval is bound to every `uri` and `digest`, revoked when they change; a `"dynamic"` skill cannot be covered. | met | The approval's key is a digest of where the server is, the URI and the manifest hash; the load refuses any other version. `helper` X14 (three tests), a version shown and another served (two), `e2e` "always covers one version only" |
| X15 | A disk cache: integrity, outside every skill-discovery path, origin kept. | met | No skill content is cached on disk. The stubs, registered with `ctx.register_skill` from the plugin's own folder (not a folder Hermes scans for skills), hold the listing's name and description and the plugin's words, and are rewritten from the listing at each start. `helper` "L1, lazy retrieval" (nothing of a skill fetched to list it), "K2" (stubs follow the servers it may use) |

## Host integration

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| H1 | (*guideline*) Surface enabled entries in context; let the user inspect and enable or disable each, with provenance. | met | Hermes lists them with its skills, each marked with its server; `skills.disabled` turns one off; `/mcp-skills show` lets you read one. `e2e` |

## Rules of the Beta page that SEP-2640 does not state

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C3 | Every request carries the request metadata in `params._meta`. | met | On a 2026-07-28 connection, as in Codex. `rules` C3 |

## The plugin in Hermes

Not rules of the extension, but what makes the rules hold in Hermes:

| What | How, and where checked |
|---|---|
| Hermes's approval isn't answered in your place | A `pre_tool_call` approve directive raises Hermes's own approval, which fails closed where nobody can answer; where Hermes would answer it itself (YOLO, `approvals.mode: off`), the plugin refuses first. `e2e`, `plugin` |
| It stands down | Hermes v0.23.4 has nothing to detect; `hermes plugins disable mcp-skills` turns it off (README, "When Hermes supports Skills itself") |
| Only the servers you named, as `config.yaml` has them | `settings.servers`, read again at each turn and tool call; no `${VAR}` filled in from `.env`. `tools/hermes/shared/test_servers.py`, `plugin` |
| The installed folder runs on its own | `test/plugin-test.ts` (the bundle is what `src/` builds, and the shared Python modules match), and `hermes plugins validate` passes |
