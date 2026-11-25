# mcp-skills for Hermes

Hermes Agent can use the [skills](https://agentskills.io/) your MCP servers
serve. They're listed with your own skills, Hermes loads one when a task calls
for it, after asking you, and reads the files the skill refers to as it needs
them.

Also available for [Codex](../codex/README.md), [Pi](../pi/README.md) and
[OpenCode](../opencode/README.md). Claude Code serves MCP skills itself.

It implements the client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final, at commit `2eb3a8e`), which Hermes doesn't support for MCP servers yet
(its own skills are local files). The client rules are the Codex form's, run
as they are; details are in [Spec and conformance](#spec-and-conformance).

## Install

```bash
hermes plugins install idosal/AgentPolyfill/polyfills/skills/hermes/plugin --enable
```

Then name the servers whose skills you want, in `~/.hermes/config.yaml` (or
your profile's), in the plugin's own settings. It uses no server you don't
name there:

```yaml
plugins:
  entries:
    mcp-skills:
      settings:
        servers: [huggingface]
```

`settings` is where Hermes keeps a plugin's settings (the plugin reads it
with `ctx.get_config`). It isn't Hermes's `mcp_allowlist`, which lets a
plugin call a server's tools over Hermes's own connection: this plugin opens
a connection of its own, so it has a grant of its own.

You need:

- **Hermes Agent v0.23.4** or newer. Checked in Hermes v0.23.4.
- **Node 20 or newer** on the `PATH` of the Hermes gateway (`AGENTPOLYFILL_NODE`
  can name another `node`).

To remove it, run `hermes plugins remove mcp-skills`. What it keeps, private
to you, is in `$HERMES_HOME/mcp-skills/`: `stubs/` (a short `SKILL.md` per
served skill, and `index.json`), `approvals.json` (each yes you gave, by
server, skill and version, up to 2,000), `servers.json` (which servers
declared the extension when last looked at), `mcp-skills.log` (with known
secrets taken out) and `helper-stderr.log` (what Node itself printed, not
scrubbed). What each session loaded is kept in Hermes's plugin state
(`ctx.state`, key `held`).

## Try it

Add Hugging Face's public MCP server, which serves 25 skills and needs no
account:

```yaml
mcp_servers:
  huggingface:
    url: https://huggingface.co/mcp
```

and add `huggingface` to `settings.servers` above. Start `hermes`. The plugin looks at
the server during your first turn; from your next session, its skills are in
Hermes's skill list as `mcp-skills:huggingface-<name>`, each marked with its
server. Ask:

> Use the Hugging Face local-models skill: which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

Hermes views the skill, which says to load it with `load_skill`. Hermes asks
you first, naming the skill, its server and its files; to read its SKILL.md
before you decide, deny and type the `/mcp-skills show` line the question
gives you. Then the plugin fetches
it from the server, checks it against the server's digests, and Hermes reads
its reference files as it needs them
([`test/interop_huggingface.py`](test/interop_huggingface.py)).

## How it works

- **Finding skills.** The plugin connects to each granted server once, keeps
  the ones that declare the Skills extension, and lists their skills. Nothing
  of a skill is fetched to list it.
- **Listing.** For each skill it writes a short `SKILL.md` of its own (a stub)
  into `$HERMES_HOME/mcp-skills/stubs/` and registers it with
  `ctx.register_skill`. The stub holds the skill's name, the server's
  description marked with the server, and how to load it. Hermes lists a skill
  registered while it runs from the next session on; when the gateway starts
  again, the plugin registers the stubs it wrote before, so the first session
  has them. Up to 100 are listed; `list_skills` reaches every one. A server
  that is granted but can't be reached now keeps its stubs; one left out
  (switched off, no longer named, signing in through Hermes, taking `${VAR}`
  from `.env`) loses them, so its descriptions leave Hermes's skill list.
- **Loading.** `load_skill` goes through Hermes's own approval (a
  `pre_tool_call` approve directive): Hermes asks you once, for the session,
  always, or not, wherever the session is, and fails closed where nobody can
  answer. The approval's key is a digest of where the server is, the skill's
  URI and its manifest hash, so "always" covers that version of the skill
  only: if the server changes it, you're asked again (rule X14). A skill the
  server generates (`"dynamic"`) has no digest, so you're asked every time.
  The load itself refuses any version but the one you were asked about.
- **Reading a skill first (X13b).** The question ends with a line to type,
  `/mcp-skills show <server> <skill URI>`. Deny, type it, and Hermes shows you
  the skill's `SKILL.md`, checked against its digest. A slash command's answer
  goes to you, not into the conversation: the model never sees it. Then ask
  for the skill again if you want it.
- **Where Hermes approves without asking** (`--yolo`, `/yolo` in a session, `hermes -z`,
  `approvals.mode: off`), the plugin refuses to load a served skill, and a
  read from another server while one is loaded (rules X5 and X8 need your own
  yes). It evaluates the test Hermes's approval gate uses, and where it can't
  (another Hermes version, `plugins.isolation: host`) it refuses too
  ([Hermes calls it uses](#hermes-calls-it-uses)).
- **Files.** `read_skill_file` and `list_skill_directory` read only from the
  skill's own server, only what its manifest lists, and check each file.
- **Another server's resources (X8).** If a session that loaded a skill from
  one server reads a resource from a different server (Hermes's
  `mcp__<server>__read_resource`), Hermes asks you first, naming both, for
  that read only. The tool's name is matched to its server as Hermes names it
  (past 64 characters, Hermes shortens it and adds a hash); where two servers'
  names come out the same (`a.b` and `a_b`), or a shortened name belongs to no
  server the plugin knows, or a shortened call passes a `uri` (it may be a
  read from a server whose name starts as a known one's), the read is asked
  about too. What each session
  loaded is kept in Hermes's plugin state (`ctx.state`), so a restart doesn't
  forget it. If that state can't be read, or saving it failed (until a save
  works), or a call doesn't say which session it's from, Hermes asks before
  every resource read instead; a load from a call with no session is refused. That
  tool is the only way Hermes reads a resource (it doesn't follow resource
  links in tool results by itself), and it is gated however the model calls
  it, Tool Search's `tool_call` included.
- **No way around `load_skill`.** Hermes's generic resource tool doesn't read
  a served skill's files (a `skill://` URI, or one under a listed skill): it
  would neither ask nor check digests.
- **Turning a skill off** works as for any Hermes skill (`skills.disabled`,
  by its `mcp-skills:` name): it's refused, and none of its files are read.
  It's checked against the skill the server resolves the URI to, too, so a
  turned-off skill stays off however its URI is spelled.

The client logic (verification, the manifest, the rules about URIs and files)
is the Codex form's [`../codex/src/app.ts`](../codex/src/app.ts) over the
shared [`../core`](../core/), bundled into the plugin's helper and run by
Node beside the Python half, for the same reason as the
[Events form](../../events/hermes/README.md#how-the-parts-fit-together): one
implementation of the spec's rules for every host.

### Which servers work

As for the [Events form](../../events/hermes/README.md#which-servers-it-works-with):
local commands and URLs with or without `headers` work; a value that takes
`${VAR}` from Hermes's `.env`, `auth: oauth`, client certificates, per-user
identity headers and SSE don't; servers not in `settings.servers` or switched
off are left alone. `list_skills` names each one it left alone, and why.

The configuration is read again at every turn and tool call. When the
servers the plugin may use change (one named or removed, its entry edited),
the helper starts again with the new set, and the skill list follows from the
next session.

### When Hermes supports Skills itself

Hermes v0.23.4 doesn't serve MCP skills, and there's nothing yet to detect if
a later release does. When it does, turn this plugin off with Hermes's own
switch, `hermes plugins disable mcp-skills`: Hermes then doesn't load it, so
there are no tools, stubs or hooks of it. If Hermes adds a per-server setting for it, as
it did for Events (`events: true`), the plugin will leave such servers to
Hermes, as the Events form does.

### Hermes calls it uses

Everything is on Hermes's documented plugin API or its published module list
(`hermes_cli/data/plugin_api.json`), except one call:

| Call | What for | Documented |
|---|---|---|
| `ctx.register_tool`, `register_hook` (`pre_tool_call`, `pre_llm_call`, `on_session_open`), `register_skill`, `register_command`, `register_system_prompt_section`, `on_unload`, `get_config`, `state` | The tools, approvals, listing, `/mcp-skills show`, the plugin's settings and saved state | Plugin guide |
| `hermes_constants.get_hermes_home`, `gateway.session_context.get_session_env` | The profile, and the session a call is from | Published API |
| `hermes_cli.config.read_raw_config` | `mcp_servers` and `skills.disabled`, as written (no `${VAR}` filled in) | Published API (`hermes_cli.config`). No plugin call lists the MCP servers |
| `tools.approval._yolo_active`, `tools.approval_context._get_approval_mode`, `tools.approval.is_approval_bypass_active_for_session` | Whether Hermes would approve the plugin's question without asking (`--yolo`, `/yolo`, `hermes -z`, `approvals.mode: off`) | **Not published.** No published call says this. It's the test Hermes's approval gate uses (`tools/approval.py`, `_run_approval_gate`), evaluated in the same turn just before it. `hermes plugins validate` warns about it. Where it can't be evaluated (another Hermes, or `plugins.isolation: host`), the step is refused |

## Security

What a served skill may and may not do, and what the plugin checks, is in
[`SECURITY.md`](SECURITY.md).

## Limits

The changes for all hosts are in
[What hosts would need to change](../../../docs/host-changes.md).

- **A second connection, and no servers behind Hermes's sign-in.** The
  extension's requests (`skills/list`, `skills/get`, `resources/read`) go over
  the plugin's own connection. `ctx.call_mcp` calls tools only. The change:
  `ctx.mcp_request(server, method, params)` over the native client, behind
  `mcp_allowlist`, and `ctx.mcp_server_info(server)` to see whether a server
  declares the extension.
- **Listed from the next session.** Hermes builds a session's skill list when
  the session starts, so a skill found while one runs is listed from the next
  (`list_skills` and `load_skill` reach it at once). The change: a skill
  registered at runtime added to the lists of sessions already open.
- **Reading a skill first takes a step of your own.** The Codex form's
  question offers "show me its SKILL.md first"; Hermes's approval offers
  once, session, always and deny. So the question says to deny and type
  `/mcp-skills show`. For a skill the server generates (`"dynamic"`), what
  loads afterwards is generated again and may differ from what you read. The
  change: a way for a tool's approval to offer choices of its own.
- **The first session after install** doesn't list the served skills yet: the
  plugin looks at the servers during that session's first turn. Ask "which
  skills do my MCP servers serve?" there, or start a second session.
- **Tool Search.** By default Hermes lists plugin tools by name only, and a
  model may not find `load_skill` there. `tools.tool_search.enabled: off`
  lists them directly.
- **No served skills in YOLO.** Where Hermes approves without asking, served
  skills aren't loaded at all (above), and where the plugin can't tell
  (another Hermes version, `plugins.isolation: host`), not either. Unattended
  runs with an approve mode (`approvals.cron_mode`, `single_query_mode` or
  `unattended_mode: approve`) approve loads where nobody is present, as you
  set them to, and a kept "session" or "always" answer covers its exact load
  there too. Telling this needs Hermes's unpublished gate test. The change:
  the approval mode in hook arguments, or a published call for it.
- **No secrets from `.env`.** A server whose `url`, `headers`, `command` or
  `env` takes `${VAR}` from Hermes's `.env` is left alone: that's where Hermes
  keeps secrets, and the plugin doesn't read them. Hermes's own connection to
  it still works. `ctx.mcp_request` (above) would close this too.
- **Not checked on Windows.**

## Spec and conformance

SEP-2640, Final at commit `2eb3a8e`. [`docs/conformance.md`](docs/conformance.md)
takes the 60 client rules one by one, as this form meets them in Hermes (the
client logic is the Codex form's, run as it is; X5, X8, X13b and W1 are
where Hermes differs). The tests:

| Test | What it covers |
|---|---|
| `test/helper-test.ts` | L1 and lazy retrieval with Hermes stubs, names Hermes accepts and that can't shadow another, stubs removed for a server left out, `list_skills` in Hermes's words, X14 (the approval binds the version, a change in between refuses the load, a server showing one version and serving another, a dynamic skill is asked every time, keys whole whatever the URI's length), X13b (the question says how to read the skill first; the preview is checked and loads nothing), a load Hermes never asked about refused, no markup into the system prompt |
| `test/e2e_test.py` | In Hermes: listed in the next session and after a restart, Hermes's approval before a load (declined: nothing fetched), "always" covering one version only, X8 asked every time (a 45-character server name, which Hermes shortens, included), `skills.disabled`, `/mcp-skills show` answered to the person and never seen by the model, no load with `approvals.mode: off` |
| `test/test_plugin.py` | The Python half: stubs, approvals, X8 kept across restarts, keyed per read, matched to servers as Hermes names their tools, and asked before every read when what a session loaded can't be read or saved or the call names no session, loads and cross-server reads refused where Hermes approves without asking, the generic resource tool refused for skills, `skills.disabled` (however the URI is spelled), the command, the configuration read again |
| `test/plugin-test.ts` | The installed folder matches a fresh build |
| `../codex` `npm test` | The client rules, against the code this form bundles |
| `test/interop_huggingface.py` | Hugging Face's server, through Hermes: listing, the stubs in Hermes's skill list, a load after Hermes asks, `read_skill_file` |
| The upstream conformance suite's SEP-2640 client scenarios (`main` at `96a6f94`), through the bundled helper: `test/conformance/run.sh` | `no-prefetch`, `verify-digest`, `verify-size`, `verify-frontmatter`: all four pass |
| `hermes plugins validate` (Hermes's own admission check) | Manifest, loading in isolation, declared tools and hooks, security scan, unpublished imports: passes, with one warning, the approval check above |

## Development

```bash
(cd ../core && npm ci) && (cd ../codex && npm ci) && npm ci
npm run build
npm test
python3 -m unittest discover -s test -p 'test_*.py'
../../../tools/hermes/setup.sh
$HERMES_PYTHON test/e2e_test.py -v
$HERMES_PYTHON test/interop_huggingface.py   # Hugging Face's public server; needs the network
```

## Licence

Apache-2.0, like the rest of this repository.
