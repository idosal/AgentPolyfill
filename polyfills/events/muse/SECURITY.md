# Security

Report a problem privately, as the [repository's SECURITY.md](../../../SECURITY.md)
says. This page is about mcp-events in Muse Code: its own bundle and hook, in
the Codex plugin's folder, started by its Muse manifest. It reuses the Codex
form's code unchanged, so everything the
[Codex form's SECURITY.md](../codex/SECURITY.md) says about the Events client
(what a server can and can't make it do, webhooks, the relay, sizes) holds
here. What follows is what differs in Muse.

## The boundary

**Plainly:** Muse offers plugins no approval dialog. Where Claude Code, Codex,
Pi and OpenCode, in a mode that asks, show you a prompt the host draws itself,
which the model can't answer (with approvals off in Claude Code or Codex, a
watch isn't asked), here consent is a phrase you type, checked by the plugin's
`UserPromptSubmit` hook. That holds because Muse ran the hook for the messages
you typed, and none of the ways a model can put text into a session (scheduled
prompts, monitors, subagents, other sessions, goals, workflows) ran it when
each was [checked](docs/live-run.md#what-can-send-the-phrase). The weaker
part: you read the question as the model relays it, so the phrase names what
it approves.

Muse's own approvals decide what Muse does: with an event, as with anything
else in the session. Receiving an event gives Muse no permission it didn't
already have.

This plugin's one consequential step is starting a watch: from then on a
server's events come into the session. Muse can't be relied on to ask you
first:

- **No elicitation.** Its MCP client offers none.
- **The judge.** A tool call that isn't read-only goes to Muse's approval judge,
  a model that can approve it with nobody asked. A hook's `ask` goes to that
  judge too.

So a watch waits for your own typed yes:

- **The question.** The first `watch_event` answers with the question, and
  starts nothing. It gives the server, the event type, the filters and your
  note, each in full. Any character that shows nothing, or that changes how the
  text around it reads, is written out (`\u{…}`). A watch whose filters or note
  are too long to show whole is refused before anything is asked. So is one
  that holds a value Muse's settings keep secret, which the question would have
  to hide.
- **The phrase.** The question ends with a phrase,
  `watch <server> <event type> <code>` (`watch tickets ticket.created 4821`), with a four-digit code
  made for it. It names the server and the event type, so you type the names
  of what you approve. A watch whose server or event type has anything but
  letters, digits and `._:/@+-` in its name is refused before anything is
  asked: its name couldn't be typed plainly. The plugin's `UserPromptSubmit` hook approves
  the question only when a message of yours is exactly that phrase, in the same
  session, within 15 minutes.
- **Who can type it.** Muse ran that hook for your own messages. None of the
  ways a model can put text into a session ran it when each was tried ([live
  runs](docs/live-run.md#what-can-send-the-phrase)), so the model can't send
  the phrase itself by any of them. The next `watch_event` for the same
  question starts the watch, once. Another watch needs its own yes.
- **Where it's kept.** The record of the question is the plugin's own
  (`muse-confirm.json` in its data folder, private to you).

What this doesn't protect against: the phrase names the server and the event
type, not the filters or the note. For those, you rely on Muse showing you the
question as the answer gives it. After you type the phrase, the hook's note in
Muse's status line names what you approved.

Stopping a watch waits for a typed yes the same way, with its own phrase,
`unwatch <server> <event type> <code>` (`unwatch tickets ticket.created 3307`). The first `unwatch_event` answers with a question that names
the watch, its server, its event type and its note, and stops nothing. Each
phrase approves only its own verb: a `watch` phrase can't stop a watch, and an
`unwatch` phrase can't start one. A call for a watch that isn't there is
refused with nobody asked.

## What it reads

- **Servers.** It reads `mcpServers` in Muse's user settings
  (`~/.config/muse/settings.json`). That list can hold header values you wrote.
  The plugin uses them to connect, as Muse does, and takes known secret values
  out of its log and of anything it shows.
- **Never** Muse's sign-in store, or any token Muse keeps. A server you signed
  in to with `muse mcp login` is left out.
- **Never a project's config:** not a project's `.mcp.json`, and no command
  from one.
- **Commands it starts.** It starts a local server's command only as your user
  settings name it, as Muse itself would. It runs `muse` only for
  `muse config status --json` and, in wake mode, `muse attach --stdio`. It never
  runs it through a shell, and passes it none of the plugin's own settings.
- **Organisation-managed Muse.** If `muse config status` shows a defaults or
  policy plane, or can't be read, the plugin reaches no server, as the Codex
  form does with a managed Codex config.

## What it honours

- **A server switched off** (`enabled: false`) is left out.
- **The plugin's MCP server off.** With it not turned on in Muse (rejected with
  `muse plugins reject`, or never approved), the hook does nothing: it adds
  nothing and writes nothing.
- **An untrusted workspace.** Muse starts no MCP server there, this one
  included.
- **`MCP_EVENTS_OFF`** in the plugin's settings file: no tools, and the hook
  does nothing.

## What is stored

Everything is in the data folder Muse gives the plugin
(`~/.local/share/muse/plugins/data/mcp-events`), private to your user. It
holds:

- each session's watches and stored events, as in Codex;
- where the hook's hand-over stands;
- a stamp of when you last wrote;
- the waiting typed-yes questions;
- in wake mode, batches waiting after an attach failed.

`muse plugins remove mcp-events --delete-data` removes it.

## Waking through `muse attach` (opt-in, experimental)

Off unless you set `MCP_EVENTS_MUSE_WAKE` to `attach` in the plugin's settings
file and start `muse` with `MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1` and
`MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1`.

- **What those gates expose.** With them on, any local process of your user
  can attach to the session as a second driver and start turns, with no
  prompt. Muse runs the `UserPromptSubmit` hook for such a turn as for one you
  typed, so that process could also type a `watch` or `unwatch` phrase. That's Muse's
  behaviour, not this plugin's, and it's why waking is off by default.
- **What the plugin itself does.** It starts only the turns that carry a batch,
  held to the wake limits (once a minute per watch, 30 times an hour, then one
  notice until you next write).
- **Where the turn is seen.** The Codex form wakes a session only once a call
  says Codex's own app shows it, because `codex queue` can start a turn inside
  another app's app server, where nobody sees it. Muse has no such call. Its
  wake is `muse attach` into the session's own process, which only a terminal
  session launched with both gates accepts; in the live run that terminal
  showed the turn. Any other session refuses the attach, and the batch waits
  for your next message. A session driven by some other client through Muse's
  session protocol wasn't tried.

## What it does not protect against

- What Muse does about an event. That's its approvals' call.
- A program of yours that can already drive your session, when the gates are
  on.
- A model that shows you a different question than the one the answer gave,
  for a watch on the same server and event type. The phrase only approves the
  question the plugin recorded, and names its server and event type, but not
  its filters or note.

## Reporting a vulnerability

Privately, through the repository's Security tab, as
[`SECURITY.md`](../../../SECURITY.md) says. Name the host (Muse Code) and its
version.
