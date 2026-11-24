# Security

This covers `ard-discovery` for GitHub Copilot CLI. The other forms have their
own: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

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
- **Where nobody can be asked,** Copilot declines the form: seen in
  `copilot -p` with `--allow-all-tools` and with `--yolo`.
- **Nothing on disk.** What a session found is kept in the plugin's memory for
  that session.
- **It never reads Copilot's stored credentials.**

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `ard-discovery`
for Copilot.
