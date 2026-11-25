# mcp-skills for Antigravity

Use skills served by your MCP servers in Google Antigravity. The plugin lists
them with Antigravity's local skills, asks before loading a new or changed
version, and checks each file against the server's published manifest.

This implements the client side of [SEP-2640, Final](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
commit `2eb3a8e`, the same revision as the [Codex form](../codex/README.md).
It shares [Skills core](../core/), Codex's approval store and content formatting,
and the [Antigravity gate](../../server-cards/antigravity/src/gate.ts).

**Not run live as a whole yet.** The adapter follows the Antigravity
documentation copied on 2026-11-25, for App 2.35.1, CLI `agy` 1.5.16 and IDE.
Its approval gate, shared with the other Antigravity forms, was checked live
through the Events plugin on 25 November 2026: the hook sees a lazily loaded
MCP tool as `call_mcp_tool` (with `ServerName` `mcp-skills_skills`), the gate
takes that form and the eager one, and `overwrite` reaches the server. The
rest is in the live checks below.

## Install

From the repository, install the plugin folder:

```bash
agy plugin install /absolute/path/to/AgentPolyfill/polyfills/skills/antigravity/plugin
```

Or copy `plugin/` as `mcp-skills/` into an Antigravity plugin directory, such
as `~/.gemini/config/plugins/`. Copy the entire folder, including `dist/`,
`hooks.json`, `mcp_config.json` and `skills/`; no repository files or
`node_modules` are needed in the installed copy.

**Node 20 or newer must be on PATH for both the MCP server and the command
hook.** The hook runs `node ./dist/server.mjs --hook` from the plugin root.
Restart Antigravity if it has not picked up the installation.

## Try it

Add a public server that serves skills to your personal
`~/.gemini/config/mcp_config.json`, keeping your other entries:

```json
{
  "mcpServers": {
    "huggingface": { "serverUrl": "https://huggingface.co/mcp" }
  }
}
```

Hugging Face is the independent server used by the Codex form's interop
probe. This adapter includes the same kind of probe, but has not run it
against the public service yet.

Ask Antigravity:

> List the skills my MCP servers serve.

That starts discovery if the MCP server has not started already. The plugin
writes short skill stubs. Antigravity documents rereading skills before each
turn across App, CLI and IDE. Check `/skills` on your next turn, then ask to
use one by its server and skill name. The CLI documentation also mentions
`/skills reload` or a new conversation to refresh the picker; whether the
picker updates with the next turn needs a live check.

`load_skill` asks whether to load the skill. Its question names the server,
skill and URI, says whether this is a new approval or a change since your last
one, and gives the file count and total size. After you approve, it returns
verified skill text as content from that server. Supporting files are read as
needed with `read_skill_file`.

The card is **yes/no**. There is no “show me SKILL.md first” option: Antigravity
documents `force_ask`, not a private multi-step preview. You can decline,
inspect the publisher's source outside the model, then retry. `list_skills`
can show the origin, description and URI without loading text. The plugin
never sends the model unapproved text as a preview.

## How it works

### Servers it reads

Only `mcpServers` in `~/.gemini/config/mcp_config.json` is read.

| Configuration | What happens |
|---|---|
| `command`, `args`, `env`, `cwd` | A separate local process connects using these values. |
| `serverUrl` or `url`, without credentials | Connects if the server allows it. |
| URL with plain `headers` | Sends those headers. |
| `disabled: true` | Left alone. |
| `authProviderType` or `oauth` | Skipped with a sign-in reason, even if headers are also present. |
| URL that responds that it needs sign-in | Skipped with a reason. No sign-in is attempted. |
| Plugin-bundled or workspace `.agents/mcp_config.json` servers | Not looked at. |

The plugin never reads Antigravity's stored credentials, including
`~/.gemini/antigravity/mcp_oauth_tokens.json`. It does not expand configuration
variables or run a header helper. Labels must be 1–64 letters, digits,
hyphens or underscores, starting with a letter or digit. Unsupported entries
are reported in `list_skills`.

Only servers declaring the extension and the resources capability receive
Skills requests. Discovery reads all listing pages within the core's bounds.
A server that does not declare Skills is not probed again for a day, unless
its location changes. Listings refresh when their `ttlMs` runs out, no more
often than every ten seconds, on `list_skills`. Load checks always obtain
current metadata. A skill missing from a listing can still load by URI.

### Approval and reads

1. Antigravity's `PreToolUse` hook runs the bundle with `--hook`. For a load,
   it reads current configuration and obtains fresh `skills/get` metadata on
   its own connection. It fetches no file. Validated metadata is shared in
   `stateDir('mcp-skills')`; the hook also reads the saved catalog to identify
   nested skills.
2. An unchanged manifest from an approved server location yields `allow`.
   A new or changed version yields `force_ask`. Dynamic skills, whose servers
   publish no digests, ask every time. Invalid entries and oversized skills
   yield `deny`.
3. The unchanged shared gate creates a short-lived one-use ticket and adds
   `agentpolyfill_ticket` through `overwrite`. It binds the call to the
   version digest and conversation. No ticket means no skill content, even
   when the hook did not run or failed open in Antigravity.
4. The MCP server redeems the ticket against the shared metadata, obtains the
   current entry on its own connection, and refuses if it differs. It loads
   and verifies SKILL.md through core, then saves the approval. Approvals
   cover every file address and digest and the server URL or command,
   arguments and working directory. Credentials are not saved in approvals.
5. `read_skill_file` and `list_skill_directory` use `allow` hooks only, with
   no question from the plugin. Their tickets identify the conversation;
   the server only reads a skill that conversation has loaded. A static
   skill's reads and directory listings stay within its held manifest.
   `list_skills` has no hook and asks no question.

Server content is untrusted data. Descriptions are bounded and cleaned;
loaded text is marked with its origin and fenced. Frontmatter grants no
permissions, and `allowed-tools` is never copied to a stub. A digest match
shows consistency, not trust. Subsequent actions still use Antigravity's
permissions.

### Where it writes

| Location | Contents |
|---|---|
| `~/.gemini/config/skills/mcp-skills-served--<server>-<6hex>--<16hex>/SKILL.md` | One stub directly under the skills root. The readable server part is lowercased and limited to 20 characters; the hashes identify the exact label and URI. Frontmatter `name` equals the folder name. |
| `~/.gemini/agentpolyfill/mcp-skills/` | Settings, approvals, declaration cache, metadata snapshots, log and tickets. This is `stateDir('mcp-skills')`, or `$AGENTPOLYFILL_STATE_DIR/mcp-skills`. The directory is 0700 and state files are 0600. |

The plugin creates, rewrites and removes only stub folders matching that
exact shape. Unrelated files and folders stay untouched. Stub symlinks are
replaced or removed without following them; a symlink at the skills root is
refused. Stubs contain metadata and the plugin's load instructions, never a
skill's file contents. **Other programs reading this folder see these stubs
too.** They say they require this Antigravity plugin.

At most 100 stubs are kept, including retained entries for temporarily
unreachable servers. `list_skills` and loads by URI reach entries beyond that
cap. Discovery removes stale stubs for removed or disabled servers. Removing
the plugin leaves the stubs: turn it off and let its server run once to clean
them up first, or remove only its exact-shape folders yourself.

No runtime writes go into the installed plugin, which Antigravity may replace
on update. No skill file content is cached on disk. Verified content and
loaded manifests stay in server-process memory.

## Settings and stand-down

Write `settings.json` in the state directory yourself; the plugin never
writes that file:

```json
{ "servers": ["huggingface"], "skip": [], "off": false }
```

Omit `servers` to discover all supported user entries. `skip` leaves named
servers alone. Set `"off": true`, or `MCP_SKILLS_DISABLED=1` in the
Antigravity environment, to stand down. At startup that removes owned stubs,
opens no upstream connections, and offers no tools. A running server checks
settings before calls, refuses work and removes stubs when turned off;
restart to turn it back on. Restart to refresh discovery after changing server
configuration or the allowlist. Calls check current configuration; moving a
server reconnects and invalidates held entries from its old origin. The hook
checks current settings on every call.

Antigravity currently documents local Agent Skills, not SEP-2640, so there is
no native extension capability to detect reliably. This setting is the
stand-down mechanism until the host supplies one. Delete `approvals.json`
to require approval on subsequent loads; already loaded content cannot be
removed from a conversation by deleting the file.

## Limits

| Limit | Host change that would close it |
|---|---|
| No access to Antigravity sign-ins; second upstream connections. A load hook briefly opens another connection, so servers with process-local skill URIs may fail safely. | Let plugins send extension requests over the host's connections, with capability information. |
| Only personal MCP config; no workspace/plugin server inventory or managed-policy evaluation. | Expose an approved, effective server inventory through a plugin API. |
| No private SKILL.md preview (X13b). | A user-only preview surface or elicitation with a separate preview step. |
| The plugin cannot enforce cross-origin approval for the host's other resource tools (X8). | Expose active skill provenance and the target server on resource reads, so the host can ask with both origins. Hook access alone does not establish which skill caused another tool call. |
| Other host resource tools can bypass manifest verification (V4); commands after a load use ordinary host permissions (X5). | Make native skill context and permission enforcement cover every read and action. |
| Loaded manifests and verified caches are lost on server restart (W1/V8). Reload before reading further files; an unchanged approved version does not ask again. | A host lifecycle API for keeping manifests with conversation context. |
| No native per-skill enable/disable enforcement; local discovery exclusions can hide a stub without preventing a tool load (H1/X11). Local name collisions are not detected (X9). | Expose effective skill policy and the complete skill namespace to plugins. Use server allow/skip settings here. |
| The first turn may need `list_skills`; stubs share a global folder, survive uninstall and appear to other programs. At most 100 are written. Multiple installations use the same personal root. | A managed dynamic skill registration API, with discovery refresh and uninstall cleanup. |
| Binary files are checked but not displayed. | A native skill-file presentation API for non-text resources. |
| The hook runs, briefly, for every lazily loaded MCP call (`call_mcp_tool`, any server); it acts only on this plugin's `ServerName`. `reason` display in the approval card hasn't been confirmed live. Without the hook's ticket, loads fail closed. | MCP elicitation, or a hook matcher on the server's name. |
| No automatic detection of native SEP-2640 support. | A host feature/version signal that plugins can query. |

## What differs from the other forms

| | Antigravity | Codex | Claude Code |
|---|---|---|---|
| Integration | Plugin, MCP server and command hook | Plugin MCP server | Mod and helper |
| Skill listing | Flat personal skill stubs | Nested stubs under `~/.agents/skills/mcp-skills-served` | Direct skill listing |
| Consent | `force_ask`, yes/no, version-bound ticket | MCP elicitation with private preview choice | Host permission dialog and preview panel |
| Conversation | Hook tickets for load and supporting reads | Codex call metadata | Mod's session |
| Approvals/settings | `stateDir('mcp-skills')` | Codex state folder | Mod store / environment settings |
| Stand-down | Explicit setting | Native capability declaration or setting | Observed native skill loading |
| Live evidence | Not run yet | Recorded terminal and exec runs | Recorded Claude Code runs |

## Spec and conformance

The [rule table](docs/conformance.md) accounts for the same client rules as
the Codex form. The shared core supplies negotiation, URI handling, limits,
pagination, manifest verification, lazy reads and held entries. Antigravity
tests port the applicable Codex client-rule tests and add config, flat stub,
gate, matcher, no-elicitation and installed-bundle checks. X8 and X13b remain
unmet host gaps; the table identifies the other limits instead of claiming
full conformance.

```bash
cd polyfills/skills/antigravity
npm ci
(cd ../core && npm ci)
npm run build
npm run typecheck
npm test
npm run check
```

Tests bundle the independent hand-written fixture from the Claude Code form;
they use temporary HOME directories and only loopback HTTP. The shared build
driver supports `--check`, `--out DIR` and `--tests`. The committed bundle
must match a fresh build byte for byte. The install test copies only `plugin/`
to a temporary directory, then runs its MCP server and hook and loads a skill.

Development in this sandbox reused `../codex/node_modules` by symlink rather
than downloading dependencies. This folder has its own package-lock, using
Codex's pinned build-tool approach. That symlink is ignored and not shipped.
The core's dependencies must also be installed for builds; runtime needs
only the bundled plugin and Node 20+.

Local verification: **64 tests pass**, with no skips. Type checking and the
byte-identical bundle check pass. Tests ran on Node 22.23.1; Node 20 and other
operating systems have not been exercised separately.

Two optional external checks are runnable, but were **not run for this
adapter**. They do not borrow the Codex form's results:

```bash
# Public network, no credentials; deliberately approves each version in the test.
npm run interop:real
# Or REAL_SERVERS='name=https://example.com/mcp' npm run interop:real

# An independently installed upstream conformance checkout; four loopback scenarios.
CONFORMANCE_DIR=/path/to/modelcontextprotocol/conformance bash test/conformance.sh
```

### Required live checks

On App, CLI and IDE, with a throwaway HOME and a known fixture, confirm:

- Done (25 November 2026, [record](../../events/antigravity/docs/live-run.md#second-pass-later-the-same-night)):
  the tool name a hook sees (`call_mcp_tool` for a lazy tool) and `overwrite`
  reaching the server; `list_skills` wrote 25 placeholder folders for
  Hugging Face's skills, and a fresh conversation found the right one by
  itself; the App's approval card showed the question ("Load the skill
  "hf-cli" from the MCP server "huggingface"? ... This is a new skill
  approval ..."), an approved load returned verified `SKILL.md` and reference
  files, and the same unchanged skill then loaded with no question; a load
  nobody could answer (headless `agy -p`) was denied and the plugin's server
  never saw it. Over `agy acp`, an editor sees the tool name and arguments,
  not the question.
- `force_ask` displays the `reason`, including origin, URI and new/changed
  wording, and declining does not invoke the MCP tool.
- `overwrite.agentpolyfill_ticket` reaches the server unchanged; approving
  loads verified content, unchanged approval passes, and changed content asks.
- Stubs appear in `/skills` on the next turn. Record separately whether the
  CLI picker needs `/skills reload`; check App/CLI/IDE turn discovery too.
- A read stays in the conversation that loaded the skill, even if Antigravity
  shares an MCP process; a missing hook refuses without any skill content.

## Licence

[Apache-2.0](../../../LICENSE). Bundled dependencies and their licences are
listed in [plugin/THIRD_PARTY_LICENSES.txt](plugin/THIRD_PARTY_LICENSES.txt).
This community plugin is not affiliated with Google or the MCP project.
