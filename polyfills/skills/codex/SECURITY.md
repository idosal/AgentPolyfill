# Security

This covers `mcp-skills` for Codex. The Claude Code form has its own:
[SECURITY.md](../claude-code/SECURITY.md).

The plugin puts text from MCP servers in front of a model that can run
commands on your machine. The Skills extension (SEP-2640) says how a client
must handle that, and the plugin follows it, except for one rule, X8, which
needs a change in Codex (see
[What it does not protect against](#what-it-does-not-protect-against)).
[`docs/conformance.md`](docs/conformance.md) goes through every rule. This page
is the short account: what the plugin assumes, what it does, and what it
doesn't protect against.

The principle: content from a server is untrusted data, and Codex's own
approvals are the boundary. Where the extension requires a person's approval,
the plugin puts the question to you through Codex.

## What is trusted

- **You**, and your Codex config (`~/.codex/config.toml`). The plugin connects
  only to the servers in it, and leaves alone the ones you turned off.
- **Codex**: how it shows the plugin's question and returns your answer, and
  its approvals for everything the model does.
- **Not the servers.** A server that serves a skill can serve anything, and its
  digests are its own. A match shows the server is consistent, not that it's
  honest.

## What the plugin does

### Which servers

It reads `[mcp_servers.*]` in your Codex config. It leaves alone a server with
`enabled = false`, or one Codex runs in another environment.

Where a managed Codex policy says anything about MCP servers, the plugin
connects to none, because it can't apply that policy. It looks for that policy
in `/etc/codex/requirements.toml`, `/etc/codex/managed_config.toml`, a macOS
managed-preferences file for Codex, and
`%ProgramData%\OpenAI\Codex\requirements.toml`.

It never reads Codex's stored sign-ins (OAuth tokens). Header values from your
config are sent only to the server they're configured for, and they're
scrubbed from the log.

### What a server can make it do

A server can make the plugin send requests to that same server, and hold at
most 24 MiB for one answer. A skill URI is only ever handed back to the server
it came from, and its host part is never resolved.

### What it writes into Codex's skill folders

For each served skill, the plugin writes one short `SKILL.md`, a stub, so that
Codex lists the skill with its others. From 0.1.5 the stubs are **outside the
plugin's folder**, in a folder of the plugin's own in your user skills folder:

    ~/.agents/skills/mcp-skills-served/<server>-<6 hex>/<16 hex of the skill's URI>/SKILL.md

(`~` is your `HOME`.) Up to 0.1.4 they were in the plugin's folder, which Codex
replaces on every marketplace update, so they vanished; the plugin now removes
any it finds there. The stub holds:

- a name, `mcp-skills:<server>:<name>`, so a served skill never takes the name
  of a local one;
- the server's one-line description, with control, zero-width and
  direction-changing characters removed (see the full list under
  [What reaches the model](#what-reaches-the-model)), written as a quoted YAML
  string that can't add a field, and marked
  `[MCP server "<server>", not a local skill]`;
- a body in the plugin's own words: this skill is served by that server, and
  it's loaded with the `load_skill` tool.

No file of the skill is fetched to write the stub, and none of the skill's
content is written to disk. The skill's frontmatter (`allowed-tools` and the
rest) never reaches the stub. The stub's path names the server and a hash of
the skill's URI.

The plugin creates `mcp-skills-served` and touches nothing outside it: not your
own skills in `~/.agents/skills`, not anything else there. Inside it, it
writes and removes only folders of the stubs' shape, and it removes a symbolic
link it finds there instead of following it. When a server stops serving a
skill, or you remove the server from your config, its stubs go at the next
start. Two things follow from the folder's place:

- **Other programs** that read `~/.agents/skills` see the stubs too. Each stub
  is the plugin's own text plus the server's one-line description, and says it
  can be loaded only through Codex's `mcp-skills` tool; it holds nothing of the
  skill's content.
- **Removing the plugin leaves the folder.** Delete
  `~/.agents/skills/mcp-skills-served` yourself; Codex would otherwise go on
  listing the stubs, and a load would fail for want of the tool.

The plugin's MCP server tells Codex, when it starts, not to keep its tool list
between sessions (the experimental `codex/tool-catalog-cache` capability, with
`cacheable: false`). Without that, a running app-server daemon puts off
starting it until one of its tools is called, and no stubs are written. It
changes nothing about what the server may do, and Codex asks it for its tools
again in each session. The server isn't marked required, so a session still
starts when the server can't (for instance without Node).

### What reaches the model

- **A skill's description,** in Codex's skill list and in `list_skills`: on one
  line, with control characters and every default-ignorable code point
  removed. Those are zero-width and direction marks, the soft hyphen, the
  combining grapheme joiner, the fillers, variation selectors and tag
  characters. The whole class is removed from 0.1.3.
- **A loaded skill, or one of its files:** only after its size, SHA-256 digest
  and (for `SKILL.md`) frontmatter matched the server's entry. It comes under a
  line naming the server, inside a marker made for each answer that the
  content can't close.
- **A loaded skill or file that holds hidden characters** (default-ignorable
  code points: tag characters can spell text, and a variation selector can
  carry a byte): delivered as the server sent them, since they're part of the
  verified content. A line tells the model how many there are, and that
  whatever they spell is the server's text, not the user's.
- **A server's error text:** never. Errors are in the plugin's own words.
- **A skill whose URI, or the URI of one of its files, holds anything but
  printable ASCII:** never. That rules out:
  - control characters (C0, DEL, C1), which a terminal could act on: erase a
    line of the question, move the cursor, set the clipboard;
  - direction marks and invisible characters (the soft hyphen, fillers, tag
    characters that can carry hidden text), which make a URI read other than
    it is;
  - spaces.

  A URI is ASCII by RFC 3986: every other character is percent-encoded. Such
  an entry is refused, and its URI isn't repeated even in the note that says
  so. Control, direction and zero-width characters are refused from 0.1.1, and
  everything but printable ASCII from 0.1.2. The same rule holds in the Claude
  Code form from 0.3.3 and 0.3.4.

### The preview you can read before deciding

"Show me its SKILL.md first" shows you the skill's `SKILL.md` with:

- control characters removed, and line breaks and tabs kept. From 0.1.4, the
  line and paragraph separators (U+2028 and U+2029) become line breaks;
- each run of hidden characters shown as a marker with its count, such as
  `⟦3 hidden characters⟧`, so text the model would read is never invisible to
  you there (from 0.1.3).

The text sits between two marker lines that carry an id made for that one
preview, and each line of the server's text is marked `│ `. A `SKILL.md` can't
write a marker line of its own: whatever it writes stays marked as its text.

### What you're asked, and when

Before a skill is loaded, Codex shows you the plugin's question. It gives the
skill's name, its server (by its name in your config), its URI, how many files
and bytes it has, whether it changed since you last approved it, and whether
it's nested inside another skill. You choose "Do not load it", "Show me its
SKILL.md first" or "Load it". "Show me" fetches the skill's `SKILL.md`,
verifies it, and shows it to you only. The model sees nothing of it until you
choose "Load it".

The question is a form with a required choice. In Codex 0.172's source
(`codex-mcp/src/elicitation.rs`), Codex accepts a form by itself only when it
has no fields, so it doesn't answer this one in your place: not under full
access, and not by its automatic reviewer. That is a reading of the source;
full access was not tried live (see below). Only "Load it", chosen by you,
loads the skill. Everything else is a no: a decline, a cancelled or dismissed
form, an answer without that choice, an error, or a Codex that can't ask at
all.

Your yes is kept in the plugin's store (`~/.codex/mcp-skills/approvals.json`):
the server's name, a fingerprint of where that server is (its URL or command,
with no credentials), the skill's URI, and a hash over every file's URI and
digest.

- The next load of the same skill, from the same place, with the same files,
  isn't asked about.
- Anything else is: a file changed, added or removed; the server moved; a
  skill nested inside one you approved.
- A skill whose content the server generates (it has no digests) is asked
  about at every load, and nothing is kept for it.
- At most 2,000 approvals are kept. Delete the file to drop them all.

**After your yes,** the skill's text is in the conversation, and what Codex
does next goes through your usual Codex approvals and sandbox, as it would for
a skill on your disk. The plugin adds no questions for commands.

### Where nobody can be asked

In `codex exec`, or with the approval policy `never`, Codex declines every
question. So a skill you haven't approved before isn't loaded, and nothing of
it reaches the model. A skill you approved once in an interactive session
loads there, as long as it's unchanged.

### Skills you turned off

Codex's own per-skill switch (`[[skills.config]]` in your config, by the
stub's path or its name) is honoured. A skill turned off there isn't in
Codex's list, and the plugin's tools refuse to load it or read its files. The
rule is read again at each call.

### What is kept

In the helper's memory, for the session: the listings, the entries of loaded
skills, and verified file content.

On disk, in `~/.codex/mcp-skills/`:

- your approvals (above);
- which of your servers declared the extension, so the others are connected
  to at most once a day;
- a log, private to you, with your config's secrets scrubbed;
- a `settings.json`, only if you write one.

In `~/.agents/skills/mcp-skills-served`: the stubs. No skill content, and no
tokens.

## What it does not protect against

- **Another server's resources, read on a skill's behalf (rule X8).** The
  extension says a host must ask you, naming both servers, before a skill of
  one server leads to a resource read from another. Codex's own
  `read_mcp_resource` tool goes past this plugin, and a plugin can't put a
  question in front of it. Codex hooks can only deny a call, and a plugin's
  hooks lose your trust each time the plugin's folder changes, which the stubs
  do. The loaded skill's text tells the model to ask you first, but that's an
  instruction, not a gate. If this matters to you, keep such a server out of
  sessions where you load skills.
- **A skill you approved whose instructions are harmful.** It can tell the
  model to write a file, run a command, or give you bad advice. Those go
  through Codex's ordinary approvals, as they would for text from a tool
  result. Choose "Show me its SKILL.md first" for a skill you don't know.
- **Full access** (`--dangerously-bypass-approvals-and-sandbox`, or the
  approval policy `never` with full access). Not tried live. In the source of
  Codex 0.172, a form with a required field is then either shown to you or
  declined, never accepted for you. But once a skill is loaded, nothing else is
  asked, so its text can drive any tool.
- **Your own processes.** The stubs are files in your Codex folder. Anything
  that runs as you could change one. It would change only what the model reads
  about how to load a skill: every load still goes to the server, is verified,
  and is asked about.
- **The server itself.** Verification catches a file that changed between
  listing and reading. It can't tell you the skill was safe to begin with.

## Reporting a problem

If you find a way to make the plugin load content it should refuse, read from
a server it shouldn't, skip a question it should raise, or leak a credential,
please report it privately. Use "Report a vulnerability" under this
repository's Security tab, rather than a public issue.
