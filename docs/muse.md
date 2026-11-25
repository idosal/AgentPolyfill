# AgentPolyfill in Muse Code

[Muse Code](https://dev.meta.ai/docs/muse-code) is Meta's terminal coding
agent (`muse`). Muse reads this repository's Codex marketplace, and each of the
four Codex plugins also carries a Muse manifest (`.muse-plugin/plugin.json`).
So Muse installs Events, Skills, Server Cards and ARD from the same marketplace,
under the same names, and runs the same code, told it is in Muse.

These forms are early. They were checked with Muse Code 1.4.25 on macOS on
25 November 2026, and Muse's plugin interface changes every few days. Some of
what follows works differently from Claude Code and Codex, because Muse gives a
plugin less to work with. Each difference is listed with its reason.

## Install

You need Muse Code 1.4.25 or newer, and Node 20 or newer on the `PATH` that
`muse` runs with. In a terminal:

```
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-events@agent-polyfill
muse plugins approve mcp-events
```

Do the same for `mcp-skills`, `mcp-server-cards` and `ard-discovery`. Then start a
new `muse` session.

- **Why `approve`.** Muse turns on a plugin's skills when you install it. It
  holds back its MCP servers and hooks until you approve them.
- **After an update, approve again.** `muse plugins marketplace update
  agent-polyfill`, then `muse plugins update <name>`, marks the plugin's servers
  and hooks as changed. They stay off until you run `muse plugins approve <name>`
  again.
- **Trusted folders only.** Muse starts no MCP server in a workspace you haven't
  trusted, these included.

## What each one does in Muse

| | What works | How Muse differs |
|---|---|---|
| **Events** ([`mcp-events`](../polyfills/events/codex)) | Watches on the servers in your Muse settings, by poll, push or webhook. New events reach the session **with your next message**. | Nothing outside a default Muse session can start a turn in it, so an event doesn't wake an idle session. An experimental opt-in mode does (below). |
| **Skills** ([`mcp-skills`](../polyfills/skills/codex)) | Skills your servers serve show up in Muse's skill list as `mcp-skills:<server>:<name>`. They load after you say yes, and are checked against the server's digests. | You say yes by **typing**: the question ends with a phrase such as `load 4821`, and only a message of yours that is exactly that phrase approves the skill. |
| **Server Cards** ([`mcp-server-cards`](../polyfills/server-cards/codex)) | Name a domain and it finds the MCP servers the domain publishes and checks each card. | It writes nothing. For the server you pick, it gives you the `muse mcp add …` command, which **you run yourself**, in a terminal or after `!` at the Muse prompt. |
| **ARD** ([`ard-discovery`](../polyfills/ard/codex)) | It finds servers through a domain's `ard.json`, then works as Server Cards does. | It has **no registry search**. A search sends your words to someone else's service, which needs your yes first. |

Apps isn't offered in Muse: Muse gives a plugin no way to draw in its terminal.

## Why some steps are typed

In Claude Code and Codex the polyfills ask you directly before anything that
matters: loading a skill a server serves, adding a server to your config, or
sending a search to a registry. Muse gives a plugin no way to ask you:

- **No elicitation.** Muse's MCP client declares no capabilities, so a plugin's
  server can't show you a form.
- **The approval judge.** A tool call that isn't read-only goes to Muse's
  approval judge. The judge is a model. It may approve the call with nobody
  asked, and the card it shows when it does ask names the tool, not its
  arguments.
- **Hooks.** A hook's `ask` goes to the same judge. When the judge approves
  (in our check a stand-in model answered for it), the tool runs and nobody is
  asked. A hook's `systemMessage` only flashes in the status line.

Two things only you can do: type your own message, and run a command. Muse runs
a plugin's `UserPromptSubmit` hook for your messages. It doesn't run it for a
turn that Muse's own timers start, so a model can't write that message for you.

- **Skills** asks with a phrase you type.
- **Server Cards** and **ARD** hand you the command, so you see the URL and
  every header it writes before you run it.
- **ARD** drops registry search, because a search has to ask before it sends
  anything.

## Events: next message by default, real wake as an opt-in

By default, `mcp-events` stores every event of your session's watches as it
arrives. Its `UserPromptSubmit` hook gives the model what's new when you next
send a message. It arrives as a context block that starts with
`[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)` and names
the watch and the event ids. Nothing the server wrote is in it. This works in
`muse exec` too: two runs with the same `--session-id` are one session, and the
second run's prompt gets what the first stored.

**Real wake (experimental).** Muse has two undocumented launch gates. With both
on, an outside program can join a live terminal session and start a turn in it.
To use them:

1. Put `{"MCP_EVENTS_MUSE_WAKE": "attach"}` in `mcp-events`' settings file (see
   Settings).
2. Start `muse` with both gates:

   ```
   MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1 muse
   ```

Each batch of new events then starts a turn in that session. The plugin runs
`muse attach --stdio <session>`, joins it over Muse's session protocol, and
queues the turn if the session is busy.

- **If waking fails, nothing is lost.** When it fails (a session started without
  the gates, say), the batch waits for your next message, as by default.
- **It's capped.** Waking is held to the same limits as in Codex: at most once a
  minute per watch and 30 times an hour.
- **What was checked.** It worked in a live terminal session with the echo
  provider. A session started with `--provider meta --base-url …` (a local
  stand-in for the model) wasn't attachable. A session signed in to Meta wasn't
  tried.

> **With these gates on, any program you run can drive your Muse session.**
> Any local process running as your user can attach to the session as a second
> driver and start turns in it. Muse doesn't ask you first. That includes typing
> Skills' `load <code>` phrase, because Muse treats a turn an attached program
> starts like one you typed. Turn the gates on only on a machine where you trust
> everything that runs as you.

## Settings

Muse starts a plugin's server and hooks with a cleared environment. They get
`HOME`, `PATH`, `TMPDIR` and Muse's own `MUSE_*` variables, and nothing of yours.
So the `MCP_EVENTS_*` and `MCP_SKILLS_*` variables you'd set for Codex never
reach them. Each plugin reads a `settings.json` in its own data folder instead:
`~/.local/share/muse/plugins/data/<plugin>/`.

- **`mcp-events`:** a JSON object of the same settings, by name, for example
  `{"MCP_EVENTS_MUSE_WAKE": "attach", "MCP_EVENTS_SKIP": "github"}`. One value
  is never taken from the file: `MCP_EVENTS_STATE`.
- **`mcp-skills`:** the same file as in Codex: `{"servers": [...], "skip": [...],
  "off": true}`.
- **`mcp-server-cards` and `ard-discovery`:** no settings in Muse.

## Which servers Events and Skills reach

Neither host lets a plugin use its own MCP connection, so Events and Skills
open a connection of their own to each server in `mcpServers` in Muse's user
settings (`~/.config/muse/settings.json`, which `muse mcp add` writes).

- **Signed-in servers: no.** A server you signed in to with `muse mcp login`
  (OAuth) can't be reached. Muse keeps that sign-in to itself, and no polyfill
  reads it.
- **Secrets from the environment: no.** A server whose header or environment
  takes a value from a variable (`${VAR}`) is left out, with the reason. Muse
  fills the variable in for its own connection, and passes it to no plugin.
- **Not read at all.** A project's `.mcp.json`, and servers other plugins bring.

Server Cards doesn't have these limits. The server you add goes into Muse's own
config, and Muse connects it with its own sign-in.

## Turning one off

When Muse supports one of these extensions itself, turn that polyfill off. No
polyfill can tell on its own, because Muse doesn't say which extensions its MCP
client supports. Use `muse plugins disable <name>`, or `muse plugins remove
<name> --delete-data`.

- **Skills stubs.** `mcp-skills` keeps its stubs in
  `~/.config/muse/skills/mcp-skills-served--*`. Removing the plugin leaves them
  there. Delete those folders by hand.
- **Events off without removing it.** Put `{"MCP_EVENTS_OFF": "1"}` in its
  settings file. The tools go, and so does the hook's hand-over.

## Limits

- **Waking.** By default nothing wakes an idle session (see Events).
- **Plugin settings.** Muse doesn't pass the environment, so settings live in
  files.
- **`muse exec` runs.** Events stores events only while a run lasts. Events that
  arrive between runs come in when a watch resumes, if its server replays them.
- **Skills.**
  - The stubs a session writes were in Muse's skill list in the sessions after
    it. Whether Muse lists them in the same session wasn't checked.
    `list_skills` shows them right away.
  - A skill you turn off with `muse skills disable` drops out of Muse's list. A
    load by its URI still works.
- **Validation warning.** `muse plugins validate` warns `multiple-manifests` for
  each plugin: the folder also holds the Codex manifest, and Muse uses its own.
  The plugin is still valid, with compatibility `full`.
- **Platforms.** Checked on macOS only.

## Host changes that would help

These are Muse's lines in [what hosts would need to change](host-changes.md):

1. **A way for a plugin to ask you.** MCP elicitation in Muse's client, or a
   hook `ask` that always reaches you, not the judge, and shows the hook's
   reason. That would turn the typed phrase and the hand-run command back into
   a question.
2. **The session-protocol terminal on by default**, with a consent step before
   anything attaches. Or a verified sender for `muse session-message send` from a
   session's own plugin. Either gives every plugin real wake.
3. **A generic MCP request over Muse's connection**, with the server's
   capabilities and notifications. Then Events and Skills could reach every
   server you've signed in to.
4. **Pass a plugin server the variables its manifest names.** Then settings
   and header secrets could reach it.

## How it was checked

Every run used the real Muse Code 1.4.25 binary (from the Homebrew cask, sha256
checked). Each ran with a cleared environment, and with `HOME`, the XDG folders
and `TMPDIR` in a scratch folder. There was no `muse login`, and no real model:
the `echo` provider, or a stand-in for the Responses API on 127.0.0.1 with a
made-up key. The stand-in also answered Muse's approval judge.

- **Install.** The repository as a marketplace (`muse plugins marketplace add`
  from a local folder, and the same command against the GitHub URL), then
  `install` and `approve`. All four plugins validate with compatibility `full`.
- **Events.**
  - With the stand-in model, a watch on the fixture events server. An event
    arrived by push during that run, and the model was given it with the next
    prompt of the same session.
  - In an `echo` session, an event stored by one run reached the next run's
    prompt.
  - In a terminal session with both gates on, an event started a turn in the
    idle session.
- **Server Cards.** It discovered `neon.com`'s two servers. For Neon Docs it
  gave `muse mcp add neon-docs --url https://neon.com/docs/mcp`. Run as a person
  would run it, that command added the server, and Muse connected it in the next
  session (`search_docs`, `get_doc`, …).
- **ARD.** A local `ard.json`, and the same command flow.
- **Skills.**
  - Hugging Face's public MCP server: its 25 skills listed in Muse's skill list.
  - The fixture skills server: a load waited for `load <code>`, then loaded and
    was verified. A later load of the same unchanged skill loaded without asking.
- **Codex unchanged.** Each plugin's Codex test suite still passes, with new
  tests for the Muse forms beside it.

Why the Codex Events plugin first closed at startup in Muse: Muse starts a
plugin's MCP server with the session's workspace as its working directory.
Codex's `.mcp.json` passes `./dist/helper.js` and sets `cwd` to the plugin
folder, but Muse refuses `cwd`. Without it, node looked for the helper in the
workspace and exited. The Muse manifest names `dist/helper.js`, which Muse
resolves against the plugin folder.
