# mcp-skills for OpenCode

OpenCode can use the [skills](https://agentskills.io/) your MCP servers serve.
They show up in OpenCode's own skill list, OpenCode loads one when a task
calls for it, and it reads the files the skill refers to as it needs them.
Loading goes through OpenCode's permission rules.

Also available for Codex and Pi: [mcp-skills for Codex](../codex/README.md), [mcp-skills for Pi](../pi/README.md). Claude Code needs no polyfill for this: it lists skills from MCP servers itself, in beta from 2.1.332 ([changelog](https://code.claude.com/docs/en/changelog)).

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which OpenCode doesn't support itself yet. All
forms share their client logic, in [`../core`](../core/). OpenCode asks you
before a served skill loads: see [Permissions](#permissions) and
[Limits](#limits).

## Install

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1). OpenCode runs
the plugin itself, so you don't need Node.

The plugin isn't on npm. OpenCode installs it from this repository on GitHub,
with Git:

```bash
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/skills/opencode/plugin'
```

That adds it to `plugins` in your global configuration
(`~/.config/opencode/opencode.json`), so it runs in every project, from the
next time OpenCode opens one. `#main` installs what the main branch holds; a
commit in its place pins one version. To remove it, run `opencode plugin remove`
with the same text. OpenCode keeps its downloaded copy in
`~/.cache/opencode/npm/` (a `git-AgentPolyfill-…` folder), which you can
delete afterwards.

Removing it leaves its log in `~/.local/share/opencode/mcp-skills/` (or
`MCP_SKILLS_STATE`), which you can delete, and, in OpenCode's plugin storage
(OpenCode's own database), which skills each session loaded and the "Allow
always" answers it kept. No skill content is kept anywhere.

Or, from a clone of this repository, add the plugin's folder to `plugins`
yourself, in the global configuration or a project's `opencode.json`:

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/skills/opencode/plugin"]
}
```

The folder is one bundled file, [`plugin/server.js`](plugin/), its licence
notices, and a `package.json` that names it. Nothing else is downloaded.

## Try it

Add Hugging Face's public MCP server, which serves 25 skills and needs no
account for this, to your OpenCode configuration:

```jsonc
{
  "mcp": { "huggingface": { "type": "remote", "url": "https://huggingface.co/mcp", "oauth": false } }
}
```

Start OpenCode and ask:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

The served skills are in OpenCode's skill list as
`mcp-skills:huggingface:<name>`, each described as
`[MCP server "huggingface", not a local skill] …`. When OpenCode picks one,
its skill tool returns a short note saying how to load it; OpenCode then calls
`mcp_skills_load_skill`, OpenCode asks you, and the skill's
text, checked against the server's digests, reaches the model as that
server's content.

`mcp_skills_list_skills` lists every served skill, and each server left
alone, with the reason.

## How it works

- **Finding servers.** When OpenCode opens a project, the plugin reads your
  MCP servers from OpenCode's configuration (through `ctx.mcp.transform`, a
  transform that only reads), connects to each once, keeps those that declare
  the extension, and asks each for its skills. No file is fetched.
- **Listing.** For each skill, the plugin adds an entry to OpenCode's skill
  list with `ctx.skill.transform`: the skill's name, the server's description
  marked with the server, and a body of the plugin's own that says how to load
  it. None of the skill's text is in it, and nothing is written to disk. The
  entry's path is `skill://<id>/SKILL.md`, OpenCode's form for a skill with no
  folder.
- **Loading.** `mcp_skills_load_skill` names the server and the skill's URI.
  The plugin asks OpenCode's permission rules about `mcp_skills_load` on
  `<server>:<uri>@<manifest digest>`, so an "Allow always" covers that skill
  as it is now, and a changed skill is asked about again. Only once OpenCode
  allows it does the plugin fetch `SKILL.md`, check its size, SHA-256 digest
  and frontmatter against the server's entry, and hand the text to the model,
  fenced and marked with the server.
- **Reading files.** `mcp_skills_read_skill_file` reads a file the skill
  refers to, only from the skill's own server, only if its manifest lists it,
  checked the same way. `mcp_skills_list_skill_directory` lists a folder.
- **Another server's resources (X8).** Once a session has loaded a served
  skill, a call of OpenCode's own resource read for another server is put to
  OpenCode's rules first (a `tool` hook), as `mcp_skills_cross_server` on
  `<skill servers>-><server>:<uri>`, for that one read. A reject stops the
  read. It holds however the read is named (`opencode_read_mcp_resource`, or
  `opencode.read_mcp_resource` as Code Mode names it), in a subagent of that
  session, and after OpenCode restarts: which servers a session loaded skills
  from is kept in the plugin's OpenCode storage.
- **A loaded skill's own files (V4).** OpenCode's resource read checks no
  digest, so a read of a file inside a loaded skill's folder, from the skill's
  server, is refused before anything is sent, with a pointer to
  `mcp_skills_read_skill_file`. That holds in subagents and after a restart
  too.

The plugin does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension.

## Permissions

OpenCode decides, with its own rules and its own prompt. The plugin asks and
never answers.

- **It asks by default.** OpenCode's shipped default allows every action, so
  a question put to its rules reaches you only where a rule says `ask`. For
  its own two actions, below, the plugin turns that `allow` into `ask`, and
  it changes nothing else.
- **"Allow always"** keeps your answer for the pattern the request offered to
  save, in this project: a skill as it is now. The plugin follows OpenCode's
  own permission events to know it.
- **A `deny` or `ask` rule you write wins.** OpenCode settles a `deny` before
  the plugin hears of it, and the plugin never turns anything into `allow`.
  With nobody there to answer, as in a scheduled run, OpenCode refuses the
  question.
- **To leave it to OpenCode's rules alone**, set the plugin option
  `askByDefault` to `false`, or `MCP_SKILLS_ASK_BY_DEFAULT=0` (see
  [Settings](#settings)). An `allow` rule you write doesn't skip the question
  by itself: the plugin can't tell it from OpenCode's default.
- **The plugin keeps its own record** of each "Allow always", in OpenCode's
  plugin storage. Taking a saved approval back in OpenCode doesn't take it
  back from the plugin; an `ask` rule for it does.
- **Upgrading from 0.1.0** asks for each "Allow always" once more. 0.1.0
  also kept an answer given in one project for every other project where the
  plugin was running at the time; 0.1.1 keeps each answer to its own project
  and doesn't read 0.1.0's lists.

| Action | Resource | Saved by "Allow always" |
|---|---|---|
| `mcp_skills_load` | `<server>:<skill uri>@sha256:<manifest digest>`, or `@dynamic` for a skill whose content the server generates | That skill as it is now. A generated skill can't be covered: it's asked about every time. |
| `mcp_skills_cross_server` | `<skill servers>-><server>:<uri>` | Nothing: each read is asked. |

With `askByDefault: false`, a rule such as
`{ "action": "mcp_skills_load", "resource": "huggingface:*", "effect": "allow" }`
trusts one server's skills. A `deny` rule keeps them from loading, either way. A `skill` deny
rule for `mcp-skills:<server>:<name>` takes a skill out of OpenCode's list, as
for any skill, but the model can still call `mcp_skills_load_skill` with its
server and URI: to turn a served skill off, deny `mcp_skills_load` for it
(`<server>:<uri>@*`).

## Settings

| Variable | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | Do nothing, without being uninstalled. The plugin option `{"off": true}` does the same. |
| `MCP_SKILLS_ASK_BY_DEFAULT=0` | Leave loads and cross-server reads to OpenCode's rules alone; by default the plugin asks. The plugin option `{"askByDefault": false}` does the same. |
| `MCP_SKILLS_STATE` | Where the log goes. Default: `~/.local/share/opencode/mcp-skills`. |

Set a variable in the environment OpenCode starts in. A plugin option goes in
the object form of the plugin's entry in `plugins`:

```jsonc
{
  "plugins": [
    { "package": "/path/to/AgentPolyfill/polyfills/skills/opencode/plugin", "options": { "askByDefault": false } }
  ]
}
```

### When OpenCode supports Skills itself

OpenCode 2.4.1 has no SEP-2640 support to detect. When it ships, turn the
plugin off with `MCP_SKILLS_OFF=1`, or remove it.

## Limits

- **What a loaded skill leads to.** The plugin asks before a skill loads.
  What the model then does, the commands a skill describes included, goes
  through OpenCode's rules as for its own skills, and OpenCode's default
  allows it.
- **No preview before you decide.** OpenCode's permission prompt offers
  "Allow once", "Allow always" and "Reject". The request carries the skill's
  name, server, URI, digest and size as metadata, but there is no way for a
  plugin to show you the skill's `SKILL.md` first without the model seeing
  it.
- **Two steps to load.** OpenCode's skill tool returns the plugin's note, and
  the model then calls `mcp_skills_load_skill`. OpenCode gives a plugin no way
  to supply a skill's text only when it's loaded, and only after a question.
- **Servers behind OAuth.** OpenCode gives a plugin neither its sign-in nor a
  way to send `skills/*` over its own connection. The plugin connects with the
  headers in your configuration only. It never reads OpenCode's stored
  credentials.
- **A second connection.** A local server that serves skills runs twice.
- **Binary files** of a skill are checked, but not shown to the model.
- **A loaded skill is held for 64 sessions at once.** Past that, or after
  OpenCode restarts, a file read asks the model to load the skill again,
  which is asked about unless "Allow always" covers it as it is. Which
  servers a session loaded skills from is kept on disk, so the V4 and X8
  checks still hold.
- **Checked in OpenCode 2.4.1 against Hugging Face's server.** With
  OpenCode's default rules, a command a loaded skill describes runs without a
  prompt. CI runs the tests on Linux, macOS and Windows.
- **OpenCode's TUI shows little in the prompt.** In OpenCode 2.4.1's TUI, a
  permission prompt for a plugin's own action says only "Call tool
  mcp_skills_load". The details are on the model's call line just above it, and
  "Always allow" lists the pattern it would save. The digest and the "not a
  local skill" note in the request aren't shown, though the saved pattern
  carries the digest.
- **In OpenCode Desktop** (checked in 2.4.1): the permission prompt shows
  the action and the full resource, the skill's digest included.
- **Not checked:** Windows by hand (CI runs the tests there).

[What hosts would need to change](../../../docs/host-changes.md) covers these
gaps for each host.

## Security

A skill is text a server wrote. A model may follow it, and it may tell the
model to run things on your machine. The plugin treats it as untrusted data
from that server: it's loaded only once you or OpenCode's rules allow it, its
frontmatter grants nothing, and it reaches the model fenced and marked with
its server. [`SECURITY.md`](SECURITY.md) has the full account.

## Spec and conformance

The plugin implements the client side of
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
the MCP Skills extension, Final, at commit `2eb3a8e`. The entries,
verification, held entries and connection are the shared core's, bundled
unchanged. This form's [`docs/conformance.md`](docs/conformance.md) maps
every client rule to the code and the test, in OpenCode. What is different in
OpenCode:

| Rule | In OpenCode |
|---|---|
| V7 (no file fetched ahead of need) | Met: the skill list is built from `skills/list` alone. Tested. |
| V4 (a skill's files resolved only to its held entry) | Met: `read_skill_file` reads from the entry; OpenCode's own resource read of a file in a loaded skill's folder is refused, in subagents and after a restart too. Tested. |
| W1 (the entry held while the skill is in context) | Exception: held in memory for up to 64 sessions at once, while the plugin runs; past that, or after a restart, a file read asks the model to load the skill again. |
| X2, X11 (served skills a higher-risk surface; user policy decides) | Met: a load is put to OpenCode's rules before anything is fetched, and asks by default where they'd allow it. Only "Allow always" for that skill as it is, or `askByDefault: false`, skips the question. Tested. |
| X5 (no code execution from a served skill without per-skill approval) | Exception: (a) no frontmatter field has any effect. (b) A skill loads only once you allow it (or, with `askByDefault: false`, OpenCode's rules do). After it loads, what the model does goes through OpenCode's rules as for any skill, and OpenCode's default allows it. |
| X8 (a cross-server read approved per call, naming both servers) | Met: a hook puts OpenCode's resource read for another server to `mcp_skills_cross_server`, per call, by either of its names, in subagents, and across restarts, and asks by default; nothing is saved. With `askByDefault: false`, OpenCode's rules alone decide. Tested, each of those cases included. |
| X14 (an approval bound to every file's digest, revoked on change; a generated skill can't be covered) | Met: the resource carries the manifest digest. Tested: "Allow always", then a load in another session isn't asked, then the server changes a file and the load is asked again. |

### Checked end to end in OpenCode

[`test/e2e.test.ts`](test/e2e.test.ts) runs the plugin in OpenCode 2.4.1,
against the Skills forms' shared fixture server (written from the SEP,
sharing no code with the client): the served skill in OpenCode's skill list
with none of its text; OpenCode's skill
tool returning the note; a load put to OpenCode's rules, rejected (nothing
fetched) and approved (verified, fenced); a file read; OpenCode's resource
read of a loaded skill's file refused (V4); the X8 hook, by either name, in a
subagent and after a restart; the X14 binding; a nested skill asked about on
its own; the plugin installed globally in the object form, and turned off; a
server that needs a sign-in; and asking by default, with "Allow always"
sticking and `askByDefault: false`.

## Development

From this folder (`polyfills/skills/opencode` in the repository):

```bash
(cd ../../../tools/opencode && npm ci)   # the pinned OpenCode the tests run
(cd ../core && npm ci)                   # the shared Skills client
npm ci
npm test                                 # Node 22.18 or newer
npm run typecheck
npm run build                            # plugin/server.js; npm run check fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin plugin --entry src/plugin.ts --bundle server.js
```

`src/` is what is specific to OpenCode: its plugin API (`opencode.ts`), its MCP
configuration (`config.ts`), the tools and the skill list (`app.ts`,
`plugin.ts`) and what it says (`format.ts`, `words.ts`). CI:
[`opencode-skills-test.yml`](../../../.github/workflows/opencode-skills-test.yml).

## Licence

Apache-2.0, as the rest of the repository.
