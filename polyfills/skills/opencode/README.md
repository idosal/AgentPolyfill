# mcp-skills for OpenCode

OpenCode can use the [skills](https://agentskills.io/) your MCP servers serve.
They show up in OpenCode's own skill list, OpenCode loads one when a task
calls for it, and it reads the files the skill refers to as it needs them.
Loading goes through OpenCode's permission rules.

Also available for Claude Code ([mcp-skills for Claude Code](../claude-code/README.md))
and Codex ([mcp-skills for Codex](../codex/README.md)).

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which OpenCode doesn't support itself yet. All
forms share their client logic, in [`../core`](../core/). Whether you're asked
before a skill loads is up to your OpenCode permission rules: see
[Permissions](#permissions) and [Limits](#limits).

## Install

The plugin isn't on npm yet. From a clone of this repository, add its folder
to `plugins` in your OpenCode configuration (`~/.config/opencode/opencode.json`
for every project, or a project's `opencode.json`):

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/skills/opencode/plugin"],
  "permissions": [
    { "action": "mcp_skills_load", "resource": "*", "effect": "ask" },
    { "action": "mcp_skills_cross_server", "resource": "*", "effect": "ask" }
  ]
}
```

The two rules make OpenCode ask you before a served skill loads, and before a
session that loaded one reads another server's resource. Without them,
OpenCode's default allows both, as it allows loading its own skills.

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1). OpenCode
runs the plugin itself, so you don't need Node.

To remove it, take the entry out of `plugins`.

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
`mcp_skills_load_skill`, you're asked (with the rules above), and the skill's
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

The plugin does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension.

## Permissions

OpenCode decides, with its own rules and its own prompt. The plugin asks and
never answers.

| Action | Resource | Saved by "Allow always" |
|---|---|---|
| `mcp_skills_load` | `<server>:<skill uri>@sha256:<manifest digest>`, or `@dynamic` for a skill whose content the server generates | That skill as it is now. A generated skill can't be covered: it's asked about every time. |
| `mcp_skills_cross_server` | `<skill servers>-><server>:<uri>` | Nothing: each read is asked. |

A rule such as `{ "action": "mcp_skills_load", "resource": "huggingface:*", "effect": "allow" }`
trusts one server's skills; `deny` keeps them from loading. A `skill` deny
rule for `mcp-skills:<server>:<name>` takes a skill out of OpenCode's list, as
for any skill, but the model can still call `mcp_skills_load_skill` with its
server and URI: to turn a served skill off, deny `mcp_skills_load` for it
(`<server>:<uri>@*`).

## Settings

| Variable | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | Do nothing, without being uninstalled. The plugin option `{"off": true}` does the same. |
| `MCP_SKILLS_STATE` | Where the log goes. Default: `~/.local/share/opencode/mcp-skills`. |

### When OpenCode supports Skills itself

OpenCode 2.4.1 has no SEP-2640 support to detect. When it ships, turn the
plugin off with `MCP_SKILLS_OFF=1`, or remove it.

## Limits

- **OpenCode's default allows every action.** With no rule for
  `mcp_skills_load`, a served skill loads without a prompt, as OpenCode's own
  skills do, and the same holds for `mcp_skills_cross_server`. Add the rules
  in [Install](#install) to be asked.
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
- **Tried live** with a real model and Hugging Face's server: its 25 skills
  in OpenCode's list, two loaded after OpenCode asked, each bound to its
  digest ([`live-run.md`](../../../tools/opencode/live-run.md)). In that run,
  with OpenCode's default rules, the model also ran a command a loaded skill
  described, without a prompt. CI runs the tests on Linux and macOS.
- **OpenCode's TUI shows little in the prompt.** In OpenCode 2.4.1's TUI, a
  permission prompt for a plugin's own action says only "Call tool
  mcp_skills_load". The details are on the model's call line just above it, and
  "Always allow" lists the pattern it would save. Checked in the TUI
  ([`live-run.md`](../../../tools/opencode/live-run.md#in-opencodes-tui)). The digest and the "not a local skill" note in the
  request aren't shown, though the saved pattern carries the digest.
- **In OpenCode Desktop** (2.4.1, tried live): the permission prompt shows
  the action and the full resource, the skill's digest included, and a
  Hugging Face skill loaded after "Allow once".
- **Not tried yet:** Windows by hand (CI runs the tests there).

[What hosts would need to change](../../../docs/host-changes.md) covers these
gaps for each host.

## Security

A skill is text a server wrote. A model may follow it, and it may tell the
model to run things on your machine. The plugin treats it as untrusted data
from that server: it's loaded only once OpenCode's rules allow it, its
frontmatter grants nothing, and it reaches the model fenced and marked with
its server. [`SECURITY.md`](SECURITY.md) has the full account.

## Spec and conformance

The plugin implements the client side of
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
the MCP Skills extension, Final, at commit `2eb3a8e`. The entries,
verification, held entries and connection are the shared core's, bundled
unchanged; the Claude Code and Codex forms' `docs/conformance.md` map each
client rule to it. What is different in OpenCode:

| Rule | In OpenCode |
|---|---|
| V7 (no file fetched ahead of need) | Met: the skill list is built from `skills/list` alone. Tested. |
| X5 (no code execution from a served skill without per-skill approval) | Exception: (a) no frontmatter field has any effect. (b) A skill loads only once OpenCode's rules allow `mcp_skills_load`; under OpenCode's default (allow everything) that needs no prompt. After it loads, what the model does goes through OpenCode's rules as for any skill. |
| X8 (a cross-server read approved per call, naming both servers) | Met through OpenCode's rules: a hook puts OpenCode's resource read for another server to `mcp_skills_cross_server`, per call, by either of its names, in subagents, and across restarts. Limit: under OpenCode's default it's allowed without a prompt. Tested with an `ask` rule, each of those cases included. |
| X11 (user policy decides whether a skill loads) | Met: OpenCode's permission rules. |
| X14 (an approval bound to every file's digest, revoked on change; a generated skill can't be covered) | Met: the resource carries the manifest digest. Tested: "Allow always", then a load in another session isn't asked, then the server changes a file and the load is asked again. |

### Checked end to end in OpenCode

[`test/e2e.test.ts`](test/e2e.test.ts) runs the plugin in OpenCode 2.4.1, in a
throwaway home, against the Claude Code form's fixture skills server (written
from the SEP, sharing no code with the client), with a scripted model: the
served skill in OpenCode's skill list with none of its text; OpenCode's skill
tool returning the note; a load put to OpenCode's rules, rejected (nothing
fetched) and approved (verified, fenced); a file read; the X8 hook; and the
X14 binding.

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
