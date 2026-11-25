# ard-discovery for Pi

Pi finds MCP servers through Agentic Resource Discovery (ARD): in what a
domain lists, or by asking a registry for a server that can do a task. You
choose the registry, and Pi asks before every search and every addition.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md). All three use the same ARD registry client and
Server Cards modules.

> Search the registry I named for an MCP server that can check why my CI build failed.

**Search sends your query to a third party.** No registry is configured by
default. Name one in your request or set `ARD_DISCOVERY_REGISTRY`. The
extension never supplies a registry on your behalf. With neither, it refuses
the search and asks Pi to ask you which registry to use.

ARD is a draft, not an MCP specification. This form implements its consumer
side for MCP Server Cards only. Each card is checked; a result counts as
confirmed only when the publisher's own catalog lists it. The registry's
ranking is relevance, not trust.

## Install

Install ARD on its own from a clone. It is left out of
`pi install git:github.com/idosal/AgentPolyfill`, which installs Events,
Skills and Server Cards together. The reason is the same as for the Claude
Code bundle: ARD's search sends the words of your request to a registry
after asking you each time.

Nothing is published to npm or Pi's package gallery. You need **Pi 1.6.0**,
the version it was tested with, and **Node 22 or newer**, which Pi needs
anyway:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/ard/pi/extension
```

Or, to try it for one run without installing:

```bash
pi -e ./polyfills/ard/pi/extension
```

The extension is one folder, [`extension/`](extension/): a manifest and one
bundled file, with nothing to build or install alongside it. Pi loads it from
where it is, so keep the clone; `git pull` in it brings the next version.

To remove it, run `pi remove ./polyfills/ard/pi/extension` from the same
folder. Servers you added stay in `mcp.json`;
remove one with `pi mcp remove <name>`.

This form includes Server Cards checking and adding; it needs no other
polyfill installed, and it works beside the Server Cards Pi form. Its add tool
is `ard_add_mcp_server`: Pi's tool names are shared by every extension (Pi
keeps the first tool registered under a name), and the Server Cards form's is
`add_mcp_server`.

## Try it

Ask Pi “What does buildkite.com list in its ard.json?”, then ask it to add
the server. Read the question and choose **Add it**. If the server needs
sign-in, use `/mcp` or `pi mcp login <name>`.

To try a registry without sending the query off your machine, run the
repository's [demo registry](../claude-code/README.md#demo-registry):

```bash
node polyfills/ard/claude-code/demo/registry.mjs
```

Then ask Pi to search `http://127.0.0.1:9011` for a server that can check a CI
build. The query stays local; fetching public result cards and checking their
publishers still makes public GET requests. Public examples depend on what
publishers currently serve. The automated Pi tests use a fully local fixture.

## How it works

| Tool | What it does |
|---|---|
| `ard_discover(domain)` | Reads `/.well-known/ard.json`, `rel="ard"` links and AI Catalog sources. Fetches and checks their Server Cards. Read-only. |
| `ard_search(query, registry?)` | Asks you, then posts the exact query to your chosen registry and follows bounded referrals. Checks result cards and publisher catalogs. Read-only, but discloses the query. |
| `ard_add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Asks you, then saves and registers a server shown by either tool in this session. |

### Discovery and search

A domain lookup uses plain GET requests and sends no task query. An ARD
manifest needs no `specVersion`. A registry named by domain is resolved
through that domain's catalogs first, so the question can name the exact
search endpoints. Those preliminary GETs carry no query text.

Before each search, Pi shows a `ctx.ui.select` question such as:

```text
registry.example: send this search to https://registry.example/search, and to up to three registries it refers to?
Query: "check why my CI build failed"
A registry is a service someone else runs, and it sees the query.

Don't send it
Send the search
```

Only **Send the search** sends. Decline, close, cancellation, a different
answer or no UI sends nothing. Print and JSON modes refuse; an RPC client
relays the question. Pi has no universal tool-call approval prompt: this
question supplies consent, and tool annotations let permission extensions
apply their own gates.

The query is trimmed, then shown and sent in full: one line, at most 300
characters, with no invisible characters, direction marks, backticks, angle
brackets or square brackets. A registry setting or argument is at most 200
characters and contains no whitespace, control characters, invisible
characters or direction marks.
The question shows the normalized endpoint URL that will actually be used.

The POST filters for Server Cards and requests `federation: "referrals"`.
At most three initial registries and three referrals are asked, one hop.
Each result names the registries contacted. A redirect cannot send the POST
to another origin or turn it into a GET.

The extension reads each result's card and, for up to five publishers, the
publisher's own catalogs. A confirmed publisher card is the one shown and
added. Otherwise the result and add question say **NOT confirmed by its
publisher's own catalog**. Scores are never treated as authorization.

### Adding a result

Adding uses exactly the [Server Cards Pi flow](../../server-cards/pi/README.md#how-it-works):
a separate question names the host, URL, headers, user `mcp.json` file and
`pi mcp remove <name>` undo command. Only **Add it** runs Pi's own `mcp add`.
Names already present are refused before and after consent. The new server
is registered with Pi for the current session immediately after saving.

Use `domain` for a domain discovery result; omit it for a registry result.
The card must have been shown in this session and the URL must match its
checked plan. Non-secret inputs go in `values`. Secret headers use generated
`${VAR}` references, never literal secrets; the result tells you which
variables to set where Pi starts. OAuth stays with Pi, through `/mcp` or
`pi mcp login <name>`.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_DISABLED` | unset | `1`, `true`, `on` or `yes` registers no tools and fetches nothing. |
| `ARD_DISCOVERY_REGISTRY` | unset | The registry you choose. A tool call can explicitly name another. Every search still asks. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's configuration directory; additions go to its `mcp.json`. |

This form has its own stand-down setting; `MCP_SERVER_CARDS_DISABLED` controls
the separate Server Cards form. There is no reliable automatic native ARD
support detector. Remove this form or disable it when Pi supports ARD itself.

## Limits

- ARD v0.91 is a draft outside MCP. Only MCP Server Cards are supported;
  other resource types are ignored. Spec and schema changes require an update.
- Search is neither private from the chosen registry nor an endorsement of
  its results. Referrals also see the query, as the consent question says.
- A query cannot be recalled once sent. Cancellation after sending cannot
  undo the request.
- The [Server Cards Pi limits](../../server-cards/pi/README.md#limits) apply:
  no live card comparison, no SSE or URL secrets, no command-valued headers,
  DNS resolution not checked for private addresses, and no atomic CLI
  add-if-absent. Each needs support in the host or fetch adapter to close it.
- Session state is not persisted. After a new, resumed, forked or reloaded
  session, show the card again before adding.

## Security

[SECURITY.md](SECURITY.md) describes the query disclosure and trust boundary.
Every search and every addition has its own question. No stored credential
is read, no registry is preselected, and cards never authorize anything.

## Spec and conformance

This form follows the same pinned revisions as the other ARD forms:

- [ARD v0.91](https://github.com/ards-project/ard-spec/tree/f073b1ea9b),
  commit `f073b1ea9b`: §5.1 domain discovery, §5.3 registry search and
  Appendix B error codes, for MCP Server Cards.
- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final; ext-server-card commit `28db12c9b4`; AI Catalog v0.9 release
  candidate at `19208af2f8`, as detailed in the
  [Server Cards form](../../server-cards/pi/README.md#spec-and-conformance).

Each rule, how it is met on Pi and where it is tested, is in
[`docs/conformance.md`](docs/conformance.md). The shared rules are the same
code and tests as in the other forms, run here against the committed Pi
bundle: ARD's 12 registry tests and the Server Cards core's 90. The Pi
form's own tests cover the search question (the exact query and registry,
no default registry, no UI), hidden characters, a registry's text, the
separate add question and the Server Cards Pi adapter's checks. Real Pi RPC
tests use an isolated agent folder and a local server for both well-known
catalogs, a card, a registry search endpoint and MCP.

[`docs/live-run.md`](docs/live-run.md) records a run in Pi 1.6.0 with a real
model, reading buildkite.com's `ard.json`, and a registry search against the
repository's demo registry that the extension asked about, naming the registry
and the exact query, before anything was sent. ARD is not an MCP extension,
and the MCP conformance suite has no ARD scenarios.

## Development

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.1/bin:$PATH
npm run build
npm run typecheck
npm test
```

`src/index.ts` registers ARD's tools. It imports the registry client from
`../claude-code/mod/hooks`, the card core from `../../server-cards/claude-code`,
and the Pi add adapter from `../../server-cards/pi/src`. `build.mjs` bundles
them into `extension/dist/index.js`. No host-neutral logic is copied.

`test/pi-rpc.ts` and `test/brain.ts` come from the Events Pi form, with
temporary state confined to `test/.tmp`. The test command also runs the
Server Cards Pi adapter tests against ARD's own bundle. Tests need loopback
listening permission. Rebuild after changing source; tests never silently
refresh the shipping bundle.

Apache-2.0. This is a community project, independent of the host and spec authors.
