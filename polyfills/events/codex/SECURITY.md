# Security

This covers mcp-events for Codex. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Pi](../pi/SECURITY.md), [OpenCode](../opencode/SECURITY.md).

"The plugin" below means this Codex plugin: a helper process
(`plugin/dist/helper.js`) that Codex starts as an MCP server for each session.
It holds the Events client, which both forms share, in [`../core`](../core).

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". The plugin does
that in two parts:

- What the server sent (the payload) reaches Codex only as a tool result,
  when Codex reads it with `get_event` or `recent_events`.
- The message that wakes the session isn't a tool result. It's put into the
  session with `codex queue`, which is the only way from outside to start a
  turn in Codex, and Codex shows it as an input message. So it carries no
  event content: it says which watch has new events, how many and their ids,
  names the server and the event type, and repeats the watch's note.
  Its first line says it was sent by the mcp-events plugin, not typed by the
  user.

Receiving an event gives Codex no permission it didn't already have. What
Codex does about one goes through its own approval policy, sandbox and
reviewer. The plugin adds no policy of its own on top.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle session. In a session that approves actions
without asking (`--ask-for-approval never`, or full access), an event from a
server can lead to actions without a prompt, as a tool result from the same
server could. How often is bounded (below), not prevented.

Note too that the wake arrives as an input message. Codex has no separate
channel for a plugin's messages. So the plugin's own first line, and its
instructions to the model, are what tell it apart from what you typed.

## What the plugin does

- **What a server sent is read as a tool result.** The wake message names the
  server and the event type as you configured and watched them. It says how
  many events are new, gives their ids, and repeats the note Codex saved when
  it set the watch. It carries no payload text.
  - `get_event` returns a payload in full, and `recent_events` a few short
    fields of each event (flattened, quoted, cut short). Both are tool results
    from that server.
  - `MCP_EVENTS_WAKE_VALUES=1` puts those few fields into the wake message.
    That's yours to choose, and it puts text a server wrote into the
    conversation.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. A session is woken at most 30 times in an hour. Past that,
  it's told once that events are waiting. It isn't woken again for an hour,
  or until, sooner, you write to it and Codex then calls one of the plugin's
  tools in that turn. Nothing is dropped. `MCP_EVENTS_WAKE_GAP_S` and
  `MCP_EVENTS_WAKES_PER_HOUR` change the numbers.
  - **Across restarts.** The count is kept on disk. Each wake is recorded
    before `codex queue` runs. So a wake the plugin never heard back about,
    because it stopped or `codex queue` didn't answer, still counts, and its
    events aren't handed over again. That holds with the same session open in
    two windows too: only the window that runs the watches writes the count,
    and a window that takes them over reads it again first.
  - **How it knows you wrote.** From the turn metadata Codex 0.172 sends with
    each call (`x-codex-turn-metadata.turn_trigger`). It never reads what you
    wrote.
  - Only these count: `user` (typed in the TUI), `composer` (sent in the
    ChatGPT desktop app), `exec` (`codex exec`) and `realtime` (voice). Each is
    where Codex 0.172's source sets it, except `composer`. That one is the
    desktop app's default. Not checked with this version.
  - These don't count: a turn the queue started (this plugin's own wake among
    them), a hook, an automation, a trigger it doesn't know, and a call with no
    turn metadata (a Codex before 0.172).
  - So a woken turn can't lift the cap. On a Codex that sends no turn
    metadata, the pause ends only after its hour.
- **A watch belongs to one session.** The session is the one Codex names in
  each call (`_meta.threadId`), which the model can't set. Only an id in
  Codex's own form (a UUID) is accepted. It names the state folder, and it's
  the only thing passed to `codex queue` besides the message. Another session
  sees none of its watches or events.
- **`codex queue` is run without a shell**, with the session id, the message
  as one argument, and `--resume`. None of the plugin's own settings are in
  its environment. What Codex prints isn't repeated, only whether it worked.
  - **On macOS and Linux** that is the `codex` program found on PATH (or in
    `MCP_EVENTS_CODEX_BIN`), started directly.
  - **On Windows** (not checked) the plugin runs only `codex.exe` or, for Codex
    installed with npm, Node itself with the package's
    `node_modules\@openai\codex\bin\codex.js`, found beside npm's `codex.cmd`.
    It never runs a `.cmd` or `.bat`, npm's `codex.cmd` included, because
    those go through cmd.exe, which would parse the message a second time.
    `MCP_EVENTS_CODEX_BIN` may name a `codex.exe` or a `codex.js`, nothing
    else. If neither is found, the plugin doesn't wake the session, and
    `list_watches` and the log say why.
- **Starting and stopping a watch ask first.** `watch_event` and
  `unwatch_event` aren't marked read-only, so Codex asks you (or its reviewer)
  before each. The four tools that only read are marked read-only, and Codex
  runs those without asking.
- **It connects only where Codex does, and with only what Codex would use.**
  - It reads `[mcp_servers.*]` from `$CODEX_HOME/config.toml`.
  - A server with `enabled = false` stays off.
  - A server that signs in through Codex (`codex mcp login`,
    `auth = "chatgpt"`, an `oauth` table) is left alone.
  - Where an organisation manages Codex, it connects to none. On macOS and
    Linux, that means `/etc/codex/requirements.toml` or `managed_config.toml`
    naming MCP (or unreadable), or, on macOS, a managed-preferences profile for
    Codex. On Windows, it means `%ProgramData%\OpenAI\Codex\requirements.toml`
    naming MCP (or unreadable). A Windows policy set only in the registry or
    by MDM isn't detected.
  - Credentials come only from the server's own configuration:
    `http_headers`, `env_http_headers` and `bearer_token_env_var` (from the
    variables Codex passes the plugin), and `http_headers_helper`.
  - **It never reads Codex's stored credentials** (`auth.json`, OAuth tokens,
    the keychain).
- **Everything else is in the plugin's own words.** A server's or the relay's
  error text is never repeated. Event type and argument names must look like
  names. Tokens from your configuration, webhook secrets and addresses, and
  the relay's keys are removed from every tool result, from the wake messages
  and from the log.
- **It sends `events/*` only to a server that advertised events**, as the
  extension defines. By default it also accepts the form from before the
  standard, and `MCP_EVENTS_PRE_STANDARD=off` refuses that. Either way it's
  checked again after every reconnect.
- **Webhooks are verified by the plugin.** Each subscription has its own
  secret, made by the plugin and given only to the MCP server. A delivery is
  taken only if its Standard Webhooks signature verifies, its timestamp is
  recent, and it hasn't been taken before.
- **The relay holds no signing secret.** So it can't make an event up, and a
  delivery it alters or replays is refused. Both forms use the same relay,
  with the same client. The public relay is off unless you turn it on by name
  (`MCP_EVENTS_RELAY=public`). The plugin then says, with every such watch,
  whose server it is. A delivery from the public relay is refused if it was
  signed more than 25 hours ago, whatever the relay says about when it
  arrived (eight days from a relay of your own). A relay that sends a frame
  larger than any delivery can be loses the connection.
- **It listens on nothing**, unless a webhook watch uses
  `MCP_EVENTS_PUBLIC_URL`. That opens a local receiver on 127.0.0.1 for your
  own forwarder. It downloads nothing.
- **A wake runs only where Codex's own app shows it.** `codex queue` runs the
  wake in whichever app server has the session open. An app that runs Codex
  through an app server of its own, as T3 Code does, may not show that turn.
  In a session with full access, actions could then run that nobody sees in
  the app.
  - So the plugin wakes a session only while the latest of the session's turns
    that called its tools was one you started in Codex's own app. It tells
    from that turn's `turn_trigger`, the same allowlist as above.
  - Any other call stops the wakes, so a trigger the plugin doesn't know
    fails closed. That covers a turn that names no trigger, as from another
    app's app server (T3 Code sets none) or a Codex before 0.172. It also
    covers a goal, an automation, a review, or an app's own name for its
    turns. Only a turn the queue started, which Codex marks `queue` in any app
    server, changes nothing.
  - The latest call's answer is kept in `threads/<session id>/shown-by.json`
    (readable only by you), so it holds for a helper that starts later and
    for the window that runs the watches.
  - In T3 Code, [mcp-events for T3 Code](../t3/SECURITY.md) wakes a thread
    through T3 Code itself instead.
  - Events are still stored, nothing is handed over and no wake is counted,
    and `list_watches` and `watch_event` say why.
- **A chat it can't reach isn't tried again.** In the ChatGPT desktop app, a
  watch records events but can't wake the chat: its threads aren't local
  Codex sessions that `codex queue` can reach. Ask for recent events. Waking
  works in the Codex TUI (and `codex exec` resumes). When `codex queue`
  answers that it has no local session for the chat ("no rollout found"), the
  plugin stops trying to wake that chat, so nothing is queued for it over and
  over. Its events are still stored, and `list_watches` says why.

## What is stored

Everything is in `$CODEX_HOME/mcp-events/` (or `MCP_EVENTS_STATE`), readable
only by you:

- each session's watches, with their cursors and webhook secrets, and
  whether its latest call came from Codex's own app (`threads/<session id>/`);
- each session's events (`sessions/<session id>/`), removed two weeks after
  the last one;
- the servers found to have no events, for a day;
- a log, with secrets taken out.

## What it does not protect against

- **A server you configured that sends misleading events.** They are its
  data, and Codex may act on them within your approval policy.
- **An app that marks its turns as Codex's own do.** `turnTrigger` is set by
  the app that starts the turn. An app that runs Codex itself and sets it to
  `user` is taken for the TUI, and a wake there runs as `codex queue` makes it
  run, shown or not.
- **Someone who can read your files.** The state folder holds webhook secrets
  and payloads, as your Codex home holds your sessions.
- **A relay operator reading webhook payloads.** Webhooks are signed, not
  encrypted. With your own relay, that operator is you. With the public relay,
  it's the person who runs it.
- **A relay delaying or dropping events.** A relay can hold a delivery back
  (within the bound above) or never hand it over. It can't make one up.
- **Abuse of the public relay.** Its limits and what they don't stop are in
  [the relay's README](../claude-code/mod/relay/README.md#a-relay-anyone-may-use).
  Requests anyone sends it count against its operator's Cloudflare quotas and
  bill, and its operator may switch it off.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-events` for
Codex.
