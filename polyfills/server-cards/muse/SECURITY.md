# Security

Report a problem privately, as the [repository's SECURITY.md](../../../SECURITY.md)
says.
- **Holds here.** The [Codex form's SECURITY.md](../codex/SECURITY.md) holds
  for discovery, because it is the same code: what it fetches, where it won't
  go, and text that displays as something else.
- **This page** says what differs in Muse.

## The boundary

**Plainly:** Muse offers plugins no approval dialog. Where Claude Code, Codex,
Pi and OpenCode, in a mode that asks, ask you through a prompt the host draws
itself, here adding a server is a command you run yourself: the plugin writes
nothing.

Muse's own configuration is the boundary. Adding a server to it is something
only you do here.

Muse can't be relied on to ask you first:

- **No form.** Muse's MCP client offers no elicitation.
- **The judge.** A tool call that isn't read-only goes to Muse's approval judge,
  a model that can approve with nobody asked.

So `add_mcp_server` writes nothing. Instead:

- **The command.** It answers with the `muse mcp add …` command, for you to run
  yourself.
- **What you see.** Each word that needs it is quoted for a POSIX shell, so the
  command you see is the one that runs, with the URL and every header.
- **No secret values.** A secret is never a value:
  `--bearer-token-env-var VAR`, or a header whose whole value is `${VAR}`.
- **The same checks as Codex:**
  - a card shown in this session;
  - the URL it gives, which must match the URL the model names;
  - a name Muse doesn't have (`muse mcp get`; when that can't say, the name
    counts as taken);
  - the URL and markup rules;
  - no character that shows as nothing in a header value it writes.

  A card that fails them gets no command.

## What it reads and runs

- **Public documents.** It reads only the domain's public documents and the card
  URLs they name, as in every form.
- **No configuration, no sign-ins.** It reads no configuration file of Muse's.
  It never reads Muse's sign-in store, or any token.
- **One command.** It runs `muse` only for `muse mcp get <name> --json`, with
  no shell.

## What it does not protect against

- **A card is a claim.** It's the publisher's word about its server, not a
  check of the server (S-3).
- **What you run is yours.** If you change the command before running it, it
  does what you changed it to.

## Undoing an addition

`muse mcp remove <name>`, as the answer says.

## Reporting

Privately, through the repository's Security tab. Name the host (Muse Code)
and its version.
