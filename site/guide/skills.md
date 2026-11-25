---
description: mcp-skills adds the client side of the MCP Skills extension (SEP-2640). Skills your MCP servers serve are listed, approved once, loaded, and checked against the server's digests. Install and limits are listed per host.
---

# Skills

`mcp-skills` lets your agent use the [skills](https://agentskills.io/) your
MCP servers serve: they appear next to your own skills, the agent loads one
when a task calls for it, and reads the files it refers to as it needs them.
The skill's content is not installed locally, and you approve each skill once.
It adds the client side of
the MCP **Skills** extension, `io.modelcontextprotocol/skills`
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md),
Final). The host forms below supply MCP Skills support that hasn't shipped
natively yet (for Codex, openai/codex#48000).

<Recording
  cut="skills"
  alt="In Codex, in the ChatGPT desktop app, asked what skills the Hugging Face MCP server serves, Codex lists its 25 skills, all visible in Codex. Asked which GGUF quantization to use for a 7B model on a 16 GB Mac, Codex asks in its own form whether to load the skill huggingface-local-models from that server, saying its 4 files are each checked against the server's SHA-256 digest when read, with Do not load it, Show me its SKILL.md first, and Load it. After Load it, Codex answers from the skill: Q4_K_M."
  caption="A real session in Codex, in the ChatGPT desktop app, against Hugging Face's public MCP server (25 s; waits sped up, with a badge saying how fast)."
/>

## Install

::: code-group

```txt [Claude Code]
/plugin install mcp-skills --marketplace idosal/AgentPolyfill
```

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-skills@agent-polyfill
```

```bash [Pi]
pi install git:github.com/idosal/AgentPolyfill
```

:::

### In Claude Code

The terminal form is `claude plugin install mcp-skills --marketplace idosal/AgentPolyfill`.
That's the whole install: no settings to fill in, nothing to configure per
server. You need:

- **Claude Code 2.1.329 or newer** (the version it was tested on), with mods.
- **Node 20 or newer, or Bun**, to run the mod's helper. If your machine has
  either, it is found by itself. If it has neither, the mod says so, and one
  command sets it up:

  ```
  /mcp-skills setup
  ```

  That downloads the official Bun release for your platform (about 40 MB, from
  `github.com/oven-sh/bun`) into the plugin's own data folder, for this mod only.
  Nothing else on your machine changes: no PATH entry, no shell profile.

The mod downloads nothing unless you type that command.

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

The sections below name the host where behavior differs. Full guides by host:

- [Claude Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/claude-code)
- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi)

## Try it

Add Hugging Face's public MCP server. It serves skills, and needs no account
for this:

::: code-group

```bash [Claude Code]
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

```bash [Codex]
codex mcp add huggingface --url https://huggingface.co/mcp
```

```bash [Pi]
pi mcp add huggingface --url https://huggingface.co/mcp
```

:::

In Codex, the served skills appear in the `$` list after you ask once to list
the served skills, from the next turn. Start your host in the same folder:

- **Claude Code:** `claude`.
- **Codex:** `codex`.
- **Pi:** `pi`; served skills appear as `mcp-<server>-<name>`.

Ask something one of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

The agent finds `huggingface-local-models` among its skills and loads it. The
host asks you once whether to load that skill. The agent then reads the
skill's reference files from the server and answers from them. In Claude Code,
these commands help:

| Command | What it does |
|---|---|
| `/mcp-skills` | Lists the skills your servers serve, and says which servers were left alone and why. |
| `/mcp-skills show <skill>` | Opens a skill's `SKILL.md` in a panel for you to read. Nothing is loaded, and Claude does not read the panel. |
| `/mcp-skills use <skill> [what to do]` | Asks Claude to load a skill by name. |
| `/mcp-skills disable <skill>` | Keeps a skill from Claude: it is not in Claude's skill listing, and cannot be loaded or read, in this session or another, until you type `/mcp-skills enable <skill>`. |

Also: `/mcp-skills refresh` looks at every server again, `/mcp-skills forget
[<skill>]` drops your approvals, and `/mcp-skills setup` is for a machine with
no Node and no Bun. `<skill>` is a name, `server:name`, the URI of a
`SKILL.md`, or `server:URI` (which also names a skill its server does not
list).

## What to expect

### In Claude Code

- **Nothing to set up per server.** A server in your MCP configuration that
  declares the Skills extension has its skills listed: straight after the
  install, with no restart, and from the next session for a server you add
  later.
- **One question per skill.** The first time Claude loads a skill, Claude Code
  asks you. Your yes is remembered for that skill as it is now: every file's
  address and digest. If the server changes the skill, you are asked again and
  told that it changed.
- **No other questions.** Reading a loaded skill's files and listing skills
  raise none. After you approved a skill, the commands Claude runs go through
  your usual permissions, as they would for a skill on your disk.
- **Skills you do not want.** `/mcp-skills disable <skill>` turns one skill off,
  by its server and the address of its `SKILL.md`, in this session and every
  other that uses the same Claude Code configuration folder. It stays off
  whatever the server changes in it. `/mcp-skills enable <skill>` turns it back
  on; only you can, by typing it. Turning a skill off takes nothing back from a
  conversation that loaded it already.
- **No slow starts.** A server found not to serve skills is not connected to
  again for a day. A session waits for a first listing (at most 4 seconds) only
  for servers that serve skills or that it has not looked at yet.

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

## Which servers work

In Pi, local (stdio) servers, public URLs and URLs with an `Authorization`
header in `mcp.json` work. Header values may be written out, `${VARIABLE}` or
`!command`. Servers signed in through Pi (`/mcp`, `pi mcp login`, OAuth or
`auth.provider`) are out of reach; `list_skills` says why. The extension
never reads `mcp-auth.json` or `auth.json`.

The table below is for Claude Code.

| How the server is configured | Works |
|---|---|
| A local command (stdio) | Yes |
| A URL with no credentials (Hugging Face, TogoMCP) | Yes |
| A URL with `"headers": { "Authorization": "Bearer ${TOKEN}" }` | Yes |
| A URL with a `"headersHelper"` command | Yes: the mod runs the command as Claude Code does |
| A URL you sign in to in the browser through `/mcp` (OAuth), with no header and no helper | **No** |
| A claude.ai connector, or a server that comes with a plugin | **No** |
| A server on the older SSE transport (`"type": "sse"`) | **No** |

Claude Code keeps a browser sign-in to itself, and gives a mod no way to send
the extension's requests over its own connection. The mod therefore opens a
connection of its own, with the credentials your configuration holds. It does
not run a sign-in of its own and stores no tokens.

## How it works

### In Claude Code

- **Finding servers.** The mod reads the servers Claude Code is configured with,
  asks Claude Code about each one, and connects only to those Claude Code itself
  uses. It keeps the ones that declare the extension and asks each for its list
  of skills.
- **Listing.** The skills are added to Claude's skill listing under their own
  heading, each with its server and the address of its `SKILL.md`.
- **Approving.** Before a skill is loaded, Claude Code asks you, in its own
  permission dialog.
- **Loading.** The mod fetches `SKILL.md` from that server, checks its size and
  SHA-256 digest against what the server published, compares its frontmatter
  with the published one field by field, and only then hands the text to
  Claude, marked with the server it came from.
- **Reading files.** A file the skill refers to is read only from the skill's own
  server, only if the skill's manifest lists it, and checked the same way.

The mod does what the extension defines for a client and nothing else: no extra
protocol, no vendor extension.

## Limits

### In Claude Code

- **Servers behind a browser sign-in, claude.ai connectors, plugin-provided
  servers and SSE servers** are not supported.
- **A second connection.** The mod's connection to a server that serves skills is
  beside Claude Code's own, so a local (stdio) server that serves skills runs
  twice.
- **Binary files** of a skill are checked but not shown to Claude.
- **No `/name` command per skill.** Use `/mcp-skills use <name>`, or just ask.
- **Unattended runs** (`claude -p`): nobody can be asked about a skill, so a skill
  that was not approved before loads only if your rules allow the tool, and
  then Claude can only read and search while it is loaded. Approve the skill
  once in an interactive session to use it unattended.
- **Managed machines.** Where an organisation's policy says which MCP servers are
  allowed, the mod connects to nothing, because it cannot apply that policy.
- **Not tried yet:** Windows and Linux (everything was run on macOS); the
  desktop app and IDE extensions; bypass-permissions mode; Claude Code versions
  other than 2.1.329.

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

## Security

### In Claude Code

A skill is text a server wrote, which a model may follow, and which may tell the
model to run things on your machine. The mod treats it as untrusted data from
that server, never as instructions from you.

- A skill is loaded only after you approved it, and your approval is bound to
  its content. An allow rule for the tool, or auto mode, does not answer in your
  place.
- Everything from a server is shown under the server's name as you configured
  it, never what the server calls itself.
- A skill's frontmatter grants nothing: `allowed-tools`, hooks and the rest are
  ignored.
- While a skill is loaded, Claude Code asks you before a resource read from any
  other MCP server.
- A skill you disabled is not offered to Claude, loaded or read until you enable
  it again, whatever a rule or mode allows; Claude cannot enable it.
- The mod never reads Claude Code's stored credentials, stores no tokens, and
  connects only to servers Claude Code itself uses.

It does not protect against a skill you approved whose instructions are
harmful: those go through Claude Code's ordinary permissions. Read a skill you
do not know before approving it (`/mcp-skills show <skill>`). Bypass-permissions
mode has not been tested; do not use it with a server you do not trust.

The full account:
[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/SECURITY.md).

### In Pi

The extension asks before loading a served skill and binds your approval to
its files. Content arrives as a tool result marked with its server; its
frontmatter grants nothing. X8 is met: a cross-server read while a skill is
loaded asks first, naming both servers. After you approve a skill, Pi's own
permissions apply: Pi runs tools without asking unless a permission extension
asks. Tool annotations let permission extensions distinguish the calls.
See [Pi's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/SECURITY.md).
An AI reviewer who did not build the Pi forms reviewed them, and checked
the fixes again. They have not been audited by a person.

## How it is tested

### In Claude Code

These results are for the Claude Code form. The Codex form's are in
[its README](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex);
it does not gate a cross-server resource read (X8).

| What | Result |
|---|---|
| Two real public servers, Hugging Face (25 skills, 135 files) and TogoMCP (5 skills, 8 files): every skill loaded, every file verified | all verified |
| The official MCP conformance suite's client scenarios for SEP-2640 (it has four) | 4 of 4 pass |
| The client rules, one test per rule, against a hand-written server; discovery; the bundled helper; per-skill disable; property tests; the model of the gate | 128 pass |
| Approval, the permission questions, disable and enable, first-run behaviour and the runtime setup, in Claude Code's own test kit | 96 pass |
| A model of approval, loading, disabling and the gate, every reachable state to its bound (it checks the model, not the code) | every invariant holds |
| The same model in TLA+, every reachable state to the same bound, by TLC 1.7.4 | every invariant holds |
| The official TypeScript SDK's Skills server and client, over stdio and HTTP | 15 checks pass |
| Real Claude Code sessions, recorded | screens in [`live/`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/claude-code/live) |

[`docs/conformance.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/docs/conformance.md)
goes through every rule the Skills extension sets for a client (60 rules: 54
met, 3 met with a stated limit, 3 that do not apply), and
[`docs/verification.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/docs/verification.md)
says what the model shows and what it does not.

### In Pi

[Pi's conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/conformance.md)
records 53 rules met, 6 met with a stated exception, 1 not applicable and
none unmet. The official MCP conformance suite's four SEP-2640 client
scenarios pass. The [live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/docs/live-run.md)
against Hugging Face records two skills approved and loaded, reference files
read and an answer from them, including a run with "Show me its SKILL.md
first".

## Settings

In Pi, `MCP_SKILLS_OFF=1` turns the extension off. Server-level `skip` is
set in `mcp-skills/settings.json` in Pi's agent folder. Pi's extension cannot
detect native Skills support: remove it or use the off switch when that
ships. See the [Pi settings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/README.md#settings).

### In Claude Code

There is nothing to set. To turn the mod off, disable the plugin in `/plugin`;
do that once Claude Code serves MCP skills itself. The mod also turns itself off
for a session in which it sees Claude Code load a skill from an MCP server.

| Variable | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | The mod does nothing, without being uninstalled. |
| `MCP_SKILLS_RUNTIME` | What runs the helper: the full path of a Node 20+ or a Bun, or `private` for only the copy of Bun the mod fetched for itself. |
| `MCP_SKILLS_SOURCES` | Which Claude Code configurations to read: `project,local,user` (default all three). |
| `MCP_SKILLS_SERVERS` / `MCP_SKILLS_SKIP` | Only these server names, or never these (comma-separated). |
| `MCP_SKILLS_CONFIG` | A servers file of your own instead of Claude Code's configuration, outside the project folder and its repository. |
| `MCP_SKILLS_STATE` | Where the mod keeps its log and its note of which servers serve skills. |

## The mod's own runtime

The helper is JavaScript, so it needs Node or Bun, and Claude Code comes with
neither. On a machine with none, `/mcp-skills setup` fetches one:

- **Only when you ask, and only after you say yes.** The command counts only
  when you type it at the prompt, or send it from your own Remote Control.
  Claude Code's own dialog then asks whether to download; "Not now" is the first
  answer.
- **What is fetched:** one fixed Bun release, for macOS or Linux, arm64 or x64,
  from that release's page on GitHub, over HTTPS only.
- **Checked before it is installed:** its SHA-256 must equal the one written in
  the mod's source, copied from the release's own checksum file. A download that
  does not match is deleted. Only the copy of the pinned version is ever run.
- **Where it goes:** a `runtime` folder in the plugin's data folder, used for
  this mod's helper and nothing else. `/mcp-skills setup remove` deletes it.

`/mcp-skills setup` has been tested in parts, not yet as one run on a machine
with no Node and no Bun: the download command against the release, the
unpacking, the checksum code inside Claude Code, the refusals, and the helper on
Bun were each run for real; the sequence as a whole is covered by tests with
stand-ins.

## More

On GitHub, in [`polyfills/skills/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/README.md),
[`docs/host-changes.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/docs/host-changes.md)
(what Claude Code would need to offer for this mod to work with every server),
and the evidence of each test run in
[`docs/evidence/`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/claude-code/docs/evidence).
