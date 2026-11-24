---
description: How a polyfill can serve as a client-side implementation of an MCP extension, and what each AgentPolyfill polyfill has been checked against.
---

# For spec authors

An MCP extension reaches Stable through a second Extensions Track SEP that
must, among other things, "Show two independent implementations, at least one
client-side and one server-side, that interoperate", carry a conformance
scenario, and show that the extension has been in real use
([SEP-3392](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3392-extension-lifecycle.md)).

A polyfill can be a client-side implementation in a host that has not shipped
the extension yet, used by real people against real servers. Each one here
names the spec revision it implements. Whether one counts as an independent
implementation for a given SEP is for that extension's maintainers to decide.

## What each one has been checked against

| | Revision | Client rules | Someone else's servers or documents | Upstream conformance |
|---|---|---|---|---|
| [Events](./events) | SEP-3415, Final | Every client-side rule, clause by clause, with the code and the test for each ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/events/docs/conformance.md)) | Three interop runs against servers built on Mastra's `@mastra/mcp` | The suite's Events client scenarios (an unmerged pull request): 17 of 17 |
| [Skills](./skills) | SEP-2640, Final | 60 rules: 54 met, 3 met with a stated limit, 3 that do not apply ([conformance.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/skills/docs/conformance.md)) | Hugging Face and TogoMCP, every skill loaded and every file verified; the official TypeScript SDK's Skills server and client | The official suite's client scenarios for SEP-2640: 4 of 4 |
| [Apps](./apps) | MCP Apps 2026-01-26, Stable, plus `ui/download-file` from the draft | Requirement by requirement in its design notes: each MUST, SHOULD and MAY, with its test ([COMPLIANCE.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/apps/docs/COMPLIANCE.md)) | Not stated as a separate run | The suite has no client scenarios for MCP Apps yet, so there is nothing of it to run |
| [Server Cards](./server-cards) | SEP-2127, Final (extension Beta); ext-server-card at `28db12c9b4`; AI Catalog v0.9 | One row per rule, with the test that covers it (99 tests); two rules are met by design, and the one to check a card against the live server is not met ([README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/server-cards/README.md#client-rules)) | The live catalogs and cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier; ajv with the official schema gives the same verdict on all eleven cards | The suite has no Server Card scenarios |

Each one also says where it steps outside the spec, and how to switch that off:
Events, by default, also talks to servers that advertise events in the form from
before SEP-3415 (`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP
exactly); Apps lists its departures on CSP, display modes and `platform`.
Server Cards and [ARD discovery](./ard) each list findings to report upstream
in their READMEs, such as a `specVersion` mismatch between the AI Catalog and
the Server Cards discovery doc.

## What a polyfill can tell you about a spec

Building a client to the letter, in a host that was not designed for the
extension, shows which parts of the spec a client can and cannot meet from the
outside. Each polyfill's README lists its limits on Claude Code and the host
change that would remove each; [How it works](./how-it-works) collects them into
four generic changes, none of which names an extension.

## If your extension needs a client

Open an [issue](https://github.com/idosal/AgentPolyfill/issues), or build one
with the [`create-polyfill`](./build-a-polyfill) skill.
