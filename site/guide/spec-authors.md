---
description: How a polyfill can serve as a client-side implementation of an MCP extension, in Claude Code and Codex, and what each AgentPolyfill polyfill has been checked against.
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
passes the official conformance suite's Skills client scenarios in both hosts,
and Events passes the Events client scenarios proposed upstream (still an open
pull request in the conformance suite). Apps checks the spec requirement by
requirement in its design notes. Whether a polyfill counts as an independent
implementation for a given SEP is up to that extension's maintainers.

The table below is for the Claude Code forms. The Codex forms of Events and
Skills share the protocol code and its tests with them (in each extension's
`core/`), and each Codex README gives its own results.

## What each one has been checked against

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

## What a polyfill can tell you about a spec

Building a client to the letter, in a host that wasn't designed for the
extension, shows which parts of the spec a client can and can't meet from the
outside. Each polyfill's README lists its limits in each host and the host
change that would remove each; [How it works](./how-it-works) collects them into
four generic changes, none of which names an extension. One example: SEP-2640's
rule X8 (a skill from one server reading another server's resources is put to
you first) is met in Claude Code, with one stated limit, and can't be met in
Codex yet, because Codex doesn't let a plugin ask.

## If your extension needs a client

Open an [issue](https://github.com/idosal/AgentPolyfill/issues), or build one
with the [`create-polyfill`](./build-a-polyfill) skill.
