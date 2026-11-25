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
- **The folder.** Muse installs from this repository's Codex marketplace, so the
  plugin lives in the Codex plugin's folder, [`../codex/plugin`](../codex/plugin),
  with its own manifest ([`.muse-plugin/plugin.json`](../codex/plugin/.muse-plugin/plugin.json))
  and its own bundles in `muse/` there. The Codex bundle beside them is the
  Codex form's alone, the same with or without this form.
- **The code.** This folder: [`src/helper.ts`](src/helper.ts) (the server),
  [`src/muse.ts`](src/muse.ts), [`src/muse-confirm.ts`](src/muse-confirm.ts),
  [`src/muse-config.ts`](src/muse-config.ts) and
  [`src/muse-prompt-hook.ts`](src/muse-prompt-hook.ts) (the hook). It reuses the
  Codex form's sources ([`../codex/src`](../codex/src)) unchanged.
- **Its version** is its own, 0.1.0.
- **All four forms.** [AgentPolyfill in Muse Code](../../../docs/muse.md) covers
  every Muse form.

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

## How you say yes

**Muse offers plugins no approval dialog.** In the other hosts, the polyfills
ask you through a prompt the host draws itself, which the model can't answer:

- **Claude Code:** its permission dialog.
- **Codex:** its approval prompt, or an MCP form.
- **Pi:** a dialog.
- **OpenCode:** its permission prompt (the polyfills set their own actions to
  ask).

Muse has nothing like that for a plugin. Its MCP client offers no form, and a
hook's `ask` goes to Muse's approval judge, a model that may approve with
nobody asked. So in Muse, **your yes is a phrase you type, checked by the
plugin's hook**:

- **The question.** The answer to a watch, or to stopping one, is the
  question, ending with a phrase that names what it approves, such as
  `watch tickets ticket.created 4821` (or `unwatch …` to stop one).
- **The check.** The plugin's `UserPromptSubmit` hook reads your next message.
  Only a message that is exactly that phrase approves it, in the same session,
  within 15 minutes, once.
- **Only you.** Muse runs that hook only for messages you type. Nothing a
  model can put into a session runs it: scheduled prompts, monitors,
  subagents, other sessions, goals and workflows were each [checked
  live](docs/live-run.md#what-can-send-the-phrase).

What a host's prompt gives you that this doesn't: you read the question as the
model relays it in the chat. The phrase names the server and what's on it, so
you type the names of what you approve, but the other details are only in the
question. With Muse's experimental session-protocol gates on, any program you
run can drive the session, and could type the phrase too.

## Try it

Add the hosted demo server (no sign-in):

```bash
muse mcp add feeds --url https://event-feeds.idosalomon.workers.dev/mcp
```

Start `muse` and ask:

> Watch for new earthquakes from the feeds server.

Muse calls `watch_event`, and the answer is a question for you, with a phrase
that names the server and the event type, such as `watch feeds usgs.earthquake 4821`. Send a message
that is exactly that phrase. Muse calls
`watch_event` again, and the watch starts. When an earthquake is reported, it
reaches the session with your next message, and Muse reads it with
`get_event`.

To stop, ask: "Stop watching the earthquakes." Stopping waits for its own
phrase, such as `unwatch feeds usgs.earthquake 3307`, and the watch stops after you send it.

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
  written out. It ends with a phrase that names the server and the event type
  (`watch <server> <event type> <code>`). The plugin's `UserPromptSubmit` hook
  approves the watch only when a message of yours is exactly that phrase, in
  the same session, within 15 minutes. Muse runs that hook for your messages,
  not for a turn Muse or a model starts, so the model can't send the phrase. The
  next `watch_event` with the same arguments starts the watch. Stopping a
  watch works the same way, with its own phrase
  (`unwatch <server> <event type> <code>`).
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

From this folder. The Muse form has no dependencies of its own: it builds with
the Codex form's pinned esbuild, and its sources' packages come from there.

```bash
(cd ../core && npm ci)
(cd ../codex && npm ci)
npm test              # its tests (test/muse-test.ts, test/plugin-test.ts)
npm run typecheck
npm run build         # ../codex/plugin/muse/dist/helper.js and ../codex/plugin/muse/hooks/user-prompt-submit.mjs
```

The Codex bundle is built in [`../codex`](../codex), and nothing here changes it.

## Licence

Apache-2.0, as the rest of the repository.
