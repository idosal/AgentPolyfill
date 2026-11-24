# Security

"The plugin" below is this Codex plugin: a helper process (`plugin/dist/helper.js`)
that Codex starts as an MCP server for each session, and that holds the Events
client (shared with the Claude Code form, in [`../core`](../core)).

## The model

An event is data from an MCP server you configured, to be handled with "the
same caution as tool results", as the Events extension asks. The plugin does
that in two parts:

- What the server sent (the payload) reaches Codex only as a tool result,
  when Codex reads it with `get_event` or `recent_events`.
- The message that wakes the session is not a tool result. It is put into the
  session with `codex queue`, which is the only way from outside to start a
  turn in Codex, and Codex shows it as an input message. So it carries nothing
  the server wrote: which watch has new events, how many, and their ids, under
  a first line saying it was sent by the mcp-events plugin, not typed by the
  user.

Receiving an event gives Codex no permission it did not already have: what
Codex does about one goes through its own approval policy, sandbox and
reviewer. The plugin adds no policy of its own on top.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle session. In a session that approves actions
without asking (`--ask-for-approval never`, or full access), an event from a
server can lead to actions without a prompt, as a tool result from the same
server could. How often is bounded (below), not prevented. Note too that the
wake arrives as an input message: Codex has no separate channel for a
plugin's messages, so the plugin's own first line, and its instructions to the
model, are what tell it apart from what you typed.

## What the plugin does

- **What a server sent is read as a tool result.** The wake message names the
  server and the event type as you configured and watched them, says how many
  events are new, gives their ids, and repeats the note Codex saved when it
  set the watch. It carries no payload text. `get_event` returns a payload in
  full, and `recent_events` a few short fields of each event (flattened,
  quoted, cut short); both are tool results from that server.
  `MCP_EVENTS_WAKE_VALUES=1` puts those few fields into the wake message; that
  is yours to choose, and it puts text a server wrote into the conversation.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute; a session is woken at most 30 times in an hour. Past that it
  is told once that events are waiting, and is not woken again for an hour,
  or until, sooner, you write to it and Codex then calls one of the plugin's
  tools in that turn. Nothing is dropped. `MCP_EVENTS_WAKE_GAP_S` and
  `MCP_EVENTS_WAKES_PER_HOUR` change the numbers.
  - **How it knows you wrote.** From the turn metadata Codex 0.172 sends with
    each call (`x-codex-turn-metadata.turn_trigger`); it never reads what you
    wrote. Only `user` (typed in Codex), `exec` (`codex exec`) and `realtime`
    or `voice` (voice) count. A turn the queue started (this plugin's own wake
    among them), a hook, an automation, a trigger it does not know, and a call
    with no turn metadata (a Codex before 0.172) do not. So a woken turn
    cannot lift the cap, and on a Codex that sends no turn metadata the pause
    ends only after its hour.
- **A watch belongs to one session.** The session is the one Codex names in
  each call (`_meta.threadId`), which the model cannot set. Only an id in
  Codex's own form (a UUID) is accepted; it names the state folder and is the
  only thing passed to `codex queue` besides the message. Another session sees
  none of its watches or events.
- **`codex queue` is run without a shell**, with the session id, the message
  as one argument, and `--resume`, and with none of the plugin's own settings
  in its environment. What Codex prints is not repeated, only whether it
  worked.
  - **On macOS and Linux** that is the `codex` program found on PATH (or in
    `MCP_EVENTS_CODEX_BIN`), started directly.
  - **On Windows** (not tried) the plugin runs only `codex.exe`, or, for Codex
    installed with npm, Node itself with the package's
    `node_modules\@openai\codex\bin\codex.js`, found beside npm's `codex.cmd`.
    It never runs a `.cmd` or `.bat`, npm's `codex.cmd` included, because
    those go through cmd.exe, which would parse the message a second time.
    `MCP_EVENTS_CODEX_BIN` may name a `codex.exe` or a `codex.js`, nothing
    else. If neither is found, the plugin does not wake the session, and
    `list_watches` and the log say why.
- **Starting and stopping a watch ask first.** `watch_event` and
  `unwatch_event` are not marked read-only, so Codex asks you (or its
  reviewer) before each. The four tools that only read are marked read-only,
  which Codex runs without asking.
- **It connects only where Codex does, and with only what Codex would use.**
  It reads `[mcp_servers.*]` from `$CODEX_HOME/config.toml`; a server with
  `enabled = false` stays off; a server that signs in through Codex (`codex
  mcp login`, `auth = "chatgpt"`, an `oauth` table) is left alone; where an
  organisation manages Codex, it connects to none. That is: on macOS and
  Linux, `/etc/codex/requirements.toml` or `managed_config.toml` naming MCP
  (or unreadable), or on macOS a managed-preferences profile for Codex; on
  Windows, `%ProgramData%\OpenAI\Codex\requirements.toml` naming MCP (or
  unreadable). A Windows policy set only in the registry or by MDM is not
  detected. Credentials come only from the server's own
  configuration: `http_headers`, `env_http_headers` and `bearer_token_env_var`
  (from the variables Codex passes the plugin), and `http_headers_helper`.
  **It never reads Codex's stored credentials** (`auth.json`, OAuth tokens,
  the keychain).
- **Everything else is in the plugin's own words.** A server's or the relay's
  error text is never repeated. Event type and argument names must look like
  names. Tokens from your configuration, webhook secrets and addresses, and
  the relay's keys are removed from every tool result, from the wake messages
  and from the log.
- **It sends `events/*` only to a server that advertised events**, as the
  extension defines (or, by default, in the form from before the standard;
  `MCP_EVENTS_PRE_STANDARD=off` refuses that), checked again after every
  reconnect.
- **Webhooks are verified by the plugin.** Each subscription has its own
  secret, made by the plugin and given only to the MCP server. A delivery is
  taken only if its Standard Webhooks signature verifies, its timestamp is
  recent, and it has not been taken before.
- **The relay holds no signing secret**, so it cannot make an event up, and a
  delivery it alters or replays is refused. It is the same relay as the
  Claude Code form's, with the same client; the public relay is off unless you
  turn it on by name (`MCP_EVENTS_RELAY=public`), and the plugin then says,
  with every such watch, whose server it is.
- **It listens on nothing** unless a webhook watch uses
  `MCP_EVENTS_PUBLIC_URL`, which opens a local receiver on 127.0.0.1 for your
  own forwarder. It downloads nothing.
- **A chat it cannot reach is not tried again.** In the ChatGPT desktop app,
  a watch records events but can't wake the chat: its threads aren't local
  Codex sessions that `codex queue` can reach. Ask for recent events. Waking
  works in the Codex TUI (and `codex exec` resumes). When `codex queue`
  answers that it has no local session for the chat ("no rollout found"), the
  plugin stops trying to wake that chat, so nothing is queued for it over and
  over; its events are still stored, and `list_watches` says why.

## What is stored

In `$CODEX_HOME/mcp-events/` (or `MCP_EVENTS_STATE`), readable only by you:
each session's watches with their cursors and webhook secrets
(`threads/<session id>/`), each session's events (`sessions/<session id>/`,
removed two weeks after the last one), servers found to have no events (for a
day), and a log with secrets taken out.

## What it does not protect against

- A server you configured that sends misleading events: they are its data, and
  Codex may act on them within your approval policy.
- Someone who can read your files: the state folder holds webhook secrets and
  payloads, as your Codex home holds your sessions.
- A relay operator reading webhook payloads (Webhooks are signed, not
  encrypted): with your own relay that is you; with the public relay, the
  person who runs it.

## Reporting a vulnerability

Privately, through this repository's **Security → Report a vulnerability**
form on GitHub, not in a public issue. Name `mcp-events` for Codex.
