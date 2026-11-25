# Security

This covers `mcp-events` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms share the Events client in [`../core`](../core),
with their own host adapters.

An event is data a server sends: untrusted, handled the way Antigravity
handles a tool result. Receiving one grants nothing; what the agent does next
goes through Antigravity's own approvals (seen live: after a wake, the agent's
calls to read the event and the server's log each asked).

## What is trusted

- **You:** your approval of each watch, in Antigravity's usual approval for MCP
  tools, and your choice to turn the wake sidecar on.
- **Antigravity:** its approvals, its hooks, its sidecars and `agentapi`, and
  its MCP connections.
- **Not a server or the model:** neither can bind a watch to another
  conversation, start a turn with its own words, or reach a conversation
  through the sidecar other than with a fixed message.

## The boundary

- **Approvals.** Every Events tool goes through Antigravity's usual approval
  for MCP tools ("Allow using this MCP tool?"). The plugin's `PreToolUse` hook
  answers `allow` with a ticket, which leaves that approval in place; it
  never answers `auto_approve` and sets no permission overrides.
- **Which conversation.** Antigravity tells hooks the conversation id and an
  MCP server nothing. The hook puts the id, checked as a UUID, in a one-use
  ticket bound to the exact call; the server redeems it and refuses any call
  without one. No conversation is ever guessed.
- **Waking.** Only through the sidecar, which is off until you add
  `"mcp-events/wake": {"enabled": true}` under `sidecars` in
  `~/.gemini/config/config.json` (the plugin never edits that file). It runs
  `agentapi send-message <uuid> <fixed text>` with no shell, only for App
  conversations (a CLI or IDE conversation is never sent one), within the
  shared wake budget. The message says new events are waiting; it carries no
  server data. The batch itself reaches the model through the plugin's
  `PreInvocation` hook, which Antigravity labels as injected by a hook, and
  which marks the summaries as data from the named server, not instructions.
  Payloads go only through `get_event` and `recent_events`.

Antigravity's defaults ask: in the App an MCP tool call shows "Allow using
this MCP tool?", and the CLI's default permission mode (`request-review`)
asks too; a headless `agy -p` call nobody can answer is denied (both seen
live, App v2.35.1, CLI v1.5.16). If you allow MCP tools in your rules or use
Auto mode, the calls the hook only ties to a conversation run without a
question; the steps that change something or send something away still ask,
through `force_ask`. Whether `--dangerously-skip-permissions` also skips
`force_ask` hasn't been checked.

Hooks fail open in Antigravity (a non-zero exit is ignored): the hooks always
exit 0; the `PreToolUse` one answers `deny` when anything goes wrong, the
`PreInvocation` one `{}`.

## What the plugin does

### What it reads

- `~/.gemini/config/mcp_config.json`, to connect to your servers. That file can
  hold header values (API keys). The plugin uses each only for its own server,
  registers it with the shared redactor, and never logs or shows it. A file it
  can't read as JSON is reported without quoting it (a parser error can quote
  a credential).
- Its own folder, `~/.gemini/agentpolyfill/mcp-events/` (0700): settings,
  watches, the event store, tickets, wake requests and the log.

It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in
store. A server that needs Antigravity's own sign-in (`oauth`,
`authProviderType`) is left out, with the reason.

### What it connects to

The servers in your personal `mcp_config.json`, over its own connection to
each (Antigravity gives a plugin no way to use its connections), as the Codex
form does. Webhook delivery needs a relay you set up, or the public relay you
opt in to by name; see the [README](README.md#webhooks-and-relays) and the
[relay's security notes](../claude-code/mod/relay/README.md).

### What it writes

Only its own folder in `~/.gemini/agentpolyfill/`. The App keeps the
sidecar's logs and its record of each `agentapi` call in
`~/.gemini/antigravity/sidecar_data/mcp-events/`.

## What it does not protect against

- What a server says in an event. It's shown as data, but it's still text the
  model reads.
- A conversation woken while you're away doing what its watch's note asks,
  through the approvals you've already given.
- Events missed while no Antigravity process runs the watch, from a server
  that keeps no cursor.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-events`, the Antigravity form, the
Antigravity surface and version, and the server. Don't include credentials.
