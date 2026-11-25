# Security

This covers `mcp-skills` for Google Antigravity. The
[Codex](../codex/SECURITY.md), [Pi](../pi/SECURITY.md) and
[OpenCode](../opencode/SECURITY.md) forms share the Skills client in
[`../core`](../core), with their own host adapters.

A served skill is text and files from an MCP server: untrusted data, handled
the way Antigravity handles a tool result. Loading one grants nothing; what the
agent does next goes through Antigravity's own approvals.

## What is trusted

- **You:** your answer in Antigravity's approval card, for each new or changed
  skill version.
- **Antigravity:** its approval card, its hooks, its MCP connections and its
  sign-in.
- **The plugin's state folder**, `~/.gemini/agentpolyfill/mcp-skills/`.
  Anything that can write it, or run the plugin's hook as you, can make a
  ticket or an approval. Antigravity's terminal sandbox, on by default, keeps
  the agent's commands to the workspace and temporary folders; a command run
  outside it (you approved it, Auto mode judged it safe, or the sandbox is
  off, as in Turbo) can reach the folder.
- **Not a server or the model:** a server's description is shown marked as
  untrusted; neither can load a skill you didn't approve, or a version other
  than the one you approved.

## The boundary: Antigravity's approval card

Antigravity cancels MCP elicitation without showing it, so `load_skill` is put
to you through the plugin's `PreToolUse` hook:

- **Which calls the hook sees.** The three gated tools are eager
  (`plugin/mcp_config.json`), and the matcher takes their eager names,
  `mcp_mcp-skills_skills_<tool>`, and Antigravity's `read_resource` (rule X8).
  It never takes `call_mcp_tool`, so the hook isn't handed other servers' tool
  calls. A gated tool called through `call_mcp_tool` gets no ticket and is
  refused. Of a `read_resource` it reads only the server's name, the URI and
  the conversation, and keeps nothing.
- **A new or changed version asks.** The hook reads the skill's current entry
  from its server itself and answers `force_ask`. The question's first two
  lines name the skill and the server, and say whether it is new or changed
  since you last approved it, with its URI (the CLI's card shows those two
  lines and hides the rest); the rest gives its files and their size and the
  server's description, marked untrusted. The whole question is cleaned and
  then scrubbed of the configuration's secrets before it is shown. The App's
  card greys out "always allow"; the CLI's still lists it.
- **An unchanged version you approved** passes the hook with `allow`, which
  leaves Antigravity's usual MCP question (MCP allow rules skip it). Nothing
  is auto-approved: the hook never answers `auto_approve`.
- **Tickets.** The hook leaves a one-use ticket for that exact version (every
  file's address and digest, and where the server is). Its file is named by
  the nonce's SHA-256; it is good for an hour at most, and the plugin's
  `PreInvocation` and `Stop` hooks remove a conversation's unused tickets at
  its next model call and when its turn ends, so a question declined or never
  answered leaves nothing past the conversation's next model call (or the
  hour, if the CLI is closed first). The MCP server hands
  over the skill's text only with that ticket, checked against the server's
  digests.
- **Reads.** `read_skill_file` and `list_skill_directory` pass with a ticket
  and serve only files of a skill this conversation loaded and approved, from
  its own server, checked against their digests. `list_skills` shows metadata
  only.
- **Rule X8.** Once a conversation holds a skill from one server, the hook
  answers `force_ask` to a `read_resource` from another server, naming both,
  as the Pi and OpenCode forms ask. It can't tell which skill (or whether
  one) asked for the read. Antigravity shows no question for it, in CLI
  1.5.17 (auto mode and default mode) or App 2.35.1 (Default preset), and the
  read goes ahead (seen live in all three, the hook's decision logged): X8
  isn't met. The plugin doesn't refuse such reads instead: that would block
  another server's reads, unrelated ones included, and a plugin never denies
  another server's call.
- **When the hook can't run.** In CLI 1.5.17 a `PreToolUse` hook that exits
  non-zero, times out or prints something that isn't JSON makes Antigravity
  fail the call (seen live). The hook always exits 0 with JSON: `allow` for a
  call it can't read or that isn't its business, `deny` for its own call when
  it can't open its state.
- **The IDE.** Antigravity documents no plugin hooks for the IDE, so a load
  there gets no ticket and is refused; the hook also refuses a call whose
  transcript is the IDE's.

Antigravity's defaults ask before an MCP tool: in the App, in the interactive
CLI (which starts in auto mode, CLI 1.5.7 and later where available), and
headless `agy -p` denies a call nobody answers (seen live). If you allow MCP
tools in your rules, an unchanged approved load and the file reads run without
a question; a new or changed version still asks. Whether
`--dangerously-skip-permissions` also skips `force_ask` hasn't been checked.

There is no "show me `SKILL.md` first": the card is yes or no, and the plugin
shows the model nothing of a skill before your yes.

## What the plugin does

### What it reads

- `~/.gemini/config/mcp_config.json`, to find your servers. That file can hold
  header values, environment values and URL query values (API keys). The
  plugin uses them only to connect to that server, registers each with the
  shared redactor, and never logs or shows them: text is cleaned of
  characters that show as nothing first, then scrubbed, in the question, the
  placeholder skills, every listing and every answer, also when a server
  echoes a secret back. A file it can't read as JSON is reported without
  quoting it.
- Its own folder, `~/.gemini/agentpolyfill/mcp-skills/` (0700): settings,
  approvals, a cache of which servers serve skills, metadata snapshots, which
  servers' skills each conversation loaded, the log and the tickets.

It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in
store. A server that needs Antigravity's own sign-in (`oauth`,
`authProviderType`, or one that answers asking for a sign-in) is left out,
with the reason.

### What it connects to

The servers in your personal `mcp_config.json` only (not a plugin's or a
workspace's), with what the file holds. It opens its own connection to each
(Antigravity gives a plugin no way to use its connections), asks whether it
declares the Skills extension, and lists its skills. Nothing is fetched to
write a placeholder; a skill's files are fetched only after your approval.

### What it writes, and how long it keeps it

- A placeholder skill per served skill, directly in
  `~/.gemini/config/skills/`, as `mcp-skills-served--<server>-<6 hex>--<16 hex>/SKILL.md`,
  0600 in a 0700 folder: the skill's name and the server's description
  (plain text, one line, secrets taken out), marked as served by an MCP
  server, and how to load it. Never a skill's content. The plugin creates,
  rewrites and removes only folders of that exact shape, never follows a
  symlink, and keeps at most 100. Other programs that read that folder see
  the placeholders too. They are removed when the server goes from your
  configuration or the plugin stands down; uninstalling leaves them.
- Its own folder, as above: approvals until you delete `approvals.json`;
  tickets an hour at most; the log, rotated at 2 MiB. Uninstalling leaves the
  folder.

Nothing is written into the installed plugin, which Antigravity may replace on
update. No skill content is cached on disk.

### Text

Files are shown only as text that is text: a server's media type is shown
only when it is one, whole; a file that holds a control character a terminal
acts on (ESC, a C1 control) is reported as a binary file, not shown.

## What it does not protect against

- What a skill tells the agent to do once you've loaded it: that goes through
  Antigravity's approvals, as for a skill on your disk.
- A skill from one server reading a resource from another (rule X8, above:
  Antigravity doesn't show the hook's question), or through a host tool other
  than `read_resource`.
- An approval given without reading the card.
- Anything that can write the plugin's state folder, as above.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-skills`, the Antigravity form, the
Antigravity surface and version, and the server. Don't include credentials.
