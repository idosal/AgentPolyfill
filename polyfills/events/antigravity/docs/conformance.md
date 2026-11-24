# SEP-3415 checks in Antigravity

Revision: Final text as of 24 November 2026, matching the Codex form.
The [shared clause table](../../claude-code/docs/conformance.md) gives the
normative text and core implementation for each of 86 client clauses. The
core is bundled unchanged. This document does not turn another host's run
into an Antigravity result.

Local run on 25 November 2026: **99 tests passed, zero failures or skips**.
Typecheck, byte-identical bundle comparison, standalone plugin boot and
third-party notice comparison also passed. Existing installed dependencies
were reused. The sandbox initially blocked three loopback listener tests;
the complete suite then passed with local-listener access enabled.

| Local check | Coverage |
|---|---|
| `core-spec.test.ts` (imports the existing suite) | Declaration and protocol gating; earlier-form opt-in; list-change opt-in and reconnection; routing headers; cursor, replay gap, poll timing, heartbeat and termination rules; authenticated webhook selection. Its two helper lifecycle tests run through this adapter. |
| `core-hardening.test.ts` | Untrusted data, known-secret redaction, bounded responses, receiver errors, ownership and replay defense. |
| `core-recovery.test.ts` | Stored events and cursors recovered after interrupted writes and ownership changes. |
| `core-relay.test.ts` | Signature, age, replay, acknowledgment and relay settings rules. |
| `spec.test.ts` (nine Codex cases adapted here) | LIST-1, DM-1, CAP-2/4, PUSH-1/2/11, STATE-1, DEDUP-1, POLL-1/2/5, WH-1/12, RX-1/7, SEC-1/2 through the bundled adapter. |
| `adapter.test.ts`, `sidecar.test.ts` | Host boundary: normal approval, UUID binding, one-use tickets, argument/tool mismatch, no guessed identity, conversation isolation, config skips, injection and separate wake accounting. SEC-3/4 remain the host's permission policy. |

Strict behavior uses `MCP_EVENTS_PRE_STANDARD=off`. The default accepts the
pre-SEP top-level capability as the other forms do, an explicit exception to
CAP-2 and CAP-4. Payloads are never injected into the higher-trust hook
container; core's bounded summaries are labeled as server data. Antigravity's
rendering and permission behavior still require the live checks in the README.

## Upstream suite

The Codex form records 17/17 checks against the Events scenarios in
[conformance PR #541](https://github.com/modelcontextprotocol/conformance/pull/541)
at `c8625de3118c2d5dc0561696cddeb0baaf124f2c`. Those are historical Codex/core
results, not a run of this adapter. No installed checkout of those scenarios
was available for this implementation run; no suite or dependencies were fetched.

With a reviewed checkout at that revision and its dependencies already installed:

```bash
MCP_CONFORMANCE_SUITE_DIR=/absolute/path/to/conformance npm run conformance
```

This builds `test/probe.ts`, then runs the same four scenarios (`no-extension`,
`poll`, `push`, `webhook`) through this form's committed MCP server, ticket
hook and temporary HOME. `MCP_CONFORMANCE_OUTPUT_DIR` keeps suite receipts.
The driver accepts loopback HTTP only. Its webhook scenario alone enables
`MCP_EVENTS_DEV=1` for the suite's unauthenticated local fixture, as the
existing Codex driver does. Tests never use a real host credential file.

The driver is provided, but no 17/17 claim is made until it is run against
that external checkout. Property-fuzz and relay end-to-end suites remain in
the Claude Code form; this form runs the shared clause and relay unit suites.
