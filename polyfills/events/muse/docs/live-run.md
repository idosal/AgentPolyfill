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
- **Install.** From this repository as a marketplace:
  ```
  muse plugins marketplace add agent-polyfill <the repository>
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

## Remove

`muse plugins remove mcp-events --delete-data`, then
`muse plugins marketplace remove agent-polyfill`, left no data folder, cache
entry, approval or marketplace snapshot of the plugin.
