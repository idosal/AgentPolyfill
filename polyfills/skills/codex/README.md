# mcp-skills for Codex

Codex can use the [skills](https://agentskills.io/) your MCP servers serve.
They show up in Codex's skill list, Codex loads one when a task calls for it,
and it reads the files the skill refers to as it needs them. You approve each
skill once.

Also available for Claude Code: [mcp-skills for Claude Code](../claude-code/README.md).
The same plugin folder is also the Muse Code form: [mcp-skills for Muse Code](../muse/README.md).

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which Codex doesn't support itself yet
(openai/codex issue #48000). One of the extension's client rules, X8, isn't
met in Codex: see [Limits](#limits). Both forms share their client logic, in
[`../core`](../core/). Details are in
[Spec and conformance](#spec-and-conformance).

## Install

In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-skills@agent-polyfill
```

That adds the [AgentPolyfill](../../../README.md) marketplace and installs the
plugin. If you've already added the marketplace,
`codex plugin add mcp-skills@agent-polyfill` alone does it. To remove the
plugin, run `codex plugin remove mcp-skills@agent-polyfill`, then delete
`~/.agents/skills/mcp-skills-served`, where it keeps the entries Codex lists
served skills by (see [Where it writes](#where-it-writes)).

You need:

- **Codex 0.172**, the version the plugin was run on. How Codex picks up skill
  folders was also checked on 0.170.0. No experimental feature has to be
  turned on: plugins, MCP servers, skills and the question the plugin asks
  (MCP elicitation) are all stable and on.
- **Node 20 or newer on your `PATH`.** Codex runs the plugin's MCP server with
  `node`.

## In Muse Code

The same folder installs in Muse Code: [mcp-skills for Muse Code](../muse/README.md)
has the install steps, what works differently there and why, its limits, and
its security notes.

## Try it

Add Hugging Face's public MCP server to `~/.codex/config.toml`. It serves 25
skills, and you don't need an account for this:

```toml
[mcp_servers.huggingface]
url = "https://huggingface.co/mcp"
```

`codex mcp add huggingface --url https://huggingface.co/mcp` writes the same
entry, then offers a Hugging Face sign-in, which the plugin doesn't use.

Start `codex` in any folder. The first time, the server's skills may not be
in Codex's `$` skill picker yet. Then ask Codex once:

> List the skills my MCP servers serve.

Codex answers with the plugin's `list_skills` tool. That starts the plugin's
MCP server if it isn't running yet, and it writes an entry for each served
skill where Codex reads skills. From your next turn, the skills are in the `$`
picker as `mcp-skills:huggingface:<name>`, each marked with its server, and in
later sessions they're there from the start. Ask with one of them:

> $mcp-skills:huggingface:huggingface-local-models Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Codex loads the skill with the plugin's `load_skill` tool, and shows you the
plugin's question once: don't load it, show you its `SKILL.md` first, or load
it. Codex then reads the skill's reference files from the server and answers
from them.

Without the `$` name, Codex picks a served skill when the task fits its
description, as it does for any skill. With many skills installed, Codex may
list them by name only, and then naming the skill is the sure way.

Why ask? Codex starts a plugin's MCP server when a session opens, except
when its app-server daemon is already running and has run the plugin
recently: then Codex starts it only at the first call of one of its tools.
The plugin writes the entries when its server starts, so asking to list the
served skills is the sure way to have them written. The entries stay on disk,
and they're written again each time the plugin's server starts, so a skill a
server adds shows up from the turn after that. `list_skills` reaches every served skill at
any time, including one not in the `$` picker yet.

## How it works

### What to expect

- **Nothing to set up per server.** Every server in `~/.codex/config.toml`
  that declares the Skills extension has its skills listed, as
  `mcp-skills:<server>:<name>`, each marked with its server.
- **One question per skill.** The first time Codex loads a skill, you're
  asked, in Codex's own form. Your yes is kept for that skill as it is now:
  every file's address and digest, and where the server is. If the server
  changes the skill, you're asked again and told it changed.
- **"Show me its SKILL.md first"** shows you the skill's text, checked against
  its digest, before you decide. The model sees nothing of it until you choose
  "Load it".
- **No other questions from the plugin.** Reading a loaded skill's files and
  listing skills raise none. After your yes, what Codex does goes through your
  usual Codex approvals, as it would for a skill on your disk.
- **Turning a skill off** works as for any Codex skill, with
  `[[skills.config]]`, by its path or its name. The skill leaves Codex's list,
  and the plugin refuses to load it or read its files.
- **`codex exec` and the approval policy `never`.** Codex declines every
  question there, so a skill you haven't approved isn't loaded. Approve it once
  in an interactive session, and it then loads there as long as it's
  unchanged.

### From install to the first skill

| Step | What you see | If it is missing or declined |
|---|---|---|
| Install | `Added marketplace agent-polyfill`, then `Added plugin mcp-skills`. | Nothing is installed. |
| Node | Nothing. | Codex reports that the `mcp-skills` MCP server failed to start. Nothing else changes. Install Node 20+. |
| A server that serves skills | Its skills are in Codex's skill list from the turn after the plugin's server starts. If they aren't, ask once to list the served skills. In later sessions they're there from the first turn. | Ask Codex which skills your MCP servers serve. `list_skills` names each server it left alone, and why: turned off, needs a sign-in, a variable Codex doesn't pass to plugins, no Skills extension. |
| Codex wants a skill | Codex shows the plugin's question. | "Do not load it", or closing the form: the skill isn't loaded, and nothing of it reaches the model. You're asked again next time. |
| The skill's files | Nothing: they're read as needed, from the server, and verified. | |
| The server changes the skill | You're asked again, and told it changed. | The old version stays in a conversation that has it. The new one isn't loaded. |

### Which servers work

| How the server is in `config.toml` | Works |
|---|---|
| A local command (`command`, `args`, `env`, `cwd`) | Yes |
| A URL with no credentials (Hugging Face) | Yes |
| A URL with `http_headers` | Yes |
| A URL with `bearer_token_env_var` or `env_http_headers` | Only if the plugin's server has the variable, which it usually doesn't. Codex starts a plugin's MCP server with a small fixed environment (HOME, PATH, USER, ...). The server is left out, and you're told why. |
| A URL you signed in to with `codex mcp login` (OAuth) | No |
| `enabled = false`, or run in another environment | Left alone |
| A server that comes with a plugin, or from a project's `.codex/config.toml` | Not looked at |

### Servers behind a sign-in

Codex keeps its sign-ins to itself, and gives a plugin no way to send the
extension's requests (`skills/list`, `skills/get`) over Codex's own
connection. So the plugin opens a connection of its own, with what your config
holds. It runs no sign-in of its own, and it stores no tokens. Codex's
app-server can call a server's tools and read its resources over Codex's
connection, but it has no method for other requests.
[`../claude-code/docs/host-changes.md`](../claude-code/docs/host-changes.md)
describes the same gap in Claude Code.

### How a skill gets to the model

```
your MCP server ◄── skills/list · skills/get · resources/read ── mcp-skills (the plugin's MCP server, mod/dist/helper.js)
                                                                   │  ▲
     writes ~/.agents/skills/mcp-skills-served/<server>-…/<…>/SKILL.md │  │ load_skill · read_skill_file · list_skill_directory · list_skills
                                                                   ▼  │ (and its question to you, as an MCP elicitation)
Codex ── lists those SKILL.md files with its other skills ──────── Codex
```

- **Finding servers.** When it starts, the plugin's MCP server
  reads `[mcp_servers.*]` in your Codex config and connects to each server
  once. It keeps the ones that declare the extension, and asks each for its
  list of skills. No file is fetched. A server found not to serve skills isn't
  connected to again for a day.
- **Listing.** For each skill, the plugin writes a short `SKILL.md` of its own,
  a stub, into `~/.agents/skills/mcp-skills-served` (see
  [Where it writes](#where-it-writes)). The stub holds the skill's name and the
  server's description, marked with the server, and a body that says how to
  load it. Codex lists the stubs with its other skills, from the next turn.
  None of the skill's content is written to disk, and nothing is fetched to
  write them.
- **Loading.** When Codex uses a skill, it calls `load_skill` with the server
  and the skill's URI. The plugin asks you, unless you approved this exact
  skill before. It fetches `SKILL.md` from that server and checks its size and
  SHA-256 digest against what the server published. It compares the
  frontmatter with the published one, field by field. Only then does it hand
  the text to Codex, marked with the server it came from.
- **Reading files.** A file the skill refers to is read with
  `read_skill_file`, only from the skill's own server, only if the skill's
  manifest lists it, and it's checked the same way.

The plugin does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension.

### How Codex picks up skill folders

The plugin's design rests on how Codex lists skills. This was checked on Codex
0.170.0, and again on 0.172.0 in the recorded session:

- A `SKILL.md` folder that exists when a session starts is listed, in every
  root Codex reads.
- One written **while a session runs** into the project's `.agents/skills`, or
  into a root set with the app-server's `skills/extraRoots/set`, is listed from
  the **next turn**. Codex watches those folders, sends `skills/changed`, and
  renders the whole list again. No flag is needed. It isn't listed within the
  turn that wrote it.
- The same holds for `~/.agents/skills`, a root Codex reads for every session
  (checked on 0.172.0 with a running app-server daemon).
- One written into a **plugin's own** skills folder while a session runs is
  listed from the **next session**: Codex keeps a plugin's skills from when the
  plugin loaded. And Codex replaces a plugin's folder with a fresh copy
  whenever its marketplace is updated, so anything written there goes.
- An app-server that runs several sessions, as the app-server daemon does,
  keeps a local MCP server's tool list from one session to the next (for up to
  30 minutes), and then starts that server only when one of its tools is called
  (`can_defer_stdio_startup` in Codex's `config/src/mcp_types.rs`). A plugin
  has no supported way to change that. Marking the server required would start
  it with the session, but then no session starts while it can't (no Node, for
  instance).
- In `codex exec`, the first turn's list is built while MCP servers start, so a
  skill an MCP server writes at its start may or may not make that turn.
- `skill_catalog_deltas` (under development, off) isn't needed, and is best
  left off. With it on, the update in one run left out skills written between
  the turns.

So the stubs go into a folder of their own in `~/.agents/skills`, which a
marketplace update doesn't touch and Codex lists from the next turn, and they
stay there from one session to the next. The plugin's server writes them when
it starts: when a session opens, or, on a running daemon, at its first tool
call. Up to 0.1.4 they were in the plugin's own folder, which lost them on
every marketplace update. What Codex would need to change is in
[host changes](../../../docs/host-changes.md).

### Where it writes

- **`~/.agents/skills/mcp-skills-served/`**: the stubs, one folder per server
  (`<server>-<6 hex>`), one folder per skill in it (`<16 hex of its URI>`),
  each with a `SKILL.md` the plugin wrote. The plugin creates this folder,
  writes and removes only folders of that shape in it, and touches nothing
  else in `~/.agents/skills`. It is rewritten each time the plugin's server
  starts: a skill a server no longer serves, or a server you removed from your
  config, loses its stubs then. All your Codex homes share this folder: a
  session under another `CODEX_HOME` replaces the stubs with those of its own
  config. Other programs that read `~/.agents/skills` see the stubs too; each
  says it is served by an MCP server and can be loaded only through Codex's
  `mcp-skills` tool. Removing the plugin leaves the folder: delete it
  yourself.
- **`~/.codex/mcp-skills/`** (`$CODEX_HOME/mcp-skills`): your approvals, which
  servers serve skills, and a log. See [Settings](#settings).

Nothing else, and none of a skill's content.

### Problems and questions

[Open an issue](https://github.com/idosal/AgentPolyfill/issues) that names
`mcp-skills` and Codex. Say which Codex version you run (`codex --version`),
how the server is configured (without its token), and what
`~/.codex/mcp-skills/mcp-skills.log` says. For a security problem, see
[`SECURITY.md`](SECURITY.md#reporting-a-problem).

### What differs between Claude Code and Codex

| | Claude Code | Codex |
|---|---|---|
| What runs | A mod inside Claude Code, and a helper process (`mod/dist/helper.js`) on Node 20+ or Bun | A plugin whose MCP server (`mod/dist/helper.js`) Codex starts with Node 20+ |
| Servers it reads | The project's `.mcp.json`, and the user and local scopes. It connects only to servers Claude Code itself uses. | `[mcp_servers.*]` in `~/.codex/config.toml`. Servers that come with a plugin, or from a project's `.codex/config.toml`, aren't looked at. |
| Where served skills appear | In Claude's skill listing, under their own heading: right after the install, and from the next session for a server you add later | In Codex's `$` skill list, as `mcp-skills:<server>:<name>`, from the turn after the plugin's server starts (after you ask once to list the served skills, if Codex's daemon was already running), and from the first turn of every later session. The plugin writes a short `SKILL.md` stub for each one into `~/.agents/skills/mcp-skills-served`. At most 100 are listed. |
| The question before a load | Claude Code's own permission dialog | Codex's form (MCP elicitation): "Do not load it", "Show me its SKILL.md first" or "Load it" |
| Reading a skill before you decide | `/mcp-skills show <skill>`, in a panel Claude doesn't read | "Show me its SKILL.md first", shown to you only |
| Where your approvals are kept | The mod's own store, in your Claude Code configuration folder | `~/.codex/mcp-skills/approvals.json` |
| Turning a skill off | `/mcp-skills disable <skill>` | Codex's own `[[skills.config]]` |
| A loaded skill leads to a resource on another server (rule X8) | Claude Code asks you first, naming both servers | Not asked: a plugin can't put a question in front of Codex's `read_mcp_resource`. The loaded skill tells the model to ask you first. |
| Nobody to ask | `claude -p`: an unapproved skill loads only if your rules allow the tool, and then Claude can only read and search | `codex exec`, or the approval policy `never`: an unapproved skill isn't loaded |
| Servers behind a sign-in | A browser sign-in through `/mcp`, claude.ai connectors and plugin servers aren't supported | A `codex mcp login` sign-in isn't supported. A token in an environment variable usually isn't either. |
| Settings | Environment variables | `~/.codex/mcp-skills/settings.json` |
| Stand-down | Turns itself off for a session in which it sees Claude Code load a skill from an MCP server | Removes its stubs, and its tools do nothing, if Codex declares the Skills extension itself |
| Client rules (60) | 54 met, 3 met with a stated limit, 3 don't apply | 52 met, 6 met with a stated limit, 1 not met (X8), 1 doesn't apply |
| Run on | macOS, Claude Code 2.1.329 | macOS, Codex 0.172: the terminal UI and `codex exec` |

## Settings

There's nothing to set. For the rare case that needs it, write
`~/.codex/mcp-skills/settings.json` yourself. The plugin never writes it.

| Key | What it does |
|---|---|
| `"servers": ["a", "b"]` | Look only at these servers. |
| `"skip": ["c"]` | Never look at these servers. |
| `"off": true` | Do nothing, without being uninstalled. |

What the plugin keeps is in `~/.codex/mcp-skills/`: your approvals, which
servers serve skills, and a log. Delete the folder to start over. The stubs
Codex lists are in `~/.agents/skills/mcp-skills-served`
([Where it writes](#where-it-writes)).

### When Codex supports Skills itself

If Codex declares the Skills extension itself, on its connection to the
plugin's server, the plugin removes its stubs and its tools do nothing. Until
Codex does, turn the plugin off with `codex plugin remove`, or by writing
`{"off": true}` to `~/.codex/mcp-skills/settings.json`.

## Limits

- **Servers behind a sign-in, and servers whose token is in an environment
  variable.** See [Which servers work](#which-servers-work).
- **The first time, you may have to ask.** When Codex's app-server daemon is
  already running and has run the plugin recently, Codex starts the plugin's
  MCP server only at its first tool call, so no stubs are written when the
  session opens. Ask once to list the served skills: they're in Codex's list
  from the next turn, and in later sessions from the start. A skill a server
  adds appears the same way. See [Try it](#try-it).
- **The stubs live in `~/.agents/skills`,** which other programs may read too,
  and they stay after the plugin is removed. See
  [Where it writes](#where-it-writes).
- **One folder for all your Codex homes.** A session under another
  `CODEX_HOME` replaces the stubs in `~/.agents/skills/mcp-skills-served` with
  those of its own config. A stub left from another home fails safely: if this
  home has no server of that name, `load_skill` refuses it.
- **Another server's resources (rule X8).** The extension requires a host to
  ask you, naming both servers, before a skill of one server leads to a
  resource read from another. Codex's own `read_mcp_resource` tool isn't
  something a plugin can put a question in front of, so this one rule isn't
  met. The loaded skill tells the model to ask you first. Details are in
  [`SECURITY.md`](SECURITY.md) and [`docs/conformance.md`](docs/conformance.md)
  (X8). Closing it needs a change in Codex: an "ask" decision for hooks, or a
  plugin hook that keeps your trust when the plugin's folder changes.
- **A second connection.** The plugin's connection to a server sits beside
  Codex's own, so a local (stdio) server that serves skills runs twice.
- **At most 100 skills** in Codex's list. `list_skills` reaches all of them.
- **Binary files** of a skill are checked, but not shown to the model.
- **Managed machines.** Where a managed Codex policy says anything about MCP
  servers, the plugin connects to none, because it can't apply that policy.
- **Not tried yet:**
  - Windows and Linux. It was run on macOS; the tests are set up to run on all
    three.
  - The Codex desktop app and IDE extension. The terminal UI and `codex exec`
    were tried.
  - Full access (`--dangerously-bypass-approvals-and-sandbox`), live. What
    [`SECURITY.md`](SECURITY.md) says about it is a reading of Codex 0.172's
    source.

[What hosts would need to change](../../../docs/host-changes.md) covers these
gaps for Codex and Claude Code side by side.

## Security

A skill is text a server wrote. A model may follow it, and it may tell the
model to run things on your machine. The plugin treats it as untrusted data
from that server, never as instructions from you.

- A skill is loaded only after you chose "Load it" in Codex's form, and your
  approval is bound to its content. The form has a required choice. In Codex
  0.172's source (`codex-mcp/src/elicitation.rs`), Codex doesn't answer such a
  form in your place. Anything but "Load it" is a no.
- A skill or file URI that holds anything but printable ASCII is refused.
- The `SKILL.md` shown before a load has its control characters removed. Every
  run of hidden characters (tag characters, variation selectors and other
  default-ignorable code points) is shown as `⟦3 hidden characters⟧`, inside a
  frame it can't forge. So a server can't use control characters to rewrite
  the question you're asked, and the preview shows you where there is text you
  can't see but the model would read. The loaded skill tells the model how many
  such characters it holds.
- Everything from a server is shown under the server's name as you configured
  it, never what the server calls itself.
- A skill's frontmatter grants nothing: `allowed-tools` and the rest never
  reach Codex.
- The plugin never reads Codex's stored sign-ins, and stores no tokens.

[`SECURITY.md`](SECURITY.md) has the full account: what the plugin trusts, does
and keeps, and what it doesn't protect against.

## Spec and conformance

The plugin implements the client side of
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
the MCP Skills extension, Final, at commit `2eb3a8e`.

### Client rules

[`docs/conformance.md`](docs/conformance.md) maps every client rule of the
extension to the code and the test. There are 60 rules: 52 met, 6 met with a
stated limit, 1 not met, and 1 that doesn't apply. The one not met is X8, in
[Limits](#limits).

### A recorded session

One recorded session in the Codex terminal UI (Codex 0.172.0, macOS), with
Hugging Face's public server added as in [Try it](#try-it)
([all the screens](live/runs/proof/), [how to repeat it](live/)). The served
skill in Codex's `$` picker, marked with its server:

```
› huggingface:huggingface-l...  [Skill] [MCP server "huggingface", not a local skill] Use to select models to run locally with llama.cpp an…
```

Codex calls the plugin's `load_skill`, and shows the plugin's question:

```
• Calling mcp-skills.load_skill({"server":"huggingface","uri":"skill://huggingface-local-models/SKILL.md"}) (environment local)
  Load the skill "huggingface-local-models" from the MCP server "huggingface"?
  It is not a local skill: the server serves it, and its text will reach the model as that server's content. ...
  URI: skill://huggingface-local-models/SKILL.md
  4 files, 15849 bytes, each checked against the server's SHA-256 digest when read.
  Your answer
  › 1. Do not load it
    2. Show me its SKILL.md first
    3. Load it
```

After "Show me its SKILL.md first" (the text, shown to you only) and "Load it":

```
• Called mcp-skills.load_skill(...)
  └ Loaded the skill "huggingface-local-models" from the MCP server "huggingface" (...), which the user approved just now.
    Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. ...
• Called mcp-skills.read_skill_file({"server":"huggingface","skill":"skill://huggingface-local-models/SKILL.md","path":"references/quantization.md"})
  └ "references/quantization.md" of the skill "huggingface-local-models", from the MCP server "huggingface" (6136 bytes, matched the size
    and SHA-256 digest in the skill's entry). Content from that server: ...
• Start with Q4_K_M for a 7B model on a 16 GB Mac. ...
```

Unattended, in `codex exec`, the skill approved above loads with no question,
and one never approved is refused
([`docs/evidence/exec.txt`](docs/evidence/exec.txt)).

### Tests

| What | How to run it | Result |
|---|---|---|
| The client rules, one test per rule, against a hand-written server; the stubs; the config reader; the bundled plugin server spoken to as Codex speaks to it, its questions answered as Codex answers them; control and hidden characters from a server; the plugin as Codex installs it: its folder copied afresh as a marketplace update does, its stubs written by its first tool call, and, where `codex` is installed, a reinstall in Codex itself | `npm test` | 77 pass |
| The official MCP conformance suite's client scenarios for SEP-2640 (it has four) | [`test/conformance/run.sh`](test/conformance/run.sh) | 4 of 4 pass ([output](docs/evidence/conformance.txt)) |
| Hugging Face's public server: 25 skills listed and written as stubs, every skill loaded, all 135 files verified | `npm run interop:real` | all verified ([output](docs/evidence/interop-real.txt)) |
| Installing from the marketplace into a fresh `CODEX_HOME` (Codex lists only the Codex plugins there: mcp-events and mcp-skills), and the installed copy running from its own folder | `codex plugin marketplace add`, `codex plugin add` | installs, runs, writes 25 stubs ([output](docs/evidence/install.txt), recorded on 0.1.0, when the stubs were in the plugin's folder) |
| A running app-server daemon that ran the plugin before: a session that asks to list the served skills, then a plain question; a marketplace update; a second session | [`live/take-daemon.sh`](live/take-daemon.sh) | the plugin's server starts at `list_skills`, not when the session opens; 25 skills listed from the next turn, and a plain question picks one; the stubs survive the update; the second session lists them from its first turn and uses one ([output](docs/evidence/daemon.txt)) |
| A real Codex session, interactive | [`live/take-proof.sh`](live/take-proof.sh) | the skill listed, asked about, shown, loaded and used ([screens](live/runs/proof/)) |
| A real `codex exec` run | see [`live/`](live/) | an approved skill loads unasked; an unapproved one is refused ([output](docs/evidence/exec.txt)) |

## Development

From this folder (`polyfills/skills/codex` in the repository):

```bash
npm ci && (cd ../core && npm ci) && (cd ../claude-code && npm ci)   # the tests reuse the Claude adapter's fixture server
npm test
npm run typecheck
npm run build          # mod/dist/helper.js, from src/ and ../core
npm run interop:real
CONFORMANCE_DIR=/path/to/modelcontextprotocol/conformance test/conformance/run.sh
```

`mod/` is all an installed copy carries: the manifest
(`.codex-plugin/plugin.json`), the MCP server entry (`.mcp.json`), the bundled
server (`dist/helper.js`, with the shared core inside it), and the plugin's own
`mcp-skills` skill.

- [`../core/src/skills.ts`](../core/src/skills.ts) is the extension's client
  logic, shared with the [Claude Code form](../claude-code/).
- [`src/stubs.ts`](src/stubs.ts) is how Codex comes to list served skills.
- [`src/mcp.ts`](src/mcp.ts) is the server Codex talks to.

## Licence

[Apache-2.0](../../../LICENSE). The bundled server (`mod/dist/helper.js`)
includes npm packages under their own licences:
[`mod/THIRD_PARTY_LICENSES.txt`](mod/THIRD_PARTY_LICENSES.txt).

This plugin is one of a set of polyfills that add MCP extensions to Claude
Code and Codex ahead of native support, collected at
[AgentPolyfill](../../../README.md). It's a community project by Ido Salomon.
It isn't affiliated with or endorsed by Anthropic, OpenAI, the Model Context
Protocol project, the Agentic AI Foundation or the Linux Foundation. Claude and
Claude Code are trademarks of Anthropic, PBC. OpenAI and Codex are trademarks
of OpenAI.
