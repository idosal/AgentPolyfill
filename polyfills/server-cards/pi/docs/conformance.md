# Conformance: the Server Cards client rules, for Pi

The Pi extension implements the client side of MCP Server Cards, against the
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
I-1 to I-4. Those shared rules carry over because Pi bundles the same card,
discovery, cache, configuration, formatting and offer modules, and runs the
same 90 rule tests against its committed
[`extension/dist/index.js`](../extension/dist/index.js).
[`src/index.ts`](../src/index.ts) exports the shared modules;
[`build.mjs`](../build.mjs) directs the test imports to that bundle. This
preserves the shared table's limits too: S-3 remains not met.

These are the rows where Pi uses its own host behavior or adds a restriction,
plus the live-comparison gap and the hand-over rules that do not apply here.
Rule IDs follow the existing [Claude Code](../../claude-code/README.md#client-rules)
and [Codex](../../codex/README.md#client-rules) tables. In the test column,
P-1 to P-13 refer to [`adapter.test.ts`](../test/adapter.test.ts), and F-1 to
F-6 refer to [`network.test.ts`](../test/network.test.ts). Shared tests are
identified separately. The real Pi tests are named in [Proof](#proof).

`exception` means met within the limit stated in the row, with its reason.
`not met` names the missing behavior; `n/a` means the rule governs something
this form does not do.

| # | Rule | Status | How Pi meets it, and limits | Tests |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | exception | Checks the user `mcp.json`, a trusted project's `.pi/mcp.json`, and session registrations before asking and again before writing. Invalid or unreadable configuration is refused. An addition already in progress blocks another in this session. A name that differs from one of the person's only in `-` and `_` counts as theirs, since Pi treats the two as one server. Another process can still write the same name between the last check and the CLI write: Pi has no atomic add-if-absent option. | P-6, P-7, P-12. The final external-process race is not tested. |
| P-2 | A person approves every addition | met | `ctx.ui.select` names the server, host, URL, headers, destination file and undo command, with **Don't add it** first. Only **Add it** proceeds. Decline, close, a different answer, dialog failure, cancellation or no UI adds nothing. Print/JSON mode refuses; an RPC client must relay the question and answer honestly. | P-4, P-5, P-9; the three RPC answer cases and `real Pi print/JSON mode refuses addition because nobody can be asked`. |
| P-3 | Add only what was shown, as shown | met | Resolves a valid card shown in this session and requires the tool call's URL to equal the planned URL. Runs `pi mcp add` through `pi.exec` and `process.execPath`, using only the running Pi `cli.js` verified against its package name and `bin.pi` entry. No shell or guessed executable is used, and a server name that starts with `-` is refused, since Pi's command line would read it as an option. After a successful write, calls `pi.registerMcpServer` with the same URL and headers. A failed command never registers; a registration failure is reported as saved but not registered. | P-1, P-4, P-6, P-8, P-9, P-13; `a session_start clears previously shown cards, including resume and fork` in [lifecycle.test.ts](../test/lifecycle.test.ts); RPC add and header tests. |
| I-2 | Handle `isSecret` values securely | exception | Saves generated, card-specific `${VAR}` references in headers, including mixed values such as `Token ${VAR}`. Model-supplied secret values are ignored; prefilled declared secrets and foreign `$` references are refused. The adapter never expands the references. Secret URL variables are refused because Pi expands headers, not URLs. | P-2, P-3, P-9; `RPC: secret header stays a reference in mcp.json; Pi expands it only when connecting`. |
| I-3 | Choose a remote by its `supportedProtocolVersions` | met | The adapter accepts `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`, as listed in [src/host.ts](../src/host.ts). A declared list with no overlap is refused. Real Pi requests `2025-11-25` in `initialize`, and the fixture accepts it. Negotiation of each older revision is not tested. | P-1, P-3; the RPC **Add it** case. |
| I-4 | Transport `streamable-http` or `sse` | exception | Adds streamable HTTP remotes. Refuses a selected SSE remote because Pi 1.6.0's remote MCP transport is streamable HTTP; it has no client for the separate SSE transport. Supporting those remotes would require an SSE client in Pi. | P-1, P-3; the RPC **Add it** case. |
| S-1 | HTTPS for cards; plain HTTP only for local development | met | Uses the shared URL checks and checks every redirect hop too. A public HTTPS request cannot redirect to plain HTTP; loopback HTTP remains available for local development. | F-1, F-3; shared S-1 and T-1 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts). |
| S-2 | Never treat a card as authoritative for security or access-control decisions | met | A card supplies a configuration plan. The person still approves the addition; Pi owns connection and sign-in. The adapter does not use `extensionsInfo` to grant access or infer extension support. | P-4, P-5; shared S-4 in [format.test.ts](../../claude-code/mod/tests/format.test.ts). Sign-in itself is not exercised by these tests. |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | not met | The adapter does not send `server/discover` or compare the card's name, version and protocol revisions with the running server. It needs a way to send that request over Pi's live connection, compare the claims and prefer runtime values on disagreement. Successful registration or MCP initialization does not establish agreement with the card. | None. The RPC connection test checks `initialize` and `tools/list`, not a card comparison. |
| N-1 | No step from a public origin to a local or private address | exception | Shared discovery rejects private addresses named by public documents; the Node fetch adapter applies the same check to redirects. This covers literal private addresses and private host spellings. A public hostname resolving to a private address is not caught because the adapter does not check DNS results. | F-1; P-3 for a private remote; shared P-1, P-3 and P-4 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts). No DNS-resolution test. |
| N-2 | Bounded answers | met | The fetch adapter permits at most five redirects and caps response bodies at 512 KiB. It checks the declared length and counts streamed bytes, cancelling an oversized body and returning 413. | F-4, F-6. F-6 exercises the byte-counting path with a smaller configured cap. |
| V-3 | No text that displays as something else | met | Shared validation refuses control and bidirectional marks, misleading URL markup, userinfo and backslashes. Pi's question names the host on its own line; question and result text pass the plain-text filter. A header that would be saved with invisible characters is refused. The adapter also refuses header markup, duplicate header names, the server or header name `__proto__`, and header values starting with `!`, which Pi would execute as commands. | P-3, P-4, P-10, P-11; shared X-1, X-2, X-4, X-5 in [card.test.ts](../../claude-code/mod/tests/card.test.ts), X-3 and X-6 in [format.test.ts](../../claude-code/mod/tests/format.test.ts), A-24 to A-26 in [configure.test.ts](../../claude-code/mod/tests/configure.test.ts). |
| C-3 | Avoid unnecessary polling | met | Discovery runs on a tool call. This form installs no web-fetch notice or polling hook. The cache is in memory; `session_start` creates a new store and forgets shown cards. Cache-Control and ETag handling remain the shared C-1 and C-2 behavior. | Shared C-1 C-2, C-2 and C-3 in [discover.test.ts](../../claude-code/mod/tests/discover.test.ts); `a session_start clears previously shown cards, including resume and fork`. No separate polling test; the hooks are in [src/host.ts](../src/host.ts). |
| H-1 | Each is an AI Catalog entry: an `identifier`, exactly one of `url` and `data`, and where it was found | n/a | This extension registers discovery and addition, with no `present_server_cards` hand-over tool. The bundled offer reader remains covered by the shared tests. | Shared O-1 in [offer.test.ts](../../claude-code/mod/tests/offer.test.ts); no Pi hand-over test. |
| H-2 | Who stands behind a server: the publisher is the domain in `urn:air:<publisher>:…`, never an address or a local name | n/a | No hand-over tool is exposed by this extension. | Shared O-5 in [offer.test.ts](../../claude-code/mod/tests/offer.test.ts); no Pi hand-over test. |
| H-3 | A server is confirmed only when the publisher's own catalog lists the same identifier with a valid card. That card is then the one shown and added | n/a | No hand-over tool is exposed by this extension. Testing the shared offer reader does not establish a Pi hand-over workflow. | Shared O-2 to O-4 in [offer.test.ts](../../claude-code/mod/tests/offer.test.ts); no Pi hand-over test. |
| H-4 | Only another plugin can hand cards over: the model isn't shown the tool, and a call of its own is refused | n/a | There is no `present_server_cards` tool to call. The registered tools are listed in [src/index.ts](../src/index.ts). | No Pi hand-over test. |

The Pi-specific checks and write path are in [`src/pi.ts`](../src/pi.ts);
consent and the shown-card check are in [`src/tools.ts`](../src/tools.ts).
The fetch implementation is [`codex/src/fetch.ts`](../../codex/src/fetch.ts),
bundled into this extension too.

Manual stand-down is tested by `stand-down: the actual factory registers
nothing when disabled` in [`lifecycle.test.ts`](../test/lifecycle.test.ts).
`MCP_SERVER_CARDS_DISABLED=1` registers no tools. The adapter has no automatic
native-support detection; it must be disabled or removed when no longer
needed.

## Proof

Run from `polyfills/server-cards/pi`, with Node.js 22 on PATH:

```bash
npm test
```

It runs **117 tests**. Checked with Node.js 22.22.1 and Pi 1.6.0. The tests
need loopback access for their local HTTP server.

- **90 shared rule tests:** `card`, `configure`, `discover`, `format` and
  `offer` from [`claude-code/mod/tests`](../../claude-code/mod/tests), against
  the committed Pi bundle. These exercise the shared functions; the Pi
  adapter tests cover the restrictions applied after shared planning.
- **13 adapter tests:** P-1 to P-13 in
  [`adapter.test.ts`](../test/adapter.test.ts). Pi execution, registration
  and the selector are stood in for in these tests.
- **6 network tests:** F-1 to F-6 in
  [`network.test.ts`](../test/network.test.ts), with fetch responses stood
  in for. F-5 also tests the reused fetch adapter's restriction on redirecting
  a request body; Server Cards discovery itself sends GET requests.
- **2 lifecycle tests:** manual stand-down and clearing shown cards on
  `session_start`, in [`lifecycle.test.ts`](../test/lifecycle.test.ts).
- **5 real Pi tests:** the three RPC answers, print/JSON refusal and secret
  header expansion, in [`rpc.test.ts`](../test/rpc.test.ts).
- **1 bundle test:** `bundle: committed extension/dist/index.js is
  byte-identical to a fresh build`, in
  [`bundle.test.ts`](../test/bundle.test.ts). It builds into a temporary
  directory and compares bytes; it also checks the extension manifest.
  Running the tests does not rebuild the shipping bundle in place.

The three answer tests are named:

- `RPC: discover_mcp_servers then add, answer Add it; actual Pi CLI and connection`
- `RPC: discover_mcp_servers then add, answer Don't add it; actual Pi CLI and connection`
- `RPC: discover_mcp_servers then add, answer undefined; actual Pi CLI and connection`

Each loads a copy of `extension/` into real Pi, and calls discovery and
addition against the local catalog, card and MCP server in
[`harness.ts`](../test/harness.ts). The accepted case inspects the saved
`mcp.json`, observes `initialize` with `2025-11-25`, and waits for
`tools/list`. Decline and cancellation leave no configuration file and make
no request to the MCP endpoint. The local server is our fixture; Pi is the
independent host. These tests need no model account or key.

`real Pi print/JSON mode refuses addition because nobody can be asked`
runs Pi with `--mode json -p`. It checks the refusal, the absence of
`mcp.json`, and the absence of requests to the MCP endpoint.

`RPC: secret header stays a reference in mcp.json; Pi expands it only when
connecting` checks that the saved headers equal the plan, that the test
secret is absent from the file and question, and that Pi sends its value
in the header on `initialize`.

Checked in Pi 1.6.0 against neon.com's published catalog. Not checked there:
a tool call on the added server.

Not checked:

- S-3's live card comparison, negotiation of each older protocol revision,
  or protection against the final name-write race and private DNS results.
- The selector's appearance in Pi's terminal UI: the tests answer the
  question through RPC. OAuth sign-in and a public server with secret
  headers.
- An upstream conformance pass. `modelcontextprotocol/conformance` at
  `96a6f9478b` has no Server Card scenarios.
