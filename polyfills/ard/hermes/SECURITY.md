# Security

This covers ard-discovery for Hermes. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).
Adding a server goes through the Server Cards logic, whose
[SECURITY.md](../../server-cards/hermes/SECURITY.md) applies here too.

## The model

ARD finds MCP servers two ways. Reading a domain's `/.well-known/ard.json`
sends nothing of yours. Searching a registry sends the words of your request
to a third party, so every search is put to you first.

## What the plugin does

- **Every registry search goes through Hermes's approval,** naming the registry,
  the endpoint and the exact query. A referral to another registry needs an
  approval of its own. A declined search sends no query (the public catalogs
  of a registry's domain may have been read first, to name the endpoint).
- **"Session" and "always" cover that exact query to that endpoint only.**
  The approval's key is a digest of the endpoint, the query and the
  referral, so any other words are asked about again; the question says so.
- **No search and no addition where Hermes approves without asking.** With
  `--yolo`, a session's `/yolo`, `hermes -z` or `approvals.mode: off`, Hermes would answer
  the question itself, so the plugin refuses both before Hermes is asked. It evaluates the test Hermes's own approval gate uses, which isn't on
  Hermes's published plugin API. Where it can't (another version of Hermes,
  or the plugin running in Hermes's plugin host process with
  `plugins.isolation: host`), it can't tell, and refuses too.
  Hermes's unattended approve modes (`approvals.cron_mode`,
  `single_query_mode` or `unattended_mode` set to `approve`) still approve
  searches and additions where nobody is present, as you set them to, and a kept "session"
  or "always" answer covers its exact action in those runs too.
- **Fetching** uses the same connect-time address check as Server Cards: no
  request reaches a private address through a public name.
- **No registry is built in.** You name one, or set `ARD_DISCOVERY_REGISTRY`.
- **What it keeps:** `$HERMES_HOME/ard-discovery/added.json`, the fingerprint
  of each entry it added, for removal. The cards and referrals a session was
  shown are kept in memory, for that session.

## Reporting

See the repository's [SECURITY.md](../../../SECURITY.md).
