# SEP-3415 client conformance, in Hermes

How this client (the Hermes form of mcp-events, 0.2.0, on Hermes Agent
v0.23.4) stands against the **Final** text of SEP-3415
(`seps/3415-events-extension.md` in `modelcontextprotocol/modelcontextprotocol`,
as fetched on 24 November 2026), the same revision as the other forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form's helper bundles
unchanged.** The clause-by-clause table, with the code and the test for each
of the 86 client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md); its tests run
against that same code. There: **with `MCP_EVENTS_PRE_STANDARD=off`, 80 met
and 6 not applicable; by default 78 met, 2 met with a documented exception
(CAP-2 and CAP-4), 6 not applicable, none missing.**

What this file adds: which rules this form's own tests check end to end,
through the helper as the Python half starts it and through a real Hermes,
and what is different in Hermes.

## Checked end to end in this form

| Clauses | What | Test |
|---|---|---|
| LIST-1, DM-1 | events/list read; delivery modes as listed | `test/spec-test.ts` "LIST-1, DM-1" |
| CAP-2, CAP-4 | no `events/*` to a server that has not advertised the extension, with the earlier form off | `test/spec-test.ts` "CAP-2, CAP-4" |
| PUSH-1, STATE-1, DEDUP-1 | one `events/stream` per watch; the client's own registry; dedup by eventId | `test/spec-test.ts` "PUSH-1, STATE-1, DEDUP-1"; `test/e2e_test.py` "watch by push wakes the idle session" |
| PUSH-2 | unwatch cancels the stream | `test/spec-test.ts` "PUSH-2" |
| POLL-1, POLL-2, POLL-5 | polled at the recommended interval, with the cursor passed back | `test/spec-test.ts` "POLL-1, POLL-2, POLL-5"; `test/e2e_test.py` "poll and a declined watch" |
| WH-11, RX-1, RX-7 | The fixture verifies the callback, delivers a signed occurrence, wakes the watching session and receives an unsubscribe | `test/spec-test.ts` "a signed webhook wakes the watching session" |
| STATE-1, PUSH-11 | after a gateway restart, resumed from the saved cursor; what came meanwhile arrives once | `test/spec-test.ts` "STATE-1, PUSH-11" |
| SEC-1, SEC-2 | payloads reach the model only as tool results; the wake carries no server text | `test/spec-test.ts` "SEC-1, SEC-2" and "a wake carries nothing a server wrote" (three tests); `test/e2e_test.py` (the wake holds ids only) |
| SEC-3 | receiving an event authorizes nothing | starting and stopping a watch go through Hermes's approval, and no watch starts where Hermes approves without asking: `test/test_plugin.py`, `test/e2e_test.py` (approved, declined, and `approvals.mode: off`) |
| PUSH-14 | a subscription the server ends is removed, and the session told | interop: hookbench "termination" (`test/interop_hookbench.py`) |
| RH-1, RH-4 | `Mcp-Name` and `Mcp-Param-*` on Streamable HTTP | interop: hookbench "routing headers" |

## Different in Hermes

| Clause | In Hermes |
|---|---|
| Webhook ownership | The plugin uses the shared webhook client on granted servers. Hermes owns servers with `events: true`. See `test/spec-test.ts` and the native ownership check in `test/e2e_test.py`. |
| SEC-2 (the wake) | Stricter than the shared client: `ctx.inject_message` puts the wake in the conversation as the user's message, so each line is written from the plugin's own data (watch id, the server's name in your config, event ids, your note), not the event type's name or a notice's text. `test/spec-test.ts` "a wake carries nothing a server wrote" |
| SEC-3, SEC-4 | `watch_event` and `unwatch_event` go through Hermes's own approval (a `pre_tool_call` approve directive; once, session, always or deny), with a key that is a digest of the whole watch, so "always" covers that exact watch only. Where Hermes approves without asking (`--yolo`, `/yolo`, `hermes -z`, `approvals.mode: off`), no watch starts. What the model does after a wake goes through Hermes's approvals as any turn does |
| SEC-5 (the client owns subscription state) | Per Hermes session, in `$HERMES_HOME/mcp-events/` (by a digest of the session key), private to the user |
| STATE-1 across a restart | Saved watches resume when the first session opens or the first turn runs after the gateway starts (a plugin can't tell, in `register()`, that it's loading in the gateway) |
| CAP-1 | The client declares the extension on its own connection to each server it may use (`settings.servers`). Hermes's connection is not used: Hermes has no way for a plugin to send `events/*` over it |
| The servers it uses | Read again at each turn and tool call; when they change, the helper starts again with the new set, so a server you leave to Hermes (`events: true`) is never watched twice. `test/e2e_test.py` "a server left to Hermes later is not watched twice" |

## The upstream conformance suite

The official Events client scenarios are in the conformance suite's open
pull request [modelcontextprotocol/conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541),
at its head `c8625de3118c2d5dc0561696cddeb0baaf124f2c`.
[`test/conformance-driver.ts`](../test/conformance-driver.ts) is what the
suite starts as the client: the bundled `plugin/dist/helper.mjs`, started and
spoken to as the Python half does (newline JSON-RPC: `initialize` with the
suite's server, then `list_event_types` and `watch_event` calls naming a
Hermes session, every wake answered as taken).

The driver runs all four scenarios (no extension, poll, push and webhook).
The webhook scenario checks subscriptions and refreshes. It uses the
shared client's development switch for the suite's anonymous loopback
server. The signed delivery itself is exercised by `test/spec-test.ts`.

To run it, from a checkout of the suite at that commit with its dependencies
installed, and this folder built:

```bash
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node test/conformance-driver.ts --suite
```

The suite's checkout is code this repository does not hold: read it before
you run it. The driver gives it only the system's basics and a temporary
`HOME`. CI does not run it: it would depend on a pull request's branch.
