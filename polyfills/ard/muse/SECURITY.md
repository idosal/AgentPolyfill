# Security

Report a problem privately, as the [repository's SECURITY.md](../../../SECURITY.md)
says. Discovery is the [Codex form's](../codex/SECURITY.md), with the same code.

## What differs in Muse

- **No search.** A registry search sends your query to a third party, so it
  must ask you first. Muse gives a plugin no way to ask: no elicitation, and an
  approval judge that is a model. So `ard_search` isn't offered: it isn't
  listed, and a call to it is refused. Nothing is ever sent to a registry from
  Muse.
- **Discovery** by domain sends only GETs, to the domain you name and the card
  URLs it lists, as in every form.
- **`add_mcp_server`** writes nothing. It answers with the `muse mcp add …`
  command for you to run yourself, as described in
  [mcp-server-cards' Muse security notes](../../server-cards/muse/SECURITY.md).
- **It reads** no configuration file of Muse's and no sign-in store. It runs
  `muse` only for `muse mcp get <name> --json`, with no shell.

## Reporting

Privately, through the repository's Security tab. Name the host (Muse Code)
and its version.
