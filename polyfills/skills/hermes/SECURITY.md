# Security

This covers mcp-skills for Hermes. The other forms have their own:
[Codex](../codex/SECURITY.md), [Pi](../pi/SECURITY.md), [OpenCode](../opencode/SECURITY.md).

"The plugin" below means both halves: the Python half Hermes loads in its
gateway (`plugin/__init__.py`) and the helper it starts (`plugin/dist/helper.mjs`,
the Codex form's client rules over [`../core`](../core)).

## The model

A served skill is text from an MCP server that tells the model how to do
something. It's more than data: it's meant to be followed. So it's loaded only
after you say yes to that skill as it is now, it's checked against what the
server published before the model sees it, and once loaded it grants nothing.
What the model does next goes through Hermes's own approvals.

## What the plugin does

- **Listing fetches nothing.** Each served skill gets a short stub of the
  plugin's own, registered with Hermes; Hermes lists it with your skills. The
  stub holds the server's description, with control and invisible characters
  removed and no angle brackets, so it can't open or close a tag of the
  system prompt it's listed in. Stub names are unique after every step, so no
  skill can take another's name.
- **Loading goes through Hermes's approval,** naming the skill, its server, its
  files and their size, and whether it changed since you approved it. The
  approval's key is a digest of where the server is, the skill's URI and its
  manifest hash, so "always" covers that version of that skill only (rule
  X14). A skill whose content the server generates (`"dynamic"`) has no digest,
  so its key holds a fresh nonce and you're asked every time. The load itself
  refuses any version but the one you were asked about, including a static
  skill turning dynamic, even if the server shows one version for the
  question and another to the session. The question ends with
  `/mcp-skills show <server> <uri>`: that command shows you the skill's
  SKILL.md, checked, as a slash command's answer, which the model never sees.
- **Every file is checked** against the size and SHA-256 digest in the skill's
  manifest, and only its own server's files are read.
- **Another server's resources (X8).** While a session holds a skill from one
  server, Hermes asks before any read of a resource from a different server,
  naming both, each time (a fresh random key per read, so no kept approval
  covers another). What a session loaded is kept in Hermes's plugin state
  (`ctx.state`), so a helper or gateway restart doesn't forget it. A read is
  matched to its server by Hermes's own naming of the tool (shortened past 64
  characters); one it can't place surely (names that come out the same, or a
  shortened name it doesn't know) is asked about. It fails closed: if that
  state can't be read, or saving it failed (until a save works), or a call
  names no session while any skill is held, Hermes asks before every resource
  read, of any server; a load from a call that names no session is refused.
- **No served skill where Hermes approves without asking.** With `--yolo`, a
  session's `/yolo`, `hermes -z` or `approvals.mode: off`, Hermes would answer the plugin's
  questions itself. So the plugin refuses the load, and any read from another
  server while a skill is held, before Hermes is asked: rules X5 and X8 need
  your own yes. It evaluates the test Hermes's own approval gate uses, which isn't on
  Hermes's published plugin API. Where it can't (another version of Hermes,
  or the plugin running in Hermes's plugin host process with
  `plugins.isolation: host`), it can't tell, and refuses too.
- **No way around `load_skill`.** Hermes's generic resource tool
  (`mcp__<server>__read_resource`) is refused for a served skill's files (a
  `skill://` URI, or one under a skill a server lists): it would neither ask
  nor check digests.
- **Turned-off skills** (`skills.disabled`) are refused, and none of their
  files read, checked against the skill the URI resolves to as well as the
  URI as spelled.
- **Stubs only for servers it may use.** A server left out (switched off, no
  longer named, signing in through Hermes, taking `${VAR}` from `.env`) loses
  its stubs, so its descriptions leave Hermes's skill list and the system
  prompt; one that is granted but unreachable keeps them.
- **Only the servers you named, only its own profile, no credentials read,**
  as for [mcp-events](../../events/hermes/SECURITY.md#what-the-plugin-does):
  servers named in `plugins.entries.mcp-skills.settings.servers`, read as
  `config.yaml` has them, and none whose entry takes `${VAR}` from `.env`;
  the helper gets an allowlist of the gateway's environment.

## Limits

- **Unattended approve modes** (`approvals.cron_mode`, `single_query_mode`
  or `unattended_mode` set to `approve`) approve loads in those runs, as you
  set them to; the plugin can't tell them apart from a person's yes. A kept
  "session" or "always" answer covers its exact load in those runs too.
- **A loaded skill's text** stays in the conversation as that server's content;
  the model may follow it, as with any skill. It's marked with its server.
- **A second connection,** with the headers in your config, to each granted
  server.

## Reporting

See the repository's [SECURITY.md](../../../SECURITY.md).
