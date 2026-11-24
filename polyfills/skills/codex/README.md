# mcp-skills for Codex: skills from your MCP servers, in Codex

A Codex plugin that lets Codex use the [skills](https://agentskills.io/) your
MCP servers serve: they appear in Codex's skill list, Codex loads one when a
task calls for it, and reads the files it refers to as it needs them. You
approve each skill once.

It adds the client side of the MCP **Skills** extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which Codex does not support by itself yet
(openai/codex issue #48000). It is the same polyfill as
[the Claude Code one](../claude-code/), on the same shared core
([`../core`](../core/)), with a Codex front.

## Install

In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-skills@agent-polyfill
```

That adds the [AgentPolyfill](../../../README.md) marketplace and installs the
plugin. With the marketplace already added, `codex plugin add
mcp-skills@agent-polyfill` alone does it. To remove it: `codex plugin remove
mcp-skills@agent-polyfill`.

You need:

- **Codex 0.172** (the version the plugin was run on; how Codex picks up
  skill folders was also checked on 0.170.0). No experimental feature:
  plugins, MCP servers, skills and the question the plugin asks (MCP
  elicitation) are all stable and on.
- **Node 20 or newer on your PATH.** Codex runs the plugin's MCP server with
  `node`.

## Try it

Add Hugging Face's public MCP server to `~/.codex/config.toml`. It serves 25
skills, and needs no account for this:

```toml
[mcp_servers.huggingface]
url = "https://huggingface.co/mcp"
```

(`codex mcp add huggingface --url https://huggingface.co/mcp` writes the same,
and then offers a Hugging Face sign-in, which the plugin does not use.)

Start `codex` once, so the plugin can look at the server, then start it again
in any folder. In Codex's `$` skill picker the server's skills show as
`mcp-skills:huggingface:<name>`, each marked with its server. Ask with one of
them:

> $mcp-skills:huggingface:huggingface-local-models Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Codex loads the skill with the plugin's `load_skill` tool, and shows you the
plugin's question once: do not load it, show you its `SKILL.md` first, or load
it. Codex then reads the skill's reference files from the server and answers
from them. Without the `$` name, Codex picks a served skill when the task fits
its description, as it does for any skill; with many skills installed, Codex
may list them by name only, and then naming the skill is the sure way.

Why start it twice: Codex reads a plugin's skills when the plugin loads, at
the start of a session, and the plugin learns what your servers serve during
that start. A skill a server adds is in Codex's list from the next session. In
the meantime Codex can still reach every served skill: ask it to list the
skills your MCP servers serve (its `mcp-skills` skill and `list_skills` tool).

## What to expect

- **Nothing to set up per server.** Every server in `~/.codex/config.toml`
  that declares the Skills extension has its skills listed, as
  `mcp-skills:<server>:<name>`, each marked with its server.
- **One question per skill.** The first time Codex loads a skill, you are
  asked, in Codex's own form. Your yes is kept for that skill as it is now:
  every file's address and digest, and where the server is. If the server
  changes the skill, you are asked again and told it changed.
- **"Show me its SKILL.md first"** shows you the skill's text, checked against
  its digest, before you decide. The model sees nothing of it until you say
  "Load it".
- **No other questions from the plugin.** Reading a loaded skill's files and
  listing skills raise none. After your yes, what Codex does goes through your
  usual Codex approvals, as for a skill on your disk.
- **Turning a skill off** works as for any Codex skill (`[[skills.config]]`,
  by its path or its name): it leaves Codex's list, and the plugin refuses to
  load it or read its files.
- **`codex exec` and the approval policy `never`:** Codex declines every
  question there, so a skill you have not approved is not loaded. Approve it
  once in an interactive session; it then loads there while unchanged.

## From install to the first skill

| Step | What you see | If it is missing or declined |
|---|---|---|
| Install | `Added marketplace agent-polyfill`, then `Added plugin mcp-skills`. | Nothing is installed. |
| Node | Nothing. | Codex reports that the `mcp-skills` MCP server failed to start; nothing else changes. Install Node 20+. |
| A server that serves skills | Its skills are in Codex's skill list from the next session. | Ask Codex which skills your MCP servers serve: `list_skills` names each server it left alone and why (turned off, needs a sign-in, a variable Codex does not pass to plugins, no Skills extension). |
| Codex wants a skill | Codex shows the plugin's question. | "Do not load it", or closing the form: the skill is not loaded and nothing of it reaches the model. You are asked again next time. |
| The skill's files | Nothing: read as needed, from the server, verified. | |
| The server changes the skill | Asked again, told it changed. | The old version stays in a conversation that has it; the new one is not loaded. |

## Which servers work

| How the server is in `config.toml` | Works |
|---|---|
| A local command (`command`, `args`, `env`, `cwd`) | Yes |
| A URL with no credentials (Hugging Face) | Yes |
| A URL with `http_headers` | Yes |
| A URL with `bearer_token_env_var` or `env_http_headers` | **Only if the plugin's server has the variable**, which it usually does not: Codex starts a plugin's MCP server with a small fixed environment (HOME, PATH, USER, ...). The server is left out and you are told why. |
| A URL you signed in to with `codex mcp login` (OAuth) | **No** |
| `enabled = false`, or run in another environment | Left alone |
| A server that comes with a plugin, or from a project's `.codex/config.toml` | Not looked at |

**Why not servers behind a sign-in.** Codex keeps its sign-ins to itself, and
gives a plugin no way to send the extension's requests (`skills/list`,
`skills/get`) over Codex's own connection. The plugin therefore opens a
connection of its own, with what your config holds. It runs no sign-in of its
own and stores no tokens. Codex's app-server can call a server's tools and
read its resources over Codex's connection, but has no method for other
requests ([`../claude-code/docs/host-changes.md`](../claude-code/docs/host-changes.md)
describes the same gap in Claude Code).

## How it works

```
your MCP server ◄── skills/list · skills/get · resources/read ── mcp-skills (the plugin's MCP server, mod/dist/helper.js)
                                                                   │  ▲
              writes <plugin>/skills/served/<server>-…/<…>/SKILL.md │  │ load_skill · read_skill_file · list_skill_directory · list_skills
                                                                   ▼  │ (and its question to you, as an MCP elicitation)
Codex ── lists those SKILL.md files with its other skills ──────── Codex
```

- **Finding servers.** At the start of each session, the plugin's MCP server
  reads `[mcp_servers.*]` in your Codex config, connects to each server once,
  keeps the ones that declare the extension, and asks each for its list of
  skills. No file is fetched. A server found not to serve skills is not
  connected to again for a day.
- **Listing.** For each skill it writes a short `SKILL.md` of its own into the
  plugin's own skills folder: the skill's name and the server's description,
  marked with the server, and a body that says how to load it. Codex lists
  those with its other skills. None of the skill's content is written to disk,
  and nothing is fetched to write them.
- **Loading.** When Codex uses one, it calls `load_skill` with the server and
  the skill's URI. The plugin asks you (unless you approved this exact skill
  before), fetches `SKILL.md` from that server, checks its size and SHA-256
  digest against what the server published, compares its frontmatter with the
  published one field by field, and only then hands the text to Codex, marked
  with the server it came from.
- **Reading files.** A file the skill refers to is read with `read_skill_file`,
  only from the skill's own server, only if the skill's manifest lists it, and
  checked the same way.

The plugin does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension.

**Stand-down.** If Codex declares the Skills extension itself (on the
connection to the plugin's server), the plugin removes its stubs and its tools
do nothing. Until Codex does, turn it off with `codex plugin remove`, or by
writing `{"off": true}` to `~/.codex/mcp-skills/settings.json`.

## Limits

- **Servers behind a sign-in, and servers whose token is in an environment
  variable** (see the table above).
- **A skill a server adds appears in Codex's list from the next session** (see
  "Try it"). Reachable meanwhile through `list_skills`.
- **Another server's resources.** The extension requires a host to ask you,
  naming both servers, before a skill of one server leads to a resource read
  from another. Codex's own `read_mcp_resource` tool is not something a plugin
  can put a question in front of, so this one rule is not met; the loaded
  skill tells the model to ask you first. Details in
  [`SECURITY.md`](SECURITY.md) and [`docs/conformance.md`](docs/conformance.md)
  (X8). Closing it needs Codex: an "ask" decision for hooks, or a plugin hook
  that keeps your trust when the plugin's folder changes.
- **A second connection.** The plugin's connection to a server is beside
  Codex's own, so a local (stdio) server that serves skills runs twice.
- **At most 100 skills** in Codex's list (all are reachable with `list_skills`).
- **Binary files** of a skill are checked but not shown to the model.
- **Managed machines.** Where a managed Codex policy says anything about MCP
  servers, the plugin connects to none, because it cannot apply that policy.
- **Not tried yet:** Windows and Linux (run on macOS; the tests are set up to
  run on all three), the Codex desktop app and IDE extension (the terminal UI
  and `codex exec` were tried).

## Security

A skill is text a server wrote, which a model may follow, and which may tell
the model to run things on your machine. The plugin treats it as untrusted
data from that server, never as instructions from you.

- A skill is loaded only after you chose "Load it" in Codex's form, and your
  approval is bound to its content. The form has a required choice, which,
  in Codex 0.172's source (`codex-mcp/src/elicitation.rs`), Codex does not
  answer in your place; anything but "Load it" is a no.
- A skill or file URI holding control, direction-changing or invisible
  characters is refused, and the SKILL.md shown before a load has them
  removed, so a server cannot rewrite the question you are asked.
- Everything from a server is shown under the server's name as you configured
  it, never what the server calls itself.
- A skill's frontmatter grants nothing: `allowed-tools` and the rest never
  reach Codex.
- The plugin never reads Codex's stored sign-ins and stores no tokens.

The full account, including what it does not protect against:
[`SECURITY.md`](SECURITY.md).

## Settings

There is nothing to set. For the rare case, write
`~/.codex/mcp-skills/settings.json` yourself (the plugin never writes it):

| Key | What it does |
|---|---|
| `"servers": ["a", "b"]` | Look only at these servers. |
| `"skip": ["c"]` | Never look at these servers. |
| `"off": true` | Do nothing, without being uninstalled. |

What the plugin keeps is in `~/.codex/mcp-skills/`: your approvals, which
servers serve skills, and a log. Delete the folder to start over.

## Proof

One recorded session in the Codex terminal UI (Codex 0.172.0, macOS), with
Hugging Face's public server added as above
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

After "Show me its SKILL.md first" (the text, to you only) and "Load it":

```
• Called mcp-skills.load_skill(...)
  └ Loaded the skill "huggingface-local-models" from the MCP server "huggingface" (...), which the user approved just now.
    Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. ...
• Called mcp-skills.read_skill_file({"server":"huggingface","skill":"skill://huggingface-local-models/SKILL.md","path":"references/quantization.md"})
  └ "references/quantization.md" of the skill "huggingface-local-models", from the MCP server "huggingface" (6136 bytes, matched the size
    and SHA-256 digest in the skill's entry). Content from that server: ...
• Start with Q4_K_M for a 7B model on a 16 GB Mac. ...
```

And unattended, in `codex exec`: the skill approved above loads with no
question, and one never approved is refused
([`docs/evidence/exec.txt`](docs/evidence/exec.txt)).

## How it is tested

| What | How to run it | Result |
|---|---|---|
| The client rules, one test per rule, against a hand-written server; the stubs; the config reader; the bundled plugin server spoken to as Codex speaks to it, its questions answered as Codex answers them; control and invisible characters from a server | `npm test` | 61 pass |
| The official MCP conformance suite's client scenarios for SEP-2640 (it has four) | [`test/conformance/run.sh`](test/conformance/run.sh) | 4 of 4 pass ([output](docs/evidence/conformance.txt)) |
| Hugging Face's public server: 25 skills listed and written as stubs, every skill loaded, all 135 files verified | `npm run interop:real` | all verified ([output](docs/evidence/interop-real.txt)) |
| Installing from the marketplace into a fresh `CODEX_HOME` (Codex lists only the Codex plugins there: mcp-events and mcp-skills), and the installed copy running from its own folder | `codex plugin marketplace add`, `codex plugin add` | installs, runs, writes 25 stubs ([output](docs/evidence/install.txt)) |
| A real Codex session, interactive | [`live/take-proof.sh`](live/take-proof.sh) | the skill listed, asked about, shown, loaded and used ([screens](live/runs/proof/)) |
| A real `codex exec` run | see [`live/`](live/) | an approved skill loads unasked; an unapproved one is refused ([output](docs/evidence/exec.txt)) |

[`docs/conformance.md`](docs/conformance.md) maps every client rule of the
extension to the code and the test (60 rules: 52 met, 6 met with a stated
limit, 1 not met, 1 that does not apply).

### Development

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
server (`dist/helper.js`, with the shared core inside it) and the plugin's own
`mcp-skills` skill. [`../core/src/skills.ts`](../core/src/skills.ts) is the
extension's client logic, shared with the Claude Code adapter;
[`src/stubs.ts`](src/stubs.ts) is how Codex comes to list served skills, and
[`src/mcp.ts`](src/mcp.ts) the server Codex talks to.

## How Codex picks up skill folders

What the plugin's design rests on, checked on Codex 0.170.0 (and again on
0.172.0 in the recorded session):

- A `SKILL.md` folder that exists when a session starts is listed, in every
  root Codex reads.
- One written **while a session runs** into the project's `.agents/skills`,
  or into a root set with the app-server's `skills/extraRoots/set`, is listed
  from the **next turn**: Codex watches those folders, sends `skills/changed`,
  and renders the whole list again. No flag is needed. Not within the turn that
  wrote it.
- One written into a **plugin's own** skills folder while a session runs is
  listed from the **next session**: Codex keeps a plugin's skills from when the
  plugin loaded.
- In `codex exec`, the first turn's list is built while MCP servers start, so a
  skill an MCP server writes at its start may or may not make that turn.
- `skill_catalog_deltas` (under development, off) is not needed, and is best
  left off: with it on, the update in one run left out skills written between
  the turns.

The plugin writes into its own folder, never into yours, so that its stubs go
when the plugin is removed; hence the next-session listing.

## Problems and questions

[Open an issue](https://github.com/idosal/AgentPolyfill/issues) that names
`mcp-skills` and Codex. Say which Codex version you run (`codex --version`),
how the server is configured (without its token), and what
`~/.codex/mcp-skills/mcp-skills.log` says. For a security problem, see
[`SECURITY.md`](SECURITY.md#reporting-a-problem).

## Licence

[Apache-2.0](../../../LICENSE). The bundled server (`mod/dist/helper.js`)
includes npm packages under their own licences:
[`mod/THIRD_PARTY_LICENSES.txt`](mod/THIRD_PARTY_LICENSES.txt).
