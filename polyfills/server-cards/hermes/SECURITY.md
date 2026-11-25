# Security

This covers mcp-server-cards for Hermes. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

## The model

A Server Card is a public document a domain publishes about its MCP servers.
It's advisory: it can be wrong, stale or hostile. Reading one grants nothing,
and the only thing the plugin changes is Hermes's own `config.yaml`, after you
approve that exact change.

## What the plugin does

- **Discovery reads public documents**, over HTTPS (HTTP only on loopback),
  and never follows a redirect from a public origin to a private one. The
  address it connects to is checked when it connects: a public name that
  resolves to a private, loopback or link-local address is refused, so DNS
  can't turn discovery into a request to your network. An address on this
  machine or your network named in the call itself (`localhost:8080`,
  `10.0.0.5`) is read: that's how a local server's card is found, and the
  call names it.
- **Adding goes through Hermes's approval,** which names the server and the
  host, and shows the whole entry (the URL, each header with its value, a
  secret only as its `${VAR}` reference, the transport and every other
  setting), the card it comes from and where it was found, the file written,
  and how to undo it. The approval's key is a digest of all of that, so a kept
  answer covers that exact addition only. A decline writes nothing.
- **No addition where Hermes approves without asking.** With `--yolo`, a
  session's `/yolo`, `hermes -z` or `approvals.mode: off`, Hermes would answer the
  question itself, so the plugin refuses an addition before Hermes is asked;
  a removal still goes to Hermes. It evaluates the test Hermes's own approval gate uses, which isn't on
  Hermes's published plugin API. Where it can't (another version of Hermes,
  or the plugin running in Hermes's plugin host process with
  `plugins.isolation: host`), it can't tell, and refuses too.
  Hermes's unattended approve modes (`approvals.cron_mode`,
  `single_query_mode` or `unattended_mode` set to `approve`) still approve
  additions where nobody is present, as you set them to, and a kept "session"
  or "always" answer covers its exact action in those runs too.
- **Nothing secret is written.** A card input marked secret becomes a `${VAR}`
  reference for you to put in Hermes's `.env`; a header that looks like a
  credential with a literal value is refused. A header that would route the
  connection elsewhere (`Host`, `Forwarded`, `X-Forwarded-Host` and the like)
  is refused.
- **OAuth is Hermes's.** After approval, an anonymous `initialize` to the exact
  endpoint (no redirects, no credentials) may detect an OAuth challenge and
  write `auth: oauth`; you then sign in with `hermes mcp login`. The plugin
  never handles tokens.
- **Removal** deletes only an unchanged entry this plugin added, from its own
  record of what it added. Writes go through Hermes's config API under its
  config lock, and keep everything else in the file as it was.
- **Hermes's own errors don't reach the model.** When `config.yaml` can't be
  read or saved, the answer is fixed text: Hermes's message can quote a line
  of the file, a secret's value included.
- **What it keeps:** `$HERMES_HOME/mcp-server-cards/added.json`, the
  fingerprint of each entry it added, for removal. What it discovered is
  kept in memory, for the session.

## Limits

- **The card isn't compared with the live server** (`server/discover`); Hermes
  checks the server when it connects.
- **Connecting is a separate step** (`/reload-mcp` or a new session).
- **Hermes's own connection isn't address-checked.** The check above covers
  the plugin's fetches. When Hermes connects to an added server, it resolves
  the name itself: one that resolved to a public address when you added it
  and resolves to a private one later is connected as it resolves then.
- **A same-name entry written in between is replaced.** The plugin checks that
  the name is free, then Hermes saves the entry, merged into the file as it
  is at that moment. An entry of the same name written between the two (by an
  editor, or `hermes mcp add`) would be replaced by this one. The window is
  one save.

## Reporting

See the repository's [SECURITY.md](../../../SECURITY.md).
