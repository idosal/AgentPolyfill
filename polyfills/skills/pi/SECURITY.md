# Security

This covers `mcp-skills` for Pi. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

The extension puts text from MCP servers in front of a model that can run
commands on your machine. The Skills extension (SEP-2640) says how a client
must handle that, and the extension follows it; the rules are gone through one
by one in the Claude Code form's [`docs/conformance.md`](../claude-code/docs/conformance.md),
and [README: Spec and conformance](README.md#spec-and-conformance) says what
differs on Pi. This page is the short account: what the extension assumes,
what it does, and what it doesn't protect against.

The principle: content from a server is untrusted data. Where the extension
requires a person's approval, the extension asks you in a Pi dialog. Beyond
that, Pi's own security model applies: Pi runs with your account's
permissions and runs tool calls without asking unless a permission extension
asks, so the boundary is what you let Pi reach.

## What is trusted

- **You**, and Pi's MCP configuration. The extension reaches only the servers
  Pi connects (`mcp.json` in Pi's agent directory, a trusted project's
  `.pi/mcp.json`, and servers other extensions register), and leaves alone the
  ones you turned off or hid.
- **Pi**: how it shows the extension's dialogs and returns your answer.
- **Not the servers.** A server that serves a skill can serve anything, and its
  digests are its own. A match shows the server is consistent, not that it's
  honest.

## What the extension does

### Which servers, and with what

It never reads Pi's stored sign-ins (`mcp-auth.json`, `auth.json`). Header and
`env` values from your configuration (written out, `${VARIABLE}`, or a
`!command` run through your shell, as Pi runs it) are sent only to the server
they're configured for, and scrubbed from the log and from what the model
reads. A server you sign in to through Pi is left alone on Pi 1.6.0. On a Pi
that lends its connection (a change to Pi we prototyped, which adds
`pi.getMcpServerSession()`), the extension uses Pi's connection, and Pi attaches the credential to each
request: the extension still sees no token.

### What a server can make it do

A server can make the extension send requests to that same server, and hold
at most 24 MiB for one answer. A skill URI is only ever handed back to the
server it came from, and its host part is never resolved.

### What it writes, and what Pi lists

For each served skill, the extension writes one short `SKILL.md`, a stub, in
its own folder (`served/` in its state folder), and gives Pi that folder when
Pi asks extensions for skill folders. The stub holds the skill's name
(`mcp-<server>-<name>`), the description from the server's listing marked with
the server's name (and cleaned of control and invisible characters), and a
body in the extension's own words that says how to load it. Nothing of the
skill's files is fetched to write it, and none is written to disk. The
folders are named by hashes, never by anything a server sent; only folders of
that shape are removed, and a symbolic link found there is removed, never
followed. Pi lists the stubs only while the extension is loaded.

### Loading a skill

- **Your yes, for exactly what you were asked about.** `load_skill` reads the
  server's current entry for the skill, and asks you, naming the skill, its
  server, its URI, how many files and bytes it has, and whether it changed
  since you last approved it. What's loaded is that entry, or nothing: if the
  skill changes on the server while you're asked, it isn't loaded.
- **"Show me its SKILL.md first"** shows you the text, checked against its
  digest, with every line marked so the server's text can't pass for the
  question's; the model sees none of it.
- **Your yes is kept** for that skill from that place with exactly those files
  (every file's URI and digest). A change is asked about again.
- **Verified before use.** Every file is checked against the size and SHA-256
  digest in the skill's entry, and `SKILL.md`'s frontmatter against the
  entry's, before any of it reaches the model. A skill whose server generates
  its content (`"dynamic"`) can't be verified: you're told so, and asked at
  every load.
- **Marked as the server's.** The text arrives as a tool result, inside a
  fence the server can't close, saying it's that server's content and not a
  local skill. Its frontmatter grants nothing (`allowed-tools` is ignored).

### While a skill is loaded

- Its files are read only from its own server, and only those its entry lists.
- **A read of another server's resource is asked about** (SEP-2640 X8): while
  a served skill is loaded, Pi's `read_mcp_resource` against any other server
  is put to you, naming both servers, or refused where nobody can be asked.
  Pi runs that check for the model's calls and for codemode's nested calls
  alike.

## What is stored

In `mcp-skills/` in Pi's agent directory (or `MCP_SKILLS_STATE`), private to
you: the stubs, your approvals (server, where it is, URI and a hash over the
files' URIs and digests), which servers declared the extension, your own
settings file if you write one, and a log with secrets taken out. No skill
content and no tokens.

## What it does not protect against

- **A server you approved a skill from that serves harmful instructions.** The
  digests only show the server is consistent. Read a skill before you load it
  when you're unsure.
- **What Pi does after you approve a skill.** Pi runs tool calls without
  asking unless something you installed asks.
- **A resource read another extension makes on its own connection.** The X8
  question covers Pi's `read_mcp_resource`, not other extensions' own clients.
- **Other extensions**, which run in Pi's process with the same permissions.
- **Someone who can read your files.**

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-skills` for
Pi.
