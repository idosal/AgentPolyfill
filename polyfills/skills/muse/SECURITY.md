# Security

Report a problem privately, as the [repository's SECURITY.md](../../../SECURITY.md)
says.
- **Holds here.** Everything in the [Codex form's SECURITY.md](../codex/SECURITY.md)
  about a served skill holds in Muse, because it is the same code: what reaches
  the model, digests, what is kept, what a server can make it do.
- **This page** says what differs in Muse.

## The boundary

**Plainly:** Muse offers plugins no approval dialog. Where this polyfill's
forms for Codex, Pi and OpenCode, in a mode that asks, show you a prompt the
host draws itself, which the model can't answer (and where Codex can't ask, a
skill you haven't approved isn't loaded), here consent is a phrase you type,
checked by the plugin's `UserPromptSubmit` hook. That holds because Muse ran the hook for the messages
you typed, and none of the ways a model can put text into a session (scheduled
prompts, monitors, subagents, other sessions, goals, workflows) ran it when
each was
[checked](../../events/muse/docs/live-run.md#what-can-send-the-phrase). The
weaker part: you read the question as the model relays it, so the phrase names
what it approves.

Loading a skill puts a server's text into the conversation, so it waits for
your yes. Muse can't be relied on to ask:

- **No elicitation.** Its MCP client offers none.
- **The judge.** A tool call that isn't read-only, or a hook's `ask`, goes to
  Muse's approval judge, a model that can approve with nobody asked.

So `load_skill` records the question for the session with a four-digit code.
It answers with the question and the phrase `load <server> <skill> <code>`
(`load github git-workflow 4821`). It names the server and the skill, so you type the names of what you
approve. A skill whose server or name has anything but letters, digits and
`._:/@+-` isn't asked about: its name couldn't be typed plainly.

- **Who can approve.** The plugin's `UserPromptSubmit` hook approves the
  question only when a message of yours is exactly that phrase, in the same
  session, within 15 minutes. Muse ran that hook for your messages. None of
  the ways a model can put text into a session ran it when each was tried
  ([mcp-events' live
  runs](../../events/muse/docs/live-run.md#what-can-send-the-phrase)), so the
  model can't send the phrase by any of them.
- **What a yes covers.** The next `load_skill` of that question loads it, once.
  After that the approval is kept as in Codex: bound to the skill's URI, its
  server and its digests, and asked again when they change.
- **No preview.** "Show me its SKILL.md first" isn't offered. Muse has no way to
  show you text the model doesn't see, so there is nothing to choose it with.

What it doesn't protect against: the phrase names the server and the skill,
not its URI or files. For those, you rely on Muse showing you the question as
the answer gives it. The hook's note in
Muse's status line names what you approved, after you type it.

**Cross-server reads (X8).** Muse gives the model no tool that reads an MCP
resource: its 32 built-in tools include none, as checked. This plugin's
`read_skill_file` reads only from the skill's own server. So a served skill
can't have another server's resources read on its behalf in Muse.

## What it writes

- **The stubs.** It writes them to Muse's own skill folder, `~/.config/muse/skills`,
  one folder each, named `mcp-skills-served--…`. It writes or removes only
  folders of that shape, and nothing else there. A symbolic link in their place
  is removed, never followed. Codex doesn't read that folder.
- **Its store** is the plugin's data folder,
  `~/.local/share/muse/plugins/data/mcp-skills`, private to you: approvals,
  server notes, the waiting questions, its log. No skill content is kept.

## What it reads

- **Servers:** `mcpServers` in Muse's user settings (`~/.config/muse/settings.json`).
  That list can hold header values you wrote. The plugin uses them to connect,
  as Muse does, and takes them out of its log.
- **Never** Muse's sign-in store, or any token Muse keeps. A server you signed
  in to with `muse mcp login` is left out.
- **Never** a project's `.mcp.json`, and no command from one.
- **Organisation-managed Muse.** Where `muse config status` shows a defaults or
  policy plane, or can't be read, no server is reached.
- **Running `muse`.** It runs `muse` only for `muse config status --json`, with
  no shell.

## What it honours

- **A server switched off** (`enabled: false`) is left out.
- **The plugin's MCP server off.** With it rejected or not approved, the hook
  does nothing.
- **An untrusted workspace.** Muse starts no MCP server there.
- **`"off": true`** in the plugin's settings.

## With Muse's session-protocol gates on

With `MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1`,
any local process of your user can attach to the session and start a turn.
Muse treats such a turn like one you typed, so that process could send the
phrase too. These gates are off by default. This plugin never needs them.

## Reporting a problem

Privately, through the repository's Security tab. Name the host (Muse Code)
and its version.
