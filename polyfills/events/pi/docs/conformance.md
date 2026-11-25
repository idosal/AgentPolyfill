# SEP-3415 client conformance, in Pi

How this client (the Pi form of mcp-events, 0.1.1, on Pi 1.6.0) stands
against the **Final** text of SEP-3415 (`seps/3415-events-extension.md` in
`modelcontextprotocol/modelcontextprotocol`, as fetched on 24 November 2026),
the same revision as the Claude Code and Codex forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md); its tests run
against that same code. The result there holds here: **with
`MCP_EVENTS_PRE_STANDARD=off`, 80 met and 6 not applicable; by default 78
met, 2 met with a documented exception (CAP-2 and CAP-4), 6 not applicable,
none missing.** The upstream conformance suite's Events client scenarios pass
against this form too ([below](#the-upstream-conformance-suite)).

What this file adds: which rules the Pi form's own tests check end to end, in
a real Pi 1.6.0 with the bundled extension, against the hand-written events
server; and what is different in Pi.

## Checked end to end in this form

| Clauses | What | Test |
|---|---|---|
| LIST-1 | the event types a server lists are in the system prompt of the turn | `test/wake-test.ts` "an event wakes the idle session that watched for it, after the user confirmed the watch" |
| PUSH-1, POLL-1, STATE-1 | a watch confirmed by the user is started; an event that arrives while the session is idle wakes it, and the model reads it | same |
| SEC-1, SEC-2 | the wake message carries nothing of what the server sent; `get_event` returns the payload as a tool result marked as data | same |
| STATE-1 | after Pi closes and the session is resumed, the watch resumes from its saved cursor, and what arrived meanwhile is handed over once | `test/lifecycle-test.ts` "a resumed session resumes its watch, and what arrived while Pi was closed is handed over" |
| CAP-1, RH-1 | Events over the extension's own connection to a Streamable HTTP server behind a token, on revision 2026-07-28 | `test/connection-test.ts` "a header-authenticated server: Events runs over the extension's own connection, on 2026-07-28" |
| SEC-5 | a watch the user declines is not started, and nothing is subscribed | `test/wake-test.ts` "a watch the user declines is not started, and nothing is subscribed" |

The form's other tests check what the SEP leaves to the client:
- the hourly cap on wakes, and how the session is told;
- that nobody can confirm a watch in print mode, so none starts;
- that the extension stands down with Pi's MCP support off;
- that a watch whose note holds a configured secret is refused before the
  question, which shows what is sent or nothing;
- a takeover by a second Pi process;
- reading Pi's configuration as Pi reads it.

## Different in Pi

| Clause | In Pi |
|---|---|
| SEC-3 ("Receipt of an event does NOT constitute authorization to act") | The wake is a message in the conversation; the model receives it in the user's turn, so its first line says it's from the extension and not typed by the user. Pi has no approval step for tools: what Pi does next is up to Pi and the extensions you run (a permission extension can ask). The extension asks the user before each watch itself, and `watch_event` and `unwatch_event` are not marked read-only (`readOnlyHint`), so a permission extension can tell them from the four tools that only read. |
| SEC-4 (policy evaluation between receipt and action) | Pi's own, through permission extensions. The extension adds none. |
| SEC-5 (the client owns all subscription state) | Per Pi session, by Pi's session id, in `mcp-events/` in Pi's agent folder, private to the user. |
| STATE-1 across a restart | A closed session's watches resume when the session is resumed (`pi --resume`, `/resume`). A watch on a local (stdio) server resumes only when the session is resumed in the same folder: the server is started in the session's folder, and one started elsewhere counts as another server. The README says so. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-pi`). Pi's own connection is not used: Pi 1.6.0 negotiates revision 2025-11-25 at most, and gives an extension no way to send `events/*` over it. |

## The upstream conformance suite

The official Events client scenarios are in the conformance suite's open
pull request [modelcontextprotocol/conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541),
at its head `c8625de3118c2d5dc0561696cddeb0baaf124f2c`, the same revision as
the Codex form. [`test/conformance-driver.ts`](../test/conformance-driver.ts)
is what the suite starts as the client. It runs the four scenarios
(`events-client-no-extension`, `-poll`, `-push`, `-webhook`) two ways:

| How | What plays the client | Result |
|---|---|---|
| `--suite` | the shared client in the driver's process, named to the server as this extension names it (`configureHost(PI)`), with a session's state laid out as the extension lays it out | **17 of 17 checks** |
| `--suite --pi` | end to end: a real Pi 1.6.0 with the bundled `extension/dist/index.js`, whose `mcp.json` names the suite's server; every event type listed is watched | **11 checks passed, none failed, 6 not evaluated** |

- **The 6 not evaluated, end to end.** Pi connects every server in `mcp.json`
  itself when a session starts, so end to end the suite's stand-in server
  also sees Pi's own client. That client speaks revision 2025-11-25, and the
  suite then takes the session for one on the earlier lifecycle. Six checks
  are skipped, or marked not testable, because of that: `Mcp-Name` in the
  poll, push and webhook scenarios and its Base64 form in the poll one, the
  opt-in to `list_changed`, and the re-list on `list_changed`. The one marked
  not testable makes the poll scenario's overall result a fail, although none
  of its checks failed. The same six checks pass with the shared client
  (`--suite`), which this form runs unchanged.
- **The one allowance.** In the webhook scenario the suite's stand-in server is
  plain http on this machine and asks for no credentials. The client
  subscribes by webhook only on an authenticated connection and only at an
  https address, so for that scenario alone the driver sets `MCP_EVENTS_DEV=1`
  (and points `MCP_EVENTS_PUBLIC_URL` at the extension's own receiver), as the
  other forms' drivers do. Every other scenario runs with no such setting.
- **To run them again.** From a checkout of the suite at that commit, with
  its dependencies installed (`npm ci`), and this folder ready (`npm ci`
  here and in `../core`):

  ```bash
  MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite
  MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite --pi
  ```

  Add `MCP_CONFORMANCE_OUTPUT_DIR=<folder>` to keep the suite's result files.
  The suite's checkout is code this repository does not hold: read it before
  you run it. CI does not run it: it would depend on a pull request's branch.

## Not in this form

- The webhook relay is the same relay, with the same client code; its tests
  are the Claude Code form's (`test/relay.e2e-test.ts`, and `mod/relay`'s own).
- Checks against other implementations' Events servers are the
  [Codex form](../../codex/README.md)'s, with the same client code. From Pi,
  the form has been checked against the hand-written fixture server, an HTTP
  server behind a token and one behind OAuth, and the hosted demo server.
