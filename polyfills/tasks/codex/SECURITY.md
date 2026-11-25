# Security

This covers mcp-tasks for Codex. "The plugin" below means a helper process
(`plugin/dist/helper.js`) that Codex starts as an MCP server for each session.
It holds the Tasks client, in [`../core`](../core).

## The model

Starting a task runs a tool on one of your MCP servers. A task's result, its
status message and the questions it asks you are data that server wrote. The
plugin handles them in three parts:

- **Starting a task is your decision, made in Codex's own form.** The plugin
  calls the server's tool itself, on a connection of its own, so the approval
  Codex would give that tool doesn't apply. The plugin asks you instead, every
  time: the server's name from your config, the tool, and every argument,
  with "Start it" and "Do not start it". The choice is required. In Codex
  0.172's source (`codex-mcp/src/elicitation.rs`), Codex accepts a form by
  itself only when it has no fields and approvals are automatic. A form with a
  field is shown to you, or, where nobody can be asked, declined, which starts
  nothing. Codex's reviewer only reviews forms that ask for it in their
  metadata, which this one doesn't. Anything but "Start it" sends nothing to
  the server.
- **What the server wrote reaches the model only as a tool result,** when Codex
  calls `get_task_result` or `get_task`, marked as that server's data.
- **The line that wakes a session isn't a tool result.** It is put into the
  session with `codex queue`, and Codex shows it as an input message. So it
  carries nothing the server wrote: the plugin's own task id (`t-` and six hex
  digits), the server's name from your config, and a word for what happened
  (finished, completed, failed, needs input). Not the server's task id, the
  tool's name, the status message, or any of the result. Its first line says
  it was sent by the mcp-tasks plugin, not typed by the user.

A result gives Codex no permission it didn't already have. What Codex does
about it goes through its own approval policy, sandbox and reviewer.

## What you see twice, and what Codex no longer decides

Each start shows two questions:

1. **Codex's own approval** for the plugin's `start_task` tool, with its
   arguments: the server, the tool and the tool's arguments. Codex shows this
   under its usual rules: you may have allowed `start_task` always, or a
   reviewer may approve it.
2. **The plugin's question**, which Codex shows and only you can answer.

What Codex no longer decides for the server's own tool, because Codex never
sees that call:

- its approval mode for that tool;
- an "always allow" you gave that tool in Codex;
- a reviewer's view of that tool;
- Codex's hooks: a `PreToolUse` or `PostToolUse` hook on the server's tool
  (`mcp__<server>__…`) never sees the call (one on `start_task` would);
- rules set anywhere but your own `$CODEX_HOME/config.toml`: a trusted
  project's `.codex/config.toml`, or `-c` on Codex's command line, which the
  plugin can't see. A system-wide `/etc/codex/config.toml` that says anything
  about MCP servers makes the plugin connect to none.

The plugin does honour `enabled = false`, `enabled_tools` and `disabled_tools`
for the server, from your `config.toml`: a tool Codex wouldn't offer isn't
started. It reads no other per-tool rule.

This is the main design judgment in this form. The question is Codex's own
interface, answered only by a person, and it shows more than Codex's approval
of the server's tool would: the server, the tool and every argument. But it is
a question the plugin writes, standing in for one Codex would ask.

## What the plugin does

**Before a start:**

- **A tool Codex wouldn't offer** (`enabled_tools`, `disabled_tools`), or one
  the server doesn't list, isn't started.
- **The question shows exactly what is sent.** The arguments are shown as the
  JSON that goes to the server, each character you couldn't see (controls,
  format and other default-ignorable characters, tag characters) written as
  `\u{…}`, and nothing is cut. Arguments longer than 6000 characters as shown
  aren't sent.
- **Arguments that hold a secret from your config aren't sent.** That means a
  header, a token variable, a headers helper's output, or a local server's
  environment, matched whole at any length, and inside any string or key at 8
  characters or more. In the question such a secret would show as
  `[redacted]`, so you'd approve something you couldn't see.
- **Where nobody can be asked,** Codex declines the form and nothing starts.
  That's `codex exec`, the approval policy `never`, and a session without
  elicitation. Live in `codex exec`, Codex refused the `start_task` call itself
  before any question.

**What a server sends:**

- **Every answer is checked against the specification** before it is kept:
  - the status, the fields that status requires, the dates and intervals;
  - a task that changes its id, or leaves a terminal status, is refused and
    left alone;
  - a task for a request that can't have one is invalid.
- **A task's questions are treated as the same requests sent on their own.**
  - A form is put to you in Codex's form, introduced as `The MCP server
    "<name>" asks, for task t-…`. The form is rebuilt from the parts a form may
    have (flat fields with plain names), and every text in it, the message,
    titles, descriptions, choices and defaults, is cut to a bound, with hidden
    characters shown as `⟦n hidden characters⟧` and control characters
    removed. A form that is too large or too deep, or names a field that isn't
    a plain name, isn't put to you.
  - A form with no fields becomes a required Accept/Decline choice, because
    Codex accepts a form with no fields by itself where approvals are
    automatic.
  - Sampling (your model), roots and URL forms aren't declared to the server
    and aren't answered, and Codex is told so.
  - Each question is put once, and answered once, even if Codex calls
    `provide_task_input` twice at once.
  - The answers go only to the task's own server, and only while the server of
    that name in your config is reached as it was when the task started (the
    same address, or the same command). Otherwise nothing about the task is
    sent, not even its id.
- **Results are shown as tool results, marked as the server's.** Each block is
  rebuilt from the fields MCP defines for it: text, a resource's text, a
  resource link's name, title and description, all cleaned (control characters
  removed, hidden characters shown); images, audio and blobs with their data
  and a checked MIME type. Annotations, `_meta` and anything else are left out,
  as are blocks of other types. `structuredContent` is shown as cleaned JSON
  text.
- **Size limits:** one answer from a server, 4 MB (a stream's messages one by
  one; a local server's through the transport's buffer); a task's questions,
  256 KB; a status message, 4000 characters; a failed task's error, 16 KB; a
  result, 1 MB.
- **Server names are always your config's names,** never what a server calls
  itself. Outside a failed task's result, which shows the server's error
  message as its data, errors are described in the plugin's own words, by code.
- **Secrets from your config are taken out of everything the plugin sends
  Codex,** in questions and answers alike, keys included: configured headers,
  a headers helper's output, a local server's environment. Anything nested
  deeper than 32 levels is cut off rather than sent. A secret shorter than 8
  characters isn't taken out of text (it would match ordinary words), only
  refused in arguments.
- **A config file that can't be parsed** is reported as such, without the
  parser's message, which quotes the text around the error.
- **It reads Codex's configuration and nothing else of Codex's:** not its
  stored sign-ins, its sessions or its auth file. A server that signs in
  through Codex is left alone.
- **Where your organisation manages Codex's MCP servers,** it connects to none.

**What it runs on your machine:**

- **Its own copy of each local MCP server** in your config (a `command`), with
  that server's `env` and `env_vars` and the MCP SDK's small default
  environment, so a local server runs twice while the plugin is connected.
- **A server's `http_headers_helper`,** as Codex runs it: through a shell, in
  the folder of the config it came from (`$CODEX_HOME`, or that of
  `MCP_TASKS_CONFIG`), with the MCP SDK's default environment plus `LANG`,
  `LC_ALL`, `TMPDIR` and `TZ`. It runs in a process group of its own, stopped
  whole after 10 seconds or 64 KB of output, and its time counts against the
  connection's own time limit. Its output must be a JSON object of headers; a
  reserved header is refused, and an `Authorization` in your config wins over
  the helper's.
- **`codex queue`,** to wake a session (below).

**The wake:**

- A wake is handed over only after a turn you started in one of Codex's own
  apps (the terminal UI, the desktop app, `codex exec`), as the call's turn
  metadata says. In an app that runs Codex through an app server of its own,
  the turn might run unseen, so the wake waits for your next turn there.
- `codex queue` is run with no shell, with the plugin's own settings taken out
  of its environment, and only for a session id that is a UUID.
- **Wakes have a budget:** one a minute about the same task, 30 an hour for a
  session (`MCP_TASKS_WAKE_GAP_S`, `MCP_TASKS_WAKES_PER_HOUR`). A server can't
  keep waking a session by asking question after question.

## What is stored

Everything is in `$CODEX_HOME/mcp-tasks/` (or `MCP_TASKS_STATE`), readable only
by you: folders 0700, set again on folders that already exist, and files
0600:

- **each session's tasks** (`threads/<session id>/tasks.json`):
  - the server, the tool and the arguments you approved;
  - the server's task id, and its last status;
  - its result, up to 1 MB;
  - how the server was reached (a fingerprint of its address or command);
  - when the session was last woken, for the budget;
  - finished tasks are removed a week after they finish, each time the plugin
    starts and each time it saves that session; a session with nothing left,
    not heard from in two weeks, is removed when the plugin starts;
- **which process polls a session's tasks** (`owner.pid`);
- **a log,** with secrets taken out.

The server's task id can be a bearer token for the task (the specification
allows that), so treat the folder as you treat your Codex home.

## Full access

`--dangerously-bypass-approvals-and-sandbox` wasn't run. From Codex 0.172's
source (`codex-mcp/src/elicitation.rs`), under the approval policy it sets:

- a form with fields is declined, unless Codex's "full-access form input" is
  on, in which case it is shown to you;
- only a form with no fields is accepted by Codex itself, and the plugin's
  question always has a required field.

So nothing should start unasked there. This is a reading of the source, not a
run.

## What it does not protect against

- **A server you configured that runs something other than what it says.**
  You approve the call; what the tool does on the server is the server's.
- **A server that returns misleading results.** They are its data, and Codex
  may act on them within your approval policy.
- **An app that marks its turns as Codex's own do.** `turn_trigger` is set by
  the app that starts the turn.
- **Someone who can read your files.** The state folder holds task ids,
  arguments and results.
- **A model that asks you to approve something misleading.** The question
  shows exactly what will be sent; reading it is up to you.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-tasks` for
Codex.
