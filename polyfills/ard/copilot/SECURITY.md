# Security

This covers `ard-discovery` for GitHub Copilot CLI. The other forms have their
own: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md),
[Pi](../pi/SECURITY.md).

This plugin runs the Codex form's tools unchanged, with Copilot's name and
Copilot's `add_mcp_server`. So the Codex form's SECURITY.md applies here as it
stands: what is trusted, what a search sends and to whom (one `POST` of the
query to the registry you name or set, and to at most three it refers to, one
hop, only after you accept that search in the form), what is shown, and what
isn't followed. For adding a server, [`mcp-server-cards` for
Copilot](../../server-cards/copilot/SECURITY.md) applies: only Copilot's user
MCP configuration, through `copilot mcp add`, after your accept, with secrets
as `${VAR}` references, never values.

What is particular to Copilot:

- **Two questions.** Copilot's own tool prompt comes first, then the plugin's
  form. Only the form's **Send the search** sends, and only **Add it** adds.
  Nothing is approved for you.
- **`ard_search` is marked not read-only.** It sends your words to a third
  party, so a permission rule in Copilot (or VS Code) that trusts read-only
  tools doesn't let it through on that account. `ard_discover` is read-only:
  it fetches public documents from the domain you name.
- **What is sent is what the form shows.** A query or registry holding a
  character that shows as nothing (tag characters, variation selectors, a
  soft hyphen, a blank Braille pattern), a control character, a direction
  mark or markup is refused before you're asked. A registry's own words (its
  errors, result names and descriptions) reach the answer as one line each,
  with such characters taken out. Both are main's shared checks
  (`registry.ts`).
- **Where nobody can be asked,** Copilot declines the form: seen in
  `copilot -p` with `--allow-all-tools` and with `--yolo`.
- **Nothing on disk.** What a session found is kept in the plugin's memory for
  that session.
- **It never reads Copilot's stored credentials** (the keychain,
  `~/.copilot/mcp-oauth-config/`, signed-in accounts in `config.json`).

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `ard-discovery`
for Copilot.
