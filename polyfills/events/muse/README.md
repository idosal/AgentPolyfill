# mcp-events for Muse Code

Muse Code can watch events on your MCP servers ("tell me when a deploy
fails"). New events reach the session with your next message. An
experimental opt-in also lets an event start a turn in an idle session.

Also available for Claude Code: [mcp-events for Claude Code](../claude-code/README.md),
for Codex: [mcp-events for Codex](../codex/README.md),
and for Pi: [mcp-events for Pi](../pi/README.md).

This plugin implements the client side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(the Final text, as of 24 November 2026), which Muse doesn't support itself.
It's the Codex plugin's folder, [`../codex/plugin`](../codex/plugin), with a
Muse manifest beside the Codex one ([`.muse-plugin/plugin.json`](../codex/plugin/.muse-plugin/plugin.json)).
Muse runs the same bundle, told it is in Muse. The code that differs is in
[`../codex/src/muse.ts`](../codex/src/muse.ts),
[`muse-confirm.ts`](../codex/src/muse-confirm.ts),
[`muse-config.ts`](../codex/src/muse-config.ts) and
[`muse-prompt-hook.ts`](../codex/src/muse-prompt-hook.ts).
[AgentPolyfill in Muse Code](../../../docs/muse.md) covers all four Muse forms.

## Install

You need **Muse Code 1.4.25** (the version tested) and **Node 20 or newer**
on the PATH `muse` runs with. In a terminal:

```bash
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-events@agent-polyfill
muse plugins approve mcp-events
```

Then start a new `muse` session, in a workspace you trust. Muse starts no MCP
server in an untrusted one.

- **Why `approve`.** Muse holds a plugin's MCP server and hooks back until you
  approve them. This plugin has one of each: the `mcp-events` server and a
  `UserPromptSubmit` hook.
- **Updates.** Run `muse plugins marketplace update agent-polyfill`, then
  `muse plugins update mcp-events`. Muse marks the server and hook as changed,
  so run `muse plugins approve mcp-events` again.

To remove it:

```bash
muse plugins remove mcp-events --delete-data
```

`--delete-data` also removes its watches and stored events: the data folder
Muse gives the plugin, `~/.local/share/muse/plugins/data/mcp-events`. To drop
the marketplace too, if no other plugin of it is installed:
`muse plugins marketplace remove agent-polyfill`. Nothing else is left behind.

## Try it

Add the hosted demo server (no sign-in):

```bash
muse mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

Start `muse` and ask:

> Watch for new earthquakes from the feeds server.

Muse calls `watch_event`, and the answer is a question for you, with a phrase
such as `watch 4821`. Send a message that is exactly that phrase. Muse calls
`watch_event` again, and the watch starts. When an earthquake is reported, it
reaches the session with your next message, and Muse reads it with
`get_event`.

To stop, ask: "Stop watching the earthquakes." Stopping waits for its own
phrase, such as `unwatch 3307`, and the watch stops after you send it.

## How it works

- **A watch belongs to the session that set it.** Muse starts the plugin's
  server once per session and puts the session's id in its environment
  (`MUSE_SESSION_ID`). The server runs that session's watches, with the Events
  client every form shares ([`../core`](../core)).
- **Your yes is typed.** Muse gives a plugin no way to ask you a question:
  - Its MCP client offers no elicitation.
  - A tool call that isn't read-only goes to Muse's approval judge, a model
    that may approve it with nobody asked.
  - A hook's `ask` goes to the same judge.

  So the first `watch_event` answers with the question: the server, the event
  type, the filters and your note, each in full, with any hidden character
  written out. It ends with a phrase. The plugin's `UserPromptSubmit` hook
  approves the watch only when a message of yours is exactly that phrase, in
  the same session, within 15 minutes. Muse runs that hook for your messages,
  not for a turn its timers start, so the model can't send the phrase. The
  next `watch_event` with the same arguments starts the watch. Stopping a
  watch works the same way, with its own phrase (`unwatch <code>`).
- **Delivery at your next message.** The server stores every event as it
  arrives and hands nothing over. When you next send a message, the hook adds
  the new events as a context block. It starts with
  `[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)` and
  names the watch and the event ids, with nothing the server wrote. The hook
  records how far it got, so each event is handed over once. This works across
  `muse exec` runs that share a `--session-id`, too.
- **Real wake (opt-in, experimental).** Put `{"MCP_EVENTS_MUSE_WAKE": "attach"}`
  in the settings file, and start `muse` with Muse's two session-protocol
  gates:

  ```bash
  MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1 muse
  ```

  Each batch of new events then starts a turn. The plugin runs
  `muse attach --stdio <session>` and sends Muse's session protocol requests
  `initialize`, `session/resume` and `turn/start` with `ifBusy: "queue"`.
  - **Capped as in Codex:** once a minute per watch, and 30 times an hour.
    After that the session is told once, and woken again after your next
    message.
  - **If it fails** (a session started without the gates), the batch waits for
    your next message.

  > **With these gates on, any program you run can drive your Muse session.**
  > Any local process running as your user can attach to the session and start
  > turns in it, without being asked, and could type a `watch` phrase too. Turn
  > them on only where you trust everything that runs as you.
- **Which servers.** Those in `mcpServers` in Muse's user settings
  (`~/.config/muse/settings.json`, which `muse mcp add` writes), over a
  connection of the plugin's own. Some are left out, each with the reason:
  - a server with `enabled: false`;
  - a server you signed in to with `muse mcp login` (Muse keeps that sign-in to
    itself);
  - a server whose values come from a variable (`${VAR}`), because Muse passes
    the variable to no plugin;
  - every server, when your organisation manages Muse (`muse config status`
    shows a defaults or policy plane);
  - never read at all: a project's `.mcp.json`, and servers other plugins
    bring.

## Settings

Muse starts a plugin's server and hooks with a cleared environment, so
`MCP_EVENTS_*` variables never reach them. They are read from `settings.json`
in the plugin's data folder (`~/.local/share/muse/plugins/data/mcp-events/`),
as a JSON object of the same names, for example:

```json
{ "MCP_EVENTS_SKIP": "github", "MCP_EVENTS_WAKE_VALUES": "1" }
```

The settings are the Codex form's ([its table](../codex/README.md#settings)), plus:

| Key | What it does |
|---|---|
| `MCP_EVENTS_MUSE_WAKE` | `attach`: new events start a turn through `muse attach` (experimental, above). Default: they come with your next message. |
| `MCP_EVENTS_MUSE_BIN` | The `muse` to run (an absolute path). Default: `muse` on PATH, then where Muse's installers put it. |

`MCP_EVENTS_STATE` is never taken from the file. `MCP_EVENTS_OFF` set to `"1"`
there turns the plugin off: no tools, and the hook does nothing.

### When Muse supports Events itself

Disable the plugin (`muse plugins disable mcp-events`), or set
`MCP_EVENTS_OFF`. It can't stand down by itself, because Muse doesn't tell a
plugin what its own MCP client supports.

## Limits

The changes Muse would need are in
[What hosts would need to change](../../../docs/host-changes.md#in-muse-code).

- **No wake by default.** An event waits for your next message. Real wake
  needs the two gates, and was checked with Muse's echo provider only. A
  session using a custom `--base-url` wasn't attachable.
- **No sign-in through Muse, and no `${VAR}` secrets.** Muse doesn't let a
  plugin use its connection or its sign-in, and passes no variables to a
  plugin.
- **A second connection.** A local (stdio) server runs twice, once for Muse
  and once for this plugin.
- **Muse's approval judge.** `watch_event` and `unwatch_event` aren't
  read-only, so Muse's judge also sees them. A watch still starts, and stops,
  only after your typed yes.
- **`muse exec`.** Events are stored only while a run lasts. Events that arrive
  between runs come in when the watch resumes, if the server replays them.
- **Platforms.** Checked on macOS only.

## Security

What Muse does about an event is Muse's to decide, with its usual approvals:
an event gives it no permission it didn't have. The context block carries
nothing the server wrote. The plugin reads Muse's MCP server list, which can
hold header values you wrote, and never Muse's sign-in store. Details, what is
stored, and how to report a vulnerability are in [`SECURITY.md`](SECURITY.md).

## Spec and conformance

The client is the one every form shares, so the clause-by-clause table of the
Claude Code form holds here: [`../claude-code/docs/conformance.md`](../claude-code/docs/conformance.md).
[`docs/conformance.md`](docs/conformance.md) says what this form's own tests
check, and what is different in Muse. [`docs/live-run.md`](docs/live-run.md)
records the runs in a real Muse 1.4.25. **No run used a real model.** Every
run used Muse's echo provider, or a stand-in for the model on 127.0.0.1 with a
made-up key.

## Development

The Muse form is built and tested with the Codex form, from
[`../codex`](../codex):

```bash
(cd ../core && npm ci)
cd ../codex && npm ci
npm test              # test/muse-test.ts is the Muse form's
npm run build         # plugin/dist/helper.js and plugin/muse/hooks/user-prompt-submit.mjs
```

## Licence

Apache-2.0, as the rest of the repository.
