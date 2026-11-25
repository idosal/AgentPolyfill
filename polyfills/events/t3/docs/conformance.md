# SEP-3415 client conformance, in T3 Code

How this client (mcp-events for T3 Code, 0.1.0, tested in T3 Code 0.1.11 with
Codex 0.172.0) stands against the **Final** text of SEP-3415
(`seps/3415-events-extension.md` in `modelcontextprotocol/modelcontextprotocol`,
as fetched on 24 November 2026), the same revision as the other forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md); its tests run
against that same code. The result there holds here: **with
`MCP_EVENTS_PRE_STANDARD=off`, 80 met and 6 not applicable; by default 78
met, 2 met with a documented exception (CAP-2 and CAP-4), 6 not applicable,
none missing.**

What this file adds: which rules this form's own tests check end to end,
through the server Codex starts for a T3 Code thread and the watcher it
starts, against the hand-written events server; and what is different in T3
Code.

## Checked end to end in this form

| Clauses | What | Test |
|---|---|---|
| CAP-2 | no `events/*` to a server that hasn't advertised the extension, with the pre-standard form off | `test/spec-test.ts` "a client MUST NOT send events/* to a server that has not declared the extension" |
| CAP-4 (the exception) | the form from before the standard is used by default, and the log says so | `test/spec-test.ts` "by default the form from before the standard is used" |
| (listing) | `events/list` is sent to a server that advertised the extension, and its types are listed | `test/spec-test.ts` "the extension declared in the SEP form is used" |
| PUSH-1, SEC-1, SEC-2 | a watch is started by push; an event wakes the thread with a message that carries nothing the server sent; `get_event` returns the payload as a tool result | `test/server-test.ts` "a watch outlives the server the agent started" |
| POLL-1 | a poll-only event type is polled, and `unwatch_event` stops the polling | `test/spec-test.ts` "unwatch_event ends the subscription on the server" |
| STATE-1, DEDUP-1 | across a restart of the watcher, the cursor is kept and an event the server sends twice is handed to the thread once | `test/spec-test.ts` "an event is handed to the thread once, across a restart of the watcher" |
| SEC-5 | each thread's watches and events are its own; another thread can't stop them | `test/server-test.ts` "one watcher serves many threads" |

The form's other tests check what the SEP leaves to the client:
- that it offers nothing outside a T3 Code thread, or with `MCP_EVENTS_OFF=1`;
- that watches outlive the agent's session and resume when the watcher
  starts again;
- waking: what `t3 thread send` is given, and what each of T3 Code's answers
  means (including against the real `t3` 0.1.11, `test/t3-cli-test.ts`);
- that the state is private to the user;
- that the committed bundle is what the source builds.

## Different in T3 Code

| Clause | In T3 Code |
|---|---|
| SEC-3 ("Receipt of an event does NOT constitute authorization to act") | The wake is a message in the thread, sent with `t3 thread send`. T3 Code puts a line of its own before it, saying it came through T3 Code's tools and not from the user, and the polyfill's first line says the same. The turn runs in the thread's own permission mode. |
| SEC-4 (policy evaluation between receipt and action) | The thread's permission mode, through Codex's approvals as T3 Code shows them. The form adds none. `watch_event` and `unwatch_event` aren't marked read-only, so a mode that asks asks before each. That prompt wasn't seen live: the live run's thread was in Full access. |
| SEC-5 (the client owns all subscription state) | Per T3 Code thread, by the id T3 Code puts in `T3CODE_THREAD_ID`, in `$CODEX_HOME/mcp-events-t3`, private to the user. |
| STATE-1 across a restart | The watcher outlives the agent's sessions and T3 Code itself. When it starts again (after `--stop`, a reboot, or ending idle) it resumes every saved watch from its cursor, without waiting for the thread to call a tool. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-t3`). Codex's connection isn't used: Codex gives an MCP server no way to send `events/*` over it. |

## The upstream conformance suite

**Not run for this form yet.** The official Events client scenarios are in
the suite's open pull request
[modelcontextprotocol/conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541),
at its head `c8625de3118c2d5dc0561696cddeb0baaf124f2c`, the revision the
Codex and Pi forms ran. [`test/conformance-driver.ts`](../test/conformance-driver.ts)
is ready to be what the suite starts as the client, two ways: `--suite` runs
the shared client in-process, named to the server as this form names it;
`--suite --t3` runs the server as Codex starts it for a T3 Code thread, with
the watcher it starts and a stand-in `t3`. Running the suite means running a
checkout of code this repository doesn't hold, and that wasn't approved in
this session, so neither has been run. The shared client this form bundles
passes the four scenarios in the Codex and Pi forms' runs
([Pi's results](../../pi/docs/conformance.md#the-upstream-conformance-suite)).

To run them, from a checkout of the suite at that commit with its
dependencies installed (`npm ci`), and this folder ready (`npm ci` here, in
`../core` and in `../codex`), after reading the suite's code:

```bash
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite --t3
```

## Not in this form

- The webhook relay is the same relay, with the same client code; its tests
  are the Claude Code form's.
- Interop runs against other implementations' Events servers are the Codex
  form's ([`interop.md`](../../codex/docs/interop.md)), with the same client
  code. From T3 Code, this form has been run against the hand-written fixture
  server, with a real model, in the [live run](live-run.md).
