# Live runs of mcp-events in Muse Code

Recorded on 25 November 2026 with the real Muse Code 1.4.25 binary from the
Homebrew cask `muse-code` (sha256 checked against the cask, Meta's signature
verified), on macOS.

**How every run was set up:**
- **Model.** No run used a real model, and there was no `muse login`. Each used
  Muse's `--provider echo`, or a stand-in for the Responses API on 127.0.0.1
  (`--provider meta --base-url … --api-key-stdin`, with a made-up key). The
  stand-in also answered Muse's approval judge: it approved, or escalated to the
  person.
- **Isolation.** Each ran with `env -i`, and with `HOME`, the XDG folders and
  `TMPDIR` in a scratch folder.
- **Install.** From this branch's worktree, as a local marketplace
  (`muse plugins marketplace add agent-polyfill <the worktree's folder>`).
  Adding the marketplace by its GitHub URL was checked too: Muse fetched it
  with Git and listed the four plugins, but `main` had no Muse manifests yet.
  So an install from GitHub, as the README gives it, can only be checked once
  this is merged. Then:
  ```
  muse plugins install mcp-events@agent-polyfill
  muse plugins approve mcp-events
  ```
- **The events server.** The Claude Code form's hand-written one
  (`test/fixture-events-server.ts`), added with `muse mcp add-json tickets …
  --user`.

## A watch, typed yes, and the next message

One session, three `muse exec` runs with the same `--session-id`.

1. **"watch new tickets on tickets".** The model calls `watch_event`. Muse's
   judge sees the call (the stand-in approves it), and the answer starts
   nothing:

   ```text
   The watch is not started yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:

   mcp-events: start a watch?
   Muse wants to watch "ticket.created" on the MCP server "tickets".
   When it fires: "tell me about new tickets"

   Its events will come with the messages you send in this session while it runs. You can stop it at any time by asking Muse to stop the watch.

   To start it, they send a message that is exactly: watch 4538
   ```

2. **"watch 4538".** The hook records the yes, and the model is given:

   ```text
   [mcp-events] The user's own message is the confirmation watch_event asked for: they approve "mcp-events: start a watch?". Call watch_event again with the same arguments to start it.
   ```

   The model calls `watch_event` again: `Watching tickets / ticket.created as
   w-a43263, by push, from now on.` A ticket created at the server during that
   turn was stored.

   **Since this run, the phrase also names the server and the event type**
   (`watch tickets ticket.created 4538`, not `watch 4538`), and stopping a watch
   waits for its own phrase (`unwatch tickets ticket.created <code>`). Neither
   was run live again. The tests run the bundled hook with Muse's hook input and
   check both. Muse hands the hook the message as it was typed, spaces
   included, as the runs below show.

3. **"anything new?".** The model is given, as a developer-role context block
   from the hook:

   ```text
   [mcp-events] (Sent by the mcp-events plugin, not typed by the user.)
   [mcp-events] tickets · ticket.created: 1 new event [event e1; watch w-a43263; get_event e1 returns it]. Note saved with this watch: "tell me about new tickets".
   ```

4. **The server turned off.** `muse plugins reject mcp-events:mcp_server:mcp-events`,
   with a batch planted in the session's inbox. On the next message the model
   got nothing from the plugin, and the batch was left untouched.

## The echo provider

In a session made with `--provider echo`, an event stored by one run, after
its helper ended, reached the next run's prompt. Muse recorded it as a
`context_block_updated` from `runtime_hook`, with the `[mcp-events]` lines.

## Waking an idle session (experimental)

- **Setup.** `{"MCP_EVENTS_MUSE_WAKE": "attach"}` in the plugin's settings
  file. A session with a watch, resumed in the terminal with
  `MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1
  muse --provider echo resume <session>`, which `muse sessions --json` listed as
  `attachable: true`.
- **What happened.** An event created while the session was idle started a turn
  in it. The terminal showed the `[mcp-events]` message, and the echo model
  answered it. That turn ran the `UserPromptSubmit` hook too, which handed over
  a batch left from an earlier failed attach.
- **A finding on the way.** Muse's session protocol refuses a client name that
  isn't `[a-z0-9_]+` (the plugin names itself `mcp_events`).
- **What didn't attach.** A session started with `--provider meta --base-url …`
  was not attachable ("held by a TUI or an older muse, which has no attach
  endpoint"), with both gates on. A session signed in to Meta was not tried.

## What can send the phrase

The typed yes holds only if nothing but the person's own message runs the
plugin's `UserPromptSubmit` hook. Muse's hook input doesn't say where a prompt
came from (it has `cwd`, `hook_event_name`, `model`, `model_provider`,
`permission_mode`, `prompt`, `session_id`, `transcript_path` and `turn_id`).
So each way a model can put its own text into a session was tried, in a
terminal session with a probe plugin whose `UserPromptSubmit` hook logged
every input. A stand-in model made each call with a text containing
`load 1234`.

| How the text came in | Did the hook run? | What the model was given |
|---|---|---|
| A message you typed | yes | your message, as a user message |
| `muse.cron_create` (a scheduled prompt) | no | (checked earlier) |
| `muse.monitor`, a line of its command's output | no | a developer message, "SYSTEM NOTIFICATION - NOT USER INPUT …" |
| `muse.subagent_spawn`: the child's task | no | the child's first message, `Role: … / Objective: …` |
| `muse.subagent_spawn`: the child's result, back in the parent | no | a developer message, `<runtime-context source="subagent_result">` |
| `muse.subagent_send_message`, from the parent to a busy child | no | a developer message, `<runtime-context source="subagent_input">` |
| `muse.send_session_message` to the session itself | no | refused by Muse (`self_send_wrong_path`) |
| `muse.send_session_message` from a second terminal session | no | a developer message, `<runtime-context source="session_message" origin="peer_agent">`, marked as unable to grant consent |
| `muse.create_goal`: Muse's turn to go on with the goal | no | a user message, "Continue working toward the active session goal …", quoting the objective |
| `muse.workflow`: an agent's input, and the workflow's end | no | the agent's first message; then a developer message and a `<workflow-launch-reconciled>` message |

`muse exec` doesn't offer `send_session_message`. With Muse's two
experimental session-protocol gates on, a turn started through
`muse attach` does run the hook, as for a message you typed. That is the
warning under "Waking an idle session".

## Remove

`muse plugins remove mcp-events --delete-data`, then
`muse plugins marketplace remove agent-polyfill`, left no data folder, cache
entry, approval or marketplace snapshot of the plugin.
