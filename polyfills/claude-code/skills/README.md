# mcp-skills: skills from your MCP servers, in Claude Code

A Claude Code mod that lets Claude use the [skills](https://agentskills.io/)
your MCP servers serve: they appear in Claude's skill listing, Claude loads one
when a task calls for it, and reads the files it refers to as it needs them.
Nothing is installed locally, and you approve each skill once.

It adds the client side of the MCP **Skills** extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)),
which Claude Code does not support by itself yet.

![A Claude Code session lists the 25 skills that Hugging Face's MCP server serves. Asked which model quantization to use on a 16 GB Mac, Claude picks the matching skill, Claude Code asks once whether to load it, and Claude reads the skill's files from the server and answers from them.](docs/media/demo.webp)

*A real session against Hugging Face's public MCP server, which you can add
yourself with one line of configuration (below). The picture zooms in on parts
of the terminal, and waits are shortened.
[Full video](docs/media/demo.mp4) (34 seconds).*

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-skills --marketplace idosal/MCPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-skills --marketplace idosal/MCPolyfill
```

Either adds the [MCPolyfill](../../../README.md) marketplace and installs
the plugin in one step. With the marketplace already added,
`/plugin install mcp-skills@mcpolyfill` does the same; to add the marketplace
by itself, `/plugin marketplace add idosal/MCPolyfill`.
`/plugin install mcpolyfill --marketplace idosal/MCPolyfill` installs every
polyfill in the marketplace, this one included.

That is the whole install: no settings to fill in, nothing to configure per
server. You need:

- **Claude Code 2.1.329 or newer** (the version it was tested on). Mods, the
  kind of plugin this is, are on by default from Claude Code 2.1.287.
- **Node 20 or newer, or Bun, somewhere on the machine.** Claude Code itself
  needs neither. The mod looks on your PATH, asks your login shell, and checks
  the usual install folders; if it finds none it says so once, with what to
  install, and does nothing else.

Nothing else is installed or downloaded: the mod is one small folder,
[`mod/`](mod/). To turn it off, disable or uninstall the plugin
(`/plugin`).

To run it from a clone of this repository instead, for one session:

```bash
git clone https://github.com/idosal/MCPolyfill
claude --plugin-dir MCPolyfill/polyfills/claude-code/skills/mod
```

## Try it

Add Hugging Face's public MCP server. It serves skills, and needs no account
for this:

```bash
claude mcp add --transport http huggingface https://huggingface.co/mcp
```

Start `claude` in the same folder and ask something one of its skills covers:

> Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Claude finds `huggingface-local-models` in its skill listing and loads it.
Claude Code asks you once whether to load that skill. Claude then reads the
skill's reference files from the server and answers from them.

Three commands are worth knowing:

| Command | What it does |
|---|---|
| `/mcp-skills` | Lists the skills your servers serve, and says which servers were left alone and why. |
| `/mcp-skills show <skill>` | Opens a skill's `SKILL.md` in a panel for you to read. Nothing is loaded, and Claude does not read the panel. |
| `/mcp-skills use <skill> [what to do]` | Asks Claude to load a skill by name. |

Also: `/mcp-skills refresh` looks at every server again, and
`/mcp-skills forget [<skill>]` drops your approvals. `<skill>` is a name,
`server:name`, or the URI of a `SKILL.md`.

To try it with a server on your own machine, [`demo/`](demo/) holds a small one
that serves two skills (`npm install`, then point a server entry at
`node --no-warnings demo/server.ts`).

## What to expect

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
- **No slow starts.** A server found not to serve skills is not connected to
  again for a day. A session waits for a first listing (at most 4 seconds) only
  for servers that serve skills or that it has not looked at yet.

## From install to the first skill

What a new user meets between the install line and a skill being used, and
what happens when a step is missing or you say no:

| Step | What you see | If it is missing or declined |
|---|---|---|
| Install | Two questions from Claude Code: "Add marketplace?" (y/n), then the plugin's page with where to install it (you, this repository, or "Not now"). Then "Installed mcp-skills. Plugin is now active." No settings, no restart. The terminal form asks nothing. | Nothing is installed. |
| A folder you trust | Claude Code's question about trusting the folder, the first time you start `claude` in it. | Claude Code runs no plugin code in a folder you have not trusted, so the mod does nothing there. |
| A runtime for the helper | Nothing: Node 20+ or Bun is found by itself. | One notice saying what to install. `/mcp-skills` and the mod's tools say the same. Claude Code is otherwise unchanged. |
| A server that serves skills | Its skills are in Claude's listing and in `/mcp-skills` at once (from the next session for a server added later). | `/mcp-skills` says no server serves skills, and names each server it left alone with the reason: not approved in Claude Code yet, switched off, needs a browser sign-in, comes from a plugin or a claude.ai connector. |
| A project's `.mcp.json` server | Claude Code's own question about trusting the folder and approving the server. | The mod leaves the server alone until Claude Code itself uses it. |
| Claude wants a skill | Claude Code asks once whether to load it. | The skill is not loaded and nothing of it reaches Claude. You are asked again the next time. To read it first: `/mcp-skills show <skill>`. |
| The skill's files, and commands | Nothing: files are read as needed, and commands follow your usual permissions. | |
| The server changes the skill | Claude Code asks again, saying it changed. | The old version stays loaded in a conversation that has it; the new one is not loaded. |

## Which servers work

| How the server is configured | Works |
|---|---|
| A local command (stdio) | Yes |
| A URL with no credentials (Hugging Face, TogoMCP) | Yes |
| A URL with `"headers": { "Authorization": "Bearer ${TOKEN}" }` (a personal access token, an API key) | Yes |
| A URL with a `"headersHelper"` command | Yes: the mod runs the command as Claude Code does |
| A URL you sign in to in the browser through `/mcp` (OAuth), with no header and no helper | **No** |
| A claude.ai connector, or a server that comes with a plugin | **No** |
| A server on the older SSE transport (`"type": "sse"`) | **No** |

**Why not servers behind a browser sign-in.** Claude Code keeps that sign-in to
itself, and gives a mod no way to send the extension's requests over its own
connection. The mod therefore opens a connection of its own, with the
credentials your configuration holds. It does not run a sign-in of its own and
stores no tokens. For such a server it offers nothing rather than something
unverified; Claude can still read the server's files as ordinary resources, as
it could without the mod.

**Keeping a token out of your config.** A `headersHelper` can read it from
wherever you keep it. On macOS, for a token stored in the keychain under the
name `my-mcp-token`:

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

## How it works

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
  with (the project's `.mcp.json`, and the user and local scopes), asks Claude
  Code about each one, and connects only to those Claude Code itself uses. It
  keeps the ones that declare the extension and asks each for its list of
  skills. No file is fetched.
- **Listing.** The skills are added to Claude's skill listing under their own
  heading, each with its server and the address of its `SKILL.md`.
- **Approving.** Before a skill is loaded, Claude Code asks you, in its own
  permission dialog. What is kept is that you said yes, to which server, and to
  which content.
- **Loading.** The mod fetches `SKILL.md` from that server, checks its size and
  SHA-256 digest against what the server published, compares its frontmatter
  with the published one field by field, and only then hands the text to
  Claude, marked with the server it came from.
- **Reading files.** A file the skill refers to is read only from the skill's
  own server, only if the skill's manifest lists it, and checked the same way.
  Nothing is fetched before it is asked for.

The mod does what the extension defines for a client and nothing else: no
extra protocol, no vendor extension. When Claude Code supports the extension
itself, the mod turns itself off (see [Settings](#settings)).

## Limits

- **Servers behind a browser sign-in, claude.ai connectors, plugin-provided
  servers and SSE servers** are not supported (see the table above).
- **A second connection.** The mod's connection to a server that serves skills
  is beside Claude Code's own, so a local (stdio) server that serves skills
  runs twice. Every other server in your configuration is connected to once,
  and then once a day, to see whether it declares the extension.
- **Binary files** of a skill are checked but not shown to Claude.
- **No `/name` command per skill.** Use `/mcp-skills use <name>`, or just ask.
- **Unattended runs** (`claude -p`): nobody can be asked about a skill, so a
  skill that was not approved before loads only if your rules allow the tool,
  and then every shell command while it is loaded is refused. Approve the skill
  once in an interactive session to use it unattended.
- **Managed machines.** Where an organisation's policy says which MCP servers
  are allowed, the mod connects to nothing, because it cannot apply that policy.
- **Not tried yet:** Windows; the desktop app and IDE extensions (the preview
  panel was tried in the terminal only); bypass-permissions mode; Claude Code
  versions other than 2.1.329.

## Security

A skill is text a server wrote, which a model may follow, and which may tell
the model to run things on your machine. The mod treats it as untrusted data
from that server, never as instructions from you.

- A skill is loaded only after you approved it, and your approval is bound to
  its content. An allow rule for the tool, or auto mode, does not answer in
  your place.
- Everything from a server is shown under the server's name as you configured
  it, never what the server calls itself.
- A skill's frontmatter grants nothing: `allowed-tools`, hooks and the rest are
  ignored.
- While a skill is loaded, Claude Code asks you before a resource read from
  any other MCP server.
- The mod never reads Claude Code's stored credentials, stores no tokens, and
  connects only to servers Claude Code itself uses.

The full account, including what it does not protect against:
[`SECURITY.md`](SECURITY.md).

## Settings

There is nothing to set. To turn the mod off, disable the plugin in `/plugin`;
do that once Claude Code serves MCP skills itself. The mod also turns itself
off for a session in which it sees Claude Code load a skill from an MCP server.

Environment variables, for the rare case:

| Variable | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | The mod does nothing, without being uninstalled. |
| `MCP_SKILLS_EXECUTION_TOOLS` | Tool names (comma-separated) that also count as running code, for a skill loaded with nobody asked. Claude Code's own shell tools always count. |
| `MCP_SKILLS_SOURCES` | Which Claude Code configurations to read: `project,local,user` (default all three). |
| `MCP_SKILLS_SERVERS` / `MCP_SKILLS_SKIP` | Only these server names, or never these (comma-separated). |
| `MCP_SKILLS_CONFIG` | A servers file of your own (`{"mcpServers": {...}}`) instead of Claude Code's configuration. It must be outside the project folder and its repository. |
| `MCP_SKILLS_STATE` | Where the mod keeps its log and its note of which servers serve skills. Default: the plugin's data folder. |

## Going deeper

- [`docs/conformance.md`](docs/conformance.md): every rule the Skills
  extension sets for a client, whether the mod meets it, and the test that
  checks it.
- [`docs/host-changes.md`](docs/host-changes.md): what Claude Code would need
  to offer for this mod to work with every server, and how much of the mod
  each addition would remove.
- [`SECURITY.md`](SECURITY.md): what the mod trusts, does, keeps, and does not
  protect against.

### How it is tested

| What | How to run it | Result |
|---|---|---|
| Two real public servers, Hugging Face (25 skills, 135 files) and TogoMCP (5 skills, 8 files): every skill loaded, every file verified | `npm run interop:real` | all verified |
| The official MCP conformance suite's client scenarios for SEP-2640 | [`test/conformance/run.sh`](test/conformance/run.sh) | 4 of 4 pass |
| The client rules, one test per rule, against a hand-written server | `npm test` | 91 pass |
| Approval, the permission questions and first-run behaviour, in Claude Code's own test kit | `npm run test:mod` | 38 pass |
| The official TypeScript SDK's Skills server and client, over stdio and HTTP | `npm run interop` | 15 checks pass |
| Real Claude Code sessions, recorded | [`live/`](live/) | [screens](live/runs/) |

The output of each run is in [`docs/evidence/`](docs/evidence/).

### Development

From this folder (`polyfills/claude-code/skills` in the repository):

```bash
npm install
npm test            # client rules, discovery, the bundled helper
npm run test:mod    # the hooks module, in Claude Code's test kit
npm run typecheck
npm run interop     # against the official TypeScript SDK
npm run interop:real
npm run build       # mod/dist/helper.js, from src/
```

`mod/` is all an installed copy carries: the manifest, the hooks module
([`mod/hooks/register.ts`](mod/hooks/register.ts)) and the bundled helper.
[`src/skills.ts`](src/skills.ts) is the extension's client logic and nothing
else; [`src/wire.ts`](src/wire.ts) and [`src/config.ts`](src/config.ts) are the
connection the mod has to make for itself today.

## Problems and questions

[Open an issue](https://github.com/idosal/MCPolyfill/issues) that names
`mcp-skills`. Say which Claude Code version you run
(`claude --version`), how the server is configured (without its token), and
what `/mcp-skills` prints. For a security problem, see
[`SECURITY.md`](SECURITY.md#reporting-a-problem).

## Related

This mod is one of a set of polyfills that add MCP extensions to Claude Code
ahead of native support, collected at
[MCPolyfill](../../../README.md).

## Licence

[Apache-2.0](../../../LICENSE). By Ido Salomon.
