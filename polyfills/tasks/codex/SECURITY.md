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
  with "Start it" and "Do not start it". The choice is required. Codex
  0.172's source (`codex-mcp/src/elicitation.rs`) never answers a form with a
  required field in your place, and its reviewer only reviews forms that ask
  for it in their metadata, which this one doesn't. Anything but "Start it"
  sends nothing to the server.
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
- a reviewer's view of that tool.

The plugin does honour Codex's `enabled_tools` and `disabled_tools` for the
server: a tool Codex wouldn't offer isn't started. It reads no other per-tool
rule.

This is the main design judgment in this form. The question is Codex's own
interface, answered only by a person, and it shows more than Codex's approval
of the server's tool would: the server, the tool and every argument. But it is
a question the plugin writes, standing in for one Codex would ask.

## What the plugin does

**Before a start:**

- **A tool Codex wouldn't offer** (`enabled_tools`, `disabled_tools`), or one
  the server doesn't list, isn't started.
- **Arguments that hold a secret from your config aren't sent.** That means a
  header, a token variable, or a local server's environment. In the question
  such a secret would show as `[redacted]`, so you'd approve something you
  couldn't see.
- **Arguments too long to show whole** (over 6000 characters) aren't sent.
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
    "<name>" asks, for task t-…`, with the server's text shown as it is. Hidden
    characters are shown as `⟦n hidden characters⟧`, and control characters
    are removed.
  - A form with no fields becomes a required Accept/Decline choice, because
    Codex accepts an empty form by itself where approvals are automatic.
  - Sampling (your model), roots and URL forms aren't declared to the server
    and aren't answered, and Codex is told so.
  - Each question is put once, and answered once.
- **Results are shown as tool results, marked as the server's.** Text blocks
  have control characters removed and hidden characters shown. Only the MCP
  content types are passed on.
- **Server names are always your config's names,** never what a server calls
  itself. Outside a failed task's result, which shows the server's error
  message as its data, errors are described in the plugin's own words, by code.
- **Secrets from your config are taken out of everything the plugin sends
  Codex,** in questions and answers alike: configured headers, a headers
  helper's output, a local server's environment.
- **It reads Codex's configuration and nothing else of Codex's:** not its
  stored sign-ins, its sessions or its auth file. A server that signs in
  through Codex is left alone.
- **Where your organisation manages Codex's MCP servers,** it connects to none.

**The wake:**

- A wake is handed over only after a turn you started in one of Codex's own
  apps (the terminal UI, the desktop app, `codex exec`), as the call's turn
  metadata says. In an app that runs Codex through an app server of its own,
  the turn might run unseen, so the wake waits for your next turn there.
- `codex queue` is run with no shell, with the plugin's own settings taken out
  of its environment, and only for a session id that is a UUID.

## What is stored

Everything is in `$CODEX_HOME/mcp-tasks/` (or `MCP_TASKS_STATE`), readable only
by you (folders 0700, files 0600):

- **each session's tasks** (`threads/<session id>/tasks.json`):
  - the server, the tool and the arguments you approved;
  - the server's task id, and its last status;
  - its result, up to 1 MB;
  - finished tasks are removed a week after they finish;
- **which process polls a session's tasks** (`owner.pid`);
- **a log,** with secrets taken out.

The server's task id can be a bearer token for the task (the specification
allows that), so treat the folder as you treat your Codex home.

## Full access

`--dangerously-bypass-approvals-and-sandbox` wasn't run. From Codex 0.172's
source (`codex-mcp/src/elicitation.rs`), under the approval policy it sets:

- a form with fields is declined;
- unless Codex's "full-access form input" is on, in which case the form is
  shown to you;
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
