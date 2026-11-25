# Conformance: the Server Cards client rules, for Copilot

The Copilot plugin implements the client side of MCP Server Cards, against the
revisions named in its [README](../README.md#spec-and-conformance):

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final.
- [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card/tree/28db12c9b4),
  commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- [AI Catalog](https://github.com/Agent-Card/ai-catalog/tree/19208af2f8), v0.9
  release candidate, commit `19208af2f8`, which SEP-2127 names for domain
  discovery.

## Client rules

The full [client rules table](../../claude-code/README.md#client-rules) gives
the source and tests for D-1 to D-9, V-1 to V-3, C-1 to C-3, S-1 to S-6 and
I-1 to I-4. Those shared rules carry over because the Copilot plugin bundles
the same card, discovery, cache, configuration, formatting and offer modules,
and runs the same 90 rule tests against its committed
[`plugin/dist/server.mjs`](../plugin/dist/server.mjs).
[`build.mjs`](../build.mjs) builds those tests against that bundle. This
keeps the shared table's limits too: S-3 is not met.

These are the rows where Copilot uses its own host behaviour or adds a
restriction, plus the live-comparison gap and the hand-over rules that don't
apply here. Rule IDs follow the [Claude Code](../../claude-code/README.md#client-rules),
[Codex](../../codex/README.md#client-rules) and
[Pi](../../pi/docs/conformance.md) tables. In the test column, C-1 to C-9
(the Copilot plan) and E-1 to E-10 (the server as Copilot runs it) are in
[`adapter.test.ts`](../test/adapter.test.ts). Shared tests are named
separately. The runs in Copilot itself are in [Proof](#proof).

`exception` means met within the limit stated in the row, with its reason.
`not met` names what is missing; `n/a` means the rule governs something this
form doesn't do.

| # | Rule | Status | How Copilot meets it, and limits | Tests |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | met | A name `copilot mcp get` knows, or can't rule out (it fails, or answers in a way the plugin doesn't recognise), is refused before the person is asked, and checked again before writing. `copilot mcp add` itself refuses a name that exists (1.0.115, checked by hand), so a name written in between isn't overwritten either. | E-5, E-7 |
| P-2 | A person approves every addition | met | Two questions, both Copilot's own: its tool prompt before `add_mcp_server` runs (unless the person allowed the tool), then an MCP elicitation form naming the server, host, URL, headers, the file written and the undo command, with a required choice and **Don't add it** first. Only **Add it** adds. Decline, close, a missing or different choice, a failed form, or no form support at all adds nothing. Copilot declines the form where nobody can be asked: `copilot -p`, with `--allow-all-tools` and with `--yolo` (seen live). | E-3, E-4, E-9 |
| P-3 | Add only what was shown, as shown | met | A valid card shown by `discover_mcp_servers` in this session, at the URL the tool call gives, is the only thing added. The write is `copilot mcp add`, run with no shell, from the `copilot` that started the server (`COPILOT_CLI_PATH`), then `PATH` and the usual install places, in the session's folder (`COPILOT_SESSION_CWD`). | E-3, E-5 |
| P-4 | Nothing from a card is read as an option of `copilot mcp add` | met | Every option is written `--option=value`: a header name may legally start with `-`, and Copilot 1.0.115 refuses `--header -x: v` but takes `--header=-x: v` whole. The name (a slug) and the URL (http or https) are checked again just before the command runs. | C-7 |
| P-5 | One value per header | met | A card that sets one header twice, in any letter case, is refused, so the form, the command and the file can't disagree. | C-8 |
| I-2 | Handle `isSecret` values securely | met | A secret is written as a `${VAR}` reference named for this card alone, also inside a value (`Token ${VAR}`) and in a URL path. A secret value the model offers is ignored; a `$` from a card is refused. The person is told which variable to set. Copilot expands the reference when it connects (seen against a local server). | C-2, C-3, C-4, E-6 |
| I-3 | Choose a remote by its `supportedProtocolVersions` | met | Copilot's revisions are listed in [`src/host.ts`](../src/host.ts) (`COPILOT_PROTOCOL_VERSIONS`). A declared list with none of them is refused, naming them. Copilot 1.0.115 initialises at `2025-11-25` (seen live); negotiation of each older revision isn't tested. | C-6 |
| I-4 | Transport `streamable-http` or `sse` | met | Both: `--transport=http` and `--transport=sse`. | C-1, C-3 |
| S-1 | HTTPS for cards; plain HTTP only for local development | met | The shared URL checks, and every redirect hop checked again by the fetch adapter the Codex form uses ([`codex/src/fetch.ts`](../../codex/src/fetch.ts)): a public HTTPS request can't redirect to plain HTTP; loopback HTTP stays available for local development. | Shared S-1 and T-1 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts); F-1 to F-3 in the [Codex form's tests](../../codex/test/adapter.test.ts), same module |
| S-2 | Never treat a card as authoritative for security or access-control decisions | met | A card supplies a plan. The person still approves the addition, and Copilot owns the connection and any sign-in. `extensionsInfo` grants nothing. | E-3, E-4; shared S-4 in [format.test.ts](../../claude-code/mod/tests/format.test.ts) |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | not met | The plugin doesn't compare the card's name, version and protocol revisions with the running server. It would need to send `server/discover` over Copilot's connection (an MCP server in a plugin can't), and Copilot connects a server added mid-session only after `/mcp reload`. | None |
| N-1 | No step from a public origin to a local or private address | exception | Shared discovery refuses private addresses named by public documents, and the fetch adapter applies the same check to redirects. A public name that resolves to a private address isn't caught, because Node's `fetch` resolves names itself. | Shared P-1, P-3, P-4 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts); C-4; F-1 in the Codex form. No DNS-resolution test |
| N-2 | Bounded answers | met | At most five redirects, and response bodies capped (an answer over the cap is not read: 413), by the same fetch adapter as the Codex and Pi forms. | F-4 and F-6 in the [Codex form's tests](../../codex/test/adapter.test.ts), same module |
| V-3 | No text that displays as something else | met | Shared validation refuses control and direction marks, misleading URL markup, userinfo and backslashes. What is shown passes the shared plain-text filter, which also takes out characters that show as nothing (tag characters, variation selectors, a soft hyphen, line separators). A header value that would be written holding such a character is refused, from the card or given. A fixed header value with markup is refused, since the form shows it as it is. | C-5, C-9, E-10; shared X-1 to X-6 in [card.test.ts](../../claude-code/mod/tests/card.test.ts) and [format.test.ts](../../claude-code/mod/tests/format.test.ts), A-24 to A-26 in [configure.test.ts](../../claude-code/mod/tests/configure.test.ts) |
| C-3 | Avoid unnecessary polling | met | Discovery runs on a tool call only. The cache is in memory, in the server's process, which Copilot starts per session. | Shared C-1 to C-3 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts) |
| H-1 to H-4 | Cards handed over by another plugin | n/a | The plugin has no `present_server_cards` tool: its tools are `discover_mcp_servers` and `add_mcp_server`. ARD's Copilot form adds what it finds itself. | E-1; shared O-1 to O-5 in [offer.test.ts](../../claude-code/mod/tests/offer.test.ts) cover the bundled offer reader only |

The Copilot plan and `copilot mcp add` are in [`src/copilot.ts`](../src/copilot.ts);
consent and the shown-card check are in the Codex form's
[`src/tools.ts`](../../codex/src/tools.ts), bundled here with Copilot's name
and words ([`src/host.ts`](../src/host.ts)).

Stand-down is manual: `MCP_SERVER_CARDS_DISABLED=1` registers no tools (E-8),
and `copilot plugin disable mcp-server-cards@agent-polyfill` stops the
plugin. Nothing detects native support; disable or uninstall the plugin when
Copilot has it.

## Proof

Run from `polyfills/server-cards/copilot`, with Node.js 20 or newer:

```bash
npm ci
npm test
```

The checked run on 25 November 2026, with Node.js 22.23.1, passed **111
tests**, none failed or skipped. The tests need loopback access for their
local web server.

- **90 shared rule tests:** `card`, `configure`, `discover`, `format` and
  `offer` from [`claude-code/mod/tests`](../../claude-code/mod/tests),
  against the committed bundle.
- **9 plan tests:** C-1 to C-9, the Copilot plan and its command line.
- **10 server tests:** E-1 to E-10, the bundled server over stdio as Copilot
  starts it, with a stand-in `copilot` that parses options as Copilot 1.0.115
  does, and a web on 127.0.0.1.
- **2 bundle tests:** the committed bundle is what the sources build, and the
  installed folder holds what the manifest names.

**In Copilot itself,** 25 November 2026, Copilot CLI 1.0.115 on macOS, with an
isolated `HOME` and `COPILOT_HOME`, no GitHub sign-in, and a scripted model on
this machine (as in [mcp-events' live run](../../../events/copilot/docs/live-run.md)):

- Installed from a clone of this repository as a marketplace
  (`copilot plugin marketplace add <clone>`, then
  `copilot plugin install mcp-server-cards@agent-polyfill`), beside
  `mcp-events` and `ard-discovery`, all three loading in one session.
  Uninstalling and removing the marketplace were run the same way; what
  stays behind is in the [README](../README.md#uninstall).
- `discover_mcp_servers` for neon.com returned Neon and Neon Docs, both valid,
  from neon.com's own published cards.
- In the TUI: Copilot's tool prompt for each tool, then the form, drawn as
  quoted in the README. **Add it** wrote `neon-docs` to `mcp-config.json`
  through `copilot mcp add`.
- In `copilot -p`, with `--allow-all-tools` and with `--yolo`: Copilot
  declined the form, and nothing was written.
- `copilot mcp add` (1.0.115), checked by hand: it writes `--header` values
  and `${VAR}` references as given, accepts SSE, refuses a name that exists,
  and contacts no server.

**In VS Code's Copilot harness** (VS Code 1.147.0, signed in, GitHub's Claude
Haiku 4.5), from the same plugin install: `discover_mcp_servers` for neon.com
ran with no prompt (it is read-only, and the harness's default permission mode
runs read-only tools without asking); `add_mcp_server` stopped at VS Code's
tool prompt; then VS Code showed the plugin's form, headed "Your answer", with
the question and the two choices, **Don't add it** first. It runs the
question's lines together in one paragraph. **Add it** wrote `neon-docs` to
`mcp-config.json` (the harness log shows the request as
`Elicitation request: … mode=form, source=mcp-server-cards`).

What this evidence doesn't establish:

- S-3's live comparison, negotiation of each older protocol revision, or a
  public name that resolves to a private address.
- An install from GitHub (`copilot plugin marketplace add idosal/AgentPolyfill`):
  that reads the repository's default branch, which has this plugin only once
  it is merged. The tested install is from a clone.
- A model of GitHub's choosing these tools in Copilot CLI: the model was
  scripted there.
- An upstream conformance pass: the MCP conformance suite has no Server Card
  scenarios.
