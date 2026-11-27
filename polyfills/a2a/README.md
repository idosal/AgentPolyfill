# A2A delegation

Connect a named A2A agent to your chat. Ask the agent to do a job, review its questions, and receive its artifact in the originating conversation. AgentPolyfill implements the **client** for the Agent2Agent project’s A2A 1.0 protocol using its official Python SDK. Structured Input v1 is a draft extension. A Tasks-capable host handles background work. Antigravity CLI can also finish a delegation during an active turn using its own permission cards.

## Install from this checkout

From the AgentPolyfill checkout, run the following command with your host and agent URL. It installs the locked Python runtime and registers the agent and the host integration. Keep this checkout at the same path. The local installer requires uv and Python 3.12 or newer (uv can provision Python). The shell entry point targets macOS and Linux. Host runs listed below were on macOS.

```sh
./polyfills/a2a/install codex --name swatch --url https://agent.example.org
```

Use `pi`, `t3`, `opencode`, `hermes`, `copilot`, `claude`, or `antigravity` in place of `codex`. Give each endpoint a distinct name. For A2A Serve, pair with the agent first and append `--serve-credentials /absolute/path/to/a2a-serve`. A bearer-authenticated endpoint can use `--bearer-file /absolute/path/to/private-token`. The installer stores the path. The adapter invokes the Serve helper or reads the token file when making a request. HTTPS and loopback HTTP are supported. Listing the local tool or adding the agent makes no call to the agent.

Open a new chat and ask “Delegate the swatch check to the swatch agent.” On a Tasks host, use the `delegate` tool through its Tasks client. A person can decline the start, leave a question pending, explicitly deny a remote permission, or cancel the task.

| Host | What the installer connects | How to use it |
| --- | --- | --- |
| Codex | User MCP configuration and the existing Codex Tasks helper (Node 20+ on the host path). Reuses an enabled marketplace Tasks plugin. | Ask to start `swatch.delegate` using Tasks. |
| Pi | MCP configuration and the Pi Tasks extension in the selected Pi agent directory (Node 22+). | Start the task in a Pi chat. |
| T3 Code | The Pi provider's agent directory, shared with Pi. | Select that Pi provider in T3. |
| OpenCode | A local MCP entry and the OpenCode Tasks plugin in the active JSON configuration. | Open the session in a frontend that can present its dialogs. |
| Hermes | A local MCP entry, Tasks plugin, and a notification grant for the named server. | Restart the gateway with Node 22 available. Run `/mcp-tasks start swatch delegate {"message":"Create a swatch"}`. |
| GitHub Copilot CLI | Native Tasks by default. For the verified interactive fallback, add `--tasks polyfill` at install and launch with `MCP_TASKS_FALLBACK=1 copilot --experimental`. | Review each decision in the interactive terminal. |
| Claude Code | User-scoped stdio MCP server for native Tasks. | Review the native permission prompt and both input forms in a Tasks-eligible interactive terminal. [Native eligibility and UI limits](https://code.claude.com/docs/en/mcp#what-a-call-needs-to-become-an-mcp-task) |
| Antigravity | A named MCP server and a per-agent approval plugin. Requires `agy` and Node 22.18+. | Review the exact destination, message, question and proposed answer on the permission card. To choose another answer, decline and request a different proposal. Longer-running work returns a handle for `resume_delegation` in the same conversation. |

`--tasks native` configures just the agent for a native Tasks client. `--tasks existing` does the same for a separately managed Tasks client. Pi and T3 honor `PI_CODING_AGENT_DIR`. Codex honors `CODEX_HOME`, Hermes honors `HERMES_HOME`, and OpenCode honors `OPENCODE_CONFIG`. Automatic OpenCode setup supports plain JSON profiles. A profile with JSONC comments can register the stdio command and Tasks plugin manually. The installer refuses a different entry using the same name. Repeating an identical installation preserves other settings.

Disconnect the named agent with the following command. It retains shared Tasks integrations and chat history. Antigravity's per-agent approval plugin is removed with the entry.

```sh
./polyfills/a2a/install codex --name swatch --remove
```

For a manually managed host, the package also provides `agentpolyfill-a2a --url URL` over stdio. The original `servers/a2a-tasks` path resolves to this package.

## Host verification

The following surfaces completed the two-question replay using the official A2A Serve process on macOS. Each run used synthetic messages and a scripted agent.

| Tested surface | How input reached A2A Serve |
| --- | --- |
| Codex Desktop 26.1120.50957 | The standalone install showed start consent and both forms. Replaying answer one while the second form was visible left it open. Only the initiating chat received the completion. |
| Claude Code 2.1.331 | The interactive terminal negotiated native Tasks, displayed both forms and received the artifact in its completion notification. A separate declined start left the remote task count unchanged. |
| Antigravity CLI 1.5.18, ACP | The installed approval hook presented each proposed operation on its native permission channel. A scripted ACP editor and local Gemini-compatible provider completed both questions in the initiating turn. |
| [Pi 1.6.0](../tasks/pi/README.md) | The installed Pi extension presented the two input dialogs through Pi's RPC interface. |
| [OpenCode 2.4.1](../tasks/opencode/README.md) | The running OpenCode server delivered both questions through its session-scoped dialog API. |
| [Hermes 0.23.4](../tasks/hermes/README.md) | The gateway presented the questions and accepted replies with the `/mcp-tasks input` command. |
| [GitHub Copilot CLI 1.0.115](../tasks/copilot/README.md) | The interactive terminal presented both choices with the Tasks fallback explicitly enabled (`MCP_TASKS_FALLBACK=1`). |
| [T3 Code 0.1.12 with Pi 1.6.0](../tasks/t3/README.md) | T3's web chat presented both questions and accepted the answers in its composer. The result appeared in the same chat. |

The Tasks runs used a paired A2A Serve 0.1.0 process, a scripted worker, and automated user responses. After a declined start, an approved start produced two successive questions. Replaying the first answer left the second open, and answering the second returned the text artifact. Codex Desktop, Pi, OpenCode, Hermes, and T3 also ran a second session and checked that it received zero wakes for the task.

The Antigravity active-turn path checks a single-use host approval against the exact proposed arguments and conversation. A stale question key is checked against the remote task again before sending. It also provides an explicit resume tool. The Antigravity CLI check covers an active ACP turn. The App and IDE, Claude Desktop, Copilot in VS Code, and T3 providers other than Pi have no end-to-end A2A result here.

## Operating the adapter

Use a stable checkout path. To upgrade, update that checkout and repeat the install command for each configured agent. Restart the host or its gateway to pick up new code. Keep the routing database when upgrading or reconnecting so pending questions retain their identity. A different URL requires a new agent name or an explicit removal and reinstall.

When the host provides native **A2A** for the endpoint, disconnect the named adapter with `--remove`. To keep its registration dormant, add `--disabled` to the adapter’s stdio arguments and restart the host. Disabled mode exposes an empty catalog and opens neither the agent connection nor its task database. Native **MCP Tasks** can still use this adapter for its A2A connection via `--tasks native`.

Pair Serve using its own CLI. For bearer authentication, rotate the owner-only token file in place. The adapter reads it for each request. Keep agent credentials out of chat messages. The configured endpoint receives approved messages and answers, and the host retains its own normal chat history. An interrupted submission can have an unknown outcome. Inspect the originating chat or agent before submitting again. Remote deduplication determines whether a retried request can cause a second effect.

See the [security and verification notes](VERIFICATION.md) for trust boundaries, supported forms and the checks that run on changes.

## Protocol behavior

- A direct A2A message is an immediate tool result. A remote task gets an opaque local handle. Polls use `GetTask`, explicit cancellation uses `CancelTask`, and completed artifacts appear as bounded inline text or data. File parts appear as attachment descriptions.
- Structured Input schemas travel as native MCP forms. Each answer is checked against the current question and its schema. The continuation carries the original A2A task, context and extension request ID, plus Serve's fixed sequence when present. A stale or already-delivered MCP answer is ignored. An agent-supplied request ID enables the receiving agent to reject a stale answer even if its question changes during the network round trip.
- Ordinary text questions use a text field. For questions without a Structured Input ID, the adapter still checks the current A2A status message before sending. The base A2A protocol has no equivalent receiver-side question ID. Complex forms outside the Tasks client's supported subset can stay pending. Authentication challenges ask the user to authenticate out of band.
- The adapter keeps routing IDs, timestamps and question receipts in a per-user SQLite database under the selected host profile. Manual stdio launches default to `~/.local/state/agentpolyfill-a2a/tasks.sqlite3`. Use `--state-dir` for a separate profile and retain it across restarts. Agent credentials, prompts, answers and artifact contents are excluded from that database. Codex maintains its usual chat and Tasks history.

The adapter targets the A2A 1.0 JSON-RPC binding, Structured Input v1, and MCP Tasks revision 2026-07-28. [A2A specification](https://github.com/a2aproject/A2A/blob/3303592588e388e62e0f69f701af531d2f4e3991/docs/specification.md) · [Structured Input](https://github.com/a2aproject/experimental-ext-structured-input/blob/ed844541803ad096dc2e12e084a29d761d91b44e/v1/spec.md) · [MCP Tasks](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md) · [Python SDK](https://github.com/a2aproject/a2a-python)

## Verify

From this directory, run `uv sync --locked --extra setup` and `.venv/bin/python -m unittest discover -s tests -v`. The SDK regression covers restart and stale answers. The installation tests exercise profile merging, repeated setup and collisions. To run the external replay independently, supply the official A2A Serve 0.1.0 executable.

```sh
.venv/bin/python tests/interop/serve.py /absolute/path/to/a2a-serve
```

The test creates a loopback agent, runs a deterministic ACP worker, pairs a disposable caller, checks that a declined start created zero tasks, replays the first answer against the second question, and retrieves the text artifact. The package supports configured-origin JSON-RPC, polling, cancellation and bounded inline results. Streaming, push notifications, additional transports and enterprise identity flows are outside this client profile. HTTP responses are limited to 2 MiB before parsing. Tool permissions include Serve's supplied arguments for review.

The [two-question TLA+ model](model/A2AReplay.tla) checks replay under a process restart and an independently advancing agent. With TLA+ Tools 1.7.4, run the following command from `model/`. The tagged and deduplicating configurations check their respective invariants. The no-ID and no-remote-dedup configurations intentionally produce counterexamples when the receiving agent lacks the corresponding guarantee.

```sh
java -cp /path/to/tla2tools.jar tlc2.TLC -workers 1 -config tagged.cfg A2AReplay.tla
```
