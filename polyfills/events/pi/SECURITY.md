# Security

This covers mcp-events for Pi. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The extension" below means this Pi extension
(`extension/dist/index.js`), which runs inside Pi's own process with Pi's
permissions, as every Pi extension does. It holds the Events client, which
every form shares, in [`../core`](../core).

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". The extension does
that in two parts:

- What the server sent (the payload) reaches Pi only as a tool result, when
  Pi reads it with `get_event` or `recent_events`.
- The message that wakes the session isn't a tool result. It's added to the
  session with `pi.sendMessage` as a message of the extension's own, which Pi
  shows as such, and which the model receives in the user's turn. So it
  carries no event content: it says which watch has new events, how many and
  their ids, names the server and the event type, and repeats the watch's
  note. Its first line says it was sent by the extension, not typed by you.

Receiving an event gives Pi no permission it didn't already have. But Pi's
own documentation is plain about what that means: Pi runs tool calls without
asking for approval, unless a permission extension you installed asks, and
its security comes from limiting what Pi can reach (a container, a VM, a
narrow account). The extension doesn't change that boundary, and adds no
policy on what Pi does with an event.

What it adds is a question before the one step that lets a server set work in
motion while you're away: **each watch needs your yes**, in a Pi dialog that
names the server, the event type, its filters and the note, and says that its
events will start turns by themselves. Filters and note are shown whole, with
any character that shows nothing or changes how text reads (controls,
direction marks, zero-width and tag characters) written out; a watch with more
than the question can show is refused, never shown cut short, and so is one
whose filters or note hold a value your MCP configuration keeps secret, which
the question would have to hide. Where nobody can
be asked (print and JSON modes), no watch is started, and a watch whose tool
call Pi cancels while you're being asked isn't started either.

## What the extension does

- **What a server sent is read as a tool result.** The wake message carries no
  payload text. `get_event` returns a payload in full and `recent_events` a
  few short fields of each event, both marked as data from that server.
  `MCP_EVENTS_WAKE_VALUES=1` puts those few fields into the wake message;
  that's yours to choose, and it puts text a server wrote into the
  conversation.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute, and a session is woken at most 30 times in an hour. Past
  that, it's told once, without a turn being started, that events are
  waiting, and isn't woken again until you write to it. Pi tells the extension
  that you wrote (its `input` event, from the terminal or an RPC client); a
  message an extension sends doesn't count, so a wake can't lift the cap. The
  count is kept on disk, so a restart doesn't reset it, and a second Pi
  process that takes over the session's watches carries on from it. Nothing
  is dropped.
- **A watch belongs to one session**, by Pi's session id, which the model
  can't set. Another session sees none of its watches or events.
- **The tools say what they do.** The four that only read are marked
  read-only (`readOnlyHint`), and `watch_event` and `unwatch_event` aren't,
  so a permission extension can tell them apart.
- **It connects only where Pi does, and with only what Pi's configuration
  holds.** Each server's transport is chosen as Pi chooses it, and an entry
  Pi would reject is left alone, before any value in it is resolved: the
  extension applies Pi 1.6.0's own checks of an entry, and a test holds them
  to Pi's own function.
  - When Pi's MCP support is off for a session (`--no-mcp`,
    `"extensions": ["-builtin:mcp"]` in the settings, or an extension that
    replaces it), Pi reads no `mcp.json` and connects no server, and the
    extension stands down: it reads no configuration, runs no command and
    reaches no server, and its tools say why.
  - It reads the servers Pi reads: `mcp.json` in Pi's agent directory, the
    project's `.pi/mcp.json` only once you trust the project, and the servers
    other extensions register.
  - A server turned off (`enabled: false`) or hidden (`exposure: "hidden"`)
    is left alone.
  - Credentials come only from the server's own configuration: its `headers`
    and `env`, with `${VARIABLE}` and `!command` values resolved as Pi
    resolves them. A `!command` is run through your shell, as Pi
    runs it, and only for a server Pi itself connects. It runs when a
    session starts, once for this extension, as it runs for Pi and for any
    other extension that reads the same entry.
  - A server that signs in through Pi (`/mcp`, `pi mcp login`, an `oauth`
    setting, `auth.provider`) is left alone. **It never reads Pi's stored
    credentials** (`mcp-auth.json`, `auth.json`).
- **Everything else is in the extension's own words.** A server's or the
  relay's error text is never repeated. Event type and argument names must
  look like names. Tokens from your configuration, webhook secrets and
  addresses, and the relay's keys are removed from every tool result, from
  the wake messages and from the log.
- **It sends `events/*` only to a server that advertised events**, as the
  extension defines, on protocol revision 2026-07-28 or later. By default it
  also accepts the form from before the standard, and
  `MCP_EVENTS_PRE_STANDARD=off` refuses that.
- **Webhooks are verified by the extension**: each subscription has its own
  secret, made here and given only to the MCP server; a delivery is taken only
  if its Standard Webhooks signature verifies, its timestamp is recent, and it
  hasn't been taken before. The relay holds no signing secret, so it can't
  make an event up. The public relay is off unless you turn it on by name.
- **It listens on nothing**, unless a webhook watch uses
  `MCP_EVENTS_PUBLIC_URL`, which opens a local receiver on 127.0.0.1 for your
  own forwarder. It downloads nothing.

## What is stored

Everything is in `mcp-events/` in Pi's agent directory (or
`MCP_EVENTS_STATE`), readable only by you:

- each session's watches, with their cursors and webhook secrets
  (`watches/<session id>/`);
- each session's events (`sessions/<session id>/`), removed two weeks after
  the last one;
- the servers found to have no events, for a day;
- a log, with secrets taken out.

## What it does not protect against

- **A server you configured that sends misleading events.** They are its
  data, and Pi may act on them, as on any tool result.
- **Anything Pi itself may do.** Pi runs tool calls without asking unless you
  installed something that asks. Run Pi where what it can reach is limited.
- **Other extensions.** They run in the same process with the same
  permissions, as Pi documents.
- **Someone who can read your files.** The state folder holds webhook secrets
  and payloads, as Pi's agent directory holds your sessions.
- **A relay operator reading webhook payloads.** Webhooks are signed, not
  encrypted.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-events` for
Pi.
