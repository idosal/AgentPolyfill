# Conformance: the Skills extension's client rules, for Pi

The MCP Skills extension says what a client must, should and may do. This page
lists every one of those rules, whether the Pi extension meets it, how, and
where that is tested.

**The source** is SEP-2640, status Final:
[`seps/2640-skills-extension.md`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md)
at commit `2eb3a8e` (12 November 2026), the same revision the Codex and
OpenCode forms implement ([Codex's table](../../codex/docs/conformance.md),
[OpenCode's](../../opencode/docs/conformance.md)). The rule ids are the same
in all three tables; the ids, and each rule's text in full, are in
[the shared rule list](../../core/docs/sep-2640-client-rules.md). This page describes version 0.1.0 of the Pi extension, on Pi
1.6.0.

**Status** is one of: **met**; **exception** (met, with a limit stated in the
row); **not met**; **n/a** (the rule governs something this extension does not
do).

**Summary:** 60 rules (R4 and X12 are one row). 53 met, 6 met with a stated
exception (V8, W1, X5, X9, X11, H1), none not met, 1 n/a (F1). The
exceptions are limits of Pi 1.6.0 an extension can't lift, or choices stated
in the row.

**Where a rule is checked:**

- `rules`: [`test/client-rules-test.ts`](../test/client-rules-test.ts), the
  extension's App against a hand-written server that shares no code with it
  (`npm test`, 38 tests).
- `hardening`: [`test/hardening-test.ts`](../test/hardening-test.ts): what
  was shown against what is loaded, loads asked for at once, cancelled calls,
  a server's media type, control characters, secrets, a `skills/get` answer
  that can't be used (`npm test`, 9 tests).
- `pi`: [`test/pi-test.ts`](../test/pi-test.ts), the extension in a real Pi
  1.6.0 (`npm test`, 8 tests). Not checked: Pi's TUI dialog.
- `connection`: [`test/connection-test.ts`](../test/connection-test.ts), a
  server behind a token and one behind OAuth (`npm test`).
- `conformance`: the official MCP conformance suite's four SEP-2640 client
  scenarios, run against the extension's App with
  [`test/conformance/run.sh`](../test/conformance/run.sh).

The logic of the rules (entries, verification, the held entry, limits) is the
shared core, [`../core/src/skills.ts`](../../core/src/skills.ts), which the
Codex form's tests also check rule by rule. The rows below say what the Pi
extension adds.

## Capability negotiation and the wire

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C1 | `skills/list` and `skills/get` only after seeing the server's declaration. | met | Also only with the `resources` capability, and on an earlier protocol revision from the `initialize` answer. `rules` C1 (two tests) |
| C2 | No `resources/directory/read` without `directoryRead: true`. | met | `rules` C2, C2/Y4 |
| G1 | `skills/get` takes the URI of a skill's `SKILL.md`. | met | `rules` G1 |
| S2 | Pagination with `nextCursor`. | met | `rules` S2. At most 64 pages or 2,000 entries per server |
| S4 | `ttlMs` and `cacheScope` are freshness hints. | met | The listing is read again after `ttlMs`, at most every ten seconds. `rules` S4 |

## What a skill is

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| F1 | Honour the Agent Skills specification's compatibility mechanisms. | n/a | It defines none yet. Frontmatter is carried and compared whole |
| R1 | Never resolve the authority of a skill URI. | met | A skill URI is handed only to its server; it is never used as a path (the stub's folder is a hash of it). `rules` R1 |
| R2 | A `skill://` URI alone does not make a skill. | met | `rules` R2 |
| S1 | A partial listing is no proof; load by URI alone. | met | `load_skill` takes any server and URI; an unlisted one goes through `skills/get`. `rules` S1 |
| E1 | An entry without a valid `resources` is never loaded. | met | Nor listed in Pi: it gets no stub. `rules` E1 |
| E2 | A size mismatch is a verification failure. | met | `rules` E2/V1/V2; `conformance` verify-size |
| E3 | MAY decline `"dynamic"` skills. | met | Loaded, said to be unverifiable, asked about at every load. `rules` E3/L3 |
| L1 | Support 512 resources and 16 MiB. | met | `rules` L1/L2 |
| L2 | Tell the user why a skill past a limit is declined. | met | From the entry alone, in `list_skills` and at `load_skill`; no stub is written for it. `rules` L1/L2 |
| L3 | The size limit applies to what a `"dynamic"` skill retrieves. | met | Core; `rules` E3/L3 |
| M1 | Ignore unknown `io.modelcontextprotocol/` metadata keys. | met | `rules` M1 |
| M2 | `_meta` keys for skill resources use the extension's prefix. | met | The extension sets none |

## Identity and names

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| U1, U2 | Keep both halves of a skill's identity (server, `uri`) everywhere; never key on the `uri` alone. | met | The listings, the held entries, the cache, the stored approvals, the stub's path and every tool take the pair. `rules` U1/U2/U3, U1 |
| U3 | A path where skill content is materialised encodes the server identity and the `uri`. | met | No skill content is written. The stubs' paths are `mcp-skills/served/<server>-<hash of its exact name>/<hash of the uri>/SKILL.md` in Pi's agent folder: same-URI skills of two servers land apart, and the server is readable from the path. `rules` U1/U2/U3 |
| N1, N2 | Do not assume unique names; disambiguate a collision within a listing. | met | Both are listed; each gets a name with part of its URI's hash (`mcp-docs-refunds-1a2b3c`). `rules` N1/N2 |
| N3 | Resolve names in a per-origin namespace, by a host-assigned label. | met | Pi lists a served skill as `mcp-<server>-<name>`, with the server's name in your `mcp.json`, cut to the 64 characters Pi accepts. `rules` N3/N4/X7, H1 |
| N4 | A served skill never shadows a same-named skill from another origin. | met | Its name always begins with `mcp-` and the server's name. Should a skill of yours have exactly that name, Pi keeps yours: it reads extensions' skill folders after your own and keeps the first skill of a name (Pi 1.6.0, `core/skills.js`). The served one is then still reachable with `list_skills` and `load_skill`. `rules` N3/N4/X7 |
| X7 | Identify servers by the host's label, not `serverInfo.name`. | met | `rules` N3/N4/X7 |
| X9 | SHOULD surface collisions to the user. | exception | `list_skills` marks two skills of one server with the same name. **Limit:** a served skill that a skill of yours outranks is only in Pi's own collision diagnostics, not flagged by the extension |

## Reading and verification

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| D1 | A read of a `SKILL.md` by another route is not a load. | met | Only `load_skill` loads. Pi reading the stub (its `read` tool, or `/skill:`), or Pi's own `read_mcp_resource`, loads nothing and opens nothing; the stub's body says to call `load_skill`. `rules` D1/V4; `pi` "/skill: loads it after the user approves it" |
| D2 | Return such content as an ordinary resource read. | met | The extension does not touch Pi's resource tool's results |
| D3 | Relative references resolve against the skill's root. | met | `rules` D3 |
| V1, V2 | Verify each file against its digest; never use unverified content. | met | `rules` E2/V1/V2; `conformance` verify-digest |
| V3 | Recover from staleness with `skills/get`. | met | Pi lists a server once, at the start, so each load first reads the entry with `skills/get`, and the person is asked about it as it is now. A server whose `skills/get` answer can't be used is taken at its listing's word, for a skill it listed; the load is held to that entry. `rules` V3; `hardening` (the `skills/get` fallback) |
| V4 | While acting on a skill, resolve its files only to the held entry's URIs. | met | `read_skill_file` resolves against the entry loaded in this session. Pi's own `read_mcp_resource` (on a server you set to `"exposure": "direct"`) is refused, through Pi's `tool_call` hook, for a file under a loaded skill's root, and points the model to `read_skill_file`. `rules` D1/V4, V4/V5/Y1/Y3; `pi` V4 |
| V5 | A read of an unlisted file is a verification failure. | met | Not requested at all. `rules` V4/V5/Y1/Y3 |
| V6 | Compare `SKILL.md`'s frontmatter with the entry, field by field. | met | `rules` V6; `conformance` verify-frontmatter |
| V7 | Never retrieve files ahead of need: not on connection, listing, or approval. | met | The stubs are written from the listing alone; the question needs no file. "Show me its SKILL.md first" fetches it because you asked to read it. `rules` V7; `conformance` no-prefetch |
| V8 | SHOULD cache what is retrieved; serve a cached file only for the same digest. | exception | In memory, while the extension runs, keyed by server, URI and digest. Nothing on disk, by choice. `rules` V8 |
| V9 | A digest match is not a security boundary. | met | `rules` V9 |
| W1 | Hold the entry from the load until, at the earliest, `SKILL.md` leaves context. | exception | Held while the extension runs in that Pi process. **Limit:** after `/reload`, or when a session is resumed in a new Pi process, nothing is held, and a read asks the model to load the skill again (asked about only if it changed) |
| Y1, Y2, Y3 | A directory read never extends the manifest; a new child is a changed skill. | met | Answered from the held entry. `rules` V4/V5/Y1/Y3 |
| Y4 | Surface `directoryRead` to the model. | met | `list_skill_directory`. `rules` C2/Y4 |

## Security considerations

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| X1 | Treat served skill content as untrusted input. | met | Fenced with a marker made per answer. A skill or file URI holding anything but printable ASCII is refused; descriptions lose every control and default-ignorable character; the `SKILL.md` shown to you before a load is between marker lines with a per-preview id, each of its lines marked; a file with control characters a terminal acts on (ESC, the C1 set) is treated as binary and not shown; a binary file's media type is printed only when the server's whole value is one. Secrets from your configuration are taken out of every result, stub and question. `rules` X1/X3/X4; `hardening` |
| X2 | Treat served skills as a higher-risk surface than tools. | met | A skill needs your own yes before anything of it is fetched |
| X3, X4 | Tag content with its server; never present it as a local skill. | met | The stub's name, description and body, the question, the loaded text and every file say which server. `rules` X1/X3/X4 |
| X5 | No host-side code execution from a served skill without explicit per-skill approval: (a) declarative fields ignored; (b) the gate applies to code execution while acting on the skill. | exception | (a) No frontmatter field has any effect, and none reaches a stub. (b) A skill is loaded only after you choose "Load it" in Pi's question (or approved it before, unchanged); in print or JSON mode, with nobody to ask, it is not loaded. **Limit:** Pi has no approval step for tools, so what Pi does with a skill you approved is up to Pi and the extensions you run, as for a skill on your disk. `rules` X5; `pi` |
| X6 | A skill of server A never causes a read against B. | met | `read_skill_file` reads only from the skill's server. `rules` X6 |
| X8 | Gate any cross-origin read behind per-call approval naming both servers. | met | While a served skill is loaded, Pi's `read_mcp_resource` against any other server, and this extension's own `load_skill`, `read_skill_file` and `list_skill_directory` against another server, are put to you through Pi's `tool_call` hook, naming both servers, every time, even for a skill approved before; with nobody to ask, the call is refused. Pi runs the hook for the model's calls and for codemode's nested calls alike. "Loaded" is what the conversation holds: each load is recorded in the session, so the check holds after `/reload`, `/resume`, `/fork` and `/clone`, when Pi starts a new instance of the extension that holds nothing yet. `pi` X8 (four tests: Pi's resource tool, a codemode script, the extension's own tools, a new instance after a clone) |
| X10 | Never honour frontmatter that widens permissions (`allowed-tools`). | met | `rules` X10/R3 |
| X11 | Served resources are not higher-authority; user policy decides whether a skill loads. | exception | Content arrives as a tool result; you decide each load. **Limit:** Pi has no per-skill policy for an extension's skills; a server can be left out with `skip` in the extension's settings |
| R3 | A nested `SKILL.md` read as a file is plain text. | met | `rules` X10/R3 |
| R4, X12 | A nested skill needs its own consent. | met | Asked about on its own, and the question says it is nested. `rules` R4/X12 |
| X13a | Show the origin server. | met | Everywhere |
| X13b | Let users inspect a skill before it is loaded. | met | "Show me its SKILL.md first" in the question; shown to you, not to the model. What is loaded is held to what you were shown: a skill with digests by them, and a generated skill, which has none, is loaded from that same read. Loads asked for at once (a codemode script runs its calls in parallel) are taken one after another, so each showing is the one its load follows. `rules` X13; `hardening` |
| X13c | MAY gate loading per skill. | met | Always |
| X14 | A kept approval is bound to every `uri` and `digest`, revoked when they change; a `"dynamic"` skill cannot be covered. | met | Also bound to where the server is. What is loaded is the set you were asked about. `rules` X14 (two tests) |
| X15 | A disk cache: integrity, outside every skill-discovery path, origin kept. | met | No skill content is cached on disk. The stubs, which Pi reads as a skill folder, hold the listing's name and description and the extension's own words, and are rewritten from the server's listing at each start. `rules` X15 |

## Host integration

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| H1 | (*guideline*) Surface enabled entries in context; let the user inspect and enable or disable each, with provenance. | exception | Pi lists served skills with its own, by names Pi accepts, each marked with its server; `list_skills` shows them all with their servers. **Limit:** Pi 1.6.0 has no switch for one skill from an extension's folder; `skip` in the extension's settings leaves out a server's skills. `rules` H1 |

## Rules of the Beta page that SEP-2640 does not state

| Id | Rule | Status | How, and where checked |
|---|---|---|---|
| C3 | Every request carries the request metadata in `params._meta`. | met | On a 2026-07-28 connection, which the extension's own connection negotiates. `rules` C3 |

## The extension, in Pi

Not rules of the extension, but what makes the rules hold in Pi:

| What | How, and where checked |
|---|---|
| The question is put to you, not answered in your place | Pi's `ctx.ui.select`, with "Don't load it" first; only "Load it" counts. In print or JSON mode (`ctx.hasUI` false) nothing is loaded. `pi` (a yes, a no); `hardening` (a call cancelled while you're asked, or while it waits) |
| Its own connection | The extension reaches each server itself, with what your `mcp.json` gives it (a header, a `${VARIABLE}` or a `!command` value resolved as Pi resolves it). A server Pi signed in to with OAuth is out of its reach, and it says so. `connection` |
| It stands down with Pi's MCP support | With `--no-mcp`, `"extensions": ["-builtin:mcp"]` or an extension that replaces Pi's MCP support (none of which leaves Pi's own `/mcp` command), Pi reads no `mcp.json` and connects no server, and the extension reaches none, runs no command and lists no skill. `pi` (with `--no-mcp`) |
| It reads the configuration as Pi does | The servers Pi connects, with each entry checked by Pi 1.6.0's own rules before anything in it is resolved or run; an entry Pi rejects is left out. The Events form's `test/config-test.ts` holds these rules to Pi's own function; the file is the same in both forms |
| It doesn't stand down by itself when Pi supports Skills | Pi gives an extension no way to see what its MCP client supports. Remove the extension, or set `MCP_SKILLS_OFF=1`, when Pi supports Skills itself |
| The installed folder runs on its own | `bundle` checks that `extension/dist/index.js` is what `build.mjs` makes from `src/` and imports nothing but Node and Pi; `pi` runs that bundle in Pi |
