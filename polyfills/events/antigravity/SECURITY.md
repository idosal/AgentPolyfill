# Security

This covers `mcp-events` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms share the Events client in [`../core`](../core),
with their own host adapters.

An event is data a server sends: untrusted. Receiving one grants nothing; what
the agent does next goes through Antigravity's own approvals (checked in App
2.35.1).

## What is trusted

- **You:** your answer to the plugin's question before each watch, your
  answers to Antigravity's usual questions for the other tools, and your
  choice to turn the wake sidecar on.
- **Antigravity:** its approvals, its hooks, its sidecars and `agentapi`, and
  its MCP connections.
- **The plugin's state folder**, `~/.gemini/agentpolyfill/mcp-events/`.
  Anything that can write it, or run the plugin's hook as you, can make a
  ticket or a wake request (a ticket made by running the hook command by hand
  is accepted, once). Antigravity's terminal sandbox, on by
  default, keeps the agent's commands to the workspace and temporary folders;
  a command run outside the sandbox (you approved it, Auto mode judged it safe,
  or the sandbox is off, as in Turbo) can reach the folder.
- **Not a server or the model:** neither can bind a watch to another
  conversation, start a turn with its own words, or put its words in a system
  message.

## The boundary

- **Which calls the hook sees.** The six tools are eager
  (`plugin/mcp_config.json`), and the `PreToolUse` matcher takes their eager
  names, `mcp_mcp-events_events_<tool>`, and nothing else. So the hook is
  never handed another server's call. A call of one of the six made through
  `call_mcp_tool` doesn't reach the hook, carries no ticket, and is refused.
  The hook reads the input only to tell which of the six it is and the
  conversation id, and keeps or logs nothing of a call it lets be.
- **Watches ask, every time.** `watch_event` answers `force_ask`: Antigravity
  shows the plugin's question, which starts with the event type and the
  server, then the filters and the note, each whole and quoted. The watch made
  is the watch shown: one whose values hold a control or hidden character, or
  are longer than the question shows, is refused before any question. `force_ask` asks even where your
  rules allow MCP tools. A watch subscribes on that server and can wake the
  conversation later, so it is never only a rule's decision.
- **The other five** (`list_event_types`, `unwatch_event`, `list_watches`,
  `get_event`, `recent_events`) answer `allow` with a ticket. That leaves
  Antigravity's usual MCP question in place (CLI 1.5.17: "Allow calling this
  tool?"), which MCP allow rules skip. The hook never answers
  `auto_approve` and sets no permission overrides.
- **Which conversation.** Antigravity tells hooks the conversation id and an
  MCP server nothing. The hook puts the id, checked as a UUID, in a one-use
  ticket bound to the exact call; the server redeems it and refuses any call
  without one. No conversation is ever guessed.
- **Tickets.** A ticket is a 128-bit nonce that goes only into the call's
  arguments; its file in `tickets/` is named by the nonce's SHA-256, so a
  listing of the folder gives nothing a call could carry. It is good once,
  for one tool and one digest of the arguments, for an hour at most, and the
  plugin's `PreInvocation` and `Stop` hooks remove a conversation's unused
  tickets at its next model call and when its turn ends: a step's tool calls
  have all run before the next model call, so none is waiting then. A
  question declined or never answered therefore leaves its ticket until that
  conversation's next model call (`Stop` alone isn't enough: a decline in the
  CLI interrupts the turn, and closing the CLI runs no `Stop`), or an hour. While
  the hook runs, it replaces any ticket a call carries, so the model can't
  use one; a call that goes around the hook could carry a live one.
- **When the hook can't run.** In CLI 1.5.17 a `PreToolUse` hook that exits
  non-zero, times out or prints something that isn't JSON makes Antigravity
  fail the call. The hook always exits 0 with JSON: `allow` for a
  call that isn't the plugin's or that it can't read, `deny` for the plugin's
  own call when it can't open its state. The `PreInvocation` hook answers
  `{}` when anything goes wrong.
- **The IDE.** Antigravity documents no plugin hooks for the IDE, so a call
  there gets no ticket and is refused; the hook also refuses a call whose
  transcript is the IDE's.
- **Waking.** Only through the sidecar, which is off until you add
  `"mcp-events/wake": {"enabled": true}` under `sidecars` in
  `~/.gemini/config/config.json` (the plugin never edits that file). It runs
  `agentapi send-message <uuid> <fixed text>` with no shell, within the
  shared wake budget, and only for a conversation its hook recorded as the
  App's (a CLI, IDE or unknown one is never sent one). It runs the App's own
  `~/.gemini/antigravity/bin/agentapi` when that is there, else the first
  `agentapi` on its `PATH`, and passes it only `HOME`, `PATH`, the temporary
  folder, the locale, the user and the App's `ANTIGRAVITY_*` variables (which
  hold the App's address and token for `agentapi`); nothing of them is logged
  or stored.
- **What reaches a system message.** The `PreInvocation` hook's step, which
  Antigravity labels "injected by a PreInvocation hook" and hooks.md calls
  "an out-of-band system instruction", holds fixed text, a count and the
  plugin's own watch ids (`w-` and six hex digits), nothing else.
  The wake message is fixed text too. Event type names, notices, the watch's
  note (which the model wrote) and payloads reach the model only through
  `recent_events` and `get_event`, as tool results.

Antigravity's defaults ask before an MCP tool: in the App ("Allow using this
MCP tool?"), in the interactive CLI, which starts in auto mode (CLI 1.5.7 and
later, where available), and headless `agy -p` denies a call nobody answers
(checked in App 2.35.1 and CLI 1.5.17). If you allow MCP tools in your rules, the five tools that
pass with a ticket run without a question; watches still ask. Whether
`--dangerously-skip-permissions` also skips `force_ask` hasn't been checked.

## What the plugin does

### What it reads

- `~/.gemini/config/mcp_config.json` (or the file `MCP_EVENTS_CONFIG` names),
  to connect to your servers. That file can hold header values (API keys).
  The plugin uses each only for its own server, registers it with the shared
  redactor, and never logs or shows it. A file it can't read as JSON is
  reported without quoting it (a parser error can quote a credential).
- Its own folder, `~/.gemini/agentpolyfill/mcp-events/` (0700).

It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in
store. A server that needs Antigravity's own sign-in (`oauth`,
`authProviderType`) is left out, with the reason.

### What it connects to

The servers in your personal `mcp_config.json`, over its own connection to
each (Antigravity gives a plugin no way to use its connections), as the Codex
form does. The first ticketed call of any Events tool, a read-only one
included, starts a second copy of every enabled stdio server in that file,
not only Events servers (`MCP_EVENTS_SERVERS` limits it), and restarts the
conversation's saved watches. Webhook delivery needs a relay you set up, or
the public relay you opt in to by name; see the
[README](README.md#webhooks-and-relays) and the
[relay's security notes](../claude-code/mod/relay/README.md).

### What it writes, and how long it keeps it

Only its own folder in `~/.gemini/agentpolyfill/mcp-events/`:

- events and their payloads, per conversation, until you delete them (at
  most 64 MiB a conversation);
- watches and cursors, until a watch is removed;
- tickets, an hour at most, removed at the next model call or the turn's end;
- wake requests, removed once handled;
- the log, scrubbed, rotated at 2 MiB with one old copy.

The App keeps the sidecar's logs and its record of each `agentapi` call in
`~/.gemini/antigravity/sidecar_data/mcp-events/`. Uninstalling leaves the
plugin's folder and that sidecar data; delete them by hand.

## What it does not protect against

- What a server says in an event. It's shown as data, in a tool result, but
  it's still text the model reads.
- A conversation woken while you're away doing what its watch's note asks,
  through the approvals you've already given.
- Events missed while no Antigravity process runs the watch, from a server
  that keeps no cursor.
- Anything that can write the plugin's state folder, as above.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-events`, the Antigravity form, the
Antigravity surface and version, and the server. Don't include credentials.
