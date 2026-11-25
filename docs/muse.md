# AgentPolyfill in Muse Code

[Muse Code](https://dev.meta.ai/docs/muse-code) is Meta's terminal coding
agent (`muse`). Muse reads this repository's Codex marketplace, and each of the
four Codex plugin folders also carries a Muse manifest
(`.muse-plugin/plugin.json`). So Muse installs Events, Skills, Server Cards and
ARD from the same marketplace, under the same names, and runs the same code,
told it is in Muse.

These forms are early. They were checked with Muse Code 1.4.25 on macOS on
25 November 2026, and Muse's plugin interface changes every few days.

**No run used a real model.** Each run used Muse's echo provider, or a
stand-in for the model on 127.0.0.1 with a made-up key, in an isolated home
with no `muse login`.

| Polyfill | Muse form | What works | How Muse differs |
|---|---|---|---|
| Events | [`mcp-events`](../polyfills/events/muse/README.md) | Watches on the servers in your Muse settings, by poll, push or webhook. New events reach the session **with your next message**. | A watch starts, and stops, after you type its phrase (`watch 4821`, `unwatch 3307`). Nothing wakes an idle session, except with an experimental opt-in. |
| Skills | [`mcp-skills`](../polyfills/skills/muse/README.md) | Served skills in Muse's skill list as `mcp-skills:<server>:<name>`, loaded after your yes, checked against the server's digests. | You say yes by typing the phrase (`load 4821`). No "show me its SKILL.md first". |
| Server Cards | [`mcp-server-cards`](../polyfills/server-cards/muse/README.md) | Finds the MCP servers a domain publishes, and checks each card. | It writes nothing: for the server you pick, it gives you the `muse mcp add …` command, which **you run yourself**. |
| ARD | [`ard-discovery`](../polyfills/ard/muse/README.md) | Finds servers through a domain's `ard.json`, then works as Server Cards does. | **No registry search.** A search must ask you before it sends your words to someone else's service. |

Apps isn't offered in Muse: Muse gives a plugin no way to draw in its terminal.

## Install

You need Muse Code 1.4.25 or newer, and Node 20 or newer on the `PATH` that
`muse` runs with. In a terminal:

```
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-events@agent-polyfill
muse plugins approve mcp-events
```

Do the same for `mcp-skills`, `mcp-server-cards` and `ard-discovery`. There is
no bundle. Then start a new `muse` session.

- **Why `approve`.** Muse turns on a plugin's skills when you install it. It
  holds its MCP servers and hooks back until you approve them.
- **After an update, approve again.** `muse plugins marketplace update
  agent-polyfill`, then `muse plugins update <name>`, marks the plugin's servers
  and hooks as changed. They stay off until you run `muse plugins approve <name>`
  again.
- **Trusted folders only.** Muse starts no MCP server in a workspace you haven't
  trusted, these included.

## Remove

```
muse plugins remove <name> --delete-data
muse plugins marketplace remove agent-polyfill
```

This removes each plugin, its data folder and its approvals. Left behind:
- **Skills' stubs**, in `~/.config/muse/skills/mcp-skills-served--*`. Delete
  them by hand.
- **Servers you added** with a command Server Cards or ARD gave you. Undo each
  with `muse mcp remove <name>`.

## Why some steps are typed or run by you

In Claude Code, Codex and Pi, the polyfills ask you directly before anything
that matters: a watch, loading a skill a server serves, adding a server, or
sending a search to a registry. Muse gives a plugin no way to ask you:

- **No elicitation.** Muse's MCP client declares no capabilities, so a plugin's
  server can't show you a form.
- **The approval judge.** A tool call that isn't read-only goes to Muse's
  approval judge. The judge is a model. It may approve the call with nobody
  asked, and the card it shows when it does ask names the tool, not its
  arguments.
- **Hooks.** A hook's `ask` goes to the same judge. When the judge approves (in
  our check a stand-in model answered for it), the tool runs and nobody is
  asked. A hook's `systemMessage` only flashes in the status line.

So the forms rely on two things only you can do:

- **Type your own message.** Muse runs a plugin's `UserPromptSubmit` hook for
  your messages. It doesn't run it for a turn that Muse's own timers start, so a
  model can't write that message for you.
  - **Events and Skills** answer a watch, a stop or a load with the question,
    which ends with a phrase (`watch 4821`, `unwatch 3307`, `load 4821`).
  - Only a message of yours that is exactly that phrase approves it. It must
    come in the same session, within 15 minutes.
  - The next call goes ahead, once.
- **Run a command.** Server Cards and ARD hand you the command, so you see the
  URL and every header it writes before you run it.

ARD drops registry search, because a search has to ask before it sends
anything.

## Events: next message by default, real wake as an opt-in

By default, `mcp-events` stores every event of your session's watches as it
arrives. Its hook gives the model what's new when you next send a message. It
arrives as a context block that starts with
`[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)` and
names the watch and the event ids. Nothing the server wrote is in it. This
works in `muse exec` too: two runs with the same `--session-id` are one
session.

**Real wake (experimental).** Muse has two undocumented launch gates. With both
on, an outside program can join a live terminal session and start a turn in it.

1. Put `{"MCP_EVENTS_MUSE_WAKE": "attach"}` in `mcp-events`' settings file
   (Settings, below).
2. Start `muse` with both gates:

   ```
   MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1 muse
   ```

- **What it does.** Each batch of new events then starts a turn in that session,
  queued if the session is busy.
- **If it fails** (a session started without the gates), the batch waits for
  your next message.
- **Capped** as in Codex: once a minute per watch, 30 times an hour.
- **Checked** with the echo provider only. A session started with
  `--provider meta --base-url …` wasn't attachable, and a session signed in to
  Meta wasn't tried.

> **With these gates on, any program you run can drive your Muse session.**
> Any local process running as your user can attach to the session as a
> second driver and start turns in it, without asking you. Muse treats such a
> turn like one you typed, so that process could also type a `watch`,
> `unwatch` or `load` phrase. Turn the gates on only on a machine where you trust everything that
> runs as you.

## Settings

Muse starts a plugin's server and hooks with a cleared environment: `HOME`,
`PATH`, `TMPDIR` and Muse's own `MUSE_*` variables, nothing of yours. So the
variables you'd set for Codex never reach them. Each plugin reads a
`settings.json` in its own data folder instead,
`~/.local/share/muse/plugins/data/<plugin>/`:

- **`mcp-events`:** the `MCP_EVENTS_*` settings by name, for example
  `{"MCP_EVENTS_MUSE_WAKE": "attach", "MCP_EVENTS_SKIP": "github"}`. One is never
  taken from the file: `MCP_EVENTS_STATE`.
- **`mcp-skills`:** the same file as in Codex: `{"servers": [...], "skip": [...],
  "off": true}`.
- **`mcp-server-cards` and `ard-discovery`:** no settings in Muse.

## What Events and Skills read, and what they honour

Muse doesn't let a plugin use its own MCP connection. So Events and Skills open
a connection of their own to each server in **Muse's MCP server list**: that's
`mcpServers` in `~/.config/muse/settings.json`, which `muse mcp add` writes.

- **Header values.** That list can hold header values you wrote. The plugins
  use them to connect, as Muse does, and keep them out of their logs.
- **Never Muse's sign-in store.** A server you signed in to with `muse mcp
  login` (OAuth) can't be reached, because Muse keeps that sign-in to itself.
- **No `${VAR}` values.** A server whose header or environment takes a value
  from a variable is left out, with the reason. Muse passes no variables to a
  plugin.
- **Never a project's config.** A project's `.mcp.json` isn't read, and no
  command from one runs. Servers other plugins bring aren't read either.
- **None where your organisation manages Muse.** If `muse config status`
  shows a defaults or policy plane, or can't be read, no server is reached, as
  the Codex forms do with a managed Codex config.
- **Turned off is off.** A server with `enabled: false` is left out. While a
  plugin's MCP server is rejected (`muse plugins reject`) or not approved, that
  plugin's hook does nothing.

Server Cards doesn't have these limits. The server you add goes into Muse's own
config, and Muse connects it with its own sign-in.

## Turning one off

When Muse supports one of these extensions itself, turn that polyfill off with
`muse plugins disable <name>`. No polyfill can tell on its own, because Muse
doesn't say which extensions its MCP client supports.

## Limits

- **Waking.** By default nothing wakes an idle session (above).
- **Skills.**
  - Stubs a session writes were in Muse's list in the sessions after it. The
    same session wasn't checked. `list_skills` shows them right away.
  - A skill you turn off with `muse skills disable` drops out of Muse's list,
    but a load by its URI still works.
- **Validation warning.** `muse plugins validate` warns `multiple-manifests` for
  each plugin, because the folder also holds the Codex manifest and Muse uses
  its own. The plugin is still valid, with compatibility `full`.
- **Platforms.** Checked on macOS only.

## Host changes that would help

These are Muse's lines in [what hosts would need to change](host-changes.md#in-muse-code):

1. **A way for a plugin to ask you.** MCP elicitation in Muse's client, or a
   hook `ask` that always reaches you, not the judge, and shows the hook's
   reason.
2. **The session-protocol terminal on by default**, with a consent step before
   anything attaches.
3. **A generic MCP request over Muse's connection**, with the server's
   capabilities and notifications.
4. **Pass a plugin server the variables its manifest names.**

## How it was checked

Every run used the real Muse Code 1.4.25 binary (from the Homebrew cask,
sha256 checked). Each ran with a cleared environment, and with `HOME`, the XDG
folders and `TMPDIR` in a scratch folder. Each form's `docs/live-run.md`
records its runs:
[Events](../polyfills/events/muse/docs/live-run.md),
[Skills](../polyfills/skills/muse/docs/live-run.md),
[Server Cards](../polyfills/server-cards/muse/docs/live-run.md),
[ARD](../polyfills/ard/muse/docs/live-run.md). In short:

- **Install.** All four validate with compatibility `full`, install from the
  repository as a marketplace, approve, and serve their tools in a session.
- **Events.**
  - A watch waited for its phrase, started after it, and its event reached the
    model with the next prompt. (Stopping one waits for its own phrase; that is
    covered by the tests, not the live run.)
  - With the plugin's server rejected, the hook stayed silent.
  - In a terminal session with both gates on, an event started a turn in the
    idle session.
- **Skills.**
  - Hugging Face's 25 skills were listed in Muse's skill list.
  - A load waited for `load <code>`, then loaded and was verified.
- **Server Cards.** It discovered neon.com's two servers. The command it gave
  for Neon Docs, run as a person would run it, added the server, and Muse
  connected it next session.
- **ARD.** Discovery through a local `ard.json`, the same command flow, and no
  search tool offered.
- **Remove.** `remove --delete-data` left only the Skills stubs.
- **Codex unchanged.** Each plugin's Codex test suite still passes, with the
  Muse tests beside it.

Why the Codex Events plugin first closed at startup in Muse: Muse starts a
plugin's MCP server with the session's workspace as its working directory.
Codex's `.mcp.json` passes `./dist/helper.js` and sets `cwd` to the plugin
folder, but Muse refuses `cwd`. Without it, node looked for the helper in the
workspace and exited. The Muse manifest names `dist/helper.js`, which Muse
resolves against the plugin folder.
