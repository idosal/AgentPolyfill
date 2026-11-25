# Security

This covers `mcp-server-cards` for GitHub Copilot CLI. The other forms have
their own: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md),
[Pi](../pi/SECURITY.md).
Where this file says nothing different, the Codex form's SECURITY.md applies:
this form runs its MCP server, its fetch and its form code unchanged.

This plugin reads documents that strangers publish on the web: catalogs and
Server Cards. It turns one of those cards into an entry in your Copilot MCP
configuration. What a catalog or card says is someone else's claim, read
before any connection. Copilot's own permissions and sign-in are the boundary,
and the plugin adds no policy of its own beyond asking you.

## What is trusted

- **You.** The servers you accept in the form.
- **Copilot:** its tool prompt, its form, its sign-in, and the `copilot`
  command (the one that started the plugin, `COPILOT_CLI_PATH`).
- **Not the publishers.** A catalog can list anything, and a card can claim
  anything. The SEP says a card is advisory and never authoritative for
  security decisions.
- **Not Copilot's model.** It decides when to call the tools and what to pass.
  Nothing it passes is written without your accept, and a URL is never taken
  from it: only from a card a tool showed in this session.

## What the plugin does

- **What it fetches, and where it won't go,** are as in the Codex form: plain
  `GET`s with no cookies or credentials, bounded answers, no step from a public
  origin to a local or private address, redirects followed by the plugin and
  each hop held to the same rule.
- **Text that displays as something else** is refused as in the Codex form,
  including markup in a header's value, which the form shows as it is.
  Characters that show as nothing (tag characters, variation selectors, a
  soft hyphen, line separators) are taken out of everything shown, and a
  header value that would be written holding one is refused, from a card or
  given: what you're asked about is what is written. These are the shared
  checks in `card.ts` and `configure.ts`.
- **What it writes:** only Copilot's user MCP configuration,
  `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json`), one server
  at a time, and only after your accept, through `copilot mcp add`, run with
  its arguments as a list (no shell), in your session's folder.
  - **Nothing a card says is read as an option.** Every option is written
    `--transport=…` and `--header=…`, so a header (whose name may legally
    start with `-`) is always that option's value. The name is a slug and the
    URL an http(s) address, checked again before the command runs. A card that
    sets one header twice is refused.
  - **Who decides:** you, in the form, which names the server, the URL, the
    headers, the file and the undo command, with a required choice whose first
    option is **Don't add it**.
  - **Where nobody can be asked,** Copilot declines the form. Seen in
    `copilot -p` with `--allow-all-tools` and with `--yolo`: allowing tools
    doesn't answer a form.
  - **Never over yours:** a name `copilot mcp get` knows, or can't rule out,
    is refused before you're asked and again before writing.
  - **Secrets:** never a value. A card's secret becomes a `${VAR}` reference,
    named for that card alone, which Copilot expands from its environment when
    it connects. You set the variable. Nothing a card or the model supplies
    may contain `$`, and a secret may not stand in a URL's host part.
- **Sign-in stays Copilot's.** `copilot mcp add` contacts no server; Copilot
  signs in when it connects (`/mcp auth`). The plugin never reads Copilot's
  stored credentials (the keychain, `~/.copilot/mcp-oauth-config/`, signed-in
  accounts in `config.json`).

## What is stored

Nothing on disk. The cards a session showed are kept in memory, in the
plugin's process, for that session.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-server-cards`
for Copilot.
