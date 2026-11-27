# Tasks client checks in Pi

Protocol revision 2026-07-28, pinned to `cc9aaac` in `modelcontextprotocol/ext-tasks`. The [rule definitions](../../core/docs/client-rules.md) and [shared checks](../../codex/docs/conformance.md) apply to the same client, store and poller bundled by both adapters.

| Rule | Pi route or shared test | Status |
| --- | --- | --- |
| C0, C0b | Stdio fixture records the capabilities on `tools/call` and Task requests. | Shared transport and Pi RPC checks |
| C0c | The fixture's legacy-only variant receives no task calls. | Pi RPC |
| C1, C2, C3 | The shared client distinguishes plain results, task handles and invalid responses per request type. | Shared client checks |
| C4, C9, C10 | An `input_required` task wakes Pi. Pi shows the form, validates the person's answer and sends `tasks/update`. Unsupported input modes are reported. | Pi RPC with a form fixture |
| C5, C6, C7, C8 | Shared poller honors server intervals and terminal status. The task record survives reopening the session's store. | Shared poller and store checks |
| C11, C12, C13 | Repeated keys produce one announcement. The shared input operation sends only outstanding keys. | Shared poller and input checks |
| C14, C15 | Cancel sends `tasks/cancel` and stops local polling on acknowledgement. | Shared client checks |
| C16 | The shared HTTP transport sets `Mcp-Name` and `Mcp-Method`. | Shared transport check and real Pi over HTTP against FastMCP 4.2.6. |
| C17 | Polling. | Push subscriptions omitted |
| C18, C19 | `get_task`, `get_task_result` and `list_tasks` show labeled server data. A wake identifies the task without including its result. | Pi RPC and shared result checks |

Pi 1.6.0 RPC checks start approval and decline, idle follow-up, in-task form input, and hidden or excluded native MCP tools using a stdio fixture and an isolated scripted model. The interactive terminal was also checked for the default decline, approval through multiple pages, idle result retrieval, and entry and delivery of a task form answer. Over Streamable HTTP, real Pi started a task, woke on completion, read the result, and answered an in-task form on FastMCP 4.2.6. Shared ownership tests cover a dead owner, simultaneous takeover attempts, and an interruption during reclaim.
