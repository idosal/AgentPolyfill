# mcp-skills for Claude Code

Claude can use the [skills](https://agentskills.io/) your MCP servers serve.
They show up in Claude's skill listing, Claude loads one when a task calls for
it, and it reads the files the skill refers to as it needs them. Nothing is
installed locally, and you approve each skill once.

Also available for Codex: [mcp-skills for Codex](../codex/README.md).

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md),
Final), which Claude Code doesn't support itself yet. Both forms share their
client logic, in [`../core`](../core/). Details are in
[Spec and conformance](#spec-and-conformance).

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-skills --marketplace idosal/AgentPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-skills --marketplace idosal/AgentPolyfill
```

Either one adds the [AgentPolyfill](../../../README.md) marketplace and
installs the plugin in one step. If you've already added the marketplace,
`/plugin install mcp-skills@agent-polyfill` does the same. To add the
marketplace on its own, run `/plugin marketplace add idosal/AgentPolyfill`. To
install every polyfill in the marketplace, this one included, run
`/plugin install agent-polyfill --marketplace idosal/AgentPolyfill`.

That's the whole install. There are no settings to fill in and nothing to
configure per server. You need:

- **Claude Code 2.1.329 or newer**, the version it was tested on, with mods.
  Mods are on by default from Claude Code 2.1.287.
- **Node 20 or newer, or Bun**, to run the mod's helper. If your machine has
  either, the mod finds it by itself: on your `PATH`, through your login
  shell, or in the usual install folders. If it has neither (Claude Code
  itself needs neither), the mod says so, and one command sets it up:

  ```
  /mcp-skills setup
  ```

  It downloads the official Bun release for your platform (about 40 MB, from
  `github.com/oven-sh/bun`) into the plugin's own data folder, for this mod
  only. Nothing else on your machine changes: no `PATH` entry, no shell
  profile. See [The mod's own runtime](#the-mods-own-runtime).

The mod is one small folder, [`mod/`](mod/). It downloads nothing unless you
type that command. To turn it off, disable or uninstall the plugin in
`/plugin`.

To run it from a clone of this repository instead, for one session:

```bash
git clone https://github.com/idosal/AgentPolyfill
claude --plugin-dir AgentPolyfill/polyfills/skills/claude-code/mod
```

### The mod's own runtime

The mod's helper is JavaScript, so it needs Node or Bun, and Claude Code comes
with neither. On a machine that has neither, `/mcp-skills setup` fetches Bun:

- **Only when you ask, and only after you say yes.** The command counts only
  when you type it at the prompt, or send it from your own Remote Control. It's
  refused from the model, from a script, from another session, and in an
  unattended run (`claude -p`). When you run it, Claude Code's own dialog asks
  whether to download, and "Not now" is the first answer.
- **What it fetches.** One fixed Bun release, for macOS or Linux, on arm64 or
  x64, from that release's page on GitHub, over HTTPS only. The version is in
  [`mod/hooks/runtime.ts`](mod/hooks/runtime.ts). GitHub redirects the
  download to its file storage. What makes the download safe is the checksum
  below, not the host.
- **How it's checked before it's installed.** The download's SHA-256 must equal
  the one written in the mod's source, which was copied from the release's own
  checksum file. A download that doesn't match is deleted. The check happens
  when the copy is fetched, not each time it runs. Only the copy of the pinned
  version ever runs, from its own folder, and not through a symbolic link. A
  copy of any other version found there never runs, not even to ask its
  version, and the next setup deletes it.
- **Where it goes.** The `runtime` folder inside the plugin's data folder:
  `~/.claude/plugins/data/` followed by the plugin's folder, or the same under
  `CLAUDE_CONFIG_DIR`. It runs this mod's helper and nothing else.
  `/mcp-skills setup remove` deletes it. Uninstalling the plugin leaves the
  data folder in place, so run that command first, or delete the folder
  yourself.
- **What it needs.** `curl` and `unzip`, as Bun's own installer does. On
  Windows, or without them, install Node or Bun yourself.

If you have a Node or Bun of your own, the mod uses it first. To run the
helper on a particular one, name it in `MCP_SKILLS_RUNTIME`. A project's
settings can set that variable too, so a folder you trust can choose the
program that runs the helper, just as it can already run code through its own
hooks.

## Try it

Add Hugging Face's public MCP server. It serves skills, and you don't need an
account for this:

```bash
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

Start `claude` in the same folder and ask something one of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Claude finds `huggingface-local-models` in its skill listing and loads it.
Claude Code asks you once whether to load that skill. Claude then reads the
skill's reference files from the server and answers from them.

![A Claude Code session lists the 25 skills that Hugging Face's MCP server serves. Asked which model quantization to use on a 16 GB Mac, Claude picks the matching skill, Claude Code asks once whether to load it, and Claude reads the skill's files from the server and answers from them.](docs/media/demo.gif)

*A real session against Hugging Face's public MCP server, added with the one
line above. The picture zooms in on parts of the terminal, and the waits are
shortened. [Full video](docs/media/demo.mp4) (21 seconds).*

To try it with a server on your own machine, [`demo/`](demo/) holds a small
one that serves two skills. Run `npm install`, then point a server entry at
`node --no-warnings demo/server.ts`.

## How it works

### What to expect

- **Nothing to set up per server.** If a server in your MCP configuration
  declares the Skills extension, its skills are listed. That happens right
  after the install, with no restart, and from the next session for a server
  you add later.
- **One question per skill.** The first time Claude loads a skill, Claude Code
  asks you. Your yes is remembered for that skill as it is now: every file's
  address and digest. If the server changes the skill, you're asked again and
  told that it changed.
- **No other questions.** Reading a loaded skill's files and listing skills
  raise none. Once you've approved a skill, the commands Claude runs go through
  your usual permissions, as they would for a skill on your disk.
- **Skills you don't want.** `/mcp-skills disable <skill>` turns one skill off,
  by its server and the address of its `SKILL.md`. From then on it isn't in
  Claude's skill listing, and Claude can't load it or read its files. That
  holds in this session and in every other session that uses the same Claude
  Code configuration folder. It stays off whatever the server changes in it,
  and the same address on another server is a different skill.
  `/mcp-skills enable <skill>` turns it back on, and only you can do that, by
  typing it. Turning a skill off takes nothing back from a conversation that
  already loaded it: it stays there until the conversation is cleared.
- **No slow starts.** A server found not to serve skills isn't connected to
  again for a day. A session waits for a first listing (at most 4 seconds) only
  for servers that serve skills or that it hasn't looked at yet. A server that
  is slow or hangs doesn't hold back the other servers' skills.

### Commands

| Command | What it does |
|---|---|
| `/mcp-skills` | Lists the skills your servers serve, the servers left alone and why, and the skills you disabled. |
| `/mcp-skills show <skill>` | Opens a skill's `SKILL.md` in a panel for you to read. Nothing is loaded, and Claude doesn't read the panel. |
| `/mcp-skills use <skill> [what to do]` | Asks Claude to load a skill by name. |
| `/mcp-skills disable <skill>` | Keeps a skill from Claude: it isn't in Claude's skill listing, and it can't be loaded or read, in this session or another, until you type `/mcp-skills enable <skill>`. |
| `/mcp-skills enable <skill>` | Turns a skill you disabled back on. Only your own typing counts. |
| `/mcp-skills refresh` | Looks at every server again. |
| `/mcp-skills forget [<skill>]` | Drops your approvals. |
| `/mcp-skills setup` | Fetches a runtime, on a machine with no Node and no Bun. See [The mod's own runtime](#the-mods-own-runtime). |

`<skill>` is a name, `server:name`, the URI of a `SKILL.md`, or `server:URI`.
The last form also names a skill its server doesn't list.

### From install to the first skill

What you meet between the install line and a skill being used, and what
happens when a step is missing or you say no:

| Step | What you see | If it is missing or declined |
|---|---|---|
| Install | Two questions from Claude Code: "Add marketplace?" (y/n), then the plugin's page, which asks where to install it (you, this repository, or "Not now"). Then "Installed mcp-skills. Plugin is now active." No settings, no restart. | Nothing is installed. |
| A folder you trust | Claude Code's question about trusting the folder, the first time you start `claude` in it. | Claude Code runs no plugin code in a folder you haven't trusted, so the mod does nothing there. |
| A runtime for the helper | Nothing: Node 20+ or Bun is found by itself. | A one-line notice, in the first three sessions. `/mcp-skills` says what to do: type `/mcp-skills setup` to have the mod fetch Bun for itself, or install Node or Bun yourself. Until then nothing is listed, and Claude Code is otherwise unchanged. |
| `/mcp-skills setup`, if you run it | A question in Claude Code's dialog: download Bun, or not now. On Download, a notice that Bun is in place and the helper is running. Skills are listed from then on. | "Not now", or closing the dialog: nothing is downloaded. A failed or mismatched download is deleted, nothing of it runs, and the notice says why. You can run the command again. |
| A server that serves skills | Its skills are in Claude's listing and in `/mcp-skills` at once, or from the next session for a server added later. | `/mcp-skills` says no server serves skills, and names each server it left alone, with the reason: not approved in Claude Code yet, switched off, needs a browser sign-in, comes from a plugin or a claude.ai connector. |
| A project's `.mcp.json` server | Claude Code's own question about trusting the folder and approving the server. | The mod leaves the server alone until Claude Code itself uses it. |
| Claude wants a skill | Claude Code asks once whether to load it. | The skill isn't loaded, and nothing of it reaches Claude. You're asked again the next time. To read it first: `/mcp-skills show <skill>`. |
| The skill's files, and commands | Nothing: files are read as needed, and commands follow your usual permissions. | |
| The server changes the skill | Claude Code asks again, and says it changed. | The old version stays loaded in a conversation that has it. The new one isn't loaded. |

### Which servers work

| How the server is configured | Works |
|---|---|
| A local command (stdio) | Yes |
| A URL with no credentials (Hugging Face, TogoMCP) | Yes |
| A URL with `"headers": { "Authorization": "Bearer ${TOKEN}" }` (a personal access token, an API key) | Yes |
| A URL with a `"headersHelper"` command | Yes. The mod runs the command as Claude Code does. |
| A URL you sign in to in the browser through `/mcp` (OAuth), with no header and no helper | No |
| A claude.ai connector, or a server that comes with a plugin | No |
| A server on the older SSE transport (`"type": "sse"`) | No |

### Servers behind a sign-in

Claude Code keeps a browser sign-in to itself, and gives a mod no way to send
the extension's requests over Claude Code's own connection. So the mod opens a
connection of its own, with the credentials your configuration holds. It
doesn't run a sign-in of its own, and it stores no tokens. For such a server it
offers nothing, rather than something unverified. Claude can still read the
server's files as ordinary resources, as it could without the mod.

### Keeping a token out of your config

A `headersHelper` can read the token from wherever you keep it. On macOS, for
a token stored in the keychain under the name `my-mcp-token`:

```json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headersHelper": "printf '{\"Authorization\":\"Bearer %s\"}' \"$(security find-generic-password -s my-mcp-token -w)\""
    }
  }
}
```

### How a skill gets to the model

```
your MCP server ◄── skills/list · skills/get · resources/read · resources/directory/read ──  helper process
 (declares the                                                                                (mod/dist/helper.js)
  extension)                                                                                        ▲
                                                                                                    │ local HTTP, one token
Claude Code ── skill listing gains the served skills ◄── hooks module (mod/hooks/register.ts) ─────┘
     ├── load_skill · read_skill_file · list_skill_directory · list_skills ──► hooks module ──► helper
     └── permission check for every tool call ──► hooks module: approve a skill once; keep a skill to its own server
```

- **Finding servers.** The mod reads the servers Claude Code is configured
  with: the project's `.mcp.json`, and the user and local scopes. It asks
  Claude Code about each one, and connects only to those Claude Code itself
  uses. It keeps the ones that declare the extension, and asks each for its
  list of skills. No file is fetched.
- **Listing.** The skills go into Claude's skill listing under their own
  heading, each with its server and the address of its `SKILL.md`.
- **Approving.** Before a skill is loaded, Claude Code asks you, in its own
  permission dialog. The mod keeps that you said yes, to which server, and to
  which content.
- **Loading.** The mod fetches `SKILL.md` from that server and checks its size
  and SHA-256 digest against what the server published. It compares the
  frontmatter with the published one, field by field. Only then does it hand
  the text to Claude, marked with the server it came from.
- **Reading files.** A file the skill refers to is read only from the skill's
  own server, only if the skill's manifest lists it, and it's checked the same
  way. Nothing is fetched before it's asked for.

The mod does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension.

### Problems and questions

[Open an issue](https://github.com/idosal/AgentPolyfill/issues) that names
`mcp-skills`. Say which Claude Code version you run (`claude --version`), how
the server is configured (without its token), and what `/mcp-skills` prints.
For a security problem, see [`SECURITY.md`](SECURITY.md#reporting-a-problem).

### What differs between Claude Code and Codex

| | Claude Code | Codex |
|---|---|---|
| What runs | A mod inside Claude Code, and a helper process (`mod/dist/helper.js`) on Node 20+ or Bun | A plugin whose MCP server (`mod/dist/helper.js`) Codex starts with Node 20+ |
| Servers it reads | The project's `.mcp.json`, and the user and local scopes. It connects only to servers Claude Code itself uses. | `[mcp_servers.*]` in `~/.codex/config.toml`. Servers that come with a plugin, or from a project's `.codex/config.toml`, aren't looked at. |
| Where served skills appear | In Claude's skill listing, under their own heading: right after the install, and from the next session for a server you add later | In Codex's `$` skill list, as `mcp-skills:<server>:<name>`, from the next session. The plugin writes a short `SKILL.md` stub for each one into its own folder. At most 100 are listed. |
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

There's nothing to set. These environment variables are for the rare case
that needs one:

| Variable | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | The mod does nothing, without being uninstalled. |
| `MCP_SKILLS_RUNTIME` | What runs the helper: the full path of a Node 20+ or a Bun (nothing else is then tried), or `private` for only the copy of Bun the mod fetched for itself. Default: whatever is found. |
| `MCP_SKILLS_SOURCES` | Which Claude Code configurations to read: `project,local,user` (default all three). |
| `MCP_SKILLS_SERVERS` / `MCP_SKILLS_SKIP` | Only these server names, or never these (comma-separated). |
| `MCP_SKILLS_CONFIG` | A servers file of your own (`{"mcpServers": {...}}`) instead of Claude Code's configuration. It must be outside the project folder and its repository. |
| `MCP_SKILLS_STATE` | Where the mod keeps its log and its note of which servers serve skills. Default: the plugin's data folder. |

### When Claude Code supports Skills itself

The mod turns itself off for a session in which it sees Claude Code load a
skill from an MCP server. Once Claude Code serves MCP skills itself, disable
the plugin in `/plugin`.

## Limits

- **Servers behind a browser sign-in, claude.ai connectors, plugin-provided
  servers and SSE servers** aren't supported. See
  [Which servers work](#which-servers-work).
- **A second connection.** The mod's connection to a server that serves skills
  sits beside Claude Code's own, so a local (stdio) server that serves skills
  runs twice. Every other server in your configuration is connected to once,
  and then once a day, to see whether it declares the extension.
- **Binary files** of a skill are checked, but not shown to Claude.
- **No `/name` command per skill.** Use `/mcp-skills use <name>`, or just ask.
- **Unattended runs** (`claude -p`). Nobody can be asked about a skill there.
  So a skill that wasn't approved before loads only if your rules allow the
  tool, and then, while it's loaded, Claude can only read and search. Commands,
  file writes and edits, subagents and other servers' tools are refused
  ([details](SECURITY.md)). That holds until the conversation is cleared, even
  if the skill is loaded again later with a yes. To use a skill unattended,
  approve it once in an interactive session.
- **Managed machines.** Where an organisation's policy says which MCP servers
  are allowed, the mod connects to nothing, because it can't apply that
  policy.
- **Not tried yet:**
  - Windows and Linux. Everything here was run on macOS; the repository's tests
    are set up to run on all three.
  - The desktop app and IDE extensions. The preview panel was tried in the
    terminal only.
  - Bypass-permissions mode.
  - Claude Code versions other than 2.1.329.
- **`/mcp-skills setup` has been tested in parts, not yet as one run** on a
  machine with no Node and no Bun. The download command against the release,
  the unpacking, the checksum code inside Claude Code on a 60 MB file, the
  refusals, and the helper on Bun were each run for real. The sequence as a
  whole is covered by tests with stand-ins.

[`docs/host-changes.md`](docs/host-changes.md) says what Claude Code would need
to offer for this mod to work with every server, and how much of the mod each
addition would remove. [What hosts would need to change](../../../docs/host-changes.md)
covers Claude Code and Codex side by side.

## Security

A skill is text a server wrote. A model may follow it, and it may tell the
model to run things on your machine. The mod treats it as untrusted data from
that server, never as instructions from you.

- A skill is loaded only after you approved it, and your approval is bound to
  its content. An allow rule for the tool, or auto mode, doesn't answer in your
  place.
- Everything from a server is shown under the server's name as you configured
  it, never what the server calls itself.
- A skill's frontmatter grants nothing: `allowed-tools`, hooks and the rest are
  ignored.
- While a skill is loaded, Claude Code asks you before a resource read from
  any other MCP server.
- A skill you disabled isn't offered to Claude, loaded or read until you
  enable it again, whatever a rule or mode allows. Claude can't enable it.
- The mod never reads Claude Code's stored credentials, stores no tokens, and
  connects only to servers Claude Code itself uses.

[`SECURITY.md`](SECURITY.md) has the full account: what the mod trusts, does
and keeps, and what it doesn't protect against.

## Spec and conformance

The mod implements the client side of
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md),
the MCP Skills extension, at the Final stage.

### Client rules

[`docs/conformance.md`](docs/conformance.md) goes through every rule the Skills
extension sets for a client: whether the mod meets it, and the test that checks
it. There are 60 rules: 54 met, 3 met with a stated limit, and 3 that don't
apply.

### Tests

[`docs/verification.md`](docs/verification.md) describes a model of the
approval and gate state machine, explored state by state (by an explorer of its
own and by TLC), and property tests of what a server's input reaches. It says
what each one shows and what it doesn't.

| What | How to run it | Result |
|---|---|---|
| Two real public servers, Hugging Face (25 skills, 135 files) and TogoMCP (5 skills, 8 files): every skill loaded, every file verified | `npm run interop:real` | all verified |
| The official MCP conformance suite's client scenarios for SEP-2640 (it has four) | [`test/conformance/run.sh`](test/conformance/run.sh) | 4 of 4 pass |
| The client rules, one test per rule, against a hand-written server; discovery; the bundled helper; per-skill disable; property tests; the model of the gate | `npm test` | 129 pass |
| Approval, the permission questions, disable and enable, first-run behaviour and the runtime setup, in Claude Code's own test kit | `npm run test:mod` | 96 pass |
| A model of approval, loading, disabling and the gate, every reachable state to its bound ([what it shows](docs/verification.md)) | `node verification/model.ts` | every invariant holds |
| The same model in TLA+, every reachable state to the same bound, by TLC 1.7.4 | `node verification/check.mjs` | every invariant holds; 0.3.0's rule and the lossy read-back break the gate, as they should ([numbers](docs/verification.md)) |
| Time to a listing, memory and CPU of the helper | [`tools/measure.ts`](tools/measure.ts) | [numbers](docs/evidence/measure.txt) |
| The official TypeScript SDK's Skills server and client, over stdio and HTTP | `npm run interop` | 15 checks pass |
| The bundled helper on Bun instead of Node | `npm run test:bun` | 5 pass (Bun 1.3.3) |
| Real Claude Code sessions, recorded | [`live/`](live/) | [screens](live/runs/) |

The output of each run is in [`docs/evidence/`](docs/evidence/).

## Development

From this folder (`polyfills/skills/claude-code` in the repository):

```bash
npm install
npm test            # client rules, discovery, the bundled helper
npm run test:mod    # the hooks module, in Claude Code's test kit
npm run typecheck
npm run interop     # against the official TypeScript SDK
npm run interop:real
npm run test:bun    # the bundled helper on Bun
npm run build       # mod/dist/helper.js, from src/
node verification/model.ts   # the model of the gate, every state to its bound
TLA2TOOLS=/path/to/tla2tools.jar node verification/check.mjs   # the same in TLA+, by TLC (needs Java)
node tools/measure.ts        # time to a listing, memory and CPU of the helper
```

`mod/` is all an installed copy carries: the manifest, the hooks module
([`mod/hooks/register.ts`](mod/hooks/register.ts), with
[`runtime.ts`](mod/hooks/runtime.ts) for a machine with no Node or Bun), and
the bundled helper.

- [`src/skills.ts`](src/skills.ts) is the extension's client logic and nothing
  else.
- [`src/wire.ts`](src/wire.ts) and [`src/config.ts`](src/config.ts) are the
  connection the mod has to make for itself today.

The first two are kept in [`../core`](../core/), shared with the
[Codex form](../codex/), and bundled into `mod/dist/helper.js`. To work on
them, run `npm ci` in `../core` too.

## Licence

[Apache-2.0](../../../LICENSE). The bundled helper (`mod/dist/helper.js`)
includes npm packages under their own licences:
[`mod/THIRD_PARTY_LICENSES.txt`](mod/THIRD_PARTY_LICENSES.txt).

This mod is one of a set of polyfills that add MCP extensions to Claude Code
and Codex ahead of native support, collected at
[AgentPolyfill](../../../README.md). It's a community project by Ido Salomon.
It isn't affiliated with or endorsed by Anthropic, OpenAI, the Model Context
Protocol project, the Agentic AI Foundation or the Linux Foundation. Claude and
Claude Code are trademarks of Anthropic, PBC. OpenAI and Codex are trademarks
of OpenAI.
