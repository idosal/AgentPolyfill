---
description: How a polyfill can serve as a client-side implementation of an MCP extension in each host, and what each AgentPolyfill polyfill has been checked against.
---

# For spec authors

An MCP extension reaches Stable through a second Extensions Track SEP that
must, among other things, "Show two independent implementations, at least one
client-side and one server-side, that interoperate", carry a conformance
scenario, and show that the extension has been in real use
([SEP-3392](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3392-extension-lifecycle.md)).

A polyfill can be that client-side implementation, in hosts that haven't
shipped the extension yet, used by real people against real servers. Each one
here names the spec revision it implements. Events and Skills have a test for
every client rule and run against servers their authors didn't write. Skills
passes the official conformance suite's Skills client scenarios in the Codex,
Pi and Antigravity forms; no run is recorded for the OpenCode form. The
shared Events client passes the Events client scenarios proposed
upstream (still an open pull request in the conformance suite); the Pi
end-to-end run has limits listed below. Apps checks the spec requirement by
requirement in its design notes. Whether a polyfill counts as an independent
implementation for a given SEP is up to that extension's maintainers.

Events and Skills share their protocol code and its tests in each
extension's `core/`. Host results are recorded separately:

- **Claude Code:** the first table below gives its results.
- **Codex:** each form's README gives its results:
  [Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex),
  [Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex),
  [Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex)
  and [ARD](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex).
- **Pi:** the second table gives its conformance and live-run evidence,
  checked with Pi 1.6.0.
- **OpenCode:** the third table gives its conformance and live-run
  evidence, checked with OpenCode 2.4.1.
- **Antigravity:** the fourth table gives its conformance pages and live-run
  evidence: these builds in CLI v1.5.17, earlier builds also in App
  v2.35.1.

## What each one has been checked against

### Claude Code

| | Revision | Client rules | Someone else's servers or documents | Upstream conformance |
|---|---|---|---|---|
| [Events](./events) | SEP-3415, Final | Every client-side rule, clause by clause, with the code and the test for each ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/conformance.md)) | Three interop runs against servers built on Mastra's `@mastra/mcp` | The suite's Events client scenarios (an unmerged pull request): 17 of 17, run on 0.5.0 |
| [Apps](./apps) | MCP Apps 2026-01-26, Stable, plus `ui/download-file` from the draft | Requirement by requirement: each MUST, SHOULD and MAY, with its test where it has one; one MUST, the default CSP, is not met, on purpose ([COMPLIANCE.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/docs/COMPLIANCE.md)) | Not stated as a separate run | The suite has no client scenarios for MCP Apps yet, so there is nothing of it to run |
| [Server Cards](./server-cards) | SEP-2127, Final (extension Beta); ext-server-card at `28db12c9b4`; AI Catalog v0.9 | One row per rule, with the test that covers it (108 tests); two rules are met by design, and the one to check a card against the live server is not met ([README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/README.md#client-rules)) | The live catalogs and cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier; ajv with the official schema gives the same verdict on all eleven cards | The suite has no Server Card scenarios |

Skills isn't in this table. Claude Code lists skills from MCP servers itself,
in beta from 2.1.332, so there is no polyfill for it, and this project hasn't
checked Claude Code's own support against SEP-2640. The Skills forms' results
are under Codex (its README), Pi, OpenCode and Antigravity.

Each one also says where it steps outside the spec. Events, by default, also
talks to servers that advertise events in the form from before SEP-3415, and
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly. Apps lists its
departures (the default CSP, display modes and `platform`), which have no
setting to turn them off.
Server Cards and [ARD discovery](./ard) each list findings to report upstream
in their READMEs, such as a `specVersion` mismatch between the AI Catalog and
the Server Cards discovery doc.

### Pi

| Polyfill | Client rules and conformance | Recorded live run |
|---|---|---|
| Events | The shared client's clause table holds. The Events scenarios in conformance PR #541 pass 17 of 17 checks with the shared client as Pi runs it. End to end through real Pi: 11 checks pass, none fail, 6 cannot be evaluated because Pi's own client also connects to the suite's server. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/conformance.md). | A real model, a confirmed watch, idle session, event wake, read, answer and stop, against a local fixture server. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/live-run.md). |
| Skills | 53 rules met, 6 met with a stated exception, 1 not applicable, none unmet. The official suite's four SEP-2640 client scenarios pass against the Pi form's client. X8 is met, including codemode's nested calls. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/conformance.md). | Hugging Face's public server: two skills loaded after approval, reference files read, and an answer from them. A second run previewed each `SKILL.md` before loading. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/live-run.md). |
| Server Cards | Shared rules and Pi-specific tests; S-3, comparison with the live server, is not met. No upstream Server Card scenarios were run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/conformance.md). | neon.com's catalog listed; the add question answered "Add it"; Neon Docs saved in `mcp.json` and connected for the session. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/live-run.md). |
| ARD (v0.91 draft, beyond MCP) | Shared ARD and Server Cards rules, with Pi's questions and add flow tested in real Pi using a scripted model and a local server. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/conformance.md). | buildkite.com's `ard.json` read and a search of the repository's demo registry approved before sending. **The add step was not completed:** the model asked in chat instead of calling `ard_add_mcp_server`. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/live-run.md). |
| Apps | No Pi form is built or tested. | None. |

The Events end-to-end result is not a full conformance pass: one unevaluable
check makes the poll scenario report a failure even though none of its checks
failed. The shared-client run covers all 17 checks. The live runs above used
Pi's RPC mode; scripts answered the dialogs. They do not establish how the
selectors appear in the terminal UI.

### OpenCode

| Polyfill | Client rules and conformance | Recorded live run |
|---|---|---|
| Events | The shared client, bundled unchanged; its clause table holds (with `MCP_EVENTS_PRE_STANDARD=off`, 80 clauses met and 6 not applicable). The upstream Events scenarios were run against that client in the Claude Code and Codex forms, not through OpenCode. The form's own tests check listing, poll, push and webhook delivery, resuming after a restart and the permission question in OpenCode. It departs from contract rule 4: it watches push events that OpenCode's automations also take. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/docs/conformance.md). | A real model and the fixture events server: a watch asked about, an idle session woken, the answer. AgentPolyfill's event-feeds server by poll, and a webhook through the public relay, each waking a session. Also in the TUI and in OpenCode Desktop. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md). |
| Skills | 60 rules: 54 met, 4 met with a stated exception, 1 not applicable, and 1 not met, X13b (letting you read a skill before it loads), which needs a change in OpenCode. X8 is met, also from a Code Mode program, in subagents and after a restart; so is V4. No official-suite run is recorded. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/docs/conformance.md). | Hugging Face's public server: its 25 skills in OpenCode's list, two loaded after OpenCode asked, each bound to its digest, reference files read and an answer from them; the X8 question from a Code Mode program. A skill also loaded in the TUI and in OpenCode Desktop. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md). |
| Server Cards | 28 rules: 26 met, 1 met with a stated exception (I-4: an SSE remote is refused), and 1 not met, S-3, comparison with the live server. No upstream Server Card scenarios were run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/docs/conformance.md). | neon.com's two cards found; Neon Docs added after OpenCode asked, connected, and its `search_docs` tool called. Also added and connected in the TUI. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md). |
| ARD (v0.91 draft, beyond MCP) | 19 rules: 17 met, 1 partly met (R-8, as in the other forms), and 1 met with a stated exception (Q-3: the TUI's prompt doesn't name a referred registry). Adding is tested in OpenCode with a scripted model and a local server. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/docs/conformance.md). | buildkite.com's `ard.json` read, and a search of the repository's demo registry sent after OpenCode asked. **No server was added through it.** ARD wasn't tried in the TUI or in OpenCode Desktop. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md). |
| Apps | No OpenCode form: OpenCode has no MCP Apps support, and a plugin can't read a `ui://` resource or a tool's `_meta` over OpenCode's connection. | None. |

The tests run each form in OpenCode 2.4.1, in a throwaway home, with a
scripted stand-in for a model, on Linux, macOS and Windows. The live runs
used OpenCode's free models through its server's API; Events, Skills and
Server Cards were also run in its TUI, and Events and Skills in OpenCode
Desktop.

### Antigravity

| Polyfill | Client rules and conformance | Recorded live run |
|---|---|---|
| Events | The Events scenarios in conformance PR #541 (suite at `c8625de`) pass 17 of 17 checks, through the form's MCP server and its real hook, with the watch question approved as a person would. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/conformance.md), [record](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/evidence/conformance.txt). | Against the repository's local deploys demo, whose Events support is Mastra's. In CLI 1.5.17 and App 2.35.1: a watch approved and one declined, and a call around the hook refused; in the CLI the event delivered at the next turn through the plugin's `PreInvocation` hook; in the App an idle conversation woken by the sidecar. With earlier builds: a wake during a running turn. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/live-run.md). |
| Skills | The official suite's four SEP-2640 client scenarios pass (suite at `c8625de`). X8 is not met in Antigravity (CLI or App). [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/docs/conformance.md), [record](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/docs/evidence/conformance.txt). | In CLI 1.5.17 and App 2.35.1, against a local skills server: a new skill's load approved, a changed one asked again, and a load declined. With earlier builds, Hugging Face's server: its 25 skills listed, and one loaded after approval in the App and over `agy acp`. |
| Server Cards | [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/antigravity/docs/conformance.md). | In CLI 1.5.17 and App 2.35.1, with neon.com's real Server Card: an addition approved and one declined. Earlier builds were also run over `agy acp`. |
| ARD (v0.91 draft, beyond MCP) | [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/antigravity/docs/conformance.md). | In CLI 1.5.17 and App 2.35.1, against Hugging Face's own registry: a search approved and one declined. |
| Apps | No form: the App renders MCP Apps itself (v2.34.0 and later). | None. |

The live runs were on 25 November 2026, on macOS, with a throwaway HOME the
user signed in to themselves. They did not cover a webhook watch,
`--dangerously-skip-permissions` against `force_ask`, or these builds in the
App. The IDE documents no plugin hooks, so the forms aren't supported there,
and their gated calls are refused.

## What a polyfill can tell you about a spec

Building a client to the letter, in a host that wasn't designed for the
extension, shows which parts of the spec a client can and can't meet from the
outside. Each polyfill's README lists its limits in each host and the host
change that would remove each; [How it works](./how-it-works) collects them into
four generic changes, none of which names an extension. One example: SEP-2640's
rule X8 (a skill from one server reading another server's resources is put to
you first):

- **Codex:** can't be met yet, because Codex doesn't let a plugin ask.
- **Pi:** met. Its `tool_call` hook can block and ask, including codemode's
  nested calls. Reads through another extension's own connection pass no
  hook of the Skills extension.
- **OpenCode:** met. A hook on OpenCode's resource read puts a read of
  another server to OpenCode's permission rules, per call, naming both
  servers, whatever the read is named (from a Code Mode program too), in
  subagents and after a restart.
- **Antigravity:** not met. Once a served skill is loaded, the plugin's
  hook asks (`force_ask`) before a `read_resource` from another server,
  naming both servers, but Antigravity ignores that question, in CLI 1.5.17
  and App 2.35.1: no card is shown, and the read goes ahead.

## If your extension needs a client

Open an [issue](https://github.com/idosal/AgentPolyfill/issues), or build one
with the [`create-polyfill`](./build-a-polyfill) skill.
