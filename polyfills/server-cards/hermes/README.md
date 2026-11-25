# mcp-server-cards for Hermes

Ask Hermes which MCP servers a domain publishes. It reads the domain's AI
Catalog, fetches and validates each Server Card, and shows the results. Ask
to add one, and Hermes asks for approval before changing its configuration.

## Install

```sh
hermes plugins install idosal/AgentPolyfill/polyfills/server-cards/hermes/plugin --enable
```

Hermes accepts `owner/repo/path/to/plugin` (v0.23.4's
`hermes_cli/plugins_cmd.py`, `_resolve_git_url`). To try a copy from a
clone instead, put `plugin/` in `$HERMES_HOME/plugins/mcp-server-cards/` and
run `hermes plugins enable mcp-server-cards`.

You need Node.js 20 or newer on the gateway's PATH. `AGENTPOLYFILL_NODE` can
name its executable. The installed folder contains its bundled JavaScript
and Python code; it needs no npm install. Checked in Hermes Agent v0.23.4.

## Try it

> What MCP servers does neon.com publish?

Then ask to add Neon Docs. Approve the prompt, then run `/reload-mcp` to
connect it and refresh the session's tools. A new Hermes session is another
option. Ask to remove it to undo the change, or use `hermes mcp remove
neon-docs`, followed by `/reload-mcp`.

The tools are `discover_mcp_servers(domain)`,
`add_mcp_server(identifier, url, domain?, remote?, name?, values?)`, and
`remove_mcp_server(name)`. `values` is for non-secret card inputs only.

## How it works

The Python plugin registers tools and a `pre_tool_call` hook. A Node helper
speaks newline-delimited JSON-RPC over stdin/stdout. Discovery, schema
validation, input substitution, caching and presentation reuse the Claude
Code form's TypeScript modules. Redirect checks reuse the Codex fetch adapter.
The helper gets a small environment without API keys or other host secrets.

Discovery reads `/.well-known/ai-catalog.json` and `rel="ai-catalog"` links.
It does not search registries or read ARD manifests. Refused cards remain
visible with their reasons. Only valid cards shown in the calling session
can be added, and `url` must match the card's resolved endpoint exactly.
Cards are untrusted advisory data, not instructions or grants of access.

For add and remove, Hermes's approval prompt names the server and shows the
whole entry: the URL, each header with its value (a secret only as its
`${VAR}` reference; a literal credential is refused before), the transport and
every other setting, then the file and the undo action. A decline writes nothing. A
surface that cannot answer fails closed. Hermes owns its once/session/always
choices; choosing a lasting approval delegates future matching actions to
Hermes. An addition's rule is a digest of all the question shows (the name,
the entry, the card and where it was found); a removal's, of the name and the
entry.
The plugin itself stores no approval decisions. Where Hermes approves without
asking (`--yolo`, a session's `/yolo`, `hermes -z`, `approvals.mode: off`), an addition is
refused before Hermes is asked: Hermes would answer itself, and adding a server
needs your own yes. A removal still goes to Hermes. Telling this takes the
test Hermes's approval gate uses, which isn't on Hermes's published plugin API
(`hermes plugins validate` warns about it); where it can't be evaluated
(another Hermes version, `plugins.isolation: host`), an addition is refused
too. Hermes's unattended approve modes (`approvals.cron_mode`,
`single_query_mode` or `unattended_mode: approve`) still approve additions
where nobody is present, as you set them to, and a kept "session" or "always"
answer covers its exact addition there too.

An approved addition writes `mcp_servers.<name>` in `$HERMES_HOME/config.yaml`.
An existing name is refused, including a name created while approval was
pending. The public `hermes_cli.config.require_readable_config_before_write`
and `save_config` APIs preserve the raw environment references and unrelated
settings. This is the same save API used by `hermes mcp add`, without its
interactive probe or token handling. Config writes use only Hermes's
published plugin API (`hermes_cli.config`). An addition saves only its own entry, with
`save_config(..., merge_existing=True)`, so Hermes merges it, under its own
config lock, into the file as it is at that moment; a removal reads, changes
and saves the file, as `hermes mcp remove` does. One lock shared by this
plugin and the ARD plugin keeps their check-then-write steps apart. An
external editor, or a Hermes write between a removal's read and its save,
can still race it; the plugin then checks what was saved and says so.

Secret inputs become `${MCP_...}` references, tagged for the card and remote
with the shared 80-bit SHA-256 scheme. Put the named variables in
`$HERMES_HOME/.env`, then reload. Never send their values to the agent. The
plugin never opens `.env` or any token store. Literal credential headers are
refused; fixed non-secret headers are allowed. Hermes supports references in
both headers and URLs, including a secret mixed into a header template.

This Server Card revision has no standard OAuth field. After approval, for
an endpoint without secret inputs, the helper sends an anonymous MCP
`initialize` request to the exact endpoint, with redirects disabled. A 401
Bearer challenge selects `auth: oauth`. The result tells you to run
`hermes mcp login <name>` before reloading. The plugin never starts a login,
follows authorization URLs, handles tokens, or trusts ad-hoc `auth` fields
in cards. A failed or unrecognized probe is reported; it is not proof that
the server needs no authentication.

Removal deletes only an unchanged entry this plugin recorded in
`$HERMES_HOME/mcp-server-cards/added.json`. That record holds card names and
entry fingerprints, not credentials. Editing an entry relinquishes automatic
removal; use Hermes's own command in that case. A removal does not delete
environment variables or OAuth tokens. `/reload-mcp` disconnects the server
from open sessions.

### Hermes calls it uses

| Call | What for | Documented |
|---|---|---|
| `ctx.register_tool`, `register_hook` (`pre_tool_call`), `register_system_prompt_section`, `on_unload` | The tools, the approvals, the tools' instructions, stopping the helper | Plugin guide |
| `hermes_constants.get_hermes_home`, `gateway.session_context.get_session_env` | The profile, and the session a call is from | Published API |
| `hermes_cli.config.get_config_path`, `require_readable_config_before_write`, `save_config` (with `merge_existing=True` for an addition) | Reading `config.yaml` as written, and writing `mcp_servers` under Hermes's own lock | Published API (`hermes_cli.config`); `hermes mcp add` uses the same writer. Hermes's own read errors aren't passed on: they can quote a line of `config.yaml` |
| `tools.approval._yolo_active`, `tools.approval_context._get_approval_mode`, `tools.approval.is_approval_bypass_active_for_session` | Whether Hermes would approve the plugin's question without asking (`--yolo`, `/yolo`, `hermes -z`, `approvals.mode: off`) | **Not published.** No published call says this. It's the test Hermes's approval gate uses (`tools/approval.py`, `_run_approval_gate`), evaluated in the same turn just before it. `hermes plugins validate` warns about it. Where it can't be evaluated, the step is refused |

## Spec and contract

The revisions match the Codex form:

- MCP Server Cards, **SEP-2127 Final**, extension stage Beta;
  `ext-server-card` schema and discovery rules at `28db12c9b4` (2026-11-19).
- AI Catalog **v0.9**, release candidate, at `19208af2f8`.

The shared [client-rule table](../claude-code/README.md#client-rules) remains
the rule-to-test reference. `npm test` bundles those original tests with
their imports redirected to this installed `plugin/dist/helper.mjs`.

| Contract rule | How it's met |
|---|---|
| 1. One published client extension | Server Cards only. `DEF-1`, `DEF-2`, `E-1`, `V-1` and `S-2` test source selection and refusal. No wire fields are invented. |
| 2. Named revision | Revisions above; same schema and discovery modules as Codex. |
| 3. Client rules and interop | Shared `V-*`, `D-*`, `C-*`, `S-*`, `A-*`, `P-*`, `O-*`, `X-*`; network `F-1`–`F-6`; Hermes `H-1`–`H-6`. `V-2` replays other publishers' saved cards. Against a publisher this repository didn't write, through Hermes: neon.com's catalog and cards, Neon Docs added after Hermes's approval and its tools reaching the model after `/reload-mcp` ([Interop](#interop)). The upstream conformance suite has no Server Cards client scenarios. |
| 4. Stand down | `hermes plugins disable mcp-server-cards`; additionally `MCP_SERVER_CARDS_DISABLED=1` registers nothing (`test_disabled_registers_nothing`). Hermes has no native Server Cards support to detect at this pin. |
| 5. State limits | Limits below; tool results name reload, secret setup and OAuth steps. |
| 6. Untrusted content and host permission | `test_approval_description_shows_the_whole_entry`, `test_no_preparation_or_changed_arguments_cannot_write`, `test_name_collision_and_race_never_overwrite`, `test_remove_ownership_and_changed_entry`; real Hermes declined and unanswerable approvals below. |

## Tests

From this directory:

```sh
npm ci
npm run build
npm run typecheck
npm run check
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py' -v
HERMES_PYTHON=/path/to/pinned/venv/bin/python HERMES_SRC=/path/to/pinned/hermes-agent \
  python3 ../../../tools/hermes/run_card_e2e.py
```

The runner then runs `$HERMES_PYTHON test/e2e_test.py -v`. The tests need no
account, API key or external registry, and touch no Hermes, Codex or Claude
state of yours: every process gets its own `HOME` and `HERMES_HOME`, the
fixtures listen on 127.0.0.1 only, and Python may reach loopback only (on
macOS, `sandbox-exec` fences every process).

Real-Hermes scenarios:

- `test_discover_decline_add_reload_and_remove`: validates discovery, decline
  without even probing the endpoint, approved YAML entry, `/reload-mcp`, an
  actual MCP tool reaching and being called by the model, duplicate/invalid
  refusal, declined removal, approved removal and tool disappearance.
- `test_secrets_oauth_and_session_isolation`: another session cannot add an
  unseen card; secret headers stay `${VAR}`; live Bearer challenge writes
  `auth: oauth` and yields the login instruction; removal works afterwards.
- `test_no_approval_surface_fails_closed`: no UI for approval, no write.
- `test_no_addition_where_hermes_approves_without_asking`: with
  `approvals.mode: off`, nobody is asked, nothing is written and the endpoint
  isn't probed.

`H-6` also verifies the shipped bundle, schemas and shared Python copies
match their sources. Build artifacts belong in the installed plugin folder.

## Interop

[`test/interop_real.py`](test/interop_real.py) runs this form in Hermes
against neon.com, a publisher this repository didn't write. It needs the
network. Checked in Hermes v0.23.4.

| Check | What passes |
|---|---|
| discover | neon.com's catalog and cards, fetched and validated (`urn:air:neon.com:mcp:neon-docs` at `https://neon.com/docs/mcp`) |
| add | Hermes asks, then the entry is written to `config.yaml` |
| connect | Hermes connects the added server with its own client, and its tools reach the model after `/reload-mcp` |

```bash
$HERMES_PYTHON test/interop_real.py
```

## Security

What the plugin checks before a card can change anything is in
[`SECURITY.md`](SECURITY.md). Among other things, the address fetched is
checked when the connection is made (a public name resolving to a private
address is refused), and a card that sets a routing header such as `Host`
isn't added.

## Limits

- **Connecting is a separate Hermes action.** Configuration is saved; the
  plugin does not claim it connected. `/reload-mcp` or a new session loads
  the tools. A public `ctx` API to add/remove and connect a server would
  remove this step, and the race a removal can still meet (above).
- **No custom-choice question in a tool handler.** Hermes owns the approval
  gate. Missing non-secret inputs are returned for the agent to ask about.
  A handler-safe `ctx` question API with custom choices would allow a picker.
- **The card is not compared to live `server/discover` metadata (S-3).**
  Hermes does its own MCP negotiation, but exposes no public plugin method
  for this comparison. A connection/request API would close the gap.
- **OAuth detection is bounded.** Secret-bearing endpoints are not probed,
  and endpoints that do not challenge with Bearer need manual `auth: oauth`
  configuration. No pre-standard card-auth fields are interpreted. A public
  Hermes MCP authentication-discovery API would handle those cases.
- **The cache and displayed-card state live in memory per session.** A helper
  or gateway restart requires discovery again. Removal ownership persists.
- **Protocol filtering covers the pinned handshake revisions**, 2025-11-25,
  2025-06-18, 2025-03-26 and 2024-11-05. A card advertising only the newer
  stateless protocol is conservatively refused until the Hermes connection
  path is verified for it. SSE is written with `transport: sse`.

To stand down, run `hermes plugins disable mcp-server-cards`. Disabling stops
the tools and helper; it leaves servers you already approved in Hermes's
configuration.
