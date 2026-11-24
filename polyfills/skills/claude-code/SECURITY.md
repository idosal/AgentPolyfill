# Security

This mod puts text from MCP servers in front of a model that can run commands
on your machine. The Skills extension (SEP-2640) says how a client must handle
that, and the mod follows it; [`docs/conformance.md`](docs/conformance.md) goes
through every rule. This page is the short account: what the mod assumes, what
it does, and what it does not protect against.

The principle: content from a server is untrusted data, and Claude Code's own
permissions are the boundary. The mod adds no policy of its own. Where the
extension requires a person's approval, the mod has Claude Code ask.

## What is trusted

- **You**, and the MCP config you wrote. The mod connects only to servers in
  it, and only to those Claude Code itself uses in the session.
- **Claude Code**: its permission dialog, its rules, its verdict on a server.
- **Not the servers.** A server that serves a skill can serve anything, and its
  digests are its own: a match shows the server is consistent, not honest.

## What the mod does

**Which servers.** It reads the same config files Claude Code reads and asks
Claude Code about each server (`$.mcp.connect`) before connecting. A server that
is switched off, not approved, refused by policy, or waiting for a sign-in is
left alone. A project's `.mcp.json` server counts as approved only by your own
answer or settings, or by the project's settings once you answered the trust
question for that folder itself: in a folder inside one you trusted, the
repository's own settings approve nothing (they can still turn a server off).
That is what Claude Code's documentation says; Claude Code 2.1.329 itself was
seen honouring such a repository's approval, so here the mod is the stricter of
the two. Where a managed MCP policy or an allow or deny list exists, it
connects to nothing, because it cannot apply that policy. It never reads Claude
Code's stored credentials and holds no OAuth tokens. Header values from your
config are sent to the server they are configured for and to nothing else, and
are scrubbed from the log. Variables that hold credentials the environment
happens to carry (cloud keys, `ANTHROPIC_*`, proxies and the like) are never
expanded into a remote server's address or headers.

**What a server can make it do.** Send requests to that same server, and hold
at most 24 MiB for one answer. Nothing a server sends is run, written to disk,
or used as a path. A skill URI is only ever handed back to the server it came
from; its host part is never resolved.

**What reaches the model.**

- A skill's description: one line, control characters removed, bounded, under a
  heading that says these are not local skills, with the server's name.
- A loaded skill or one of its files: only after its size, SHA-256 digest and
  (for `SKILL.md`) frontmatter matched the server's entry; under a line naming
  the server; inside a marker made per answer that the content cannot close.
- A server's error text: never. Errors are in the mod's own words, with the
  JSON-RPC code.
- A skill's frontmatter: never, and it grants nothing. `allowed-tools`, hooks
  and anything else in it are ignored.
- A skill whose URI, or the URI of one of its files, holds anything but
  printable ASCII (a control character, a direction mark, an invisible
  character such as a soft hyphen or a tag character, a space): never. A URI
  is ASCII by RFC 3986. Such an entry is refused, and its URI is not repeated
  even in the note that says so (control and invisible characters from 0.3.3,
  everything but printable ASCII from 0.3.4, in the core shared with the
  Codex form).

**What you are asked, and when.** Every question is put by Claude Code's own
permission dialog. The mod raises it; it does not draw one or decide for you.

- *Before a skill is loaded, once.* The dialog names the server and the
  skill's URI. Your yes is kept in the mod's own store in your Claude Code
  configuration folder, as three things: the server's name, a fingerprint of
  where that server is (its address or command, no credentials), and a hash
  over every file's address and digest. The next load of the same skill, from
  the same place, with the same files, is not asked about. Anything else is:
  a file changed, added or removed; the server moved; a skill nested inside
  one you approved. A skill whose content the server generates (no digests) is
  asked about at every load. `/mcp-skills forget` drops what is kept. At most
  2,000 approvals are kept; past that the oldest are dropped, and those skills
  are asked about again. A yes that cannot be kept (Claude Code's store for a
  mod is full) still loads the skill it was given for. A call is taken to name
  a skill only by its server and URI exactly as given: before 0.3.2 the helper
  trimmed spaces around them, so a padded call skipped this question and loaded
  the skill unapproved (with the refusals below in force).
- *You can read it first.* `/mcp-skills show <skill>` shows the skill's
  `SKILL.md`, verified, in a panel. The panel is not part of the conversation:
  Claude does not read it, and nothing is loaded or approved by opening it.
- *After your yes,* the skill's text is in the conversation, and what Claude
  does next goes through your usual permissions, as it would for a skill on
  your disk. The mod adds no further questions for commands.
- *Before a resource read from any other MCP server,* while any served skill is
  loaded, with both servers named. Until the conversation is cleared.

The questions are the mod's own, so Claude Code puts them to a person: an allow
rule for the tool or auto mode's classifier does not answer them (both seen in
live runs). What can answer in your place is what can answer any permission
question for you: a PermissionRequest hook of your own, or an application that
hosts Claude Code. Bypass-permissions mode has not been tested; see "What it
does not protect against".

**Where nobody can be asked** (`claude -p`, a headless host), there is no
approval to give. A skill then loads only if your own rules allow the load
tool, and loads *unapproved*: the model is told so. While it is loaded, the
mod refuses every tool call except these, whatever your rules allow:

- Claude Code's `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `TodoWrite`,
  `ToolSearch`, `ListMcpResourcesTool` and `AskUserQuestion` (which only puts
  a question to you);
- the mod's own four tools (list skills, load a skill, read a loaded skill's
  file, list its directory);
- a resource read from the skill's own server.

So a command is refused, and so is a file write or edit (a file written now
can be code run later: a hook in a settings file, a git hook, a package
script), a subagent, a web fetch, a tool of any other MCP server, and any tool
this version of the mod does not know. The list names what is let through, not
what is stopped. Seen in a live headless run under the default permission mode:
`Write`, `Edit`, `Bash` and `Agent` refused though allowed by rule, `Read`
allowed ([`docs/evidence/headless.txt`](docs/evidence/headless.txt)). If the
session is later resumed with a person present, each such call is put to them
instead. A skill loaded this way stays unapproved until the conversation is
cleared, even if it is loaded again later with a yes: its earlier text is
still in the conversation, and may differ from what was approved. (Before
0.3.1 the later yes ended the refusals; the model of the gate found this, see
[`docs/verification.md`](docs/verification.md).)

To use a skill fully in headless runs, approve it once in an interactive
session on the same machine. The approval stands while the skill is unchanged,
and a headless run then loads it approved (also seen live).

**What is not asked about.** Reading a file of a loaded skill, listing one of
its directories, and listing skills go ahead without a question, unless a rule
of yours or your organisation's asks for one. They read only from the skill's
own server, only what its manifest lists, and verify it. This matches how
Claude Code treats its own read of an MCP resource.

A loaded skill's own files can be read only through `read_skill_file`, which
verifies them; Claude Code's generic resource tool is refused for them.

**Skills you disabled.** `/mcp-skills disable <skill>` keeps, in the same
store as your approvals, the skill's identity as the extension defines it:
the server's name in your configuration and the URI of its `SKILL.md`. Not
its content, and not the server's address: the skill stays disabled whatever
the server changes in it, and wherever the server moves. From then on, in
every session that uses the same Claude Code configuration folder:

- it is left out of what Claude is offered (the skill listing, `list_skills`);
  a listing the helper made before it was told the latest list is not used;
- `load_skill` for it is refused at the permission check, whatever a rule or
  mode allows, and refused again when the call runs, as are reads of its
  files and directories. The store is read for each of these, so a skill
  disabled in another session is refused here at once, and one disabled while
  a load waited for your answer, or while the helper fetched it, is not handed
  to Claude. The helper asks its server nothing about it;
- where the store cannot be read, nothing served is listed or loaded.

Turning a skill on again (`/mcp-skills enable <skill>`) is honoured only from
your own input, typed or from your own Remote Control: not from Claude, a
script, another session or `claude -p`, since it widens what Claude is
offered. Turning one off is honoured from anywhere. Enabling approves
nothing: the skill is asked about as it would have been. At most 2,000 skills
are kept disabled; past that, a disable is refused, and none is dropped to
make room. A disable that cannot be kept (the store is full) holds in the
session it was made in until Claude Code is restarted, and says so.

Disabling takes nothing back from a conversation. A skill loaded before is
still in it, and the questions Claude Code asks because it is (before a read
from another server; for an unapproved one, before anything but reading and
searching) go on until the conversation is cleared. `/mcp-skills` names the
skills you disabled, by name and server, so it can tell you which; nothing a
server wrote about them is shown there.

**What is kept.** In the helper's memory, for the session: the listings, the
entries of loaded skills, and verified file content. On disk: your approvals
(above); the skills you disabled, by server name and URI; which of your
servers serve skills, by name and fingerprint, so the
others are not connected to at every start; a log (your config's secrets
scrubbed, private to your user); and, if you ran `/mcp-skills setup`, the
mod's own copy of Bun. No skill content, and no tokens.

**The one thing it downloads.** Nothing, unless you run `/mcp-skills setup`
on a machine that has no Node and no Bun, and answer Download to the question
it then puts in Claude Code's own dialog ("Not now" is the first answer, so a
dialog that closes by itself is a no). Then it downloads one fixed Bun
release from GitHub over HTTPS (`curl`, HTTPS also required of any redirect),
hashes the archive inside the mod (no checksum program on your PATH is
trusted), and compares the SHA-256 with the value written in
[`mod/hooks/runtime.ts`](mod/hooks/runtime.ts) for that platform. Only on a
match is one named file unpacked, checked to answer with the expected
version, and moved into the plugin's data folder; otherwise the download is
deleted and nothing of it is run; a file that cannot be deleted is left not
runnable, and you are told where it is. The command is honoured only from your
own input: typed at the prompt, or sent from your own Remote Control. Claude
cannot run it, and neither can a script, another session or `claude -p`. Two sessions cannot fetch at once (the second is told
to wait).
No server, skill or project file can change what is downloaded or from where.
The SHA-256 is checked when the copy is fetched, not each time it runs, and
only the copy of the pinned version is ever run: the mod looks only at that
version's folder, and runs nothing there unless the folder and the program
in it are a real folder and a real file, not symbolic links. A copy of
another version put in that folder is never run, not even to ask its
version, and the next setup deletes it by name. (Before 0.3.2 the mod ran
every such copy once, with `--version`, to learn which were there.) The copy is used only to run this mod's helper;
your PATH and shell profile are not touched; `/mcp-skills setup remove` deletes it. A newer Bun arrives
only with a newer version of the mod, and only when you run the command
again.

**A server's `headersHelper`.** Where a server's entry has one, the mod runs
that command as Claude Code documents it and does itself, to get the headers
for its own connection: only for a server Claude Code uses in the session, for
a project's or local server only in a folder you trusted, and a helper that
came with a repository is not handed `ANTHROPIC_*`, `CLAUDE_*` or
`MCP_SKILLS_*` variables. What it prints is held in memory and scrubbed from
the log.

## What it does not protect against

- **A skill you approved whose instructions are harmful.** It can tell the
  model to write a file, call another server's tool, or give you bad advice.
  Those go through Claude Code's ordinary permissions, exactly as they would
  for text from a tool result. After your yes, the only further question the
  mod raises is for a resource read from another MCP server. Read a skill you
  do not know before approving it (`/mcp-skills show <skill>`).
- **What an unapproved skill makes Claude say or read.** With nobody to ask,
  its text is still in the conversation: it can shape the answer, and have
  Claude read files the session can read. It cannot make Claude change, run or
  send anything through a tool (above).
- **Bypass-permissions mode** (`--dangerously-skip-permissions`). Not tested.
  In that mode Claude Code skips its permission checks. Whether it still
  consults a mod's permission hook, puts a mod's question to you, or honours a
  mod's refusal is not known. Assume that none of the questions and refusals
  on this page hold there: a skill may load without your being asked, and its
  text may then drive any tool. Do not use that mode with a server you do not
  trust.
- **The runtime it runs on.** The helper runs on your Node or Bun, or on the
  Bun release you had it fetch. The checksum shows the download is the file
  its publisher released, not that the release is free of faults; a newer one
  is fetched only with a newer version of the mod and your command.
- **Other mods.** A mod can call tools without a permission check
  (`$.tool.call`). That is Claude Code's design for mods, not something this mod
  can change.
- **A window that is read back incompletely.** After a resume, the loaded
  skills are found by reading the conversation's newest 4,096 messages. A skill
  that only a subagent loaded, or that was loaded further back, is not found,
  and the question about reads from other servers (and, for an unapproved
  skill, the refusal of tool calls) stops for it.
- **The server itself.** Verification catches a file that changed between
  listing and reading. It cannot tell you the skill was safe to begin with.

## Reporting a problem

If you find a way to make the mod load content it should refuse, read from a
server it should not, skip a question it should raise, or leak a credential,
please report it privately: use "Report a vulnerability" under this
repository's Security tab, rather than a public issue. You will get an answer
within a few days. Other bugs are welcome as ordinary issues.
