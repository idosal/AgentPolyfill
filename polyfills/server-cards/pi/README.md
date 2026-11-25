# mcp-server-cards for Pi

Name a company, and Pi finds the MCP servers its domain publishes. Ask it to
add one, choose **Add it** in Pi's question, and the server goes into Pi's
own MCP configuration and connects in the current session.

Also available for Claude Code, Codex and OpenCode: [mcp-server-cards for Claude Code](../claude-code/README.md), [mcp-server-cards for Codex](../codex/README.md), [mcp-server-cards for OpenCode](../opencode/README.md).
All four use the same card and discovery modules, and all but OpenCode the
same configuration modules.

> What MCP servers does neon.com publish?

Pi reads that domain's catalog, fetches each Server Card it lists, checks
the card against the schema, and tells you what it found. Server Cards are
publishers' claims. A valid card is not a judgement that a server is safe.

Agentic Resource Discovery is a separate form,
[`ard-discovery`](../../ard/pi/README.md), because its registry search sends
your words to a third party.

## Install

Nothing is published to npm or Pi's package gallery yet, so install it from a
clone of this repository. You need **Pi 1.6.0**, the version it was tested
with, and **Node 22 or newer**, which Pi needs anyway:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/server-cards/pi/extension
```

Or, to try it for one run without installing:

```bash
pi -e ./polyfills/server-cards/pi/extension
```

The extension is one folder, [`extension/`](extension/): a manifest and one
bundled file, with nothing to build or install alongside it. Pi loads it from
where it is, so keep the clone; `git pull` in it brings the next version.

To remove it, run `pi remove ./polyfills/server-cards/pi/extension` from the same
folder. Servers you added stay in `mcp.json`;
remove one with `pi mcp remove <name>`.

It works beside the ARD Pi form, which reads AI Catalogs too and names its
own add tool `ard_add_mcp_server` (Pi's tool names are shared by every
extension).

## Try it

Ask Pi “What MCP servers does neon.com publish?”, then “Add Neon Docs”. Read
the question and choose **Add it**. The result gives the server name and its
undo command, such as `pi mcp remove neon-docs`.

For a server that needs sign-in, use Pi's `/mcp` screen or run
`pi mcp login <name>`. This extension never runs sign-in or reads its tokens.
These public examples depend on what those publishers currently serve; the
Pi integration tests use a local publisher and MCP server.

## How it works

1. `discover_mcp_servers(domain)` reads `/.well-known/ai-catalog.json`, follows
   `rel="ai-catalog"` links, and checks every card it finds. It is read-only.
2. Pi shows the server, its remote URL, and any reason a card was refused.
3. `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` resolves
   a card shown in this session. The requested URL must match the card's
   plan. Refused and unseen cards cannot be added.
4. Pi asks with `ctx.ui.select`, with **Don't add it** first:

   ```text
   neon.com: add the MCP server "neon-docs" to Pi?
   It connects to the host neon.com
   URL: https://neon.com/docs/mcp
   Headers: none
   From the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog.
   Written to /Users/you/.pi/agent/mcp.json (all your projects).
   To undo: pi mcp remove neon-docs
   ```

   Only **Add it** adds. Decline, close, cancellation, a different answer or
   a failed dialog writes nothing. Print and JSON modes have nobody to ask,
   so additions are refused. RPC clients relay the dialog to their person.
5. The extension invokes the running Pi's `pi mcp add` through `pi.exec`,
   without a shell. It checks for an existing name before and after the
   question, including the user file, a trusted project's `.pi/mcp.json`,
   and session registrations. Unreadable configuration is refused too.
6. It calls `pi.registerMcpServer` after a successful write. Pi connects in
   the background; its tools become available without `/reload`. A saved
   file entry takes precedence in later sessions. The result distinguishes
   a successful save from a failed session registration.

Pi does not ask permission before every tool call. **This extension's
question is the consent.** Tool annotations identify discovery as read-only
and addition as changing configuration and contacting a server, so permission
extensions can apply their own gates as well.

Secrets are never requested from the model. A secret header is saved as a
generated `${MCP_SERVER__INPUT_TAG}` reference, including headers such as
`Token ${MCP_SERVER__INPUT_TAG}`. The tag is 80 bits of SHA-256 over the card
name and remote URL. The result names the variable for you to set where Pi
starts, then restart Pi. The extension never expands or reads its value.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MCP_SERVER_CARDS_DISABLED` | unset | `1`, `true`, `on` or `yes` registers no tools and fetches nothing. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's user configuration directory. Additions go to its `mcp.json`. |

There is no reliable native Server Card support signal in this adapter.
When Pi supports this extension itself, remove this form or turn it off with
`MCP_SERVER_CARDS_DISABLED=1`. It does not automatically detect native support.

## Limits

- The card is not compared with the live server through `server/discover`
  (S-3). A documented Pi API for sending that request over its MCP connection
  would let this adapter implement the check.
- Pi 1.6.0 supports streamable HTTP, not SSE. SSE-only cards are refused.
  Secret variables inside URLs are refused because Pi expands header values,
  not URLs. Host support would remove those limits.
- Header values beginning with `!` are refused: Pi would execute them as
  commands. Duplicate header names and header markup are refused too.
  The name and header `__proto__` are refused because Pi 1.6.0's CLI cannot
  save them faithfully.
- Only literal private addresses and private host spellings are blocked.
  A public hostname resolving to a private address is not caught. The fetch
  adapter would need address checking during DNS resolution to close this gap.
- Names are checked twice, but Pi's CLI has no atomic “add only if absent”
  operation. Another process could write the same name between the final
  check and Pi's write. An atomic CLI option would remove that race.
- Library hosts without a verifiable running Pi `cli.js` cannot add servers.
  The adapter refuses instead of guessing an executable.
- A replacement MCP extension, disabled built-in MCP, or a failed connection
  can prevent tool availability after registration. Check `/mcp` for status.
- Discovered cards and the cache are forgotten on new, resumed, forked and
  reloaded sessions. Discover again before adding.

## Security

[SECURITY.md](SECURITY.md) describes what is sent, saved and trusted. Reads
use no cookies or credentials. Every addition requires your explicit answer.
The extension never reads `mcp-auth.json` or any stored credential, and it
never executes a command supplied by a card.

## Spec and conformance

This form follows the same pinned revisions as the other Server Cards forms:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final.
- [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card/tree/28db12c9b4),
  commit `28db12c9b4` (2026-11-19), its schema and discovery rules.
- [AI Catalog](https://github.com/Agent-Card/ai-catalog/tree/19208af2f8), v0.9
  release candidate, commit `19208af2f8`.

Each client rule, how it is met on Pi and where it is tested, is in
[`docs/conformance.md`](docs/conformance.md). The shared rules (D-1 to D-9,
V-1 to V-3, C-1 to C-3, S-1 to S-6, I-1 to I-4) are the same code and the
same 90 tests as in the other forms, run here against the committed Pi
bundle; the Pi form's own tests cover the question, Pi's command line and
headers, existing names, cancellation, the session, stand-down, redirects
and body bounds. Real Pi RPC tests run `pi mcp add` for real in an isolated
agent folder, and check what Pi then connects. One rule isn't met, as in the
other forms: S-3, the live comparison of a card with the server.

[`docs/live-run.md`](docs/live-run.md) records a run in Pi 1.6.0 with a real
model, against neon.com's published catalog: Pi listed its servers, the
extension asked before adding Neon Docs, and after "Add it" the server was in
`mcp.json` and connected for the session. The MCP conformance suite has no
Server Card scenarios, so there is no upstream run to report.

## Development

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.1/bin:$PATH
npm run build
npm run typecheck
npm test
```

`src/index.ts` registers the extension, `src/tools.ts` handles session state
and questions, `src/pi.ts` plans and saves Pi entries, and `src/host.ts`
binds the host. `build.mjs` bundles the shared modules by relative import.
`test/` holds unit and real Pi RPC tests; its `brain.ts` and `pi-rpc.ts` come
from the Events Pi form, with temporary files kept under `test/.tmp`.
Tests need permission to listen on loopback. They do not rebuild the shipping
bundle silently: run `npm run build` after source changes.

Apache-2.0. This is a community project, independent of the host and spec authors.
