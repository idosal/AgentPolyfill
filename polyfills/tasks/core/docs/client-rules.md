# What the Tasks extension asks of a client

Every MUST, SHOULD and MAY that the Tasks extension puts on a client, with an id of
our own for each: 22 ids, C0, C0b, C0c and C1 to C19. Sources, read on 25 November 2026:

- **Spec:** the ext-tasks specification at revision 2026-07-28,
  [`specification/2026-07-28/tasks.md`](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md)
  in `modelcontextprotocol/ext-tasks` at commit `cc9aaac` (v0.2.3).
- **SEP:** [SEP-2663, Tasks Extension](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/seps/2663-tasks-extension.md)
  (status Final), in the same repository.

The two texts say the same, except where a row says one has a rule the other doesn't.
"Derived" means the rule isn't written as a client MUST, but a server MUST leaves the client
no other way to get the behaviour. The schema's comments count as rules where they use
the words.

| Id | Level | Rule | Where |
|---|---|---|---|
| C0 | MUST (derived) | Declare `io.modelcontextprotocol/tasks` in the request's own capabilities, `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions`, on each request that may be answered with a task. Servers MUST NOT return a task to a request without it, "regardless of prior declarations". | Spec, Capability Negotiation |
| C0b | MUST (derived) | Declare it on `tasks/get`, `tasks/update` and `tasks/cancel` too: servers MUST answer -32021 to a client that doesn't. | Spec, Protocol Errors |
| C0c | MUST (derived) | Use the extension only on protocol revision 2026-07-28 or later: the revision this specification is written for and links to throughout. On 2025-11-25 the extension isn't defined, and servers MUST NOT treat the declaration as enabling tasks. (The SEP's Backward Compatibility table, written before the revision was named, calls the canonical case `2026-06-30`.) | Spec (its revision and links); SEP, Backward Compatibility |
| C1 | MUST | A client that has negotiated the extension handles either a `CallToolResult` or a `CreateTaskResult` in answer to any supported request it sends (today only `tools/call`). Repeated in the SEP's Backward Compatibility section. | Spec and SEP, Capability Negotiation |
| C2 | MUST | A `CreateTaskResult` in answer to a request type that isn't supported is an invalid response to that request. | Spec, Capability Negotiation |
| C3 | SHOULD | Implementations are designed to accommodate other request types in future revisions. | Spec, Supported Methods |
| C4 | MUST, then SHOULD | On `input_required`, the client MUST inspect `inputRequests` and SHOULD answer through `inputResponses` in later `tasks/update` requests. Only the SEP has the MUST; the spec says "should" in lower case there. | SEP, Task Status |
| C5 | SHOULD | Respect `pollIntervalMs` when deciding how often to poll. It may change over the task's life. | Spec, Task Polling; `Task` |
| C6 | SHOULD | Keep polling until the task reaches a terminal status, or until the client sends `tasks/cancel`. | Spec, Task Polling |
| C7 | SHOULD | Keep task ids in durable storage, so that polling can resume after a crash or a restart. | Spec, Task Polling |
| C8 | MAY | Treat `createdAt` + `ttlMs` as a backstop: past it, with the task still not finished, the client may consider the task unusable. | Spec, Task Polling |
| C9 | SHOULD | Fulfil the outstanding `inputRequests` with one or more `tasks/update` requests; after a `tasks/update`, keep observing the task (polling or notifications) until it is terminal. | Spec, Task Update Requests |
| C10 | MUST | Treat each entry of `inputRequests` as the equivalent request sent on its own: an elicitation there gets the same trust model and the same user-facing behaviour as a direct `elicitation/create`. The Security Considerations repeat this for hosts ("a task is not a higher-trust channel"). | Spec, Task Update Requests; Security Considerations |
| C11 | SHOULD | Deduplicate `inputRequests` keys across consecutive polls, so the same request isn't put to the user or the model twice. | Spec, Task Update Requests |
| C12 | SHOULD | Track `inputRequests` keys, so a request isn't answered more than once. | Spec, Task Update Requests, Response |
| C13 | MUST | Each key of `inputResponses` corresponds to a request that is currently outstanding. | Spec, `UpdateTaskRequest` (schema comment) |
| C14 | MUST NOT | Never use `notifications/cancelled` to cancel a task: `tasks/cancel` is the way. | Spec, Task Cancellation |
| C15 | MAY | Delete everything about a task once `tasks/cancel` is sent; there is no need to poll for the `cancelled` status. | Spec, Task Cancellation |
| C16 | MUST | Over Streamable HTTP, set `Mcp-Name` to `params.taskId` on `tasks/get`, `tasks/update` and `tasks/cancel`, and `Mcp-Method` to the method, as the transport's header conventions say. | Spec, Streamable HTTP: Routing Headers |
| C17 | MAY | Subscribe to `notifications/tasks` with `subscriptions/listen` (`notifications.taskIds`), declaring the extension. A client may keep polling as well. | Spec, Task Status Notifications |
| C18 | MAY | Show a task's `statusMessage` to the end user or the model. | Spec, `Task` (the field's comment) |
| C19 | MAY | Expose the task's lifecycle to whoever uses the client, rather than only the final result: "New implementation surfaces can then expose the task lifecycle directly". | Spec, Implementation Considerations |

What a client reads off the server's answers, which the texts put as server MUSTs and
which this client checks so that it can refuse an answer outside them (contract rule 1):

| Id | Server rule the client relies on | Where |
|---|---|---|
| S1 | `resultType` is `"task"` on a `CreateTaskResult` and on nothing else; `"complete"` on the answers to `tasks/get`, `tasks/update` and `tasks/cancel`. | Spec, Polymorphic Results; each method's Response |
| S2 | A task is durably created before its `CreateTaskResult` is sent, so the first `tasks/get` resolves. | Spec, Task Creation |
| S3 | `tasks/get` returns the status's own fields: `inputRequests` for `input_required`, `result` for `completed`, `error` for `failed`. | Spec, Task Polling, Response |
| S4 | `failed` only for a JSON-RPC error; a tool result with `isError: true` is `completed`. | Spec, Task Execution Errors |
| S5 | A missing or expired task id is answered -32602 on `tasks/get`. | Spec, Protocol Errors |
| S6 | Status moves only along the state diagram: once terminal, a task stays so. | Spec, Task Status |
| S7 | An `inputRequests` key is unique over the task's life and never reused. | Spec, Task Update Requests |

Not client rules, but they shape a client: `tasks/result` and `tasks/list` don't exist in this
revision (the SEP's Backward Compatibility table), and a server may ask for input before it
creates a task, with the core protocol's multi round-trip requests (SEP-2322), which the
extension leaves to the core protocol.
