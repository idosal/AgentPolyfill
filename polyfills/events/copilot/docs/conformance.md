# SEP-3415 client conformance, in Copilot

How this client (the Copilot form of mcp-events, 0.1.0) stands against the
**Final** text of SEP-3415 (`seps/3415-events-extension.md` in
`modelcontextprotocol/modelcontextprotocol`, as fetched on 24 November 2026),
the same revision as the other forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md). The result
there holds here: **with `MCP_EVENTS_PRE_STANDARD=off`, 80 met and 6 not
applicable; by default 78 met, 2 met with a documented exception (CAP-2 and
CAP-4), 6 not applicable, none missing.**

What this file adds: which rules this form's own tests check end to end,
through the extension as Copilot starts it (a child process with `SESSION_ID`,
joining through a stand-in for `@microsoft/copilot-sdk/extension`), against
the fixture events server, and the upstream suite's run through it.

## Checked end to end in this form

| Clauses | What | Test |
|---|---|---|
| LIST-1, DM-1 | events/list read; delivery modes as listed | `test/spec-test.ts` "LIST-1, DM-1" |
| CAP-2, CAP-4 | no `events/*` to a server that has not advertised the extension, with the earlier form off | `test/spec-test.ts` "CAP-2, CAP-4" |
| CAP-2 (exception) | the earlier form used by default | `test/spec-test.ts` "CAP-2 (documented exception)" |
| PUSH-1, STATE-1, DEDUP-1 | one `events/stream` per watch; the client's own registry; dedup by eventId; the wake through `session.send` as an automation turn | `test/spec-test.ts` "PUSH-1, STATE-1, DEDUP-1" |
| PUSH-2 | unwatch cancels the stream | `test/spec-test.ts` "PUSH-2" |
| POLL-1, POLL-2, POLL-5 | polled at the recommended interval, with the cursor passed back | `test/spec-test.ts` "POLL-1, POLL-2, POLL-5" |
| STATE-1, PUSH-11 | a resumed session's watch starts again by itself, from the saved cursor; what came meanwhile arrives once | `test/spec-test.ts` "STATE-1, PUSH-11"; live: [`live-run.md`](live-run.md) "Resumed" |
| WH-1, WH-12, RX-1, RX-7 | a fresh `whsec_` secret per subscription; only signed deliveries taken; https except on loopback for tests | `test/spec-test.ts` "WH-1, WH-12 (dev), RX-1, RX-7" |
| WH (no address) | a webhook-only type with no public address is refused, with the choices | `test/spec-test.ts` "a webhook-only event type with no public address" |
| SEC-1, SEC-2 | payloads reach the model only as tool results; the wake carries no server text | `test/spec-test.ts` "SEC-1, SEC-2" |
| SEC-2 | an event type named with a sentence is watched, but its name stays out of the wake | `test/spec-test.ts` "SEC-2: an event type whose name is a sentence" |
| PUSH-14 | a subscription the server ends is removed, and the session told | interop: hookbench "termination" ([`interop.md`](interop.md)) |
| RH-1, RH-4 | `Mcp-Name` and `Mcp-Param-*` on Streamable HTTP | interop: hookbench "routing headers" |

## What is different in Copilot

These aren't SEP rules: they're how this form meets the contract in Copilot.
Tests are in `test/extension-test.ts` and `test/units-test.ts`.

- **Which servers.** Only those Copilot lists as enabled for the session,
  each read from the source Copilot names (a project file never stands in for
  your own); none at all when Copilot can't say. Plugin, one-run and built-in
  servers, and servers needing a variable Copilot strips from extensions, are
  listed as unavailable with the reason. A server Copilot stops using
  mid-session is let go, its watches kept.
- **A resumed session** whose first tool call comes while its servers are
  still being connected doesn't strand its saved watches.
- **Who counts as you.** A `user.message` with no source; the plugin's own
  automation turns and other sources don't lift the wake pause.
- **The wake's answer.** Refused by Copilot: tried again, once taken handed
  over once. No answer within a minute: counted as handed over, never sent
  twice.
- **Stand-down.** `MCP_EVENTS_OFF=1` joins the session with no tools and no
  hooks.

## The upstream conformance suite

The official Events client scenarios are in the conformance suite's open pull
request
[modelcontextprotocol/conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541),
at its head `c8625de3118c2d5dc0561696cddeb0baaf124f2c`, the commit the other
forms ran. `test/conformance-driver.ts` is what the suite starts as the client:
the bundled extension with a throwaway `COPILOT_HOME` whose `mcp-config.json`
names the suite's server, driven as the model would (`list_event_types`, then
`watch_event` for every type), ended with SIGTERM as Copilot ends it.

Run on 25 November 2026, macOS, Node 22.23, the suite installed with
`npm ci --ignore-scripts`:

```
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> npm run conformance
events-client-no-extension   Passed: 1/1, 0 failed, 0 warnings
events-client-poll           Passed: 10/10, 0 failed, 0 warnings
events-client-push           Passed: 3/3, 0 failed, 0 warnings
events-client-webhook        Passed: 3/3, 0 failed, 0 warnings
[driver] extension (end to end): all 4 scenarios passed
```

17 of 17 checks. **The one allowance**, as in the other forms: in the webhook
scenario the suite's stand-in server is plain http on this machine and asks
for no credentials, so for that scenario alone the driver turns on the
client's testing switch (`MCP_EVENTS_DEV=1`), and the "public" address is the
extension's own receiver. The suite's checkout is code this repository does
not hold: read it before you run it.
