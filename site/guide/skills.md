---
description: mcp-skills adds the client side of the MCP Skills extension (SEP-2640) to Codex, Pi, OpenCode, Antigravity and Hermes Agent. Skills your MCP servers serve are listed, approved once, loaded, and checked against the server's digests. Install and limits are listed per host. Claude Code lists skills from MCP servers itself, in beta, and Copilot CLI has Skills over MCP built in.
---

# Skills

`mcp-skills` lets Codex, Pi, OpenCode, Antigravity and Hermes use the [skills](https://agentskills.io/) your
MCP servers serve: they appear next to your own skills, the agent loads one
when a task calls for it, and reads the files it refers to as it needs them.
The skill's content is not installed locally, and you approve each skill once.
It adds the client side of
the MCP **Skills** extension, `io.modelcontextprotocol/skills`
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md),
Final). The Codex, Pi, OpenCode, Antigravity and Hermes forms below supply MCP Skills support those
hosts haven't shipped natively yet (for Codex, openai/codex#48000). Claude Code
has its own, in beta: see [Claude Code](#claude-code). Copilot CLI has Skills
over MCP built in: see [Copilot CLI](#copilot-cli).

<Recording
  cut="skills"
  alt="In Codex, in the ChatGPT desktop app, asked what skills the Hugging Face MCP server serves, Codex lists its 25 skills, all visible in Codex. Asked which GGUF quantization to use for a 7B model on a 16 GB Mac, Codex asks in its own form whether to load the skill huggingface-local-models from that server, saying its 4 files are each checked against the server's SHA-256 digest when read, with Do not load it, Show me its SKILL.md first, and Load it. After Load it, Codex answers from the skill: Q4_K_M."
  caption="A real session in Codex, in the ChatGPT desktop app, against Hugging Face's public MCP server (25 s; waits sped up, with a badge saying how fast)."
/>

## Claude Code

There is no Skills polyfill for Claude Code. Claude Code lists skills from MCP
servers itself, in beta from 2.1.332 (25 November 2026). Its
[changelog](https://code.claude.com/docs/en/changelog) says they show as
`server:skill` in the `/` menu, and other skills keep their names. It is a
beta and may not be on for every account or server yet; where it isn't on,
there is currently no Skills over MCP in Claude Code.

This project had a Claude Code form of `mcp-skills` until then, and removed
it. The marketplace no longer lists it, and from version 0.3.0 the
`agent-polyfill` bundle no longer depends on it. If you installed it, by name
or through the bundle, remove it at the prompt of a `claude` session:

```
/plugin uninstall mcp-skills@agent-polyfill
```

Whether Claude Code removes it by itself when the bundle stops depending on it
isn't known here, so look in `/plugin`. Before you uninstall,
`/mcp-skills forget` drops the approvals it kept, and `/mcp-skills setup remove`
deletes its copy of Bun, if you had it download one. The approvals were in the
mod's own store in your Claude Code configuration folder; its log was in the
plugin's data folder, which uninstalling leaves in place.
[What it kept on your machine](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/skills/README.md)
has the rest.

## Copilot CLI

There is no Copilot form, on purpose. Copilot CLI 1.0.115 has Skills over MCP
built in: it declares `io.modelcontextprotocol/skills` to every server it
connects, in its `initialize`, and VS Code 1.147.0's Copilot harness has
it on by default (from its source). Listing or loading a served skill in
Copilot was not checked. A polyfill would be a second client
([why](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/README.md#skills-and-apps-in-copilot)).

## Install

::: code-group

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-skills@agent-polyfill
```

```bash [Pi]
pi install git:github.com/idosal/AgentPolyfill
```

```bash [OpenCode]
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/skills/opencode/plugin'
```

```bash [Antigravity]
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/skills/antigravity/plugin
```

```bash [Hermes]
hermes plugins install idosal/AgentPolyfill/polyfills/skills/hermes/plugin --enable
```

:::

### In Codex

Codex 0.172 (the version it was tested on), with Node 20 or newer. Served
skills appear in Codex's own `$` skill list from the turn after the plugin's
server starts (if Codex's daemon was already running, after you ask once to
list the served skills), and from the first turn of every later session. They
load after a yes for each one in Codex's own form, and are checked against
the server's digests. One rule of the spec can't be met in
Codex yet: a skill from one server reading another server's resources isn't
put to you first (rule X8), because Codex doesn't let a plugin ask.

### In Pi

Pi 1.6.0 (the version tested), with Node 22 or newer. The command above
installs Events, Skills and Server Cards together.
Pi clones the repository under `~/.pi/agent/git/` and loads the three
extensions from there. Nothing is published to npm or Pi's package gallery,
and nothing is built.

Update installed packages with `pi update --extensions`. Remove all three
and Pi's copy of the repository with
`pi remove git:github.com/idosal/AgentPolyfill`. For one run of all three
without installing, use `pi -e git:github.com/idosal/AgentPolyfill`.

To install only Skills, use a clone:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/skills/pi/extension
```

Pi loads the local path where it is, so keep the clone. From the same folder,
`pi remove ./polyfills/skills/pi/extension` removes that local install;
`pi -e ./polyfills/skills/pi/extension` runs it once without installing.
Use one way per form: Pi tells packages apart by repository address or local
path, so a form installed both ways loads twice.

[ARD](./ard#install) is left out of the one-line install, as it is from the
Claude Code bundle: its search sends the words of your request to a registry
after asking each time. Install it separately from a clone.

Removal leaves watches and events in `mcp-events/`, and approvals and skill
stubs in `mcp-skills/`, in Pi's agent folder (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`); delete those folders too to remove that data.
Servers you added stay in `mcp.json`; remove one with
`pi mcp remove <name>`.

### In OpenCode

OpenCode 2.4 or newer (tested with 2.4.1). OpenCode runs the plugin itself,
so you don't need Node. The plugin isn't on npm: the command fetches it from
GitHub, with Git, and adds it to `plugins` in your global
`~/.config/opencode/opencode.json`, so it runs in every project from the next
time OpenCode opens one. A commit in place of `main` pins one version. From a
clone, put the folder `polyfills/skills/opencode/plugin` in `plugins` in an
`opencode.json` instead. To remove it, run `opencode plugin remove` with the
same text; OpenCode's downloaded copy stays in `~/.cache/opencode/npm/` (a
`git-AgentPolyfill-…` folder), which you can delete. Its log stays in
`~/.local/share/opencode/mcp-skills/` (or `MCP_SKILLS_STATE`); delete that
folder too to remove it. Which skills each session loaded, and the "Allow
always" answers it kept, stay in OpenCode's plugin storage (OpenCode's own
database). No skill content is kept anywhere.

### In Antigravity

Node 20 or newer on `PATH`. Nothing is published to Antigravity's
Marketplace; install from a clone, with the Antigravity CLI (the App doesn't
ship `agy`). `agy plugin install` copies the folder to
`~/.gemini/config/plugins/mcp-skills`, which the App and the CLI both read.
Remove it with `agy plugin uninstall mcp-skills`. Its state stays in
`~/.gemini/agentpolyfill/mcp-skills/`, and its placeholders in
`~/.gemini/config/skills/mcp-skills-served--*`; delete those too to remove
them.

### In Hermes

Hermes Agent v0.23.4 (the version tested), with Node 20 or newer on the
gateway's PATH. `AGENTPOLYFILL_NODE` can name another executable. Name the
servers in `plugins.entries.mcp-skills.settings.servers` in your profile's
`config.yaml`; the demo below includes this. This is the plugin's own grant,
separate from Hermes's `mcp_allowlist`.

Remove it with `hermes plugins remove mcp-skills`. Its stubs are kept in
`$HERMES_HOME/mcp-skills/`; what each session loaded is kept in Hermes's
plugin state.

The sections below name the host where behavior differs. Full guides by host:

- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi)
- [OpenCode](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/opencode)
- [Antigravity](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity)
- [Hermes](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/hermes)

## Try it

Add Hugging Face's public MCP server. It serves skills, and needs no account
for this:

::: code-group

```bash [Codex]
codex mcp add huggingface --url https://huggingface.co/mcp
```

```bash [Pi]
pi mcp add huggingface --url https://huggingface.co/mcp
```

```jsonc [OpenCode]
{
  "mcp": { "huggingface": { "type": "remote", "url": "https://huggingface.co/mcp", "oauth": false } }
}
```

```bash [Antigravity]
agy mcp add huggingface https://huggingface.co/mcp
```

```yaml [Hermes]
# config.yaml in your Hermes profile
mcp_servers:
  huggingface:
    url: https://huggingface.co/mcp
plugins:
  entries:
    mcp-skills:
      settings:
        servers: [huggingface]
```

:::

In Codex, the served skills appear in the `$` list after you ask once to list
the served skills, from the next turn. Start your host in the same folder:

- **Codex:** `codex`.
- **Pi:** `pi`; served skills appear as `mcp-<server>-<name>`.
- **OpenCode:** `opencode`, with that entry in the project's `opencode.json`
  or the global one; served skills appear as `mcp-skills:<server>:<name>`,
  and a load takes two steps ([What to expect](#what-to-expect)).
- **Antigravity:** `agy`, or the App. `agy mcp add` is in CLI 1.5.17's own
  help, not in Antigravity's docs. The App doesn't ship `agy`; there, add
  the server under Customizations > Installed > MCP Servers, or in
  `~/.gemini/config/mcp_config.json`.
- **Hermes:** `hermes`, with the YAML above in your profile's `config.yaml`.
  The plugin looks at the server on the first turn; skills are listed from
  the next session as `mcp-skills:huggingface-<name>`. `list_skills` and
  `load_skill` reach them at once. You can ask "Use the Hugging Face
  local-models skill" with the question below.

Ask something one of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

The agent finds `huggingface-local-models` among its skills and loads it. The
host asks you once whether to load that skill. The agent then reads the
skill's reference files from the server and answers from them.

## What to expect

### In Codex

Served skills appear in Codex's own `$` skill list as
`mcp-skills:<server>:<name>`, each marked with its server. The first time
Codex loads one, you're asked in Codex's own form: "Do not load it", "Show me
its SKILL.md first" or "Load it". The preview is shown to you only, checked
against its digest; the model sees nothing of the skill until you choose "Load
it". Your yes is kept for that skill as it is now (every file's address and
digest, and where the server is); a changed skill is asked about again.
Reading a loaded skill's files and listing skills raise no questions, and what
Codex does after your yes goes through your usual Codex approvals. In
`codex exec`, or under the approval policy `never`, nobody can be asked, so a
skill you haven't approved isn't loaded. To turn one served skill off, use
Codex's own `[[skills.config]]`.

### In Pi

Served skills appear in Pi's own list as `mcp-<server>-<name>`, their
descriptions marked `[MCP server "<server>", not a local skill]`. Ask in
plain words, or use `/skill:mcp-huggingface-huggingface-local-models` with the
question above. Loading asks a Pi dialog: "Don't load it", "Show me its
SKILL.md first", "Load it". Your yes is kept for that skill with exactly
those files; changes ask again. The preview is shown to you before the model
sees it. Files are checked against the server's digests as they are read.

While a served skill is loaded, a read from another MCP server asks
"mcp-skills: reach another MCP server?", naming both servers (SEP-2640 X8).
This covers Pi's resource tool and the extension's skill tools, including
codemode's nested calls. Print and JSON modes cannot ask, so they load only
skills already approved and unchanged, and refuse cross-server reads that
need approval. Skills a server adds mid-session appear after `/reload`.

### In OpenCode

Served skills appear in OpenCode's own skill list as
`mcp-skills:<server>:<name>`, described
`[MCP server "<server>", not a local skill] …`, with none of their text. A
load takes two steps: OpenCode's skill tool returns the plugin's note, then
the model calls `mcp_skills_load_skill`, and OpenCode asks you. OpenCode's
shipped rules allow every action, so the plugin makes a load ask by default.
The prompt offers "Allow once", "Allow always" and "Reject", and can't show
you the skill's `SKILL.md` first. "Allow always" covers that skill as it is
now: a changed skill is asked about again, and one whose content the server
generates is asked about every time. The text arrives checked against the
server's digests, fenced and marked as that server's, and files are read
with `mcp_skills_read_skill_file`, checked the same way. In OpenCode 2.4.1's
TUI the prompt says only "Call tool mcp_skills_load": the server and URI are
on the model's call line just above it, and "Always allow" lists the pattern
it would save, digest included. OpenCode Desktop shows the whole resource,
digest included, in the prompt.

Once a session has loaded a served skill, OpenCode's own resource read of
another server is asked about, per call, naming both servers (SEP-2640 X8).
That holds whatever the read is named, from a Code Mode program too, in
subagents and after a restart. OpenCode's own read of a file inside a loaded
skill's folder is refused, with a pointer to `mcp_skills_read_skill_file`
(V4). A `deny` or `ask` rule you write wins, and with nobody there to answer,
as in a scheduled run, OpenCode refuses the question. The plugin option
`askByDefault: false` (or `MCP_SKILLS_ASK_BY_DEFAULT=0`) leaves loads and
cross-server reads to OpenCode's rules alone, whose default allows them. To
turn one served skill off, deny `mcp_skills_load` for `<server>:<uri>@*`.

### In Antigravity

Served skills appear as placeholder folders in `~/.gemini/config/skills/`,
which Antigravity documents reading before each turn. Loading a new or
changed one is put to you in Antigravity's approval card, yes or no; the
CLI's card shows the question's first two lines, which say whether it is new
or changed and give its URI. An approved skill skips the plugin's question
while it is unchanged, and gets only Antigravity's usual MCP question, which
allow rules can skip; so do reads of its files. Editors on `agy acp` see the
tool and its arguments in the card, not the question. X8 isn't met in the
CLI: once a served skill is loaded, the plugin's hook asks before a
`read_resource` from another server, naming both, but CLI 1.5.17 ignores
that question (no card; the read goes ahead).

### In Hermes

Hermes lists a stub for each served skill, marked with its server. It says
to use `load_skill`. Hermes's own approval names the skill, server, files and
size, with once, session, always and deny. A kept approval covers that
version only; a changed skill asks again, and a dynamic skill asks every
time. To read SKILL.md first, deny and type the
`/mcp-skills show <server> <skill URI>` line in the question. That preview is checked against its digest
and shown to you only. Then ask for the skill again if you want it.

The files are fetched only as needed and checked against the manifest.
While a served skill is loaded, Hermes asks before each resource read from
another server, naming both. That stays in force after a restart. Through
Tool Search it should too (Hermes runs the hook for each call it makes, read
in Hermes's source); that isn't tested. Hermes's generic resource tool cannot read served skill files
in place of `load_skill`. Turn one off with `skills.disabled`, using its
`mcp-skills:` name.

## Which servers work

In Codex, a local command, a URL with no credentials and a URL with
`http_headers` in `~/.codex/config.toml` work. A URL whose token comes from
`bearer_token_env_var` or `env_http_headers` usually doesn't, because Codex
starts a plugin's server with a small fixed environment. A server you signed
in to with `codex mcp login` (OAuth) is out of reach, and servers that come
with a plugin or from a project's `.codex/config.toml` aren't looked at.
`list_skills` names each server it left alone, and why. The plugin never reads
Codex's stored sign-ins.

In Pi, local (stdio) servers, public URLs and URLs with an `Authorization`
header in `mcp.json` work. Header values may be written out, `${VARIABLE}` or
`!command`. Servers signed in through Pi (`/mcp`, `pi mcp login`, OAuth or
`auth.provider`) are out of reach; `list_skills` says why. The extension
never reads `mcp-auth.json` or `auth.json`.

In OpenCode, local servers work, and remote URLs with the headers in their
OpenCode configuration. Servers OpenCode signs in to with OAuth
(`opencode mcp auth`) are out of reach; `mcp_skills_list_skills` names each
server it left alone, with the reason. The plugin never reads OpenCode's
stored credentials.

In Antigravity, the plugin connects to the servers in
`~/.gemini/config/mcp_config.json`, using any header values there, and never
logs or shows those values. A header can be added with
`agy mcp add --header "Authorization: Bearer <token>" <name> <url>`. Servers
that need Antigravity's own sign-in are skipped. It never opens
`~/.gemini/antigravity/mcp_oauth_tokens.json`.

In Hermes, only servers named in the plugin's `settings.servers` are used.
Local commands and URLs with headers in `config.yaml` work. `auth: oauth`,
entries that take `${VAR}` from `.env`, client certificates, per-user identity
headers and legacy SSE don't. Disabled servers are left alone. `list_skills`
names each server it left alone and why. The plugin reads no stored credentials
and reads the configuration again at every turn and tool call.

## How it works

Each form does the same things, with the same client code underneath
([`polyfills/skills/core`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/core)):

- **Finding servers.** The form reads the servers its host is configured with,
  and opens a connection of its own to those it can reach with what the
  configuration holds. It keeps the ones that declare the extension and asks
  each for its list of skills.
- **Listing.** The skills are added to the host's own skill list, each marked
  with its server.
- **Approving.** Before a skill is loaded, you're asked: in Codex's form, in a
  Pi dialog, through OpenCode's permission rules, in Antigravity's approval
  card, or through Hermes's approval.
- **Loading.** The form fetches `SKILL.md` from that server, checks its size and
  SHA-256 digest against what the server published, compares its frontmatter
  with the published one field by field, and only then hands the text to the
  model, marked with the server it came from.
- **Reading files.** A file the skill refers to is read only from the skill's own
  server, only if the skill's manifest lists it, and checked the same way.

The forms do what the extension defines for a client and nothing else: no extra
protocol, no vendor extension.

## Limits

### In Codex

- **Servers behind a sign-in, and servers whose token is in an environment
  variable,** are out of reach ([Which servers work](#which-servers-work)).
- **The first time, you may have to ask.** If Codex's daemon was already
  running, ask once to list the served skills; they're in Codex's list from
  the next turn, and in later sessions from the start.
- **Another server's resources (rule X8).** A plugin can't put a question in
  front of Codex's own resource read, so a skill from one server reading
  another server's resources isn't put to you first. The loaded skill tells
  the model to ask you.
- **A second connection.** A local (stdio) server that serves skills runs
  twice.
- **At most 100 skills** in Codex's list; `list_skills` reaches all of them.
- **Binary files** of a skill are checked, but not shown to the model.
- **Not checked yet:** Windows and Linux outside the tests (checked on macOS).

### In Pi

- **Its own connection.** Pi gives extensions no way to send Skills requests
  over its connection. A local (stdio) server runs twice; sign-ins held by
  Pi cannot be used by the extension.
- **Reload for later servers and skills.** Servers are read at session
  start; one another extension registers later is reached after `/reload`.
  Skills added mid-session need `/reload` to appear in Pi's list.
- **No per-skill switch.** Put a server in `{"skip": [...]}` in
  `mcp-skills/settings.json` in Pi's agent folder to leave its skills out.
- **Off with Pi's MCP support.** With `--no-mcp`, `-builtin:mcp` in the
  extension settings, or a replacement MCP extension, Skills stands down too.
- **The cross-server question has a boundary.** It cannot intercept a read
  another extension makes through its own MCP connection.

### In OpenCode

- **Its own connection.** OpenCode gives a plugin neither its sign-in nor a
  way to send `skills/*` over its own connection. Servers OpenCode signs in
  to with OAuth are out of reach, and a local server that serves skills runs
  twice.
- **No preview before you decide.** OpenCode's prompt has no place for text
  you read and the model doesn't, so rule X13b (let you inspect a skill
  before it loads) isn't met. The request carries the skill's name, server,
  URI, digest and size.
- **Two steps to load.** OpenCode gives a plugin no way to supply a skill's
  text only when it's loaded, and only after a question.
- **What a loaded skill leads to.** What the model then does, the commands a
  skill describes included, goes through OpenCode's rules as for its own
  skills, and OpenCode's default allows it. So the model can run a
  command a loaded skill describes, without a prompt.
- **A loaded skill is held for 64 sessions at once.** Past that, or after
  OpenCode restarts, a file read asks the model to load the skill again,
  which is asked about unless "Allow always" covers it as it is.
- **Binary files** of a skill are checked, but not shown to the model.
- **The plugin keeps its own "Allow always".** Taking a saved approval back
  in OpenCode doesn't take it back from the plugin; an `ask` rule does. An
  `allow` rule you write doesn't skip the question by itself, since the
  plugin can't tell it from OpenCode's default.
- **Not checked yet:** Windows outside CI (CI runs the tests there).

### In Antigravity

- **No sign-in through Antigravity.** Servers behind Antigravity's own
  sign-in can't be reached.
- **Yes or no.** The approval card has no other choices. The App greys out
  its "always allow" choices; the CLI's card still lists them. Editors on
  `agy acp` see the tool and its arguments, not the question.
- **X8 isn't met.** The plugin's hook asks before another server's
  `read_resource` once a served skill is loaded, but Antigravity ignores
  that question, in CLI 1.5.17 and App 2.35.1: no card, and the read goes
  ahead.
- **Not in the IDE.** The IDE documents no plugin hooks, so the forms aren't
  supported there, and their gated calls are refused.

### In Hermes

- **Its own connection.** A local server runs twice. Hermes's OAuth sign-in
  and entries that take secrets from `.env` are out of reach.
- **New skills are listed from the next session.** The first session's
  first turn discovers them; `list_skills` and `load_skill` reach them at once.
  At most 100 are listed; `list_skills` reaches every one.
- **Previewing takes a step of your own.** Deny, then type `/mcp-skills show`.
  A dynamic skill is generated again at load time and may differ from the preview.
- **No served skills in YOLO.** `--yolo`, `/yolo`, `hermes -z` and `approvals.mode: off`
  refuse loads and cross-server reads. Unattended approve modes still approve
  them. Telling uses Hermes's unpublished gate test; where it can't be
  evaluated (another Hermes version, `plugins.isolation: host`), loads are
  refused too.
- **Tool Search.** With Tool Search on (Hermes's default) a model may not
  find `load_skill`; `tools.tool_search.enabled: off` lists it directly.
- **Not checked on Windows.**

### In T3 Code

T3 Code runs Codex, Claude Code or OpenCode for you, and the form for the
agent it runs loads there (checked with Codex). With Codex, the question it asks before loading a skill ("Load it") is
an MCP elicitation form, and T3 Code shows such a form only when it can
answer it with Approve or Decline; it cancels this one without showing it, so
the step is refused as if you had said no. Nothing is approved for you.
Listing the served skills works (checked).
[T3 Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md) has the details.

## Security

A skill is text a server wrote, which a model may follow, and which may tell the
model to run things on your machine. Each form treats it as untrusted data from
that server, never as instructions from you. None protects against a skill you
approved whose instructions are harmful: what the model does after a load goes
through the host's ordinary permissions, so read a skill you don't know before
you approve it, where the host lets you.

### In Codex

A skill is loaded only after you chose "Load it" in Codex's form, and your
approval is bound to its content; anything but "Load it" is a no. "Show me
its SKILL.md first" shows you the text, with control characters removed and
hidden characters counted, before the model sees any of it. Everything from a
server is shown under the server's name as you configured it, never what the
server calls itself, and a skill's frontmatter grants nothing. X8 isn't met:
a read from another MCP server while a skill is loaded isn't put to you
first. The plugin never reads Codex's stored sign-ins and stores no tokens.
See [Codex's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/SECURITY.md).

### In Pi

The extension asks before loading a served skill and binds your approval to
its files. Content arrives as a tool result marked with its server; its
frontmatter grants nothing. X8 is met: a cross-server read while a skill is
loaded asks first, naming both servers. After you approve a skill, Pi's own
permissions apply: Pi runs tools without asking unless a permission extension
asks. Tool annotations let permission extensions distinguish the calls.
See [Pi's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/SECURITY.md).

### In OpenCode

Each load is put to OpenCode's permission rules before anything of the skill
is fetched, and asked about by default; your approval is bound to the
skill's manifest digest. The plugin never answers a prompt, never turns
anything into `allow`, and a `deny` rule is final. Content arrives fenced and
marked with its server, and its frontmatter grants nothing. X8 is met: while
a skill is loaded, OpenCode's read of another server's resource asks first,
naming both servers. After a load, OpenCode's own rules apply, and its
shipped default allows what the model does next. The plugin never reads
OpenCode's stored credentials. See
[OpenCode's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/SECURITY.md).

### In Antigravity

Loading a new or changed served skill is put to you in Antigravity's
approval card, through `force_ask`, and nothing is auto-approved: no
`auto_approve`, no permission overrides. The hook leaves a one-use ticket for
exactly that call, and the MCP server loads the skill only with it. An
approved unchanged skill, skill file reads and the read-only tools pass with
a ticket and then get Antigravity's usual MCP question, which allow rules
can skip. Whether `--dangerously-skip-permissions` also skips `force_ask`
hasn't been checked. The plugin writes only its own folder and its
placeholders, and never opens a sign-in store. X8 isn't met: the hook asks
before a cross-server read while a skill is loaded, but Antigravity (CLI
1.5.17, App 2.35.1) ignores that question. See
[Antigravity's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/SECURITY.md).

### In Hermes

The approval is bound to the server, skill URI and manifest hash; a different
version cannot load under that answer. Dynamic skills ask each time.
Every file is checked against its size and digest. Cross-server resource
reads ask each time, and Hermes's generic resource tool cannot bypass a skill
load. What the model does after loading uses Hermes's own approvals. The
plugin reads only granted servers in its own profile and no stored credentials.
See [Hermes's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/hermes/SECURITY.md).

## How it is tested

Every rule the Skills extension sets for a client has an id in
[the shared rule list](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/core/docs/sep-2640-client-rules.md);
each form's conformance table says what that form does about each one. The
forms' tests share one Skills server written by hand from the SEP, which
shares no code with the client.

### In Codex

[Codex's conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/docs/conformance.md)
records 60 rules: 52 met, 6 met with a stated limit, 1 not met (X8) and 1
that doesn't apply. The official MCP conformance suite's four SEP-2640 client
scenarios pass. Checked in Codex 0.172 against Hugging Face's public server:
all 25 skills load and all 135 files verify. Checked in the Codex terminal
UI: a skill listed, asked about, shown, loaded and used.

### In Pi

[Pi's conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/conformance.md)
records 53 rules met, 6 met with a stated exception, 1 not applicable and
none unmet. The official MCP conformance suite's four SEP-2640 client
scenarios pass. Checked in Pi 1.6.0 against Hugging Face's server: two
skills approved and loaded, reference files read and an answer from them,
and "Show me its SKILL.md first".

### In OpenCode

[OpenCode's conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/docs/conformance.md)
records 60 rules: 54 met, 4 met with a stated exception, 1 not applicable,
and 1 not met, X13b (letting you read a skill before it loads), which needs a
change in OpenCode. X8 and V4 are met. Its tests run the plugin in OpenCode
2.4.1; CI runs them on Linux, macOS and Windows. The official conformance
suite was not run for this form. Checked in OpenCode 2.4.1 against Hugging
Face's server: its 25 skills in OpenCode's list, two loaded after OpenCode
asked, each bound to its digest, reference files read and an answer from
them, and the X8 question from a Code Mode program. Loading a skill was also
checked in the TUI and in OpenCode Desktop.

### In Antigravity

[Antigravity's conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/docs/conformance.md)
maps the client rules for this form. Checked in App 2.35.1 and CLI 1.5.17:
a new skill's load approved, a changed one asked about again, and a declined
load, which reads nothing. The official MCP conformance suite's four
SEP-2640 client scenarios pass (suite at `c8625de`).

### In Hermes

The [conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/hermes/docs/conformance.md)
covers all 60 client rules using the Codex form's client logic. All four
upstream Skills client scenarios passed through the helper. Tests in Hermes
v0.23.4 cover approvals, changed versions, previews, cross-server reads and
listing in the next session. Hugging Face's server passes 4 of 4 through
Hermes.

## Settings

In Codex there is nothing to set. For the rare case that needs it,
`~/.codex/mcp-skills/settings.json` takes `servers`, `skip` and `off`. If
Codex declares the Skills extension itself, the plugin removes its stubs and
its tools do nothing. See the
[Codex settings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/README.md#settings).

In Pi, `MCP_SKILLS_OFF=1` turns the extension off. Server-level `skip` is
set in `mcp-skills/settings.json` in Pi's agent folder. Pi's extension cannot
detect native Skills support: remove it or use the off switch when that
ships. See the [Pi settings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/README.md#settings).

In OpenCode, `MCP_SKILLS_OFF=1`, or the plugin option `off`, turns the plugin
off, and `MCP_SKILLS_ASK_BY_DEFAULT=0`, or `askByDefault: false`, leaves loads
and cross-server reads to OpenCode's rules alone. Set a variable in the
environment OpenCode starts in, and an option in the object form of the
plugin's entry in `plugins`. OpenCode 2.4.1 has no Skills support to detect:
when it ships, turn the plugin off or remove it. See the
[OpenCode settings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/README.md#settings).

In Antigravity, `MCP_SKILLS_DISABLED=1` in the environment Antigravity starts
in, or `"off": true` in `~/.gemini/agentpolyfill/mcp-skills/settings.json`,
turns the plugin off; so does `agy plugin disable mcp-skills`. It cannot
detect native Skills support: Antigravity tells plugins nothing about its
MCP client's extensions. See the [Antigravity settings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/README.md#settings-and-stand-down).

In Hermes, `plugins.entries.mcp-skills.settings.servers` lists the servers
the plugin may use. `skills.disabled` turns off individual served skills.
`hermes plugins disable mcp-skills` turns off the form. Hermes v0.23.4 has
no native MCP Skills support to detect; disable it when that ships.

## More

On GitHub, each form's folder has its full README, its `SECURITY.md` and its
conformance table:
[Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex),
[Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi),
[OpenCode](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/opencode),
[Antigravity](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity) and
[Hermes](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/hermes).
[What hosts would need to change](./how-it-works) says what each host would
need to offer for these forms to work with every server.
