# Security

This covers mcp-events for OpenCode. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The plugin" below means this OpenCode plugin: one bundled file
(`plugin/server.js`) that OpenCode loads into its own server. It holds the
Events client, which every form shares, in [`../core`](../core).

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". The plugin does
that in two parts:

- What the server sent (the payload) reaches the model only as a tool result,
  when it reads it with `mcp_events_get_event` or `mcp_events_recent_events`.
- The message that wakes the session isn't a tool result. The plugin puts it
  into the session with `ctx.session.synthetic`. OpenCode stores it as
  synthetic, not as yours, but sends it to the model in the user's role. So it
  carries no event content: it names the server, the event type and the
  watch, says how many events are new and gives their ids, and repeats the
  watch's note. Its first line says it was sent by the mcp-events plugin, not
  typed by you.

Receiving an event gives OpenCode no permission it didn't already have. What
it does about one goes through OpenCode's permission rules, as for any turn.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle session. Under OpenCode's shipped default,
which allows every action, an event from a server can lead to actions without
a prompt, as a tool result from the same server could. How often is bounded
(below), not prevented.

## What the plugin does

- **Watches go through OpenCode's rules.** Starting a watch is the action
  `mcp_events_watch`, stopping one `mcp_events_unwatch`, each on
  `<server>:<event type>`, asked with `ctx.permission.assert`. OpenCode
  decides: a `deny` rule refuses, an `ask` rule prompts you, and the plugin
  never answers a prompt.
- **They're asked about by default.** OpenCode's shipped default allows every
  action. For these two actions only, the plugin's `evaluate` hook turns that
  `allow` into `ask`, unless you chose "Allow always" for that server and
  event type in this project, or set `askByDefault` to `false`. It never turns
  anything into `allow`, and a configured `deny` is settled before it runs.
  With nobody there to answer, OpenCode refuses the question. "Allow always"
  is kept by the plugin, from OpenCode's own permission events, only for a
  request of its own and only as the patterns that request offered to save.
- **What a watch says is plain text.** A watch's note and `arguments` are the
  model's text, repeated with every event or sent to the server. One holding
  a control or hidden character, or a note over 500 characters or `arguments`
  over 2,000, is refused before anyone is asked. The names in a request are shown
  with anything but printable ASCII escaped, so a server's event name can't
  read as another. "Allow always" saves a rule only when both names are plain:
  an event type a server named `*` or `?`, a wildcard in OpenCode's rules,
  would otherwise save a rule covering every event type of that server.
- **What a server sent is read as a tool result.** `mcp_events_get_event`
  returns a payload in full, marked as that server's data;
  `mcp_events_recent_events` a few short fields of each event. With
  `MCP_EVENTS_WAKE_VALUES=1`, those few fields go into the wake message too:
  that's yours to choose, and it puts text a server wrote into the
  conversation.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. A session is woken at most 30 times in an hour. Past that,
  it's told once that events are waiting, and it isn't woken again until you
  write to it (OpenCode's `prompt` hook, which a synthetic message doesn't
  run). Nothing is dropped. The count is kept on disk, and each wake is
  recorded before it's handed to OpenCode, so a restart doesn't reset it.
- **Webhooks are verified.** Only deliveries signed with the watch's secret
  are taken, and only from a subscription on a connection that carries your
  credentials, as in the other forms.
- **Push beside OpenCode's automations.** An event type offered by push is
  watched by push, on the plugin's own connection. OpenCode's automations, and
  OpenCode Console's `console_watch` tools for a signed-in workspace, can take
  events too. The plugin tells the model to use one or the other for an event
  type, and nothing more: it can't see an automation, so with both set up an
  event wakes the session twice. Each wake still counts toward the limits
  above, and what follows still goes through OpenCode's rules.
- **No sign-in of its own.** The plugin connects with what your OpenCode
  configuration holds (a command, a URL, headers). It never reads OpenCode's
  stored credentials, OAuth tokens included, though OpenCode's plugin API
  could hand it an integration's credential: a server you signed in to with
  `opencode mcp auth` isn't used. Values OpenCode would fill in from a
  variable or a file, left unfilled, are never sent.
- **Secrets stay out of what it says.** Header values, environment values and
  URL credentials from your configuration are taken out of every answer and
  every log line.

## What is stored

Everything is in `~/.local/share/opencode/mcp-events/`
(`$XDG_DATA_HOME/opencode/mcp-events`, or `MCP_EVENTS_STATE`), readable only by
you:

- each session's watches, with their cursors, webhook secrets and the project
  folder they belong to (`threads/<session id>/`);
- each session's events (`sessions/<session id>/`), removed two weeks after
  the last one;
- a log, with secrets taken out.

The patterns you chose "Allow always" for are in OpenCode's plugin storage
(its own database), one list per project.

## What it does not protect against

- **What OpenCode's TUI shows in the prompt.** OpenCode 2.4.1's TUI shows a
  request for this plugin's action as "Call tool mcp_events_watch", without
  the resource or metadata it carries. You read the server and event type on
  the model's call line above it, which is what the request is about.
  OpenCode Desktop shows them in the prompt itself.
- **A server you configured that sends misleading events.** They are its
  data, and OpenCode may act on them within your permission rules.
- **OpenCode's default policy, after a wake.** It allows every action. The
  plugin asks about watches by default, but what the model does after an
  event is asked about only where your rules say `ask`.
- **An "Allow always" taken back in OpenCode.** The plugin keeps its own
  record, so removing OpenCode's saved approval doesn't make it ask again. An
  `ask` or `deny` rule for the action does.
- **Turning asking off.** With `askByDefault: false` or
  `MCP_EVENTS_ASK_BY_DEFAULT=0`, OpenCode's rules alone decide, and under its
  default a watch starts without a prompt.
- **Someone who can read your files.** The state folder holds webhook secrets
  and payloads, as OpenCode's data folder holds your sessions.
- **A relay operator reading webhook payloads.** Webhooks are signed, not
  encrypted. With your own relay, that operator is you. With the public relay,
  it's the person who runs it.
- **Other plugins.** A plugin runs inside OpenCode's server with the same
  access as this one.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-events` for
OpenCode.
