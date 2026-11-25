# Security

This covers `mcp-skills` for Claude Code. The other forms have their own:
[Codex](../codex/SECURITY.md), [Pi](../pi/SECURITY.md), [OpenCode](../opencode/SECURITY.md).

The mod puts text from MCP servers in front of a model that can run commands
on your machine. The Skills extension (SEP-2640) says how a client must handle
that, and the mod follows it. [`docs/conformance.md`](docs/conformance.md) goes
through every rule. This page is the short account: what the mod assumes, what
it does, and what it doesn't protect against.

The principle: content from a server is untrusted data, and Claude Code's own
permissions are the boundary. The mod adds no policy of its own. Where the
extension requires a person's approval, the mod has Claude Code ask.

## What is trusted

- **You**, and the MCP config you wrote. The mod connects only to servers in
  it, and only to those Claude Code itself uses in the session.
- **Claude Code**: its permission dialog, its rules, and its verdict on a
  server.
- **Not the servers.** A server that serves a skill can serve anything, and its
  digests are its own. A match shows the server is consistent, not that it's
  honest.

## What the mod does

### Which servers

It reads the same config files Claude Code reads, and asks Claude Code about
each server (`$.mcp.connect`) before connecting. It leaves alone a server that
is switched off, not approved, refused by policy, or waiting for a sign-in.

A project's `.mcp.json` server counts as approved only by your own answer or
settings, or by the project's settings once you've answered the trust question
for that folder itself. In a folder inside one you trusted, the repository's
own settings approve nothing, though they can still turn a server off. That's
what Claude Code's documentation says. Claude Code 2.1.329 itself was seen
honouring such a repository's approval, so here the mod is the stricter of the
two.

Where a managed MCP policy, or an allow or deny list, exists, the mod connects
to nothing, because it can't apply that policy.

It never reads Claude Code's stored credentials, and it holds no OAuth tokens.
Header values from your config are sent to the server they're configured for
and to nothing else, and they're scrubbed from the log. Variables that hold
credentials the environment happens to carry (cloud keys, `ANTHROPIC_*`,
proxies and the like) are never expanded into a remote server's address or
headers.

### What a server can make it do

A server can make the mod send requests to that same server, and hold at most
24 MiB for one answer. Nothing a server sends is run, written to disk, or used
as a path. A skill URI is only ever handed back to the server it came from,
and its host part is never resolved.

### What reaches the model

- **A skill's description:** one line, with control characters removed, and
  bounded, under a heading that says these aren't local skills, with
  the server's name.
- **A loaded skill, or one of its files:** only after its size, SHA-256 digest
  and (for `SKILL.md`) frontmatter matched the server's entry. It comes under a
  line naming the server, inside a marker made for each answer that the
  content can't close.
- **A server's error text:** never. Errors are in the mod's own words, with the
  JSON-RPC code.
- **A binary file's media type:** only when the server's whole value is a media
  type (`image/png`); anything else is left out. Before 0.3.6 a value that only
  began as one was printed as given.
- **A file with control characters a terminal acts on** (ESC, the C1 set, DEL
  and the like; not tabs or line breaks): never as text. It is treated as a
  binary file and not shown. Nothing is stripped to make it showable: what was
  verified is what is shown, or nothing is. Before 0.3.6 ESC and four more passed
  as text.
- **A skill's frontmatter:** never, and it grants nothing. `allowed-tools`,
  hooks and anything else in it are ignored.
- **A skill whose URI, or the URI of one of its files, holds anything but
  printable ASCII:** never. That covers a control character, a direction mark,
  an invisible character such as a soft hyphen or a tag character, and a
  space. A URI is ASCII by RFC 3986. Such an entry is refused, and its URI isn't
  repeated even in the note that says so. Control and invisible characters are
  refused from 0.3.3, and everything but printable ASCII from 0.3.4, in the
  core shared with the Codex form.

### What you're asked, and when

Every question comes from Claude Code's own permission dialog. The mod raises
it. It doesn't draw a dialog of its own, or decide for you.

- **Before a skill is loaded, once.** The dialog names the server and the
  skill's URI. Your yes is kept in the mod's own store in your Claude Code
  configuration folder, as three things: the server's name, a fingerprint of
  where that server is (its address or command, with no credentials), and a
  hash over every file's address and digest.
  - The next load of the same skill, from the same place, with the same files,
    isn't asked about.
  - Anything else is: a file changed, added or removed; the server moved; a
    skill nested inside one you approved.
  - A skill whose content the server generates (it has no digests) is asked
    about at every load.
  - `/mcp-skills forget` drops what's kept. At most 2,000 approvals are kept.
    Past that, the oldest are dropped, and those skills are asked about again.
  - A yes that can't be kept, because Claude Code's store for a mod is full,
    still loads the skill it was given for.
  - A call is taken to name a skill only by its server and URI exactly as
    given. Before 0.3.2 the helper trimmed spaces around them, so a padded call
    skipped this question and loaded the skill unapproved, with the refusals
    below in force.
- **You can read it first.** `/mcp-skills show <skill>` shows the skill's
  `SKILL.md`, verified, in a panel. The panel isn't part of the conversation:
  Claude doesn't read it, and opening it loads or approves nothing.
- **After your yes,** the skill's text is in the conversation, and what Claude
  does next goes through your usual permissions, as it would for a skill on
  your disk. The mod adds no further questions for commands.
- **Before a resource read from any other MCP server,** while any served skill
  is loaded, with both servers named. This lasts until the conversation is
  cleared.

The questions are the mod's own, so Claude Code puts them to a person. An
allow rule for the tool doesn't answer them, and neither does auto mode's
classifier; both were seen in live runs. What can answer in your place is
whatever can answer any permission question for you: a PermissionRequest hook
of your own, or an application that hosts Claude Code. Bypass-permissions mode
hasn't been tested. See
[What it does not protect against](#what-it-does-not-protect-against).

### Where nobody can be asked

In `claude -p` or a headless host, there's no approval to give. A skill then
loads only if your own rules allow the load tool, and it loads *unapproved*.
The model is told so. While it's loaded, the mod refuses every tool call
except these, whatever your rules allow:

- Claude Code's `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `TodoWrite`,
  `ToolSearch`, `ListMcpResourcesTool` and `AskUserQuestion` (which only puts
  a question to you);
- the mod's own four tools (list skills, load a skill, read a loaded skill's
  file, list its directory);
- a resource read from the skill's own server.

So the mod refuses a command, a file write or edit, a subagent, a web fetch, a
tool of any other MCP server, and any tool this version of the mod doesn't
know. File writes are refused because a file written now can be code run
later: a hook in a settings file, a git hook, a package script. The list names
what is let through, not what is stopped.

This was seen in a live headless run under the default permission mode:
`Write`, `Edit`, `Bash` and `Agent` were refused though allowed by rule, and
`Read` was allowed ([`docs/evidence/headless.txt`](docs/evidence/headless.txt)).
If the session is later resumed with a person present, each such call is put
to them instead.

A skill loaded this way stays unapproved until the conversation is cleared,
even if it's loaded again later with a yes. Its earlier text is still in the
conversation, and may differ from what was approved. Before 0.3.1 the later
yes ended the refusals; the model of the gate found this (see
[`docs/verification.md`](docs/verification.md)).

To use a skill fully in headless runs, approve it once in an interactive
session on the same machine. The approval stands while the skill is
unchanged, and a headless run then loads it approved. This was also seen live.

### What isn't asked about

Reading a file of a loaded skill, listing one of its directories, and listing
skills go ahead without a question, unless a rule of yours or your
organisation's asks for one. They read only from the skill's own server, only
what its manifest lists, and they verify it. This matches how Claude Code
treats its own read of an MCP resource.

A loaded skill's own files can be read only through `read_skill_file`, which
verifies them. Claude Code's generic resource tool is refused for them.

### Skills you disabled

`/mcp-skills disable <skill>` keeps the skill's identity, as the extension
defines it, in the same store as your approvals: the server's name in your
configuration, and the URI of its `SKILL.md`. It doesn't keep the skill's
content or the server's address. So the skill stays disabled whatever the
server changes in it, and wherever the server moves. From then on, in every
session that uses the same Claude Code configuration folder:

- It's left out of what Claude is offered: the skill listing and
  `list_skills`. A listing the helper made before it was told the latest list
  isn't used.
- `load_skill` for it is refused at the permission check, whatever a rule or
  mode allows, and refused again when the call runs. So are reads of its files
  and directories. The store is read for each of these, so a skill disabled in
  another session is refused here at once. One disabled while a load waited
  for your answer, or while the helper fetched it, isn't handed to Claude. The
  helper asks its server nothing about it.
- Where the store can't be read, nothing served is listed or loaded.

Turning a skill on again (`/mcp-skills enable <skill>`) is honoured only from
your own input, typed or from your own Remote Control. It isn't honoured from
Claude, a script, another session or `claude -p`, since it widens what Claude
is offered. Turning one off is honoured from anywhere. Enabling approves
nothing: the skill is asked about as it would have been.

At most 2,000 skills are kept disabled. Past that, a disable is refused, and
none is dropped to make room. A disable that can't be kept, because the store
is full, holds in the session it was made in until Claude Code is restarted,
and says so.

Disabling takes nothing back from a conversation. A skill loaded before is
still in it, and the questions Claude Code asks because it's there go on until
the conversation is cleared: before a read from another server, and, for an
unapproved skill, before anything but reading and searching. `/mcp-skills`
names the skills you disabled, by name and server, so it can tell you which.
Nothing a server wrote about them is shown there.

### What is kept

In the helper's memory, for the session: the listings, the entries of loaded
skills, and verified file content.

On disk:

- your approvals (above);
- the skills you disabled, by server name and URI;
- which of your servers serve skills, by name and fingerprint, so the others
  aren't connected to at every start;
- a log, with your config's secrets scrubbed, private to your user;
- if you ran `/mcp-skills setup`, the mod's own copy of Bun.

No skill content, and no tokens.

### The one thing it downloads

It downloads nothing unless you run `/mcp-skills setup` on a machine that has
no Node and no Bun, and answer Download to the question it then puts in Claude
Code's own dialog. "Not now" is the first answer, so a dialog that closes by
itself is a no.

- **Who can run it.** The command is honoured only from your own input: typed
  at the prompt, or sent from your own Remote Control. Claude can't run it, and
  neither can a script, another session or `claude -p`. Two sessions can't
  fetch at once; the second is told to wait.
- **What it fetches.** One fixed Bun release from GitHub over HTTPS, with
  `curl`. HTTPS is also required of any redirect. No server, skill or project
  file can change what is downloaded or from where.
- **How it checks it.** It hashes the archive inside the mod, so no checksum
  program on your `PATH` is trusted. It compares the SHA-256 with the value
  written in [`mod/hooks/runtime.ts`](mod/hooks/runtime.ts) for that platform.
  Only on a match is one named file unpacked, checked to answer with the
  expected version, and moved into the plugin's data folder. Otherwise the
  download is deleted and nothing of it runs. A file that can't be deleted is
  left not runnable, and you're told where it is.
- **What runs later.** The SHA-256 is checked when the copy is fetched, not
  each time it runs. Only the copy of the pinned version ever runs: the mod
  looks only at that version's folder, and runs nothing there unless the
  folder and the program in it are a real folder and a real file, not symbolic
  links. A copy of another version put in that folder never runs, not even to
  ask its version, and the next setup deletes it by name. Before 0.3.2 the mod
  ran every such copy once, with `--version`, to learn which were there.
- **What it touches.** The copy is used only to run this mod's helper. Your
  `PATH` and shell profile aren't touched. `/mcp-skills setup remove` deletes
  the copy. A newer Bun arrives only with a newer version of the mod, and only
  when you run the command again.

### A server's `headersHelper`

Where a server's entry has a `headersHelper`, the mod runs that command, as
Claude Code documents it and runs it itself, to get the headers for its own
connection. It does so only for a server Claude Code uses in the session, and,
for a project's or local server, only in a folder you trusted. A helper that
came with a repository isn't handed `ANTHROPIC_*`, `CLAUDE_*` or
`MCP_SKILLS_*` variables. What the command prints is held in memory and
scrubbed from the log.

## What it does not protect against

- **A skill you approved whose instructions are harmful.** It can tell the
  model to write a file, call another server's tool, or give you bad advice.
  Those go through Claude Code's ordinary permissions, exactly as they would
  for text from a tool result. After your yes, the only further question the
  mod raises is for a resource read from another MCP server. Read a skill you
  don't know before approving it (`/mcp-skills show <skill>`).
- **What an unapproved skill makes Claude say or read.** With nobody to ask,
  its text is still in the conversation. It can shape the answer, and have
  Claude read files the session can read. It can't make Claude change, run or
  send anything through a tool (see
  [Where nobody can be asked](#where-nobody-can-be-asked)).
- **Bypass-permissions mode** (`--dangerously-skip-permissions`). Not tested.
  In that mode Claude Code skips its permission checks. Whether it still
  consults a mod's permission hook, puts a mod's question to you, or honours a
  mod's refusal isn't known. Assume that none of the questions and refusals on
  this page hold there: a skill may load without your being asked, and its text
  may then drive any tool. Don't use that mode with a server you don't trust.
- **The runtime it runs on.** The helper runs on your Node or Bun, or on the
  Bun release you had it fetch. The checksum shows the download is the file
  its publisher released, not that the release is free of faults. A newer one
  is fetched only with a newer version of the mod and your command.
- **Other mods.** A mod can call tools without a permission check
  (`$.tool.call`). That's Claude Code's design for mods, not something this
  mod can change.
- **A window that is read back incompletely.** After a resume, the loaded
  skills are found by reading the conversation's newest 4,096 messages. A skill
  that only a subagent loaded, or that was loaded further back, isn't found.
  For it, the question about reads from other servers stops, and so does the
  refusal of tool calls for an unapproved skill.
- **The server itself.** Verification catches a file that changed between
  listing and reading. It can't tell you the skill was safe to begin with.

## Reporting a problem

If you find a way to make the mod load content it should refuse, read from a
server it shouldn't, skip a question it should raise, or leak a credential,
please report it privately. Use "Report a vulnerability" under this
repository's Security tab, rather than a public issue. You'll get an answer
within a few days. Other bugs are welcome as ordinary issues.
