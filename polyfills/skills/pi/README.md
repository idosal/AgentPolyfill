# mcp-skills for Pi

Pi can use the [skills](https://agentskills.io/) your MCP servers serve. They
show up in Pi's skill list next to your own, Pi loads one when a task calls
for it, and it reads the files the skill refers to as it needs them. You
approve each skill once.

Also available for Claude Code, Codex and OpenCode: [mcp-skills for Claude Code](../claude-code/README.md), [mcp-skills for Codex](../codex/README.md), [mcp-skills for OpenCode](../opencode/README.md).

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which Pi doesn't support itself. Every form
shares its client logic, in [`../core`](../core/). Details are in
[Spec and conformance](#spec-and-conformance).

## Install

Nothing is published to npm or Pi's package gallery yet, so install it from a
clone of this repository. You need **Pi 1.6.0**, the version it was tested
with, and **Node 22 or newer**, which Pi needs anyway:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/skills/pi/extension
```

Or, to try it for one run without installing:

```bash
pi -e ./polyfills/skills/pi/extension
```

The extension is one folder, [`extension/`](extension/): a manifest and one
bundled file, with nothing to build or install alongside it. Pi loads it from
where it is, so keep the clone; `git pull` in it brings the next version.

To remove it, run `pi remove ./polyfills/skills/pi/extension` from the same
folder. The served skills leave Pi's list with it. Your approvals
and the stubs are in `mcp-skills/` in Pi's agent folder (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`); delete that folder too to remove them.

## Try it

Add Hugging Face's public MCP server, which serves skills and needs no account
for this:

```bash
pi mcp add huggingface --url https://huggingface.co/mcp
```

Start `pi`. The server's skills are in Pi's skill list as
`mcp-huggingface-<name>`, each marked with its server. Ask with one of them:

> /skill:mcp-huggingface-huggingface-local-models Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Pi reads the skill's entry, which says how to load it, and calls `load_skill`.
The extension asks you once: don't load it, show you its `SKILL.md` first, or
load it. Pi then reads the skill's reference files from the server and
answers from them. Without `/skill:`, Pi picks a served skill when the task
fits its description, as it does for any skill.

[`docs/live-run.md`](docs/live-run.md) records this question asked in Pi 1.6.0
with a real model, against Hugging Face's server: Pi found the served skills in
its own list, loaded two after one question each, read the reference files it
needed through codemode, and answered from them.

## How it works

### What to expect

- **Nothing to set up per server.** Every server Pi connects that declares the
  Skills extension has its skills listed, as `mcp-<server>-<name>`, marked
  with its server.
- **One question per skill.** The first time Pi loads a skill, you're asked,
  in a Pi dialog. Your yes is kept for that skill as it is now: every file's
  address and digest, and where the server is. If the server changes the
  skill, you're asked again and told it changed.
- **"Show me its SKILL.md first"** shows you the skill's text, checked against
  its digest, before you decide. The model sees nothing of it until you choose
  "Load it".
- **One more question, only while a served skill is loaded:** if Pi then
  reaches *another* MCP server (Pi's `read_mcp_resource`, or loading or
  reading a skill of that server), you're asked first, with both servers
  named. That's SEP-2640's rule X8: a
  skill's text may be what asks for the read.
- **Print and JSON modes** can't ask, so a skill you haven't approved isn't
  loaded there. Approve it once in an interactive session (or over RPC), and
  it loads there as long as it's unchanged.

### How a skill gets to the model

- **Finding servers.** When a session starts, the extension reaches the
  servers Pi connects (`mcp.json` in Pi's agent directory, the project's
  `.pi/mcp.json` once you trust the project, and servers other extensions
  register), keeps the ones that declare the extension, and asks each for its
  list of skills. No file is fetched. A server found not to serve skills isn't
  connected to again for a day.
- **Listing.** For each skill, the extension writes a short `SKILL.md` of its
  own, a stub, into its state folder, and hands Pi that folder when Pi asks
  extensions for skill folders (`resources_discover`). The stub holds the
  skill's name and the server's description, marked with the server, and a
  body that says how to load it. None of the skill's content is written to
  disk. Pi waits for the listing up to 8 seconds at start; skills a server
  adds later are listed after `/reload`, and Pi tells you so.
- **Loading.** `load_skill` reads the server's current entry for the skill,
  asks you unless you approved this exact skill before, fetches `SKILL.md`
  from that server, and checks its size and SHA-256 digest, and its
  frontmatter field by field, against the entry. Only then does it hand the
  text to Pi, marked with the server it came from.
- **Reading files.** `read_skill_file` reads a file the skill refers to, only
  from the skill's own server, only if the skill's manifest lists it, checked
  the same way. `list_skill_directory` lists a folder of it.
- `list_skills` lists every served skill, including any Pi's list doesn't
  hold yet, and each server left alone, with the reason.

### Which servers work

| How the server is in Pi's `mcp.json` | Works |
|---|---|
| A local command (`command`, `args`, `env`, `cwd`) | Yes |
| A URL with no credentials | Yes |
| A URL with an `Authorization` header (written out, `${VARIABLE}`, or `!command`) | Yes, resolved as Pi resolves it. Tested against a server that refuses requests without it. |
| A URL you sign in to through Pi (`/mcp`, `pi mcp login`), an `oauth` setting, or `auth.provider` | Not on Pi 1.6.0 ([below](#servers-behind-a-sign-in)) |
| `enabled: false`, or `exposure: "hidden"` | Left alone |

### Servers behind a sign-in

Pi keeps its sign-ins to its own connection, and Pi 1.6.0 doesn't give that
connection to extensions. So the extension opens a connection of its own,
with what your configuration holds. It runs no sign-in of its own, stores no
tokens, and never reads Pi's stored credentials (`mcp-auth.json`). A server
behind Pi's sign-in is listed by `list_skills` as not used, with the reason.
That is tested: Pi signs in to a test server with `pi mcp login`, and the
extension reports it can't reach it.

One change in Pi would close this: letting extensions send their own
requests over Pi's connection, with its sign-in, and read what the server
advertised. Skills needs nothing more from Pi than that.
[What hosts would need to change](../../../docs/host-changes.md) describes it.

### Where it writes

In `mcp-skills/` in Pi's agent directory (`PI_CODING_AGENT_DIR`, else
`~/.pi/agent`), or `MCP_SKILLS_STATE`, private to you:

- `served/`: the stubs, one folder per server and skill, named by a hash of
  the server's name and the skill's URI, never by anything a server sent;
- `approvals.json`: each yes you gave (server, where it is, the skill's URI,
  and a hash over every file's URI and digest);
- `servers.json`: which servers declared the extension when last looked at;
- `settings.json`: your own settings, if you write one
  (`{"servers": […]}`, `{"skip": […]}`, `{"off": true}`);
- `mcp-skills.log`, with secrets taken out.

No skill content and no tokens.

## Settings

| Setting | What it does |
|---|---|
| `MCP_SKILLS_OFF=1` | Loaded, and doing nothing. |
| `MCP_SKILLS_STATE` | Where it keeps what it writes. |
| `MCP_SKILLS_STARTUP_WAIT_MS` | How long Pi's start waits for the listings. Default 8000. |
| `MCP_SKILLS_CONNECT_TIMEOUT_MS` | How long to wait for a server. Default 10000. |
| `settings.json` in the state folder | `servers` to look only at those, `skip` to never look at those, `off` to do nothing. |

### When Pi supports Skills itself

Remove this extension, or set `MCP_SKILLS_OFF=1`. It can't tell by itself:
Pi gives an extension no way to see what its MCP client supports.

## Limits

The changes hosts would need are in
[What hosts would need to change](../../../docs/host-changes.md).

- **No sign-in through Pi** on Pi 1.6.0 ([above](#servers-behind-a-sign-in)).
  The change in Pi: let extensions send their own requests over its
  connection.
- **A second connection.** Without that change, the extension opens its own
  connection to each server, so a local (stdio) server runs twice.
- **New skills need a `/reload`.** Pi reads skill folders when a session
  starts or reloads, so a skill a server adds mid-session is listed after
  `/reload`. `list_skills` reaches it at any time, and loading it by its URI
  works without the reload.
- **No per-skill switch in Pi.** Pi has no setting to turn off one skill from
  an extension's folder, so to stop using a server's skills, put it in
  `skip` in `settings.json`, or turn the server off in `mcp.json`.
- **The X8 question covers Pi's own resource tool.** A resource read another
  extension makes with its own connection passes no hook of this extension's.
- **Servers are read when a session starts.** A server another extension
  registers later in the session is reached after `/reload`. Each `!command`
  value in a server's entry runs when a session starts, once for this
  extension, as it runs for Pi and for any other extension that reads it.
- **Off with Pi's MCP support.** With `--no-mcp`, `"extensions":
  ["-builtin:mcp"]` in the settings, or an extension that replaces Pi's MCP
  support, Pi connects no server and the extension stands down.
- **Pi has no approval step for tools.** After you approve a skill, what Pi
  does with it is up to Pi and the extensions you run, as for a skill on your
  disk.

## Security

A served skill is a server's content, never a local skill. It's loaded only
after your yes, for exactly the files you were asked about, and arrives as a
tool result marked with its server. Its frontmatter grants nothing. While it's
loaded, reading another server's resource asks you first. The extension never
reads Pi's stored credentials. Details, and how to report a vulnerability,
are in [`SECURITY.md`](SECURITY.md).

## Spec and conformance

mcp-skills implements SEP-2640 (Final, at commit `2eb3a8e`), with the client
logic every form shares. Every rule, with how it is met on Pi and where it is
tested, is in [`docs/conformance.md`](docs/conformance.md): 53 met, 6 met with
a stated exception, 1 not applicable, none unmet. The official MCP
conformance suite's four SEP-2640 client scenarios pass against this
extension's App ([output](docs/evidence/conformance.txt)). On Pi:

- **X8 is met.** Pi's `tool_call` hook can block and ask, for the model's
  calls and for codemode's nested calls alike, so a cross-server
  `read_mcp_resource` while a served skill is loaded is put to you naming both
  servers, or refused where nobody can be asked; both are tested in a real Pi.
  The same question covers this extension's own tools: with a skill of one
  server loaded, `load_skill`, `read_skill_file` or `list_skill_directory`
  against another server asks first, every time, even for a skill approved
  before. It holds after `/reload`, `/resume`, `/fork` and `/clone`, from the
  loads the session records. (In the Codex form X8 isn't met, for want of
  such a hook.)
- **V4 is met.** Pi's `read_mcp_resource` is refused for a loaded skill's own
  files, which are read with `read_skill_file`, against the skill's entry.
- **H1, per-skill switch:** Pi has none for an extension's skills; the
  server-level `skip` stands in ([Limits](#limits)).
- No step outside the SEP is taken.

### Tests

- `test/client-rules-test.ts`: the Codex form's tests of the SEP's client
  rules, run against this form's app (38 tests), against a hand-written server
  that shares no code with the client.
- `test/pi-test.ts`, in a real Pi 1.6.0 with its own agent directory and home
  and a scripted stand-in model: a served skill is in Pi's skill list,
  `/skill:` loads it after you approve it, a no loads nothing and fetches no
  file; the X8 question, for the model's read, for a codemode script's, for
  this extension's own tools, and in a new instance of the extension after a
  clone; Pi's resource tool refused for a loaded skill's own files (V4); and
  with `--no-mcp`, no server reached and no skill listed.
- `test/hardening-test.ts`, from the security review: a generated skill that
  changes after you read it is loaded as you read it; two loads asked at once
  run one after the other; a call cancelled while you're asked, or while it
  waits for another load, loads and keeps nothing; a server whose `skills/get`
  answer can't be used is asked about as it listed the skill; a server's media
  type can't add a line to the result, whether it reaches the form or comes
  from a read; a file with terminal control characters isn't shown as text; a
  configured secret a server echoes back reaches no stub.
- `test/config-test.ts`: the configuration file is the Events form's (whose
  test holds it to Pi's own entry check); an entry Pi rejects runs nothing;
  the extension runs only with Pi's own MCP support.
- `test/conformance/`: the official MCP conformance suite's four SEP-2640
  client scenarios, run against this extension's App
  ([output](docs/evidence/conformance.txt)).
- `test/connection-test.ts`: against an HTTP server behind a token (reached,
  with the header resolved as Pi resolves it) and behind OAuth (out of reach,
  with the reason).

## Development

From this folder (`polyfills/skills/pi` in the repository):

```bash
(cd ../core && npm ci)         # the shared Skills client
(cd ../claude-code && npm ci)  # the test fixtures the tests reuse
npm ci                         # Pi 1.6.0 itself is a devDependency: the tests run it
npm test
npm run typecheck
npm run build                  # extension/dist/index.js; a test fails when it is stale
node ../../../tools/bundle-notices.mjs . --plugin extension --entry src/index.ts
```

CI: [`pi-skills-test.yml`](../../../.github/workflows/pi-skills-test.yml).

## Licence

Part of [AgentPolyfill](../../../README.md): MCP extensions for hosts that
haven't shipped them yet.

Apache-2.0. See [`LICENSE`](../../../LICENSE). The bundle includes npm
packages under their own licences:
[`extension/THIRD_PARTY_LICENSES.txt`](extension/THIRD_PARTY_LICENSES.txt).

This is a community project. It isn't affiliated with or endorsed by
Anthropic, OpenAI, Earendil, the Model Context Protocol project, the Agentic
AI Foundation or the Linux Foundation.
