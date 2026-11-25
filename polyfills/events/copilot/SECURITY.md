# Security

This covers mcp-events for GitHub Copilot CLI. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md),
[Pi](../pi/SECURITY.md).

"The plugin" below means this Copilot plugin: an extension
(`plugin/extensions/mcp-events/extension.mjs`) that Copilot starts as a child
process for the session in the foreground. It holds the Events client, which
all forms share, in [`../core`](../core).

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". The plugin does
that in two parts:

- What the server sent (the payload) reaches Copilot only as a tool result,
  when Copilot reads it with `get_event` or `recent_events`.
- The message that wakes the session isn't a tool result. It goes in with
  `session.send` as an automation turn (`source: "automation-mcp-events"`),
  which Copilot's SDK defines as defining the session's task "like a user
  message but carries no human authority". It carries no event content: it
  says which watch has new events, how many and their ids, names the server
  and the event type, and repeats the watch's note. Its first line says it was
  sent by the mcp-events plugin, not typed by the user.

Receiving an event gives Copilot no permission it didn't already have. What
Copilot does about one goes through its own tool prompts and permission mode.
The plugin adds no policy of its own on top.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle session. In a session that allows tools
without asking (`--allow-all-tools`, `--yolo`, autopilot), an event from a
server can lead to actions without a prompt, as a tool result from the same
server could. How often is bounded (below), not prevented.

## What Copilot asks you

- **Once, before the extension loads:** whether it may "skip tool permission
  prompts, register hooks". Copilot asks this of any extension that wants
  either. Denying keeps the extension from loading.
  - "Skip tool permission prompts" applies to the four tools that only read
    (`list_event_types`, `list_watches`, `get_event`, `recent_events`), so a
    session woken while you're away can read what came without stopping at a
    prompt.
  - "Register hooks" is one hook, `onSessionStart`, which gives the session
    the plugin's instructions. It changes nothing you type.
- **Before each `watch_event` and `unwatch_event`,** Copilot's tool prompt, as
  for any tool that changes something. Copilot's permission rules apply to
  them as to any tool: the plugin doesn't skip that prompt for either.
- **Then, before each watch, the plugin's own question,** in a Copilot dialog
  (`session.ui.select`): the server, the event type, the filters and the note,
  shown whole (a character that shows as nothing is written out as `\u{…}`),
  and that the watch's events will start turns while you're away, at most as
  often as the wake limits allow. **Don't watch it** comes first, and only
  **Watch it** starts the watch. A watch whose filters or note are too long
  to show in full, or hold a value your configuration keeps secret, is refused
  before you're asked. Where Copilot can't ask anyone (`copilot -p`, say), no
  watch starts.
  - Why a second question: Copilot's prompt isn't always a person. In
    assisted mode, which an organisation can make the default, an LLM review
    approves the calls it judges safe, and allow-all approves everything. A
    watch hands a server a way to start turns, so the person says yes to it.
  - `MCP_EVENTS_ASK_BY_DEFAULT=0` turns the plugin's question off. Copilot's
    permission rules alone then decide, and in a session that allows tools
    without asking, a watch starts without a question.

The plugin asks for no environment variables (`requestedEnvironmentVariables`),
so Copilot's stripping of sensitive variables from extensions holds.

## What the plugin does

- **What a server sent is read as a tool result.** The wake message carries
  no payload text. `get_event` returns a payload in full, and `recent_events`
  a few short fields of each event (flattened, quoted, cut short). Both are
  tool results from that server. `MCP_EVENTS_WAKE_VALUES=1` puts those few
  fields into the wake message: that's yours to choose, and it puts text a
  server wrote into the conversation.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. A session is woken at most 30 times in an hour. Past that,
  it's told once that events are waiting, and isn't woken again until you send
  a message. Nothing is dropped.
  - **How it knows you wrote.** From the session's `user.message` events: one
    with no source (or `user`), from the main agent, is yours. The plugin's
    own wakes carry `automation-mcp-events`, and messages from skills,
    sub-agents, other automations and the system carry their own sources, so
    none of them lifts the pause. It never reads what you wrote beyond that.
  - **Across restarts.** The count is kept on disk, and each wake is recorded
    before `session.send` runs. A wake the plugin never heard back about still
    counts, and its events aren't handed over again (the same code as the Codex
    form, model-checked there).
- **A watch belongs to one session,** the one Copilot started the extension
  for (`SESSION_ID`, a UUID, which the model can't set). It names the state
  folder. Another session sees none of its watches or events.
- **It connects only where Copilot does, and with only what Copilot would
  use.**
  - It uses only the servers Copilot lists as enabled for the session
    (`session.rpc.mcp.listConfigured`), which already reflects folder trust,
    `disabledMcpServers` and your organisation's policy. When Copilot can't
    say, it connects to none: it doesn't guess at trust or policy.
  - Each server is read from the source Copilot names for it. A server
    Copilot has from your `mcp-config.json` is never taken from a project's
    file of the same name, and project files are read only when Copilot uses
    a server from one (it reads them only in a trusted folder). So a
    repository you clone can't put its own command under your server's name.
  - A server Copilot stops using during the session is let go: its watches
    stop, their webhook subscriptions are ended on the server (lasting ones
    too), nothing more from it is stored (not even a delivery or an answer
    already on its way), and its connection closes. Before a resumed
    session's saved watches start, the extension asks Copilot afresh.
  - **A second copy of each local server.** The extension connects to each
    server itself, beside Copilot's own connection. It does so at the first
    call of any of its tools, `list_event_types` included, which runs with no
    prompt, so a local (stdio) server Copilot enables for the session is
    started a second time then, with the command, arguments and environment
    in its entry, as Copilot starts it.
  - Credentials come only from the server's own entry (`headers`, with
    `$VAR`, `${VAR}` and `${VAR:-default}` expanded from the extension's
    environment, as Copilot does). Every value a variable or a default put in
    is removed from the log and from tool results, wherever it landed (a URL's
    path, an argument), except values shorter than eight characters. A
    `${VAR}` the extension can't fill leaves that server out, and so does a
    default that holds another variable.
  - A server that signs in through Copilot is left alone.
  - **It never reads Copilot's stored credentials** (the keychain,
    `~/.copilot/mcp-oauth-config/`, signed-in accounts in `config.json`).
- **Nothing goes to stdout.** That's the extension's JSON-RPC channel to
  Copilot. The plugin logs to its own file, and sends anything a bundled
  library prints with `console.log`, `info`, `debug` or `trace` (which Node
  writes to stdout) to that file too. An error nobody caught is logged, the
  watches are stopped within a bound, and the process ends: its state, and
  its channel to Copilot, can't be trusted after that. Events are on disk
  before they are acknowledged, and pick up from their cursors next time.
- **An event type's name reaches the wake only if it reads as a name**
  (`ticket.created`): it's the server's text, and the wake starts a turn. Any
  other is left out of the wake and the notices; `list_watches` gives it, as a
  tool result. (This is in the shared client, so every form has it.)
- **A configuration file that isn't valid JSON** is logged as such, never with
  the parser's message, which quotes the text around the error.
- **Everything else is in the plugin's own words.** A server's or the relay's
  error text is never repeated. Tokens from your configuration, webhook
  secrets and addresses, and the relay's keys are removed from every tool
  result, from the wake messages and from the log.
- **It sends `events/*` only to a server that advertised events,** as the
  extension defines. By default it also accepts the form from before the
  standard, and `MCP_EVENTS_PRE_STANDARD=off` refuses that.
- **Webhooks are verified by the plugin,** with a secret per subscription that
  only the MCP server is given. The relay holds no signing secret, so it can't
  make an event up. This, and the public relay's terms, are as in the
  [Codex form](../codex/SECURITY.md#what-the-plugin-does).
- **It listens on nothing**, unless a webhook watch uses
  `MCP_EVENTS_PUBLIC_URL` (a local receiver on 127.0.0.1 for your own
  forwarder). It downloads nothing.

## What is stored

Everything is in `$COPILOT_HOME/mcp-events/` (`~/.copilot/mcp-events/`, or
`MCP_EVENTS_STATE`), readable only by you:

- each session's watches, with their cursors and webhook secrets
  (`threads/<session id>/`);
- each session's events (`sessions/<session id>/`), removed two weeks after
  the last one;
- the servers found to have no events, for a day;
- a log, with secrets taken out.

## What it does not protect against

- **A server you configured that sends misleading events.** They are its
  data, and Copilot may act on them within your permission mode.
- **Someone who can read your files.** The state folder holds webhook secrets
  and payloads, as Copilot's home holds your sessions.
- **A relay operator reading webhook payloads**, or a relay delaying or
  dropping deliveries. See the [Codex form](../codex/SECURITY.md#what-it-does-not-protect-against).

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-events` for
Copilot.
