# Security

This covers mcp-skills for OpenCode. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The plugin" below means this OpenCode plugin: one bundled file
(`plugin/server.js`) that OpenCode loads into its own server. It holds the
Skills client, which every form shares, in [`../core`](../core).

A skill is text an MCP server wrote. A model may follow it, and a skill can
tell the model to run commands, edit files or call tools. The plugin's job is
to make sure such text reaches the model only after you, or OpenCode's
permission rules, allowed it, only as the server published it, and always
marked as that server's.

## What is trusted

- **You, and your OpenCode configuration.** The servers the plugin connects
  to, and the headers it sends, are the ones in OpenCode's configuration.
- **OpenCode's permission rules,** which decide every load and every
  cross-server read. The plugin asks with `ctx.permission.assert` and never
  answers a prompt. By default it has them ask you (below).
- **Nothing a server sends.** Its skill list, descriptions, files and digests
  are its data. A server can only make the plugin read its own skills, never
  another server's.

## What the plugin does

### Which servers

Those in OpenCode's MCP configuration, read through a transform that only
reads, that declare the Skills extension. Servers turned off in OpenCode are
left alone, and so is any value OpenCode would fill in from a variable or a
file, left unfilled. The plugin never reads OpenCode's stored credentials,
OAuth tokens included, so a server you signed in to with `opencode mcp auth`
isn't used.

### What reaches OpenCode's skill list

For each served skill: its name, the server's description on one line (cut
short, with no markup), marked `[MCP server "<server>", not a local skill]`
first, and a body of the plugin's own that says how to load it. None of the
skill's text, and nothing on disk. A served skill never takes the place of a
skill OpenCode has from elsewhere under the same id.

### What you're asked, and when

- **Loading** is `mcp_skills_load` on `<server>:<uri>@sha256:<digest of the
  manifest>`. The request carries the server, the skill's name and URI, its
  digest, its number of files and their size as metadata. "Allow always"
  saves that exact resource, so it covers the skill as it is now; when the
  server changes any file, the digest changes and you're asked again. A
  skill whose content the server generates (`"dynamic"`) has no digest: it
  saves nothing and is asked about every time.
- **A cross-server read** is `mcp_skills_cross_server`: once a session has
  loaded a served skill, OpenCode's own resource read for a different server
  is put to your rules first, naming both servers, for that one read. The
  hook knows the read by its effective name and by the dotted name a model or
  a Code Mode program may use, holds for the session's subagents, and holds
  after a restart.
- **Nothing else.** Listing skills and reading a loaded skill's own files
  with `mcp_skills_read_skill_file` raise no question.

OpenCode's shipped default allows every action. For these two actions only,
the plugin's `evaluate` hook turns that `allow` into `ask`, unless you chose
"Allow always" for that exact resource in this project, or set
`askByDefault` to `false`. It never turns anything into `allow`, and a
configured `deny` is settled before it runs. With nobody there to answer,
OpenCode refuses the question. "Allow always" is kept by the plugin, from
OpenCode's own permission events, only for a request of its own and only as
the patterns that request offered to save: a cross-server read offers none.

### What OpenCode's own resource read may do

OpenCode's resource read checks no digest. Once a session has loaded a served
skill, a read through it of a file inside that skill's folder, from the
skill's server, is refused before anything is sent, and the model is pointed
to `mcp_skills_read_skill_file`, which checks the file against the skill's
manifest (SEP-2640's V4). A read for another server is the cross-server
question above.

### What reaches the model

The skill's `SKILL.md`, only after OpenCode allowed the load, and only if its
size, SHA-256 digest and frontmatter match the server's entry (the request
names the digest it was asked about, and a skill that changed in between
isn't loaded). It arrives fenced, with a marker the text can't forge, under a
line naming the server, saying it is that server's content and not a local
skill, how many hidden characters it holds, and that its frontmatter has no
effect. Files the skill refers to are read only from its own server, only if
its manifest lists them, and checked the same way. Binary files are checked
and not shown.

### What is kept

A log in `~/.local/share/opencode/mcp-skills/` (or `MCP_SKILLS_STATE`),
readable only by you, with secrets taken out. In the plugin's OpenCode
storage (OpenCode's own database), for each session that loaded a served
skill, the server and URI of each skill it loaded (for V4 and X8), and, per
project, the patterns you chose "Allow always" for. No skill content is kept.

## What it does not protect against

- **What OpenCode's TUI shows in the prompt.** OpenCode 2.4.1's TUI shows a
  request for this plugin's action as "Call tool mcp_skills_load", without
  the resource or metadata it carries. You read the server and the skill's
  URI on the model's call line above it; the digest shows only under
  "Always allow", in the pattern it would save. OpenCode Desktop shows the
  whole resource in the prompt.
- **OpenCode's default policy, after a load.** It allows every action. The
  plugin asks before a skill loads, but what the model does with it is
  asked about only where your rules say `ask`.
- **An "Allow always" taken back in OpenCode.** The plugin keeps its own
  record, so removing OpenCode's saved approval doesn't make it ask again. An
  `ask` or `deny` rule for the action does.
- **Turning asking off.** With `askByDefault: false` or
  `MCP_SKILLS_ASK_BY_DEFAULT=0`, OpenCode's rules alone decide, and under its
  default a served skill loads without a prompt.
- **What you approve.** Once a skill is loaded, what it tells the model to do
  goes through OpenCode's rules like anything else, no stricter.
- **A server you configured that serves harmful skills.** Verification shows
  a server is consistent with itself, not that its content is safe.
- **Other plugins.** A plugin runs inside OpenCode's server with the same
  access as this one.

## Reporting a problem

Report a vulnerability privately, through this repository's **Security →
Report a vulnerability** form on GitHub, not in a public issue. Name
`mcp-skills` for OpenCode.
