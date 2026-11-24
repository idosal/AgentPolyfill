# SEP-3415 client conformance, in Codex

How this client (the Codex form of mcp-events, 0.1.1) stands against the
**Final** text of SEP-3415 (`seps/3415-events-extension.md` in
`modelcontextprotocol/modelcontextprotocol`, as fetched on 24 November 2026),
the same revision as the Claude Code form.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md); its tests run
against that same code (`test/spec-test.ts`, `properties-test.ts`,
`hardening-test.ts`, `recovery-test.ts` and the relay tests there), and its
run of the upstream conformance suite (17 of 17 Events client scenarios)
drives the shared client directly. The result there holds here: **with
`MCP_EVENTS_PRE_STANDARD=off`, 80 met and 6 not applicable; by default 78
met, 2 met with a documented exception (CAP-2 and CAP-4), 6 not applicable,
none missing.**

What this file adds: which rules the Codex form's own tests check end to end,
through the helper as Codex starts it (an MCP server over stdio, each call
carrying a session id) against the fixture events server, and what is
different in Codex.

## Checked end to end in this form

| Clauses | What | Test |
|---|---|---|
| LIST-1, DM-1 | events/list read; delivery modes as listed | `test/spec-test.ts` "LIST-1, DM-1" |
| CAP-2, CAP-4 | no `events/*` to a server that has not advertised the extension, with the earlier form off | `test/spec-test.ts` "CAP-2, CAP-4" |
| CAP-2 (exception) | the earlier form used by default, as in Claude Code | `test/spec-test.ts` "CAP-2 (documented exception)" |
| PUSH-1, STATE-1, DEDUP-1 | one `events/stream` per watch; the client's own registry; dedup by eventId | `test/spec-test.ts` "PUSH-1, STATE-1, DEDUP-1" |
| PUSH-2 | unwatch cancels the stream (`notifications/cancelled` on stdio) | `test/spec-test.ts` "PUSH-2" |
| POLL-1, POLL-2, POLL-5 | polled at the recommended interval, with the cursor passed back | `test/spec-test.ts` "POLL-1, POLL-2, POLL-5" |
| STATE-1, PUSH-11 | after a restart, resumed from the saved cursor; what came meanwhile arrives once | `test/spec-test.ts` "STATE-1, PUSH-11" |
| WH-1, WH-12, RX-1, RX-7 | a fresh `whsec_` secret per subscription; only signed deliveries taken, stored before 2xx; https except on loopback for tests | `test/spec-test.ts` "WH-1, WH-12 (dev), RX-1, RX-7" |
| SEC-1, SEC-2 | payloads reach the model only as tool results; the wake message carries no server text | `test/spec-test.ts` "SEC-1, SEC-2" |
| PUSH-14 | a subscription the server ends is removed, and the session told | interop: hookbench "termination" ([`interop.md`](interop.md)) |
| RH-1, RH-4 | `Mcp-Name` and `Mcp-Param-*` on Streamable HTTP | interop: hookbench "routing headers" |
| WH-7, WH-11 | webhook only on an authenticated connection; `events/unsubscribe` with name, arguments and url | interop: hookbench and outpost-demo "unwatch" |

## Different in Codex

| Clause | In Codex |
|---|---|
| SEC-3 ("Receipt of an event does NOT constitute authorization to act") | The wake is a message in the conversation, and what Codex does next goes through its approval policy as for any message. `watch_event` and `unwatch_event` are not marked read-only, so Codex's approval (or its auto-review) is asked before each; the four reading tools are marked read-only (`readOnlyHint`), which Codex runs without asking. |
| SEC-4 (policy evaluation between receipt and action) | Codex's own: approval policy, sandbox, `approvals_reviewer`. The plugin adds none. |
| SEC-5 (the client owns all subscription state) | Per Codex session, in `$CODEX_HOME/mcp-events/threads/<session id>/` (watches and cursors) and `sessions/<session id>/` (events), private to the user. |
| STATE-1 across a restart | A closed session's watches resume from their cursors the next time Codex calls one of this plugin's tools in that session (Codex starts a resumed session's MCP servers then). The README says so under Limits. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-codex`). Codex's own connection is not used: Codex has no way for a plugin to send `events/*` over it. |

## Not in this form

- The upstream conformance suite is not run against this form separately:
  its scenarios exercise the client, which is the shared one, and the Claude
  Code form runs them (`npm run conformance` there).
- The webhook relay is the same relay, with the same client code; its tests
  are the Claude Code form's (`test/relay.e2e-test.ts`, and `mod/relay`'s own).
