# Security

This covers `mcp-skills` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms share the Skills client in
[`../core`](../core), with their own host adapters.

A served skill is text and files from an MCP server: untrusted data, handled
the way Antigravity handles a tool result. Loading one grants nothing; what the
agent does next goes through Antigravity's own approvals.

## What is trusted

- **You:** your approval in Antigravity's own approval card, for each new or
  changed skill version.
- **Antigravity:** its approval card, its hooks, its MCP connections and its
  sign-in.
- **Not a server or the model:** a server's description is shown marked as
  untrusted; neither can load a skill you didn't approve, or a version other
  than the one you approved.

## The boundary: Antigravity's approval card

Antigravity cancels MCP elicitation without showing it, so `load_skill` is put
to you through the plugin's `PreToolUse` hook:

- The hook fetches the skill's current entry from its server itself and
  answers `force_ask`, with a question naming the skill, the server, its URI,
  whether it is new or changed since you last approved it, its files and
  their size, and the server's description marked untrusted. Antigravity shows
  it in its approval card and greys out "always allow".
- It leaves a one-use ticket for that exact version (every file's address and
  digest, and where the server is), valid for 4 hours. The MCP server hands
  over the skill's text only with that ticket, checked against the server's
  digests.
- A version you approved before, unchanged, passes the hook without a
  question (`allow`, which leaves the call to Antigravity's usual MCP
  approval). Nothing is auto-approved: the hook never answers `auto_approve`.
- `read_skill_file` and `list_skill_directory` serve only files of a skill
  this conversation loaded and approved, from its own server, checked against
  their digests. `list_skills` shows metadata only.

There is no "show me `SKILL.md` first": the card is yes or no, and the plugin
shows the model nothing of a skill before your yes.

## What the plugin does

### What it reads

- `~/.gemini/config/mcp_config.json`, to find your servers. That file can hold
  header values and environment values (API keys). The plugin uses them only
  to connect to that server, registers each with the shared redactor, and
  never logs or shows them: they're taken out of the log, the placeholder
  skills and every listing, also when a server echoes one back. A file it
  can't read as JSON is reported without quoting it.
- Its own folder, `~/.gemini/agentpolyfill/mcp-skills/` (0700): settings,
  approvals, a cache of which servers serve skills, metadata snapshots, the
  log and the tickets.

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

### What it writes

- A placeholder skill per served skill, directly in
  `~/.gemini/config/skills/`, as `mcp-skills-served--<server>-<6 hex>--<16 hex>/SKILL.md`:
  the skill's name and the server's description (plain text, one line,
  secrets taken out), marked as served by an MCP server, and how to load it.
  Never a skill's content. The plugin creates, rewrites and removes only
  folders of that exact shape, never follows a symlink, and keeps at most 100.
  Other programs that read that folder see the placeholders too.
- Its own folder, as above.

Nothing is written into the installed plugin, which Antigravity may replace on
update. No skill content is cached on disk.

### Text

Files are shown only as text that is text: a server's media type is shown
only when it is one, whole; a file that holds a control character a terminal
acts on (ESC, a C1 control) is reported as a binary file, not shown.

## What it does not protect against

- What a skill tells the agent to do once you've loaded it: that goes through
  Antigravity's approvals, as for a skill on your disk.
- A skill from one server reading a resource from another (rule X8): the
  plugin can't put a question in front of Antigravity's own resource reads;
  the loaded skill tells the model to ask you first.
- An approval given without reading the card.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-skills`, the Antigravity form, the
Antigravity surface and version, and the server. Don't include credentials.
