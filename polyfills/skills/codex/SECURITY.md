# Security

This plugin puts text from MCP servers in front of a model that can run
commands on your machine. The Skills extension (SEP-2640) says how a client
must handle that, and the plugin follows it;
[`docs/conformance.md`](docs/conformance.md) goes through every rule. This page
is the short account: what the plugin assumes, what it does, and what it does
not protect against.

The principle: content from a server is untrusted data, and Codex's own
approvals are the boundary. Where the extension requires a person's approval,
the plugin puts the question to you through Codex.

## What is trusted

- **You**, and your Codex config (`~/.codex/config.toml`). The plugin connects
  only to the servers in it, and leaves alone the ones you turned off.
- **Codex**: how it shows the plugin's question and returns your answer, and its
  approvals for everything the model does.
- **Not the servers.** A server that serves a skill can serve anything, and its
  digests are its own: a match shows the server is consistent, not honest.

## What the plugin does

**Which servers.** It reads `[mcp_servers.*]` in your Codex config. A server
with `enabled = false`, or one Codex runs in another environment, is left alone.
Where a managed Codex policy says anything about MCP servers
(`/etc/codex/requirements.toml`, `/etc/codex/managed_config.toml`, a macOS
managed-preferences file for Codex, or `%ProgramData%\OpenAI\Codex\requirements.toml`),
it connects to none, because it cannot apply that policy. It never reads Codex's
stored sign-ins (OAuth tokens). Header values from your config are sent only to
the server they are configured for, and are scrubbed from the log.

**What a server can make it do.** Send requests to that same server, and hold
at most 24 MiB for one answer. A skill URI is only ever handed back to the
server it came from; its host part is never resolved.

**What it writes into Codex's skill folders.** For each served skill, one short
`SKILL.md` in the plugin's own folder (`<plugin>/skills/served/`), so that Codex
lists the skill with its others. It holds:

- a name, `<server>:<name>`, which Codex shows as `mcp-skills:<server>:<name>`,
  so a served skill never takes the name of a local one;
- the server's one-line description, with control, zero-width and
  direction-changing characters removed, written as a quoted YAML string that
  cannot add a field, and marked `[MCP server "<server>", not a local skill]`;
- a body in the plugin's own words: this skill is served by that server, and
  is loaded with the `load_skill` tool.

No file of the skill is fetched to write it, and none of the skill's content is
written to disk. Its frontmatter (`allowed-tools` and the rest) never reaches
it. The path names the server and a hash of the skill's URI. The plugin touches
nothing outside `served/`, removes only folders it would have made, and removes
a symbolic link it finds there instead of following it. When a server stops
serving a skill, or you remove the server from your config, its stubs go at the
next start.

**What reaches the model.**

- A skill's description, in Codex's skill list, as above.
- A loaded skill or one of its files: only after its size, SHA-256 digest and
  (for `SKILL.md`) frontmatter matched the server's entry; under a line naming
  the server; inside a marker made per answer that the content cannot close.
- A server's error text: never. Errors are in the plugin's own words.

**What you are asked, and when.** Before a skill is loaded, Codex shows you the
plugin's question: the skill's name, its server (by its name in your config),
its URI, how many files and bytes it has, whether it changed since you last
approved it, and whether it is nested inside another skill. You choose
"Do not load it", "Show me its SKILL.md first" or "Load it". "Show me" fetches
the skill's `SKILL.md`, verifies it, and shows it to you only; the model sees
nothing of it until you choose "Load it".

The question is a form with a required choice. Codex accepts a form by itself
only when it has no fields, so it never answers this one in your place: not
under full access, not by its automatic reviewer. Only "Load it", chosen by
you, loads the skill. A decline, a cancelled or dismissed form, an answer
without that choice, an error, or a Codex that cannot ask at all, is a no.

Your yes is kept in the plugin's store (`~/.codex/mcp-skills/approvals.json`):
the server's name, a fingerprint of where that server is (its URL or command, no
credentials), the skill's URI, and a hash over every file's URI and digest. The
next load of the same skill, from the same place, with the same files, is not
asked about. Anything else is: a file changed, added or removed; the server
moved; a skill nested inside one you approved. A skill whose content the server
generates (no digests) is asked about at every load, and nothing is kept for it.
At most 2,000 approvals are kept. Delete the file to drop them all.

**After your yes,** the skill's text is in the conversation, and what Codex does
next goes through your usual Codex approvals and sandbox, as it would for a
skill on your disk. The plugin adds no questions for commands.

**Where nobody can be asked** (`codex exec`, or the approval policy `never`),
Codex declines every question, so a skill you have not approved before is not
loaded, and nothing of it reaches the model. A skill you approved once in an
interactive session loads there, as long as it is unchanged.

**Skills you turned off.** Codex's own per-skill switch (`[[skills.config]]` in
your config, by the stub's path or its name) is honoured: a skill turned off
there is not in Codex's list, and the plugin's tools refuse to load it or read
its files. The rule is read again at each call.

**What is kept.** In the helper's memory, for the session: the listings, the
entries of loaded skills, and verified file content. On disk, in
`~/.codex/mcp-skills/`: your approvals (above); which of your servers declared
the extension (so the others are connected to at most once a day); a log, private
to you, with your config's secrets scrubbed; and a `settings.json` only if you
write one. In the plugin's folder: the stubs. No skill content and no tokens.

## What it does not protect against

- **Another server's resources, read on a skill's behalf.** The extension says a
  host must ask you, naming both servers, before a skill of one server leads to
  a resource read from another. Codex's own `read_mcp_resource` tool goes past
  this plugin, and a plugin cannot put a question in front of it: Codex hooks
  can only deny a call, and a plugin's hooks lose your trust each time the
  plugin's folder changes, which the stubs do. The loaded skill's text tells
  the model to ask you first; that is an instruction, not a gate. If this
  matters to you, keep such a server out of sessions where you load skills.
- **A skill you approved whose instructions are harmful.** It can tell the model
  to write a file, run a command, or give you bad advice. Those go through
  Codex's ordinary approvals, as they would for text from a tool result. Choose
  "Show me its SKILL.md first" for a skill you do not know.
- **Full access** (`--dangerously-bypass-approvals-and-sandbox`, or the approval
  policy `never` with full access). Not tried live. In the source of Codex
  0.172, a form with a required field is then either shown to you or declined,
  never accepted for you; but once a skill is loaded, nothing else is asked, so
  its text can drive any tool.
- **Your own processes.** The stubs are files in your Codex folder. Anything
  that runs as you could change one; it would change only what the model reads
  about how to load a skill, and every load still goes to the server, is
  verified, and is asked about.
- **The server itself.** Verification catches a file that changed between
  listing and reading. It cannot tell you the skill was safe to begin with.

## Reporting a problem

If you find a way to make the plugin load content it should refuse, read from a
server it should not, skip a question it should raise, or leak a credential,
please report it privately: use "Report a vulnerability" under this
repository's Security tab, rather than a public issue.
