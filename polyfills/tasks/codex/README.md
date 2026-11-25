# mcp-tasks for Codex

Some MCP tools take minutes or hours: a research run, a build, a batch job. With
this plugin, Codex can start such a tool as a task on your MCP server, carry on
or sit idle, and be woken when the task finishes. You approve each start, in
Codex's own form, with the server, the tool and its arguments in front of you.

This plugin implements the client side of the MCP Tasks extension
(`io.modelcontextprotocol/tasks`):
[SEP-2663](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/seps/2663-tasks-extension.md)
(Final) and the ext-tasks specification at revision
[2026-07-28](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md),
as of commit `cc9aaac` of `modelcontextprotocol/ext-tasks`. Codex doesn't
support the extension itself yet ([openai/codex#48617](https://github.com/openai/codex/issues/48617)).
Claude Code lists it as supported in the MCP [client
matrix](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx)
and needs no polyfill. Details are in [Spec and conformance](#spec-and-conformance).

## Install

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-tasks@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace, and
the second installs the plugin. Until the plugin is listed in that marketplace,
install it from a marketplace of your own that holds a copy of
[`plugin/`](plugin/): a folder with `.agents/plugins/marketplace.json` naming it
(as [`live/run.sh`](live/run.sh) makes one), then
`codex plugin marketplace add <that folder>` and
`codex plugin add mcp-tasks@<its name>`. The install is one small folder,
[`plugin/`](plugin/), of about 0.5 MB. Nothing else is downloaded.

You need:

- **Codex 0.172 or newer.** It was tested with 0.172.0.
- **Node 20 or newer** on the PATH Codex runs with.
- **An MCP server that offers the Tasks extension** on protocol revision
  2026-07-28, in your `config.toml`. It was tested with FastMCP 4.2.6
  (`fastmcp[tasks]`, tools marked `task=True`) only. Others that say they serve
  it: the Rust SDK ([rmcp PR 1020](https://github.com/modelcontextprotocol/rust-sdk/pull/1020)),
  the C# SDK's [`ModelContextProtocol.Extensions.Tasks`](https://csharp.sdk.modelcontextprotocol.io/v2/concepts/tasks/tasks.html),
  and [mcpkit](https://github.com/panyam/mcpkit/tree/main/examples/tasks-v2) (Go,
  SEP-2663's reference). See [Which servers it works with](#which-servers-it-works-with).

To remove it, run `codex plugin remove mcp-tasks@agent-polyfill`. What it kept
is in `~/.codex/mcp-tasks/`, which you can delete.

## How it works

### From install to the first task

| Step | What you see | If it is missing or declined |
|---|---|---|
| Install | `Added marketplace agent-polyfill`, then `Added plugin mcp-tasks`. | Nothing is installed. |
| Node | Nothing. | Codex reports that the `mcp-tasks` MCP server failed to start. Nothing else changes. |
| A server that offers Tasks | Ask Codex which of your servers can run tasks. `list_task_servers` names them with their tools, and names every other server with the reason it was left alone. | It says none offers the extension. Your servers work in Codex as before. |
| Codex wants a long tool | First Codex's own approval for the plugin's `start_task` tool, showing the server, the tool and the arguments. Then the plugin's question, in Codex's form: `Start a task on the MCP server "<server>"?`, with the tool, every argument, and "Start it" or "Do not start it". | "Do not start it", closing the form, or Codex declining for you (`codex exec`, the approval policy `never`): nothing is sent to the server. |
| The server answers at once | Codex gets the result straight away, as from any tool. | |
| The server starts a task | Codex says the task's id (`t-` and six hex digits) and carries on. The plugin follows the task at the pace the server asks for. | |
| The task finishes | The idle session wakes, at most once a minute about the same task and 30 times an hour in all, with a line from the plugin: `[mcp-tasks] (Sent by the mcp-tasks plugin, not typed by the user.) Task t-628380 on fm has finished (completed); get_task_result t-628380 returns its result.` Codex reads the result and goes on. | If Codex isn't running the session's plugin then, the line comes when it next does ([Limits](#limits)). |
| The task needs your input | The session wakes: "needs input from the user". Codex calls `provide_task_input`, and the server's question appears in Codex's form, headed with the plugin's name and saying which server asks. | Declining or closing the form sends that answer to the server. Questions the plugin can't put to you, such as a request to use your model, are refused, and Codex is told. |

### The tools

| Tool | What it does |
|---|---|
| `list_task_servers` | Lists your servers that offer Tasks, with their tools, and the others with why each was left alone. |
| `start_task` | Asks you, then calls a server's tool with the extension declared. It returns the result, or the task's id. |
| `get_task` | Asks the server for a task's status. Its status message is shown as the server's data. |
| `get_task_result` | Returns a finished task's result, as the server sent it, marked as that server's data. |
| `provide_task_input` | Puts a task's questions to you in Codex's form, and sends your answers back. |
| `cancel_task` | Asks the server to cancel a task. The server decides whether and when it stops. |
| `list_tasks` | Lists this session's tasks and what the plugin last heard about each. |

### How the parts fit together

```
 Codex ──stdio──▶ mcp-tasks (the plugin's MCP server, one per session)
   ▲                 │  its own connection, protocol 2026-07-28,
   │                 │  declaring io.modelcontextprotocol/tasks on each request
   │                 ▼
   │              your MCP server ──▶ tools/call → a task, tasks/get, tasks/update, tasks/cancel
   │                 │
   └── codex queue ◀─┘  when a task finishes or needs input: a line naming its id, nothing else
```

The plugin keeps each session's tasks on disk, in
`~/.codex/mcp-tasks/threads/<session>/tasks.json`, readable only by you. It
polls each open task at the interval the server gives, never faster, with a
floor of one second. After a restart it carries on from there. One process
polls a session's tasks; a second window of the same session leaves them to the
first, and takes over if the first goes.

### Which servers it works with

| How the server is in `config.toml` | Works |
|---|---|
| A local server (`command`) | Yes. The plugin starts its own copy, so the server runs twice. |
| An HTTP server (`url`) with no sign-in | Yes. |
| An HTTP server with `http_headers`, `env_http_headers`, `bearer_token_env_var` | Yes, where Codex passes the variable to plugins. It passes only a fixed few, so a token in your shell's environment usually isn't visible to the plugin. |
| An HTTP server with `http_headers_helper` | Yes. The helper is run as Codex runs it, before each connection. |
| A server you signed in to through Codex (`codex mcp login`, an `oauth` table, `auth = "chatgpt"`) | No. Codex keeps that sign-in to itself, and the plugin never reads it. |
| `enabled = false` | Left alone. |
| A server that offers tasks only in the form from the 2025-11-25 specification (`params.task`, `tasks/result`, a top-level `tasks` capability), such as FastMCP 3 or ToolUniverse | Left alone, and named as such in `list_task_servers`. |
| Where your organisation manages Codex's MCP servers (`requirements.toml`, a managed profile) | The plugin connects to none, because it can't apply that policy. |
| Where a system-wide `/etc/codex/config.toml` says anything about MCP servers | The plugin connects to none: it reads only your own `config.toml`, so it could miss an `enabled = false` or a tool list there. |

Codex's own tool rules for a server, `enabled_tools` and `disabled_tools`, are
honoured: a tool Codex wouldn't offer isn't started here either. They are read
from your `config.toml` only: not from a trusted project's `.codex/config.toml`,
or from `-c` on Codex's command line, which the plugin can't see.

A task stays with the server it started on. If the server of that name in your
config is later reached some other way (another address or command), the
plugin sends it nothing about the task, not even its id, which may be a bearer
token.

## Settings

Set these in the environment Codex starts with.

| Setting | What it does |
|---|---|
| `MCP_TASKS_OFF=1` | The plugin does nothing: no tools, no connections. |
| `MCP_TASKS_SERVERS=a,b` | Only these servers. |
| `MCP_TASKS_SKIP=a,b` | Never these servers. |
| `MCP_TASKS_CONFIG=<file>` | Read servers from this TOML or JSON file instead of `config.toml`. |
| `MCP_TASKS_STATE=<dir>` | Keep tasks here instead of `~/.codex/mcp-tasks`. |
| `MCP_TASKS_CODEX_BIN=<path>` | The `codex` to wake sessions with. |
| `MCP_TASKS_CODEX_REMOTE=<addr>` | Wake through this app server (`ws://…`, `unix://…`), as `codex --remote` does. |
| `MCP_TASKS_CONNECT_TIMEOUT_MS` | How long to wait for a server to answer at the start (10 s). |
| `MCP_TASKS_MIN_POLL_MS` | The floor under the server's polling interval (1000 ms). |
| `MCP_TASKS_WAKE_GAP_S` | The least time between two wakes about the same task (60 s). |
| `MCP_TASKS_WAKES_PER_HOUR` | The most wakes of one session in an hour (30). |

### When Codex supports Tasks itself

The plugin stands down: it offers no tools, opens no connection, and closes any
it has. It knows by
what Codex declares to every MCP server it starts, the plugin's own included.

- **What is proven.** Codex 0.172 declares its client extensions at
  `initialize`, from a fixed list in its source
  (`codex-mcp/src/client_capabilities.rs`). Live, that list is empty for the
  plugin.
- **With Codex's experimental `mcp_2026_07_28` feature on.** Codex first sends
  `server/discover`, declaring its capabilities in that request's `_meta`
  (again no extensions, seen in one run by hand, on this code before 0.1.0;
  [live-run.md](docs/live-run.md)). The plugin reads that declaration, then
  answers "method not found", as a server that speaks only the 2025 revisions
  does, and Codex goes on with `initialize`. The plugin also reads the
  declaration on every other request.
- **What isn't proven.** How a Codex that speaks Tasks will declare it. If it
  declares the extension to every server, on any of those three, the plugin
  sees it. If it declares it only to servers that advertise Tasks, the plugin
  won't see it, because the plugin's own server doesn't advertise Tasks.
  Until that's known, `MCP_TASKS_OFF=1` turns the plugin off.

## Limits

What works: starting a task (with your approval), a plain result, polling,
the result, cancelling, questions from a task, waking an idle session, a
restart. What doesn't, and what in Codex would close each:

- **Codex's approval for the server's tool is replaced by the plugin's
  question.** The plugin calls the tool itself, on its own connection, so
  Codex's approval of that tool (its approval mode, an "always allow" you gave
  it, a reviewer) doesn't decide it. The plugin asks you every time instead,
  and honours `enabled_tools` and `disabled_tools`, but no other rule Codex
  may have for that tool. Codex's hooks (`PreToolUse`, `PostToolUse`) on the
  server's tool (`mcp__<server>__…`) never see the call; only `start_task`'s
  would. You see two questions per start: Codex's approval of `start_task`,
  which shows the same server, tool and arguments, and then the plugin's.
  - *Would close it:* Tasks in Codex itself; or a way for a plugin to send a
    request over Codex's own connection, with Codex's approval, and see the
    raw result (changes 1 and 4 in [What hosts would need to
    change](../../../docs/host-changes.md)).
- **A server's question is shown as the plugin's.** Codex heads it with the
  plugin's name; the text says which server asks. Codex's rules for questions
  from that server apply to the plugin instead. A question with no fields,
  which Codex might answer by itself where approvals are automatic, becomes an
  Accept/Decline choice you make.
  - *Would close it:* Tasks in Codex itself, or a way for a plugin to pass on
    a server's question as that server's.
- **No servers you signed in to through Codex.** A local server runs twice.
  - *Would close it:* the same changes 1 and 4.
- **A task is followed only while Codex runs the session's plugin.** Codex
  starts it with the session, ends it about a minute after the session closes,
  and for a resumed session starts it only at the first call of one of its
  tools. A task that finishes in between is noticed when the plugin next runs.
  - *Would close it:* starting a resumed session's plugin servers when it
    opens, or a supported background service for plugins.
- **Questions the plugin can't put to you are refused.** A request to use your
  model (sampling), for your workspace roots, or for a URL form: the plugin
  doesn't declare those to the server, doesn't answer them, and tells Codex.
  The task may wait; `cancel_task` stops it. This is what a client that
  doesn't offer them does.
- **Input before a task exists.** A server may ask for input on the first call,
  before it creates a task (the core protocol's multi round-trip requests).
  The plugin doesn't answer those yet: it says so and starts nothing.
- **No push.** The plugin polls; it doesn't subscribe to the server's task
  notifications (`subscriptions/listen`). The spec makes that optional.
- **Arguments that hold a secret from your config aren't sent,** and arguments
  longer than 6000 characters as the question shows them aren't sent either:
  the question shows every argument exactly as it would be sent, each
  character you couldn't see written as `\u{…}`, and nothing is cut.
- **Wakes have a budget:** one a minute about the same task, 30 an hour for a
  session, as for Events. A task that asks a question and then finishes wakes
  the session the second time a minute after the first.
- **A task id must be visible ASCII, up to 512 characters,** because it goes
  in an `Mcp-Name` header. The spec sets no limit; such a task is refused.
- **The earlier form isn't accepted.** Servers that speak only the
  experimental tasks of the 2025-11-25 specification (SEP-1686) are left
  alone. That form isn't wire-compatible with this extension.
- **No upstream conformance run.** The MCP conformance suite has Tasks
  scenarios for servers only (conformance#374).
- **Not tried yet:**
  - Full access (`--dangerously-bypass-approvals-and-sandbox`). It wasn't run.
    Codex 0.172's source (`codex-mcp/src/elicitation.rs`) says that there, a
    question with a required field is declined, or shown to you when Codex's
    "full-access form input" is on, and never answered for you. What
    [`SECURITY.md`](SECURITY.md) says about it is a reading of that source.
  - The Codex desktop app, Windows and Linux. It was run in the terminal UI and
    `codex exec`, on macOS; the tests run on Linux and macOS.

## Security

A task's result, its status message and its questions are text a server wrote.
The plugin treats them as untrusted data from that server, the way Codex treats
a tool result. In short:

- Nothing starts without your "Start it" in Codex's form. The form has a
  required choice, which Codex never answers in your place.
- The line that wakes a session holds the plugin's own task id and the server's
  name from your config, and nothing the server wrote.
- What a server wrote reaches the model only as a tool result, marked as that
  server's, rebuilt from the fields MCP defines, with hidden characters shown
  and control characters removed. Its questions are rebuilt the same way.
- Secrets from your config (8 characters or more) are taken out of everything
  the plugin sends Codex; arguments that hold one, of any length, aren't sent.
- The plugin never reads Codex's stored sign-ins, and stores no credential of
  yours. It does store each task's id, which a server may use as a bearer
  token for the task.

[`SECURITY.md`](SECURITY.md) has the details, including what it doesn't
protect against.

## Spec and conformance

- **Spec:** SEP-2663 (Final) and the ext-tasks specification at revision
  2026-07-28, at commit `cc9aaac` of `modelcontextprotocol/ext-tasks`. Every
  rule they put on a client, with ids, is in
  [`../core/docs/client-rules.md`](../core/docs/client-rules.md).
- **Conformance:** [`docs/conformance.md`](docs/conformance.md) has one row
  per client rule, with the test that checks it.
- **Interop:** against FastMCP 4.2.6 with fastmcp-tasks 4.2.6, a server whose
  Tasks side someone else wrote, over Streamable HTTP. There are 10 checks, in
  `test/interop/fastmcp-interop.ts` ([`docs/interop.md`](docs/interop.md)).
- **Upstream suite:** it has no client scenarios for Tasks yet
  (modelcontextprotocol/conformance#374), so there is nothing to run.
- **Live:** a real Codex 0.172.0 in a throwaway home, with a scripted model,
  against FastMCP, by [`live/run.sh`](live/run.sh). A task completed and woke
  the session; a task's question was answered, and another's closed, in
  Codex's form; and `codex exec` started nothing ([`docs/live-run.md`](docs/live-run.md)).
- **No production server tried.** The only production use we found, ZoomInfo's
  MCP server, needs an OAuth sign-in, which this plugin can't use.

## Development

The tests need Node 22.18 or newer (they run TypeScript directly); the plugin
itself runs on Node 20.

```bash
cd polyfills/tasks/core && npm ci
cd ../codex && npm ci
npm run typecheck
npm test            # the helper as Codex runs it, against test/fixture-tasks-server.mjs, over stdio and HTTP
npm run build       # plugin/dist/helper.js (committed)
python3 -m venv /tmp/fm && /tmp/fm/bin/pip install --require-hashes -r test/interop/requirements.txt
MCP_TASKS_INTEROP_PYTHON=/tmp/fm/bin/python npm run interop
MCP_TASKS_INTEROP_PYTHON=<same> live/run.sh <out dir>   # a real Codex TUI, in a throwaway home
node ../../../tools/bundle-notices.mjs . --plugin plugin   # plugin/THIRD_PARTY_LICENSES.txt
```

The shared client is [`../core`](../core): its own connection, the task
store, the poller and the checks on a server's answers. This folder adds what
is Codex's: the MCP server Codex starts, `config.toml`, the questions, and the
wake. No test can find a real `codex` or `gh`: each runs with Node's folder
alone on its PATH, and checks that.

## Licence

Apache-2.0. The bundle includes third-party code under its own licences:
[`plugin/THIRD_PARTY_LICENSES.txt`](plugin/THIRD_PARTY_LICENSES.txt).
