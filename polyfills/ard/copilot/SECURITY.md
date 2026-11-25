# Security

This covers `ard-discovery` for GitHub Copilot CLI. The other forms have their
own: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md),
[Pi](../pi/SECURITY.md).

This plugin runs the Codex form's tools unchanged, with Copilot's name and
Copilot's `add_mcp_server`. So the Codex form's SECURITY.md applies here for
what a search sends and to whom (one `POST` of the
query to the registry you name or set, and to at most three it refers to, one
hop, only after you accept that search in the form), what is shown, and what
isn't followed. Its statements about Codex's own modes and approvals don't
apply here; what Copilot does is below. For adding a server,
[`mcp-server-cards` for Copilot](../../server-cards/copilot/SECURITY.md)
applies in full: only Copilot's user MCP configuration, through
`copilot mcp add`, after your accept, with secrets as `${VAR}` references,
never values; the same `copilot` command, found the same way (an absolute path
only); names checked with `copilot mcp get` in your session's folder, never by
reading `mcp-config.json`; and a failed add's error output (up to 600
characters) returned to the model.

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
- **Where nobody can be asked,** Copilot declines the form. Checked in
  Copilot CLI 1.0.115 with the Server Cards plugin's add form, in `copilot -p`
  with `--allow-all-tools` and with `--yolo`. Not checked with the search
  form, which is the same kind of request (an MCP elicitation form).
- **Copilot's modes and the form.** In the interactive session, `--yolo`,
  `--allow-all-tools` and allow-all skip Copilot's tool prompt; whether
  Copilot still shows the form there, and what autopilot mode does with it,
  weren't checked.
- **Nothing on disk,** unless you set `ARD_DISCOVERY_LOG` (or
  `MCP_SERVER_CARDS_LOG`): then a log of the plugin's steps goes to that file,
  with no header values and no environment. What a session found is kept in
  the plugin's memory for that session.
- **It never reads Copilot's stored credentials** (the keychain,
  `~/.copilot/mcp-oauth-config/`, signed-in accounts in `config.json`).

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `ard-discovery`
for Copilot.
