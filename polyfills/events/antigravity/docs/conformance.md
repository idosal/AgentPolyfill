# SEP-3415 checks in Antigravity

Revision: Final text as of 24 November 2026, matching the Codex form.
The [shared clause table](../../claude-code/docs/conformance.md) gives the
normative text and core implementation for each of 86 client clauses. The
core is bundled unchanged. This document does not turn another host's run
into an Antigravity result.

Local run on 25 November 2026, Node.js 22.23.1: **102 tests passed, zero
failures or skips** (`npm test`). Typecheck, byte-identical bundle
comparison, standalone plugin boot and third-party notice comparison also
passed. `agy plugin validate --strict` passes for `plugin/` (it counts the
sidecar).

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

## Live, 25 November 2026

In Antigravity App v2.35.1 and CLI v1.5.16 on macOS, with a throwaway `HOME`
([the record](live-run.md)), against this repository's deploys demo, whose
Events support is Mastra's (`@mastra/mcp` 2.10.0), a server this project
didn't write: so these runs are also this form's interop run.

- A push watch; the event delivered once at the CLI conversation's next turn,
  labelled by Antigravity as injected by a hook.
- An idle App conversation woken by the sidecar's `agentapi send-message`,
  which then answered from the event; a wake during a running turn, held and
  put into that turn.
- A second conversation saw none of the first's events; `MCP_EVENTS_OFF=1`
  left no tools and no injections; after restarts, the events missed in
  between arrived from the server's cursor once the conversation called the
  plugin again.
- Not run: the IDE's agent, and a webhook watch (the demo server refused a
  plain `http` local callback; it needs an https address).

## Upstream suite

The Events client scenarios proposed upstream
([conformance PR #541](https://github.com/modelcontextprotocol/conformance/pull/541)),
at `c8625de3118c2d5dc0561696cddeb0baaf124f2c`, the revision the other forms
used, run on 25 November 2026 through this form's committed MCP server, its
ticket hook and a temporary `HOME`: **17 of 17 checks pass**
(`events-client-no-extension` 1/1, `events-client-poll` 10/10,
`events-client-push` 3/3, `events-client-webhook` 3/3). The record is
[evidence/conformance.txt](evidence/conformance.txt).

The first run tested nothing: the driver accepted only `127.0.0.1`, and the
suite names its server `localhost`. It now accepts any loopback name.

With a checkout at that revision and its dependencies installed:

```bash
MCP_CONFORMANCE_SUITE_DIR=/absolute/path/to/conformance npm run conformance
```

This builds `test/probe.ts`, then runs the four scenarios through this form's
committed MCP server, ticket hook and temporary HOME.
`MCP_CONFORMANCE_OUTPUT_DIR` keeps suite receipts. The driver accepts
loopback HTTP only. Its webhook scenario alone enables `MCP_EVENTS_DEV=1` for
the suite's unauthenticated local fixture, as the Codex driver does. Tests
never use a real host credential file.

Property-fuzz and relay end-to-end suites remain in the Claude Code form;
this form runs the shared clause and relay unit suites.
