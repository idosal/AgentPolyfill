# mcp-skills for Antigravity

Use skills served by your MCP servers in Google Antigravity. The plugin lists
them with Antigravity's local skills, asks before loading a new or changed
version, and checks each file against the server's published manifest.

This implements the client side of [SEP-2640, Final](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
commit `2eb3a8e`, the same revision as the [Codex form](../codex/README.md).
It shares [Skills core](../core/), Codex's approval store and content formatting,
and the [Antigravity gate](../../server-cards/antigravity/src/gate.ts).

Checked in Antigravity App 2.35.1 and CLI 1.5.17. Rule X8 is not met:
Antigravity shows no question for the plugin's `force_ask` on a resource read
(see [Gaps](#gaps-and-the-host-changes-that-would-close-them)).

## Install

You need the Antigravity CLI (`agy`) to install a plugin from a folder: the
App doesn't ship it. Node 20 or newer must be on your `PATH`, for the MCP
server and the command hook (the hook runs `node ./dist/server.mjs --hook`
from the plugin root). From a clone of this repository:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/skills/antigravity/plugin
agy plugin list
```

`agy plugin install` copies the folder to `~/.gemini/config/plugins/mcp-skills/`,
which the App and the CLI both read. Nothing is published to Antigravity's
Marketplace. Restart the App if it has not picked up the installation.

### Uninstall, and what stays behind

```bash
agy plugin uninstall mcp-skills
```

That removes the plugin's folder. It leaves:

- the placeholder skills in `~/.gemini/config/skills/mcp-skills-served--*`
  (turn the plugin off in its settings and let its server run once to remove
  them first, or delete those folders yourself);
- its own folder, `~/.gemini/agentpolyfill/mcp-skills/` (settings, approvals,
  which servers' skills each conversation loaded, log): delete it by hand.

### Where it runs

| Surface | Supported | Checked |
|---|---|---|
| Antigravity CLI 1.5.17 (macOS) | yes | new, changed and unchanged loads; a load declined; a load around the hook refused; X8 (the CLI ignores its question) |
| Antigravity App 2.35.1 (macOS) | yes | a changed version asked and loaded, one declined, a load around the hook refused; X8 (the App ignores its question too) |
| Antigravity IDE | no | Antigravity documents no plugin hooks for the IDE, so there is no question and no ticket: every load there is refused |

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

Ask Antigravity:

> List the skills my MCP servers serve.

That starts discovery if the MCP server has not started already. The plugin
writes short placeholder skills. A placeholder written when the plugin's
server starts is found by that conversation's agent (CLI 1.5.17).
Antigravity documents rereading skills before each turn; whether a
placeholder written in the middle of a conversation shows on its next turn
hasn't been checked, and the CLI documents `/skills reload` or a new
conversation to refresh its picker.

`load_skill` asks whether to load the skill, for a new or changed version
only. Its question's first two lines name the skill and the server, then say
whether this is a new approval or a change since your last one, with the URI
(the CLI's card shows those two lines and hides the rest); the rest gives the
file count and total size and the server's description, marked untrusted.
After you approve, it returns verified skill text as content from that server.
Supporting files are read as needed with `read_skill_file`.

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
variables or run a header helper. Header values, environment values and a
URL's query values are registered as secrets and taken out of everything the
plugin shows. Labels must be 1–64 letters, digits, hyphens or underscores,
starting with a letter or digit. Unsupported entries are reported in
`list_skills`.

Only servers declaring the extension and the resources capability receive
Skills requests. Discovery reads all listing pages within the core's bounds.
A server that does not declare Skills is not probed again for a day, unless
its location changes. Listings refresh when their `ttlMs` runs out, no more
often than every ten seconds, on `list_skills`. Load checks always obtain
current metadata. A skill missing from a listing can still load by URI.

### Approval and reads

1. The three gated tools are eager (`plugin/mcp_config.json`), so Antigravity
   calls them as `mcp_mcp-skills_skills_<tool>`, and the plugin's
   `PreToolUse` matcher takes those names (and `read_resource`, for rule X8)
   only. For a load, the hook reads current configuration and the skill's
   current entry on its own connection. It fetches no file. Validated
   metadata is shared in `stateDir('mcp-skills')`; the hook also reads the
   saved catalog to identify nested skills.
2. An unchanged manifest from an approved server location yields `allow`,
   which leaves Antigravity's usual MCP question. A new or changed version
   yields `force_ask`. Dynamic skills, whose servers publish no digests, ask
   every time. Invalid entries and oversized skills yield `deny`.
3. The shared gate creates a one-use ticket, good for an hour at most and
   removed at the conversation's next model call or when its turn ends, and adds `agentpolyfill_ticket`
   through `overwrite`. It binds the call to the version digest and the
   conversation. No ticket means no skill content: a load sent through
   `call_mcp_tool` doesn't reach the hook and is refused.
4. The MCP server redeems the ticket against the shared metadata, obtains the
   current entry on its own connection, and refuses if it differs. It loads
   and verifies SKILL.md through core, then saves the approval and records
   that this conversation holds a skill from that server. Approvals cover
   every file address and digest and the server URL or command, arguments and
   working directory. Credentials are not saved in approvals.
5. `read_skill_file` and `list_skill_directory` use `allow` hooks only, with
   no question from the plugin. Their tickets identify the conversation;
   the server only reads a skill that conversation has loaded. A static
   skill's reads and directory listings stay within its held manifest.
   `list_skills` has no hook and asks no question.
6. Rule X8: once a conversation holds a skill from one server, the hook
   answers `force_ask` to a `read_resource` from any other server, naming
   both. Antigravity shows no question for it, in the CLI 1.5.17 (in its auto
   mode and in its default mode, `request-review`) or the App 2.35.1 (its
   Default preset), and the read goes ahead, so this holds only where
   Antigravity honours the question.

Server content is untrusted data. Descriptions are bounded, cleaned and then
scrubbed of known secrets; loaded text is marked with its origin and fenced,
and every answer is scrubbed. Frontmatter grants no permissions, and
`allowed-tools` is never copied to a stub. A digest match shows consistency,
not trust. Subsequent actions still use Antigravity's permissions.

### Where it writes

| Location | Contents |
|---|---|
| `~/.gemini/config/skills/mcp-skills-served--<server>-<6hex>--<16hex>/SKILL.md` | One placeholder directly under the skills root, 0600 in a 0700 folder. The readable server part is lowercased and limited to 20 characters; the hashes identify the exact label and URI. Frontmatter `name` equals the folder name. |
| `~/.gemini/agentpolyfill/mcp-skills/` | Settings, approvals, declaration cache, metadata snapshots, which servers' skills each conversation loaded (`held/`), log and tickets. This is `stateDir('mcp-skills')`, or `$AGENTPOLYFILL_STATE_DIR/mcp-skills`. The directory is 0700 and state files are 0600. |

The plugin creates, rewrites and removes only placeholder folders matching
that exact shape. Unrelated files and folders stay untouched. Placeholder
symlinks are replaced or removed without following them; a symlink at the
skills root is refused. Placeholders contain metadata and the plugin's load
instructions, never a skill's file contents. **Other programs reading this
folder see these placeholders too.** They say they require this Antigravity
plugin.

At most 100 placeholders are kept, including retained entries for temporarily
unreachable servers. `list_skills` and loads by URI reach entries beyond that
cap. Discovery removes stale placeholders for removed or disabled servers.
Removing the plugin leaves them: turn it off and let its server run once to
clean them up first, or remove only its exact-shape folders yourself.

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
Antigravity environment, to stand down. At startup that removes owned
placeholders, opens no upstream connections, and offers no tools. A running
server checks settings before calls, refuses work and removes placeholders
when turned off; restart to turn it back on. Restart to refresh discovery
after changing server configuration or the allowlist. Calls check current
configuration; moving a server reconnects and invalidates held entries from
its old origin. The hook checks current settings on every call.

Antigravity currently documents local Agent Skills, not SEP-2640, so there is
no native extension capability to detect reliably. This setting is the
stand-down mechanism until the host supplies one. Delete `approvals.json`
to require approval on subsequent loads; already loaded content cannot be
removed from a conversation by deleting the file.

## Gaps, and the host changes that would close them

| Gap | What it means for you | Host change that closes it |
|---|---|---|
| No MCP elicitation (Antigravity declares it and cancels every request), so the question goes through a hook. | Loads are put to you in Antigravity's approval card; there is no private "show me SKILL.md first" (X13b). In the CLI the card shows the question's first two lines. | Elicitation shown to the person, with a preview step. |
| Antigravity shows no question for a hook's `force_ask` on `read_resource` (CLI 1.5.17 in auto and default mode, App 2.35.1). | After a skill loads, a read of another server's resource isn't put to you (rule X8 not met). A setting that refuses such reads until you approve them through a plugin tool isn't built: it would block another server's reads for the rest of the conversation, unrelated ones included. | Honour `force_ask` for built-in resource reads. |
| No plugin hooks in the IDE. | The plugin doesn't work in the Antigravity IDE: every load there is refused. | Plugin hooks in the IDE. |
| Plugins can't use Antigravity's MCP connections or sign-ins. | The plugin opens its own connections; a server that needs Antigravity's sign-in is left out, and a load hook briefly opens one more connection. | Extension requests over the host's own connections. |
| Only the personal MCP config is visible to plugins. | Servers from workspaces or other plugins aren't offered. | An approved server inventory for plugins. |
| Other host tools can read resources without the manifest check (V4); actions after a load use your usual permissions (X5). | A loaded skill can ask the agent to read or do things through Antigravity's own tools. | Native skill context covering every read and action. |
| Loaded manifests are lost when the plugin's server restarts (W1/V8). | Reload the skill before reading more files; an unchanged approved version doesn't ask again. | A lifecycle API that keeps them with the conversation. |
| No native per-skill enable/disable or name-collision view (H1/X11/X9). | Use the plugin's `servers`/`skip` settings to choose servers. | Effective skill policy and namespace for plugins. |
| Placeholders share the global skills folder. | They survive uninstall and other programs see them; at most 100 are written. | A dynamic skill registration API. |
| Binary files are checked but not shown. | You see that a binary file is there, not its contents. | A presentation API for non-text resources. |
| A `PreToolUse` hook that fails makes the call fail (CLI 1.5.17). | If Node isn't on `PATH` or the hook crashes, loads and reads fail; other servers' calls, apart from `read_resource`, never reach it. | Documented hook failure behaviour. |
| No way to tell whether Antigravity supports SEP-2640 itself. | Turn the plugin off yourself when it does. | A capability signal plugins can query. |

## What differs from the other forms

| | Antigravity | Codex | Pi |
|---|---|---|---|
| Integration | Plugin, MCP server and command hook | Plugin MCP server | Extension |
| Skill listing | Flat personal placeholder skills | Nested stubs under `~/.agents/skills/mcp-skills-served` | Pi's own skill list |
| Consent | `force_ask`, yes/no, version-bound ticket | MCP elicitation with private preview choice | Pi's own dialog with preview |
| Conversation | Hook tickets for load and supporting reads | Codex call metadata | Pi session |
| X8 (another server's read after a load) | The hook asks; Antigravity ignores it | Not met | Asks |
| Stand-down | Explicit setting | Native capability declaration or setting | See the [Pi README](../pi/README.md) |

## Security

[SECURITY.md](SECURITY.md). In short: every new or changed skill is put to
you in Antigravity's approval card; nothing is auto-approved. The plugin
reads `~/.gemini/config/mcp_config.json`, which can hold header values, and
never logs or shows them. It never opens `mcp_oauth_tokens.json` or any
sign-in store.

## Spec and conformance

The [rule table](docs/conformance.md) accounts for the same client rules as
the Codex form. The shared core supplies negotiation, URI handling, limits,
pagination, manifest verification, lazy reads and held entries. Antigravity
tests port the applicable Codex client-rule tests and add config, flat
placeholder, gate, matcher, X8, no-elicitation and installed-bundle checks.
X13b and X8 remain unmet; the table identifies the
other limits instead of claiming full conformance.

```bash
cd polyfills/skills/antigravity
npm ci
(cd ../core && npm ci)
npm run build
npm run typecheck
npm test
npm run check
```

Tests bundle the hand-written fixture server from
[`../core/test-fixtures`](../core/test-fixtures); they use temporary HOME
directories and only loopback HTTP. The shared build driver supports
`--check`, `--out DIR` and `--tests`. The committed bundle must match a fresh
build byte for byte. The install test copies only `plugin/` to a temporary
directory, then runs its MCP server and hook and loads a skill.

`npm test` runs **69 tests**. Checked on Node 22. Not checked separately:
Node 20 and other operating systems.

The upstream SEP-2640 client scenarios (conformance suite at `c8625de`) pass
4 of 4. The suite's client is `test/interop.ts`, which runs this form's hook handlers
in-process, taking a `force_ask` as your yes, and this form's MCP server code:

```bash
CONFORMANCE_DIR=/path/to/modelcontextprotocol/conformance bash test/conformance.sh
```

`npm run interop:real` (public network, no credentials) runs the adapter
against public servers.

## Licence

[Apache-2.0](../../../LICENSE). Bundled dependencies and their licences are
listed in [plugin/THIRD_PARTY_LICENSES.txt](plugin/THIRD_PARTY_LICENSES.txt).
This community plugin is not affiliated with Google or the MCP project.
