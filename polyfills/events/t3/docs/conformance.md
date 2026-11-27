# SEP-3415 client conformance, in T3 Code

mcp-events for T3 Code 0.1.1 was checked against
[SEP-3415 Final](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/bbc31f8ded5762eae4df115b93942f5e71c8b3a7/seps/3415-events-extension.md)
(`bbc31f8d`, the latest change to the text as of 27 November 2026). This
revision still matches the shared client's clause matrix.

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
- that concurrent first calls start one watcher and all callers get a result;
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
| SEC-4 (policy evaluation between receipt and action) | T3 Code applies the thread's permission mode. In 0.1.13, Supervised showed Codex's approval prompt for both watch changes. Full access accepted the prompt automatically. |
| SEC-5 (the client owns all subscription state) | Per T3 Code thread, by the id T3 Code puts in `T3CODE_THREAD_ID`, in `$CODEX_HOME/mcp-events-t3`, private to the user. |
| STATE-1 across a restart | The watcher outlives the agent's sessions and T3 Code itself. When it starts again (after `--stop`, a reboot, or ending idle) it resumes every saved watch from its cursor, without waiting for the thread to call a tool. |
| CAP-1 | The watcher declares the extension on its own connection to each upstream (`clientInfo` `mcp-events-t3`). The adapter's stdio connection to Codex serves the six client tools. |

## Released host checks

macOS, Node 22.23.1 and Codex CLI 0.172.0. The real Codex provider used an
isolated profile and a loopback scripted model endpoint. The upstream source
was the repository's local Events fixture. No hosted model or account was
needed.

| Host | Observed |
|---|---|
| T3 Code 0.1.11 | The Codex thread started a filtered stdio push subscription, idled, woke on a matching event, called `get_event`, and stopped the watch. |
| T3 Code 0.1.13, web UI | Supervised displayed the watch and stop approvals. Declining a watch sent no `events/stream`. Declining a stop sent no cancellation. Approving the stop sent `notifications/cancelled`, and a subsequent matching ticket produced no wake. Full access auto-accepted the native Codex prompt in a separate run. |
| T3 Code 0.1.13, scope and wake | The low-priority ticket did not match. The high-priority ticket started a visible turn in the original idle thread. The wake contained the event reference, and its payload was retrieved with `get_event`. Another thread had no watch and could not read the event. |
| T3 Code 0.1.13, session and host restart | The original thread woke after **Restart agent session**. While the T3 server was down, the watcher stored a second ticket and retried. The same thread woke with it after the server returned. |
| Native Events | T3 Code 0.1.13 serves its own Events via its [HTTP MCP server](https://github.com/pingdotgg/t3code/blob/v0.1.13/docs/user/outside-agents.md). The stock Codex connection to the ticket fixture declared no Events capability, and T3 made no native Events calls. Codex 0.172.0 has an experimental `mcpServer/event/stream/start` endpoint. A direct local app-server call returned “MCP event subscriptions are only supported for hosted apps,” with and without `features.mcp_2026_07_28`. |

The adapter tests also covered watcher restart and deduplication, both
released CLIs' wake failure responses, and manual stand-down.
Before the fix, twelve concurrent first calls started two
watchers sharing one state folder. After the fix, the same probe and its
regression test both started one.

## The upstream conformance suite

All four Events client scenarios passed on the shared client and on the T3
adapter with its watcher. Both runs passed **17 of 17 checks**. The scenarios
come from the conformance suite's open
[modelcontextprotocol/conformance#541](https://github.com/modelcontextprotocol/conformance/pull/541),
at `c8625de3118c2d5dc0561696cddeb0baaf124f2c`.

[`test/conformance-driver.ts`](../test/conformance-driver.ts) runs
`--suite` with the shared client in-process. `--suite --t3` runs the adapter
over stdio with the real watcher and a stand-in `t3`. The webhook scenario
uses the driver's loopback-only test allowance for the suite's plain HTTP
callback. Production webhook verification keeps its normal requirements.

To run them, from a checkout of the suite at that commit with its
dependencies installed (`npm ci`), and this folder ready (`npm ci` here, in
`../core` and in `../codex`), after reading the suite's code:

```bash
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite
MCP_CONFORMANCE_SUITE_DIR=<suite checkout> node --no-warnings test/conformance-driver.ts --suite --t3
```

## Independent server interoperability

The built adapter discovered
[Hookbench](https://github.com/NHTanvir/hookbench/tree/0df78ef87185a2bcfcddf7209960b057e2d1ca3d)
over Streamable HTTP with `MCP_EVENTS_PRE_STANDARD=off`. A
`build.finished` watch filtered to `branch: main` ignored a feature-branch
event and delivered a matching build to the thread's wake path. The wake had
the event id, `get_event` retrieved the build, another thread could not read
it, and a post-unwatch matching event produced no wake. This test used a
stand-in `t3` to capture the wake separately from the released-host runs.

The shared webhook relay also has its own tests in the Claude Code form. Live
webhook delivery in T3 Code, OAuth-backed upstreams, remote T3 environments
and Windows remain unverified.
