# Security and verification

The supported client profile uses one configured A2A 1.0 JSON-RPC endpoint per named server. The [pinned A2A specification](https://github.com/a2aproject/A2A/blob/3303592588e388e62e0f69f701af531d2f4e3991/docs/specification.md), [Structured Input v1 draft](https://github.com/a2aproject/experimental-ext-structured-input/blob/ed844541803ad096dc2e12e084a29d761d91b44e/v1/spec.md), and [MCP Tasks revision](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md) define the wire formats.

| Boundary | Behavior and executable check |
| --- | --- |
| Discovery and credentials | The operator selects an HTTPS or loopback agent URL. The client uses the configured origin, refuses redirects and unknown required extensions, and sends delegation messages only on a compatible interface. Credential files must belong to the current user and be readable only by that user. The SDK and credential tests exercise destination selection, file permissions and rotation. |
| Starting work | A native Tasks host or the existing Tasks client presents its consent UI. In the Antigravity active turn the host hook binds approval to the exact arguments and conversation. Declining creates zero remote tasks in the official Serve replay. |
| Questions and retries | The adapter rereads the remote task and checks the task, context and current question before sending an answer. SQLite serializes local writers. A repeat uses the same A2A message ID. The two-question SDK and Serve tests exercise stale answers across stdio restarts. |
| Untrusted input | The adapter displays bounded inline results. It never downloads artifact URLs. HTTP bodies are limited to 2 MiB. An agent must advertise Structured Input before the client will use its schema. The flat form profile supports primitive fields, bounded choice schemas and arrays. Regular expressions, schema references, nested objects and schemas larger than 32 KiB require answering at the agent. An oversized prompt or unsupported form stays pending. Enter credentials only through the endpoint’s out-of-band authentication. |
| Session ownership | Native Tasks hosts own their task handles. Each polyfilled host binds them to its chat. Antigravity’s active-turn handles and host approvals also check the originating conversation. The one-use ticket tests cover argument changes, ticket reuse and a receipt from a different chat. |
| Native takeover | `--disabled` keeps the stdio handshake available with no tools or remote contact. The subprocess regression also verifies that this mode creates no local state. |
| Protocol results | The SDK suite covers immediate messages, task creation, terminal states, explicit cancellation, out-of-band authentication and optional Structured Input request IDs. Additional bindings, streaming, push notifications and enterprise identity are outside the tested profile. |

## Reproduce the checks

From this directory run the following commands. The last one needs the official [A2A Serve 0.1.0 executable](https://github.com/a2aproject/a2a-serve/releases/tag/v0.1.0). Its deterministic worker operates in a temporary directory with loopback networking and synthetic data.

```sh
uv sync --locked --python 3.12 --extra setup
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python tests/interop/serve.py /absolute/path/to/a2a-serve
```

The [CI workflow](../../.github/workflows/a2a-test.yml) verifies a checksum-pinned Serve release on Linux through both the standard MCP Tasks stdio protocol and the active-turn fallback, installs and removes the adapter in a fresh profile, runs the tests and builds the wheel. The [host verification table](README.md#host-verification) records the separately exercised macOS surfaces. The eight-host runs used real hosts with synthetic models and a paired Serve process.

The [bounded TLA+ model](model/A2AReplay.tla) checks two successive questions, concurrent remote advancement and a local restart. Correlation checks passed in 154 distinct states. With receiver deduplication the additional single-effect invariant passed in 70 distinct states. Negative controls show how the wrong question can receive an answer without correlation and how a crash can repeat an effect without remote deduplication. These model assumptions also apply to real agents.
