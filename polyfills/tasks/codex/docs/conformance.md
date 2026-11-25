# Tasks client conformance, in Codex

How this client (mcp-tasks for Codex, 0.1.0) stands against SEP-2663 (Final)
and the ext-tasks specification at revision 2026-07-28, at commit `cc9aaac` of
`modelcontextprotocol/ext-tasks`. The rules, with their ids and where each is
written, are in [`../../core/docs/client-rules.md`](../../core/docs/client-rules.md).

**Result:** 22 rule ids (C0, C0b, C0c, C1 to C19).

- **Met:** 19.
- **Met by design:** C3, with no test of its own.
- **Met, with a difference in presentation:** C10, below.
- **Not used:** C17, a MAY.

The upstream MCP conformance suite has no client scenarios for Tasks
(modelcontextprotocol/conformance#374), so there is no suite run.

Tests:

- `test/core-test.ts`: the shared client's rules one by one.
- `test/flow-test.ts`, `test/http-test.ts` and `test/standdown-test.ts`: the
  helper as Codex runs it, against `test/fixture-tasks-server.mjs`, over stdio
  and HTTP.
- `test/review-test.ts`: hardening: the question, the wake budget, secrets,
  and what a server sends.
- `test/plugin-test.ts`: the committed bundle, the manifests, `.mcp.json`.
- `test/interop/fastmcp-interop.ts`: against FastMCP 4.2.6 with fastmcp-tasks
  4.2.6, 10 of 10 (`npm run interop`).

| Rule | Level | How it is met | Test |
|---|---|---|---|
| C0 | MUST (derived) | Every request on the plugin's connection carries the declaration in `_meta["io.modelcontextprotocol/clientCapabilities"]` (`core/src/connection.ts`, `request()`; the SDK frames `server/discover` and `tools/list` the same way). | flow "an accepted task is polled…" (every `tools/call` and `tasks/get` declares it); interop "FastMCP gives no task to a client that doesn't declare the extension" |
| C0b | MUST (derived) | The same on `tasks/get`, `tasks/update`, `tasks/cancel`. The fixture answers -32021 without it. | flow "an accepted task…", "cancel sends tasks/cancel…" |
| C0c | MUST (derived) | A server is used only if it advertises the extension on revision 2026-07-28 or later (`offersTasks`). | flow "C0c: a server that advertises the extension on a 2025 revision only…" |
| C1 | MUST | `classify()` takes a `CallToolResult` or a `CreateTaskResult` for `tools/call`; `start_task` returns the first and follows the second. | core "C1"; flow "a plain result comes back at once"; interop "a plain result" |
| C2 | MUST | A task for any other request is invalid (`TASK_AUGMENTABLE`). The SDK refuses one on `tools/list` too. | core "C2" |
| C3 | SHOULD | Which requests may be answered with a task is one set (`TASK_AUGMENTABLE`), separate from the code that follows a task. | by design |
| C4 | MUST, SHOULD | An `input_required` task's `inputRequests` are read on every poll. New ones wake the session; `provide_task_input` answers them. | flow "input_required: the session is woken…"; interop "input_required" |
| C5 | SHOULD | Polled at the server's `pollIntervalMs` as it changes, never faster, with a one-second floor. | core "C5" |
| C6 | SHOULD | Polled until a terminal status, or until `tasks/cancel`. | core "C6, C15"; flow "a finished task is not polled again…" |
| C7 | SHOULD | Task ids are kept in `tasks.json` (0600). Open tasks are polled again when the helper starts. | core "C7"; flow "C7: after a restart…" |
| C8 | MAY | Past `createdAt` + `ttlMs` with no result, the task is reported as expired and no longer polled. | core "C8" |
| C9 | SHOULD | Answers go back with `tasks/update`; the task is then polled until it is terminal. | flow "input_required…" (second wake, result read); interop "input_required", "a declined question" |
| C10 | MUST | Each entry is handled as the same request sent on its own (below). | flow "input_required…", "an empty form…", "sampling is refused…"; interop "sampling is refused" |
| C11 | SHOULD | A key already seen isn't announced again. | core "C11" |
| C12 | SHOULD | A key already answered isn't put again; two calls at once put a question once. | review "C12, C13, S7: two questions in turn…", "two provide_task_input calls at once…" |
| C13 | MUST | Before answering, the task is read again. Only its outstanding keys are answered, and only those go in `inputResponses`. | review "C12, C13, S7…" (the updates carry `k1`, then `k2`, each alone) |
| C14 | MUST NOT | Cancelling sends `tasks/cancel`; `notifications/cancelled` is never sent for a task. | flow "cancel sends tasks/cancel…", "an accepted task…" |
| C15 | MAY | After `tasks/cancel` the task is no longer polled. | flow "cancel sends tasks/cancel and stops polling"; interop "cancel" (FastMCP reports it cancelled) |
| C16 | MUST | Over Streamable HTTP, `tasks/get`, `tasks/update` and `tasks/cancel` carry `Mcp-Name: <taskId>` and `Mcp-Method` (`tasksFetch`). | http "C16"; core "C16"; interop "FastMCP refuses tasks/get with an Mcp-Name that isn't the task's" (the rule matters to the server), and every other interop check passes with ours |
| C17 | MAY | Not used: the client polls. | |
| C18 | MAY | `get_task` shows the status message to the model, as the server's data, cleaned and bounded. | review "a failed task's error…" (its status message); core "server text is shown as data" |
| C19 | MAY | The lifecycle is the plugin's tools: start, status, input, result, cancel. | flow, throughout |

## C10 in Codex

Codex has no way to let a plugin pass on a server's request as that server's.
So each entry of `inputRequests` is handled as Codex would handle the request
sent on its own, as far as a plugin can:

- **A form** (`elicitation/create`, form mode) goes to the person in Codex's
  form, with the server's schema. Codex heads it with the plugin's name, and
  its text begins `The MCP server "<name>" asks, for task t-…`. Codex's own
  rules for questions from that server apply to the plugin instead.
- **A form with no fields** becomes a required Accept/Decline choice. Codex
  might accept such a form by itself where approvals are automatic; the choice
  makes the person decide, which is stricter, not looser.
- **Sampling, roots and URL forms** aren't declared on the plugin's connection.
  They are left unanswered, as a client that doesn't offer them would leave
  them, and Codex is told.

The trust model is the same: the content is the server's, shown as data, and
only the person answers. The presentation isn't quite, and the README says so.

## The server rules the client relies on

| Rule | Checked | Test |
|---|---|---|
| S1 | An unknown `resultType`, or one that isn't `"complete"` on `tasks/get`, is refused. | core "S1" |
| S2 | The first `tasks/get` follows creation without retries. | flow "an accepted task is polled…"; interop "a task completes…" |
| S3 | A status without its fields (`result`, `error`, `inputRequests`) is refused. | core "S3" |
| S4 | A `completed` result with `isError` is shown as the tool's error; a `failed` task's JSON-RPC error is shown as the server's data, with its code. | core "server text is shown as data"; review "a failed task's error…" |
| S5 | -32602 on `tasks/get`: the task is gone. | core "S5"; flow "a vanish task…" |
| S6 | A changed task id, or a terminal task that changes status, is refused. | core "S6"; flow "a morph task…", "a bad_create task…" |
| S7 | Keys are taken as unique per task: an answered key is never answered again. | review "C12, C13, S7…" |

## Beyond the rules: the contract's own checks

| What | Test |
|---|---|
| A declined start sends nothing | flow "a declined start sends nothing to the server" |
| Nobody to ask: nothing starts | flow "where nobody can be asked, nothing starts" |
| A wake is held until the person's turn in Codex's own app | flow "a wake is held until…", "C7: after a restart…" |
| The wake carries nothing the server wrote | flow "an accepted task…"; core "the wake line…" |
| Stand-down: at `initialize`, on `server/discover`, on a call; and `MCP_TASKS_OFF=1` | standdown (four tests); flow "MCP_TASKS_OFF=1…" |
| Codex's `enabled_tools`/`disabled_tools` honoured | flow "a tool Codex is told not to use is not started" |
| Secrets kept out of what reaches Codex, and out of arguments | http "a header from the config is sent, and never shown to Codex" (the server echoes it back); review "secrets are found whole…", "object keys are scrubbed…" |
| The question shows the arguments exactly as sent | review "the question shows every argument exactly as sent…", "the length limit is on the text as shown" |
| A wake budget | review "wakes have a budget…" |
| A task stays with the server it started on | review "a task is followed only on the server it started on" |
| A server's form and results rebuilt and cleaned | review "a server's form is rebuilt…", "every result block is rebuilt…" |
| The headers helper | http "the http_headers_helper runs…"; core "the headers helper…" |
| The earlier (2025-11-25) form left alone | flow "a server with only the 2025-11-25 form…" |
| No test can reach an installed `codex` or `gh` | `test/harness.ts`, `assertNoOwnersTools()`, run in every test file |
