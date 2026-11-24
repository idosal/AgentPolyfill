# mcp-server-cards for Codex: connect Codex to a company's MCP server by its domain

A Codex plugin that lets Codex find the MCP servers a domain publishes, and add one to Codex. Name a company, and Codex reads that domain's catalog, fetches each Server Card it lists, checks the card against the schema, and tells you what it found. Ask it to add one, and Codex shows you a form naming the server, the URL, the headers, the file it writes and the undo command. Only if you accept does the server go into Codex's own MCP configuration, as if you had typed `codex mcp add`.

> What MCP servers does neon.com publish?

It adds the client side of the MCP **Server Cards** extension, which Codex does not support by itself yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) at commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127 hands domain discovery to, v0.9 (a release candidate) at `19208af2f8`.

This is the Codex form of [`mcp-server-cards`](../claude-code) for Claude Code. Both run the same card, discovery and configuration code: this plugin bundles those modules from [`../claude-code/mod/hooks`](../claude-code/mod/hooks) and adds a Codex front (an MCP server, a form for consent, `codex mcp add`). [What differs](#what-differs-from-the-claude-code-form) is listed below.

This is a community project. It is not affiliated with or endorsed by OpenAI, Anthropic, the Model Context Protocol project, the Agentic AI Foundation or the Linux Foundation.

ARD (`/.well-known/ard.json` and registry search) is not in this plugin. It is in [`ard-discovery`](../../ard/codex), a separate plugin, because its search sends your words to a third party.

## Install

In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add mcp-server-cards@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace (Codex reads its `.agents/plugins/marketplace.json`), and the second installs the plugin. With the marketplace added, `codex plugin list` shows both of its Codex plugins. Start a new Codex session afterwards.

You need:

- **Codex CLI 0.170.0 or newer** (tested with 0.170.0 and 0.172.0). Plugins are on by default.
- **Node.js 20 or newer** on your `PATH`: the plugin is one JavaScript file, [`plugin/dist/server.mjs`](plugin/dist/server.mjs), with no dependencies, that Codex starts as a stdio MCP server.
- Nothing else: no account, no key.

To remove it: `codex plugin remove mcp-server-cards@agent-polyfill`.

To run it from a clone instead, add the clone as the marketplace: `codex plugin marketplace add ./AgentPolyfill`, then `codex plugin add mcp-server-cards@agent-polyfill`.

## Try it

Ask Codex "What MCP servers does neon.com publish?", then "Add Neon Docs". Codex shows a form; accept it. Neon Docs needs no sign-in. Start a new session to use it, and `codex mcp remove neon-docs` removes it again.

For one that needs a sign-in, ask about buildkite.com and add Buildkite; then run `codex mcp login buildkite` in a terminal.

## Using it, step by step

1. **Ask.** For example "connect Codex to Buildkite", or "what MCP servers does neon.com publish?".
2. **Codex calls `discover_mcp_servers`.** It reads the domain's `/.well-known/ai-catalog.json` and the `rel="ai-catalog"` links on its home page, fetches each card, and checks it. It is read-only, and in the live runs Codex called it, and `add_mcp_server`, without an approval prompt of its own: the plugin's form is the question.
3. **Codex tells you what it found:** each server's card, the URL it connects to, and whether the card is valid. A refused card says why; nothing refused can be added.
4. **Ask Codex to add one.** Codex calls `add_mcp_server`, and the plugin asks you through Codex's form (MCP elicitation):

   ```
   Add the MCP server "neon-docs" to Codex?
   It connects to https://neon.com/docs/mcp
   Headers: none
   From the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog.
   Written to /Users/you/.codex/config.toml (all your projects).
   To undo: codex mcp remove neon-docs
   ```

   - **Accept**, and the server is written with `codex mcp add`.
   - **Decline** or close it, and nothing is written. Codex is told not to ask again unless you bring it up.
   - Where nobody can be asked (`-a never`, `codex exec`), Codex declines the form, so nothing is written. Under `--dangerously-bypass-approvals-and-sandbox`, Codex accepts the form itself, so the server is added without asking you. [Which Codex modes ask you](#which-codex-modes-ask-you) is below.
   - The plugin adds only a card a tool showed in this session, at the URL that card gives, and only if no server of that name exists (`codex mcp get`). Otherwise it refuses before asking.
5. **The server is added** to `$CODEX_HOME/config.toml` (`~/.codex/config.toml`), which serves all your projects. Codex connects MCP servers when a session starts, so its tools arrive in your next session.
6. **If it needs a sign-in:** `codex mcp add` starts a browser sign-in by itself when a server offers OAuth, and waits for it. A tool call can't wait like that, so the plugin stops the command there, once the entry is written, and the result tells you to run `codex mcp login <name>`. The sign-in is Codex's own; the plugin never sees it.
7. **If the card asks for a secret** (an API key, say), the plugin never asks you for it and never shows it to Codex's model. The configuration holds the name of an environment variable, such as `MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ`, and the result tells you its name. Set it where you start Codex, then start a new session. The tag at the end is 80 bits of SHA-256 over the card's name and URL, so no other card can be given a reference to it.
   - A bearer token is written as `bearer_token_env_var`, with `codex mcp add --bearer-token-env-var`.
   - Any other secret header is written as `env_http_headers`, and a fixed header as `http_headers`. `codex mcp add` can't set those, so such a server is written through `codex app-server`'s `config/value/write`, which edits the same file.
8. **To undo:** `codex mcp remove <name>`. The result gives the exact line.

### Which Codex modes ask you

Checked live on 24 November 2026 (Codex 0.170.0 for `codex exec`, 0.172.0 for app-server), with the plugin's server loaded and Neon Docs added to a throwaway `CODEX_HOME`. "App-server" is the API the TUI and the desktop app run on; a client stood in for the person there and answered after two seconds.

| Mode | The form | What the plugin does |
|---|---|---|
| TUI or desktop, `--ask-for-approval on-request` (the default), approvals to you | shown to you | adds only on your accept |
| The same with auto-review (`approvals_reviewer = "auto_review"`, `--approve-for-me`) | shown to you: auto-review does not answer it | adds only on your accept |
| The same with `--sandbox danger-full-access` | shown to you | adds only on your accept |
| `--ask-for-approval never` | declined by Codex, without asking | nothing is written |
| Granular approvals with `mcp_elicitations = false` | declined by Codex, without asking | nothing is written |
| `codex exec`, with or without `--approve-for-me` | declined or closed by Codex (nobody to ask) | nothing is written |
| `--dangerously-bypass-approvals-and-sandbox` | **accepted by Codex, without asking**, in about 20 ms | the server is added without asking you, as every tool runs without asking in that mode |

The form is the consent, and the plugin takes Codex's answer to it as it comes. In every mode but one, that answer is yours. Under `--dangerously-bypass-approvals-and-sandbox`, Codex accepts the form itself, so the plugin adds the server without asking you, as every tool runs without asking in that mode. Under `-a never` and in `codex exec`, Codex declines the form, so nothing is added. A Codex field in a tool call's metadata naming the approval mode would let the plugin tell these apart; see [Limits](#limits-and-the-host-changes-that-would-remove-them).

### Settings

Codex plugins have no settings page, so the plugin reads these from the environment Codex starts in. Its `.mcp.json` passes them through.

| Variable | Default | What it does |
|---|---|---|
| `MCP_SERVER_CARDS_DISABLED` | unset | `1` turns the plugin off: no tools, nothing fetched. |
| `CODEX_HOME` | `~/.codex` | Where Codex keeps its configuration; the plugin writes there. |
| `CODEX_CLI_PATH` | unset | The `codex` command to run, when it is not on `PATH` (the desktop app sets it). Otherwise `codex` on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` are tried. |

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Adds a server shown in this session, after your accept in the form. `url` must be the URL the server will connect to. |

## What differs from the Claude Code form

| | Claude Code form | Codex form |
|---|---|---|
| What runs | a mod (hooks) inside Claude Code | a stdio MCP server in a Codex plugin, started with Node |
| Consent to an add | a question the mod makes in Claude Code's permission prompt | a form through MCP elicitation, refused without a form, or on a decline or close |
| A picker with **Add** buttons | under each result | none: the TUI draws no third-party UI. You ask Codex to add a server |
| Where it is written | `claude mcp add`, in the scope you choose (local, project, user) | `codex mcp add` into Codex's one configuration file (all projects); there is no `scope` |
| A name you already have | refused for Claude's add; the picker takes `name-2` | refused; pass another `name` |
| Secrets | `${VAR}` references in the URL and headers | names of environment variables (`bearer_token_env_var`, `env_http_headers`); Codex reads no `${VAR}`, so a card with a secret in its URL, or a secret mixed into a header (`Token {key}`), is refused |
| SSE remotes | added | refused: Codex connects to streamable HTTP servers only |
| Sign-in | `/mcp` | `codex mcp login <name>` |
| Redirects | followed by Claude Code's fetch, unseen, so one to a private address is not caught | followed by the plugin, each hop under the same address rule, so **a redirect to a local or private address is refused** |
| Protocol revisions it adds for | Claude Code's: 2026-07-28 back to 2024-11-05 | Codex's: 2025-06-18 back to 2024-11-05 (Codex 0.170.0 asks for 2025-06-18; 2026-07-28 is behind its `mcp_2026_07_28` feature, off) |
| The cache | the plugin store, kept between sessions | in memory, for one session |
| A notice after a web fetch | yes (`notice_on_fetch`) | no: a plugin can't see Codex's web fetches |
| Cards from another plugin (`present_server_cards`) | yes | no: one Codex plugin's server can't call another's tools. `ard-discovery` carries the same core instead |

## Client rules

The discovery, validation, input and transport rules are those of the Claude Code form, with the same code and the same tests: see [its client rules](../claude-code/README.md#client-rules) (D-1 to D-9, V-1 to V-3, C-1 to C-3, S-1 to S-6, I-1 to I-4). Those tests run here against the built [`plugin/dist/server.mjs`](plugin/dist/server.mjs), with `npm test`. What Codex changes:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | the polyfills' own (security review SC2) | E-6 | met: a name `codex mcp get` knows, or can't rule out, is refused before the person is asked, and again before writing |
| P-2 | A person approves every addition | the polyfills' own (security review SC4) | E-3, E-4 | met where Codex puts the form to the person: an MCP elicitation form naming the server, URL, headers, file and undo; refused with no form, or on decline or close. Under `--dangerously-bypass-approvals-and-sandbox` Codex accepts the form itself; see [Which Codex modes ask you](#which-codex-modes-ask-you) |
| P-3 | Add only what was shown, as shown | the polyfills' own | E-6 | met: a card a tool showed in this session, at the URL it yields |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | C-2, C-3, E-8 | met: an environment variable's name, never a value; a secret in a URL, or mixed into a header, is refused |
| I-3 | Choose a remote by its `supportedProtocolVersions` | schema.ts, `Remote` | C-6 | met, with Codex's revisions |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | C-4 | streamable HTTP met; SSE refused, because Codex has no SSE client |
| S-1 | HTTPS for cards; plain HTTP only for local development | discovery.md | F-1, F-3 | met, for every redirect hop too |
| N-1 | No step from a public origin to a local or private address | the polyfills' own | F-1 | met for documents and, here, for redirects |
| N-2 | Bounded answers | the polyfills' own | F-4, F-6 | 512 KiB per answer, read no further; five redirects |
| V-3 | No text that displays as something else | the polyfills' own (security reviews SC1 and, for these forms, C1) | X-4, A-24, P-6, O-9, E-9 | met: besides control and invisible characters, a URL from a card or a finder may hold no `` ` ``, `<`, `>` or square bracket outside an IPv6 host, so a host that renders the form as Markdown can't show a link text in place of the URL. In the shared core, so the Claude Code form has it too |

## Stand-down

Codex has no Server Card support to detect yet. When it ships, remove or disable the plugin (`codex plugin remove mcp-server-cards@agent-polyfill`, or `enabled = false` under `[plugins."mcp-server-cards@agent-polyfill"]` in `config.toml`), or set `MCP_SERVER_CARDS_DISABLED=1`: the server then registers no tools and fetches nothing.

## Proof

- **Per rule:** 107 tests, run with `npm test`. 84 are the Claude Code form's rule tests (card, configure, discover, format, offer), run against the committed bundle. 21 are this form's: the fetch guard (F-), the Codex plan (C-), and the server as Codex runs it (E-), over stdio, with a stand-in `codex` command and a web on 127.0.0.1. 2 check the bundle: it is byte-identical to a fresh build, and a copy of `plugin/` alone starts and lists its tools.
- **The real host**, 24 November 2026, with the user's own Codex login and the plugin's server, and every add going to a throwaway `CODEX_HOME`:
  - `codex exec` (0.170.0): `discover_mcp_servers` returned Neon and Neon Docs for neon.com, and Buildkite for buildkite.com, all valid.
  - Through app-server (0.172.0), as the TUI runs: the add of Neon Docs (`https://neon.com/docs/mcp`) put the form to the client, which accepted after two seconds; `codex mcp get neon-docs` then showed it, and `codex mcp remove neon-docs` removed it.
  - Each approval mode in the table above.
  - Installed from this repository's marketplace into a throwaway `CODEX_HOME` (`codex plugin marketplace add`, `codex plugin add mcp-server-cards@agent-polyfill`): both servers started and listed their tools.
  - The sign-in step, with the real `codex mcp add` (0.172.0) against a local server that advertises OAuth: the entry was in `config.toml` when "Detected OAuth support" was printed, and the command was stopped before any registration request.
  - A live server that needs a sign-in, Buildkite, added the same way through [`ard-discovery`](../../ard/codex/README.md#proof-in-the-real-host), which runs this add: the entry was written, `codex mcp add` was stopped at its sign-in, and the result said `codex mcp login buildkite`.
- **Not yet run in the real host:** a live card with headers; and the form as the TUI or the desktop app draws it. In these runs the client answering the form was a script on app-server, the API both of them use, so the question reached the client exactly as recorded, but how it looks on screen was not seen. The headers path (`codex app-server` `config/value/write`) was checked by hand against a throwaway `CODEX_HOME`, and is tested with the stand-in `codex` (E-8); none of the live cards found has headers.
- **Upstream conformance:** the MCP conformance suite has no Server Card scenarios.

## Limits, and the host changes that would remove them

- **The card is not compared with the live server** (rule S-3). The plugin can't send `server/discover` over Codex's connection. A Codex app-server method that passes an MCP request to a configured server would let it.
- **No picker in the TUI.** Codex's TUI draws no third-party UI. The desktop app shows MCP Apps, which a later version could use.
- **A public name that resolves to a private address** is not caught: Node's `fetch` resolves names itself. Redirects are now checked. Checking the resolved address in the plugin's own fetch (a `lookup` that refuses private results) is a known follow-up.
- **Under `--dangerously-bypass-approvals-and-sandbox`, a server is added without asking you**: Codex accepts the form itself, as it approves every tool in that mode. The plugin can't tell that answer from yours. Codex putting the approval mode in a tool call's metadata would let it.
- **Headers other than a bearer token** need `codex app-server`, which Codex marks experimental (it is on by default, and the TUI runs on it). A `--header` and `--env-header` for `codex mcp add` would remove that.
- **A secret in a URL, or mixed into a header,** can't be added: Codex reads environment variables only as a bearer token or a whole header value.
- **A project's own `.codex/config.toml`** is not checked for a name clash: the plugin's server runs in the plugin's folder, not the project's.
- **New servers arrive in the next session**, as Codex reads its MCP configuration when a session starts.

## Privacy and security

What it sends, what it stores, what it changes and what it trusts are in [SECURITY.md](SECURITY.md). In short:
- It reads public documents from the domain you name and the card URLs that domain's catalog lists. It never fetches a local or private address unless you name one yourself, and no redirect takes it to one.
- It changes only Codex's MCP configuration, for the server you accept in the form.
- It never reads Codex's credentials, holds no token, and never puts a secret's value anywhere.

## Develop

```bash
npm ci
npm run build       # plugin/dist/server.mjs, from src/ and ../claude-code/mod/hooks
npm run check       # fails if plugin/dist/server.mjs is not what the sources build
npm run typecheck
npm test            # against the committed plugin/dist/server.mjs: run npm run build first
```

`plugin/dist/server.mjs` is committed, because Codex installs `plugin/` as it is. `npm test` fails while it is stale, and CI rebuilds it and fails if the result differs.

| Path | What it is |
|---|---|
| `src/main.ts` | The server: its two tools; the entry of the bundle. |
| `src/tools.ts` | `discover_mcp_servers`, `add_mcp_server`, and the form. |
| `src/codex.ts` | The plan in Codex's terms, and `codex mcp get`, `codex mcp add`, `codex app-server`. |
| `src/fetch.ts` | Node's `fetch`, with redirects followed under the address rule, and the size cap. |
| `src/mcp.ts` | A small stdio MCP server, with elicitation. |
| `src/host.ts` | Codex's name and protocol revisions, the store, the logger. |
| `build.mjs` | The esbuild bundle, and the tests' build. |
| `plugin/` | What Codex installs: `.codex-plugin/plugin.json`, `.mcp.json`, a skill and `dist/server.mjs`. |
| `test/` | The adapter tests, their harness and the `claude-code/testing` stand-in. |
