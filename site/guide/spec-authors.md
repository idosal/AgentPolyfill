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
passes the official conformance suite's Skills client scenarios in each host
form. The shared Events client passes the Events client scenarios proposed
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
- **Copilot CLI:** the third table gives its conformance and live-run
  evidence, checked with Copilot CLI 1.0.115.

## What each one has been checked against

### Claude Code

| | Revision | Client rules | Someone else's servers or documents | Upstream conformance |
|---|---|---|---|---|
| [Events](./events) | SEP-3415, Final | Every client-side rule, clause by clause, with the code and the test for each ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/docs/conformance.md)) | Three interop runs against servers built on Mastra's `@mastra/mcp` | The suite's Events client scenarios (an unmerged pull request): 17 of 17, run on 0.5.0 |
| [Skills](./skills) | SEP-2640, Final | 60 rules: 54 met, 3 met with a stated limit, 3 that do not apply ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/docs/conformance.md)) | Hugging Face and TogoMCP, every skill loaded and every file verified; the official TypeScript SDK's Skills server and client | The official suite's client scenarios for SEP-2640: 4 of 4 |
| [Apps](./apps) | MCP Apps 2026-01-26, Stable, plus `ui/download-file` from the draft | Requirement by requirement: each MUST, SHOULD and MAY, with its test where it has one; one MUST, the default CSP, is not met, on purpose ([COMPLIANCE.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/docs/COMPLIANCE.md)) | Not stated as a separate run | The suite has no client scenarios for MCP Apps yet, so there is nothing of it to run |
| [Server Cards](./server-cards) | SEP-2127, Final (extension Beta); ext-server-card at `28db12c9b4`; AI Catalog v0.9 | One row per rule, with the test that covers it (108 tests); two rules are met by design, and the one to check a card against the live server is not met ([README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/README.md#client-rules)) | The live catalogs and cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier; ajv with the official schema gives the same verdict on all eleven cards | The suite has no Server Card scenarios |

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

### Copilot CLI

| Polyfill | Client rules and conformance | Recorded live run |
|---|---|---|
| Events | The shared client's clause table holds. The Events scenarios in conformance PR #541 pass 17 of 17 checks, end to end through the bundled extension. hookbench's reference server passes 7 of 7, and this repository's event-feeds 3 of 3. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/docs/conformance.md). | The Copilot CLI terminal, with a scripted model: a watch set through Copilot's tool prompt, an event while the session was idle, the session waking and reading it, against a local fixture server. The same in VS Code 1.147.0's Copilot harness: a message from the plugin, then the turn. [Live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/docs/live-run.md). |
| Skills | Built into Copilot: Copilot CLI 1.0.115 declares it to every server. No Copilot form. | None. |
| Server Cards | Shared rules and Copilot-specific tests, 111 in all; S-3, comparison with the live server, is not met. The suite has no Server Card scenarios. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/docs/conformance.md). | Installed from a clone; neon.com's Neon and Neon Docs found; after Copilot's tool prompt and "Add it", `neon-docs` written with `copilot mcp add`. In `copilot -p`, with `--yolo` too, Copilot declined the form and nothing was written. |
| ARD (v0.91 draft, beyond MCP) | Shared ARD and Server Cards rules, with Copilot's questions and add flow tested over stdio as Copilot starts the server, 123 tests in all. No upstream ARD conformance run. [Conformance](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/copilot/docs/conformance.md). | buildkite.com's catalogs read; a search of the demo registry on 127.0.0.1 sent only after Copilot's tool prompt and "Send the search". No server was added through ARD. |
| Apps | Built into Copilot for graphical hosts (VS Code's Copilot harness); none in the terminal. No Copilot form. | None. |

The Server Cards and ARD runs in Copilot CLI used a scripted model too, with
no GitHub sign-in. None of these runs shows how a model of GitHub's choosing
uses the tools in Copilot CLI, and an install from GitHub, rather than from a
clone, isn't covered.

## What a polyfill can tell you about a spec

Building a client to the letter, in a host that wasn't designed for the
extension, shows which parts of the spec a client can and can't meet from the
outside. Each polyfill's README lists its limits in each host and the host
change that would remove each; [How it works](./how-it-works) collects them into
four generic changes, none of which names an extension. One example: SEP-2640's
rule X8 (a skill from one server reading another server's resources is put to
you first):

- **Claude Code:** met, with one stated limit.
- **Codex:** can't be met yet, because Codex doesn't let a plugin ask.
- **Pi:** met. Its `tool_call` hook can block and ask, including codemode's
  nested calls. Reads through another extension's own connection pass no
  hook of the Skills extension.
- **Copilot CLI:** Skills is built in, so there is no Copilot form to check.

## If your extension needs a client

Open an [issue](https://github.com/idosal/AgentPolyfill/issues), or build one
with the [`create-polyfill`](./build-a-polyfill) skill.
