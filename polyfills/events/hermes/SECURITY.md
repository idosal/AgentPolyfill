# Security

This covers mcp-events for Hermes. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The plugin" below means both halves: the Python half Hermes loads in its
gateway (`plugin/__init__.py`) and the helper it starts (`plugin/dist/helper.mjs`,
the Events client the forms share, in [`../core`](../core)).

## The model

An event is data from an MCP server you configured and granted to the plugin.
The extension asks that it be handled with "the same caution as tool results":

- What a server sent reaches the model only as a tool result, when it reads it
  with `get_event` or `recent_events`.
- The message that wakes a session isn't a tool result: `ctx.inject_message`
  puts it in the conversation as the user's message, the only way a plugin can
  start a turn in Hermes. So it carries nothing a server wrote. Each line is
  written from the plugin's own data: the watch id, the server's name from
  your config, the event ids, and the note you approved with the watch. Not
  the event type's name, which the server chose, and not a notice's text,
  which can quote the server. Its first line says it was sent by the plugin.

Receiving an event grants nothing. What the model does about one goes through
Hermes's own approvals, as any turn does. An event arrives unasked and wakes
an idle session, so in a session that approves without asking (YOLO,
`approvals.mode: off`) an event can lead to actions without a prompt, as a
tool result from the same server could. How often is bounded, not prevented.

## What the plugin does

- **Starting or stopping a watch goes through Hermes's approval.** The
  `pre_tool_call` hook returns an approve directive; Hermes asks (once,
  session, always, deny) on the session's own surface and fails closed where
  nobody can answer. The question shows the whole action: server, event type,
  every filter, the note and the replay window, with control, direction and
  invisible characters replaced. An action too long to show in full isn't
  asked about; it's refused. A kept approval's key is a digest of that whole
  action and of the server's entry as configured now, so "always" covers that
  exact watch on that server as it is set up, and nothing else: pointed
  elsewhere, the same name is asked about again. Stopping a watch is keyed by
  the watch. Only the call asked about runs: if another plugin changes it
  after the question (Hermes applies such changes after its approval),
  nothing is started.
- **No watch where Hermes approves without asking.** With `--yolo`, a
  session's `/yolo`, `hermes -z` or `approvals.mode: off`, Hermes would answer the
  question itself, and a watch starts turns later by itself. So the plugin
  refuses to start one there, before Hermes is asked; stopping one still goes
  to Hermes. It evaluates the test Hermes's own approval gate uses, which isn't on
  Hermes's published plugin API. Where it can't (another version of Hermes,
  or the plugin running in Hermes's plugin host process with
  `plugins.isolation: host`), it can't tell, and refuses too.
  Hermes's unattended approve modes (`approvals.cron_mode`,
  `single_query_mode` or `unattended_mode` set to `approve`) still approve
  watches where nobody is present, as you set them to, and a kept "session"
  or "always" answer covers its exact action in those runs too.
- **Only servers you named.** The plugin connects only to servers named in
  its own settings, `plugins.entries.mcp-events.settings.servers`, never to
  one that signs in through Hermes (`auth: oauth`), and leaves `events: true`
  servers to Hermes. It reads the configuration again at each turn and tool
  call, so a server you remove or leave to Hermes stops being used then.
- **Only its own profile.** Hermes keeps a profile's home, config and secrets
  in context variables. Every thread the plugin starts carries the caller's
  context, and the helper refuses to start outside the profile the plugin was
  loaded for, so a secondary profile never reads the main profile's servers.
- **Only the session that set the watch is woken.** Watches belong to the
  session key Hermes gives the call; a call with none sets no watch. Session
  folders are named by a digest of the key.
- **How often.** A watch wakes its session at most once a minute, a session at
  most 30 times an hour, then one notice and a pause until you next write (or
  an hour). Delivery is at most once: an event handed to Hermes that the
  plugin never heard back about counts as delivered. The wake gate is checked
  with TLC: [`../claude-code/model`](../claude-code/model/README.md#wakehermestla-how-often-events-wake-a-hermes-session).
- **No credentials read.** The plugin never opens Hermes's token store
  (`mcp-tokens/`), `auth.json` or `.env`. It reads `config.yaml` as written,
  with Hermes's `read_raw_config`, so no `${VAR}` is filled in from `.env`: a
  server whose entry takes one is left alone, with that reason. The helper
  gets an allowlist of the gateway's environment: the system's basics, what
  Node needs to reach a server (CA certificates, a proxy) and the plugin's
  own settings, and no key, token or credential under any other name. A local
  server gets only the MCP SDK's default environment and its own `env`. The
  helper's log takes known secrets out; `helper-stderr.log`, what Node itself
  prints, doesn't.
- **The line between the halves** is JSON per line, so no server text can
  frame a message. The only request the helper may make of the Python half is
  `wake`. Writes have one deadline with the answer; a helper that stops
  reading is ended, and the tools say so.
- **No webhook.** Webhook delivery needs a public address; this plugin never
  sets one up, and ignores the relay the other forms can use (its settings
  and its file, `~/.mcp-events/relay.json`). Hermes does webhooks itself for
  `events: true` servers.

## Limits

- **Turns another plugin or Hermes itself starts count as the person writing.**
  The plugin tells your message from its own wake by its first line only
  (Hermes's hooks don't say who started a turn), so such a turn ends a pause
  early. A delegated child agent's turn doesn't count; one the model starts
  through another plugin or a Hermes tool can. The model shows what that costs ([`WakeHermesOthersHour`](../claude-code/model/README.md#wakehermestla-how-often-events-wake-a-hermes-session)).
- **`allow_gateway_injection` is broad.** It lets the plugin start turns in any
  session of its profile, chat apps included; the plugin only wakes sessions
  that set a watch.
- **A second connection,** with the headers in your config, to each granted
  server.

## Reporting

See the repository's [SECURITY.md](../../../SECURITY.md).
