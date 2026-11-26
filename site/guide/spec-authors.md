---
description: How a polyfill can serve as a client-side implementation of an MCP extension in each host, and what each AgentPolyfill polyfill has been checked against.
---

# For spec authors

An MCP extension reaches Stable through a second Extensions Track SEP that
must, among other things, "Show two independent implementations, at least one
client-side and one server-side, that interoperate", carry a conformance
scenario, and show that the extension has been in real use
([SEP-3392](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3392-extension-lifecycle.md)).

Extension maintainers decide which implementations qualify for their SEP.
The tables below link to the client requirements, test suites and independent
servers used for interoperability checks. Shared protocol code is tested
separately from each host’s approval, transport and delivery behavior.

For Codex, see the adapter results for [Events](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex),
[Skills](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex),
[Server Cards](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex) and
[ARD](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex).

## What each one has been checked against

### Claude Code

| | Revision | Client rules | Independent servers or documents | Upstream conformance |
|---|---|---|---|---|
| [Events](./events) | SEP-3415, Final | Every client-side rule, clause by clause, with the code and the test for each ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/conformance.md)) | Three interop runs against servers built on Mastra's `@mastra/mcp` | The suite's Events client scenarios (an unmerged pull request): 17 of 17, run on 0.5.0 |
| [Apps](./apps) | MCP Apps 2026-01-26, Stable, plus `ui/download-file` from the draft | Requirement by requirement: each MUST, SHOULD and MAY, with its test where it has one; one MUST, the default CSP, is not met ([COMPLIANCE.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/docs/COMPLIANCE.md)) | Not stated as a separate run | The suite has no client scenarios for MCP Apps yet, so there is nothing of it to run |
| [Server Cards](./server-cards) | SEP-2127, Final (extension Beta); ext-server-card at `28db12c9b4`; AI Catalog v0.9 | One row per rule, with the test that covers it (108 tests); two rules are met by design, and the one to check a card against the live server is not met ([README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/README.md#client-rules)) | The live catalogs and cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier; ajv with the official schema gives the same verdict on all eleven cards | The suite has no Server Card scenarios |

Skills isn't in this table. Claude Code lists skills from MCP servers itself,
in beta from 2.1.332, so there is no polyfill for it, and this project hasn't
checked Claude Code's own support against SEP-2640. The Skills forms' results
are under Codex (its README), Pi, OpenCode, Antigravity and Hermes.

Each one also says where it steps outside the spec. Events, by default, also
talks to servers that advertise events in the form from before SEP-3415, and
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly. Apps lists its
departures (the default CSP, display modes and `platform`), which have no
setting to turn them off.
Server Cards and [ARD discovery](./ard) document interoperability issues
in their READMEs, such as a `specVersion` mismatch between the AI Catalog and
the Server Cards discovery doc.

### Pi

| Polyfill | Client rules and conformance | Checked in Pi 1.6.0 |
|---|---|---|
| Events | The shared client's clause table holds. The Events scenarios in conformance PR #541 pass 17 of 17 checks with the shared client as Pi runs it. End to end through real Pi: 11 checks pass, none fail, 6 cannot be evaluated because Pi's own client also connects to the suite's server. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/docs/conformance.md). | A confirmed watch, an idle session, the event wake, the read, the answer and the stop. |
| Skills | 53 rules met, 6 met with a stated exception, 1 not applicable, none unmet. The official suite's four SEP-2640 client scenarios pass against the Pi form's client. X8 is met, including codemode's nested calls. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/conformance.md). | Hugging Face's public server: two skills loaded after approval, reference files read, and an answer from them; each `SKILL.md` previewed before loading. |
| Server Cards | Shared rules and Pi-specific tests; S-3, comparison with the live server, is not met. No upstream Server Card scenarios were run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/conformance.md). | neon.com's catalog listed; the add question answered "Add it"; Neon Docs saved in `mcp.json` and connected for the session. |
| ARD (v0.91 draft, beyond MCP) | Shared ARD and Server Cards rules, with Pi's questions and add flow covered by the form's tests. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/conformance.md). | buildkite.com's `ard.json` read, and a search of the repository's demo registry approved before sending. Adding is checked by the form's tests only. |
| Apps | No Pi form is built or tested. | None. |

The Events end-to-end result is not a full conformance pass: one unevaluable
check makes the poll scenario report a failure even though none of its checks
failed. The shared-client run covers all 17 checks. The third column was
checked in Pi's RPC mode. Not checked: how the selectors appear in the
terminal UI.

### OpenCode

| Polyfill | Client rules and conformance | Checked in OpenCode 2.4.1 |
|---|---|---|
| Events | The shared client, bundled unchanged; its clause table holds (with `MCP_EVENTS_PRE_STANDARD=off`, 80 clauses met and 6 not applicable). The upstream Events scenarios were run against that client in the Claude Code and Codex forms, not through OpenCode. The form's own tests check listing, poll, push and webhook delivery, resuming after a restart and the permission question in OpenCode. It departs from contract rule 4: it watches push events that OpenCode's automations also take. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/docs/conformance.md). | A watch asked about, an idle session woken, the answer. AgentPolyfill's event-feeds server by poll, and a webhook through the public relay, each waking a session. Also in the TUI and in OpenCode Desktop. |
| Skills | 60 rules: 54 met, 4 met with a stated exception, 1 not applicable, and 1 not met, X13b (letting you read a skill before it loads), which needs a change in OpenCode. X8 is met, also from a Code Mode program, in subagents and after a restart; so is V4. The official suite was not run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/docs/conformance.md). | Hugging Face's public server: its 25 skills in OpenCode's list, two loaded after OpenCode asked, each bound to its digest, reference files read and an answer from them; the X8 question from a Code Mode program. Loading a skill also in the TUI and in OpenCode Desktop. |
| Server Cards | 28 rules: 26 met, 1 met with a stated exception (I-4: an SSE remote is refused), and 1 not met, S-3, comparison with the live server. No upstream Server Card scenarios were run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/docs/conformance.md). | neon.com's two cards found; Neon Docs added after OpenCode asked, connected, and its `search_docs` tool called. Also added and connected in the TUI. |
| ARD (v0.91 draft, beyond MCP) | 19 rules: 17 met, 1 partly met (R-8, as in the other forms), and 1 met with a stated exception (Q-3: the TUI's prompt doesn't name a referred registry). Adding is covered by the form's tests. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/docs/conformance.md). | buildkite.com's `ard.json` read, and a search of the repository's demo registry sent after OpenCode asked. Adding is checked by the form's tests only. Not checked in the TUI or in OpenCode Desktop. |
| Apps | No OpenCode form: OpenCode has no MCP Apps support, and a plugin can't read a `ui://` resource or a tool's `_meta` over OpenCode's connection. | None. |

The tests run each form in OpenCode 2.4.1 on Linux, macOS and Windows.
Events, Skills and Server Cards were also checked in its TUI, and Events and
Skills in OpenCode Desktop.

### Antigravity

| Polyfill | Client rules and conformance | Checked in Antigravity |
|---|---|---|
| Events | The Events scenarios in conformance PR #541 (suite at `c8625de`) pass 17 of 17 checks, through the form's MCP server and its real hook. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/docs/conformance.md). | Against the repository's local deploys demo, whose Events support is Mastra's. In CLI 1.5.17 and App 2.35.1: a watch approved and one declined, and a call around the hook refused; in the CLI the event delivered at the next turn through the plugin's `PreInvocation` hook; in the App an idle conversation woken by the sidecar. With earlier builds: a wake during a running turn. |
| Skills | The official suite's four SEP-2640 client scenarios pass (suite at `c8625de`). X8 is not met in Antigravity (CLI or App). [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/docs/conformance.md). | In CLI 1.5.17 and App 2.35.1: a new skill's load approved, a changed one asked again, and a load declined. With earlier builds, Hugging Face's server: its 25 skills listed, and one loaded after approval in the App and over `agy acp`. |
| Server Cards | [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/antigravity/docs/conformance.md). | In CLI 1.5.17 and App 2.35.1, with neon.com's real Server Card: an addition approved and one declined. Earlier builds were also checked over `agy acp`. |
| ARD (v0.91 draft, beyond MCP) | [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/antigravity/docs/conformance.md). | In CLI 1.5.17 and App 2.35.1, against Hugging Face's own registry: a search approved and one declined. |
| Apps | No form: the App renders MCP Apps itself (v2.34.0 and later). | None. |

Not checked: a webhook watch, or `--dangerously-skip-permissions` against
`force_ask`. The IDE documents no plugin hooks, so the forms aren't supported there,
and their gated calls are refused.

### Copilot CLI

| Polyfill | Client rules and conformance | Checked in Copilot |
|---|---|---|
| Events | The shared client's clause table holds. The Events scenarios in conformance PR #541 pass 17 of 17 checks, end to end through the bundled extension. hookbench's reference server passes 7 of 7, and this repository's event-feeds 3 of 3. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/docs/conformance.md). | In the Copilot CLI terminal: a watch set through Copilot's tool prompt, an event while the session was idle, the session waking and reading it. The same in VS Code 1.147.0's Copilot harness: a message from the plugin, then the turn. |
| Skills | Built into Copilot: Copilot CLI 1.0.115 declares it to every server. No Copilot form. | None. |
| Server Cards | Shared rules and Copilot-specific tests, 114 in all; S-3, comparison with the live server, is not met. The suite has no Server Card scenarios. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/docs/conformance.md). | Installed from a clone; neon.com's Neon and Neon Docs found; after Copilot's tool prompt and "Add it", `neon-docs` written with `copilot mcp add`. In `copilot -p`, with `--yolo` too, Copilot declines the form and nothing is written. In VS Code 1.147.0's Copilot harness, an add through VS Code's tool prompt and the plugin's form, which VS Code shows as one paragraph. |
| ARD (v0.91 draft, beyond MCP) | Shared ARD and Server Cards rules, with Copilot's questions and add flow tested over stdio as Copilot starts the server, 124 tests in all. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/copilot/docs/conformance.md). | buildkite.com's catalogs read; a search of the repository's demo registry sent only after Copilot's tool prompt and "Send the search". No other registry was checked. Adding is checked by the form's tests only. In VS Code, the server loads; no search was checked. |
| Apps | Built into Copilot for graphical hosts (VS Code's Copilot harness); none in the terminal. No Copilot form. | None. |

Not checked in Copilot CLI: how a model of GitHub's choosing uses the tools.
An install from GitHub, rather than from a clone, was checked in Copilot CLI
1.0.105, and not in 1.0.115, in the interactive TUI, or in VS Code. Not
checked in VS Code: the question Events asks before a watch.

### Hermes Agent

| Polyfill | Client rules and conformance | Checked in Hermes |
|---|---|---|
| Events | The shared client's clause table holds. The Events scenarios in conformance PR #541 pass the 14 checks that apply, through the bundled helper; the webhook scenario's three are unverified, not violated, as Hermes owns webhook delivery. hookbench's reference server passes 6 of 6 through Hermes. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/hermes/docs/conformance.md). | v0.23.4: a watch approved in Hermes, an event while the session was idle, the session waking and reading it; the hosted event-feeds demo by poll; the same through Hermes's shared gateway. |
| Skills | The Codex client rules, all 60 in the table. The four upstream Skills client scenarios pass through the helper. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/hermes/docs/conformance.md). | v0.23.4: Hugging Face's server, its 25 skills listed as stubs, one loaded after Hermes's approval and checked against its digest, and a file it refers to read. |
| Server Cards | Shared rules and Hermes tests for approval, config writes, removal, OAuth and session isolation. S-3, comparison with the live server, is not met. The suite has no Server Card scenarios. [README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/hermes/README.md#tests). | v0.23.4: neon.com's Neon Docs found, added after Hermes's approval, and its tools reaching the model after `/reload-mcp`. |
| ARD (v0.91 draft, beyond MCP) | Shared rules and Hermes tests for search, referrals, additions and coexistence with Server Cards. No upstream ARD conformance run. [README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/hermes/README.md#tests). | v0.23.4: buildkite.com's `ard.json` and card read. Not checked against a public registry; search and adding are checked by the form's tests only. |
| Apps | Not yet. | None. |

Not checked in Hermes: how a model of your choosing uses the tools, and
Windows.

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
