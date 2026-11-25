# mcp-resource-links for Codex

When an MCP tool's result links to a resource (a `resource_link`), Codex can
now read it so the model sees it: text as text, and images as images. The
plugin reads the link through Codex, from the server whose tool returned it,
and asks you before reading it from any other server.

Claude Code handles resource links itself, so there is no Claude Code form.
[Its page](../claude-code/README.md) says what it does.

It implements the client side of resource links in tool results, from the
core MCP spec: **MCP 2025-11-25, Server > Tools > Tool Result > Resource
Links**, which reads the same as 2025-06-18. Resource links aren't an
extension, so there's no SEP. The host-neutral rules are in
[`../core`](../core/), and the reasoning is in [`../DESIGN.md`](../DESIGN.md).

## Why

Codex shows the model every resource link a tool returns, and its own
`read_mcp_resource` reads text links well. Images are the problem.
`read_mcp_resource` hands an image back as a base64 string inside JSON. The
model sees the picture only if it works out, in code mode, how to turn that
string into an image. Measured on Codex 0.172.0
([findings](../docs/findings.md)):

| Model | Linked image, Codex alone | With this plugin ([recorded](live/runs/proof/)) |
|---|---|---|
| gpt-6.2-sol (the default) | seen in 3 of 3 runs | seen: blue left half, yellow right half |
| gpt-5.6-sol | not seen; it fell back to another tool | seen: blue left, yellow right (it put the split at a third) |
| gpt-6-luna | not seen; it described a chart that isn't there | the image reaches it, but it described only pale yellow |

In each run with the plugin, Codex's session record shows the image given to
the model in the tool's output. How well a model then reads a picture is the
model's.

With the plugin, the image comes back as an MCP `image` block, which Codex
gives the model as an image. Codex's reader also tells the model it can only
read URIs that `list_mcp_resources` lists. The spec says linked resources
need not be listed, and in one run the model gave up because of it. The
plugin's tool says otherwise.

## Install

```bash
codex plugin marketplace add idosal/AgentPolyfill
```

```bash
codex plugin add mcp-resource-links@agent-polyfill
```

Then start Codex. Codex says **Hooks need review**: the plugin brings one
hook, which notes the links tools return. Choose **Review hooks**, select the
`PostToolUse` hook from `mcp-resource-links`, and press `t` to trust it. You
can do it later in `/hooks`. Until you trust it, the plugin can't see links,
and its tool says so.

You need:

- **Codex 0.172.0 or newer**, the version it was tested on.
- **Node 20 or newer** on your `PATH`, which runs the plugin's server and its
  hook.

There's nothing to configure per server.

To run it from a clone of this repository instead, add the clone as a
marketplace (`codex plugin marketplace add <clone>`). It also works without
installing from a marketplace: the recorded run below installs it from a
copy of [`mod/`](mod/).

## Try it

Any server whose tools return resource links works. To see it with the test
server from this repository (Node 22.18 or newer):

```bash
codex mcp add docs -- node <clone>/polyfills/resource-links/core/test/fixture-links-server.ts
```

Then ask Codex:

> Use the docs server's image_link tool and tell me what the chart looks like.

Codex calls `image_link`, which returns a link to a PNG, then
`read_resource_link`, and describes a chart split into blue and yellow
halves.

## How it works

1. **A tool returns a link.** After every MCP tool call, Codex runs the
   plugin's `PostToolUse` hook with the call's result. The hook notes each
   `resource_link` in it (server, tool, URI, name, type, size, audience) for
   that session. It returns nothing, so the result reaches the model
   unchanged.
2. **The model wants it.** It calls `read_resource_link` with the server and
   the URI. The tool checks the session's notes:
   - a link that server's tool returned: read, with nothing asked;
   - a link another server's tool returned: **you're asked** first;
   - a link marked for you only (`audience: ["user"]`): not read, and the
     model is told why;
   - anything else: refused.
3. **Codex reads it.** The plugin asks Codex's app server
   (`mcpServer/resource/read`). In the terminal UI and the desktop app,
   sessions run in Codex's app-server daemon, and the read uses the session's
   own connection to the server. Under `codex exec` there's no daemon session
   to use, so the plugin starts `codex app-server` and Codex opens a fresh
   connection for the read. Either way it's Codex's configuration and sign-in
   (OAuth included). The plugin never sees a credential.
4. **The model gets it**: text with a line naming its server and URI, images
   as image content, anything else described in one line.

In code mode the model passes an image block on with `image()`, which
Codex's own instructions tell it to do for MCP images.

### What you're asked

| When | Question |
|---|---|
| Once, when Codex starts after you install or update the plugin | Codex's own: trust the plugin's hook |
| The model reads a link from a different server than the one whose tool returned it | The plugin's, through Codex: "The MCP server docs returned a link to `fixture://other/note.txt`. Codex wants to read it from other, a different server. Read it from other?" with **Don't read it** first |

Reading a link from the server that returned it asks nothing, as Codex's own
`read_mcp_resource` asks nothing. The tool is marked read-only, and Codex's
approval settings decide the rest. Under `codex exec`, Codex declines every
question, so cross-server links aren't read there.

### Where it writes

`$CODEX_HOME/mcp-resource-links/` (`~/.codex/mcp-resource-links/`): the links
noted per session (`sessions/`, kept 7 days) and a log of what was noted,
read, refused or asked. No contents are kept.

## Settings

Environment variables, read by the plugin's server and its hook:

| Variable | Default | What it does |
|---|---|---|
| `MCP_RESOURCE_LINKS_DISABLED` | unset | `1` turns the plugin off: no tool listed, nothing noted |
| `MCP_RESOURCE_LINKS_STATE` | `$CODEX_HOME/mcp-resource-links` | Where notes and the log go |
| `CODEX_CLI_PATH` | `codex` on `PATH`, then the usual install places | Which `codex` to start for `codex app-server` |

### When Codex supports this itself

Codex has no flag that says its reader returns images as images, so the
plugin can't tell. When Codex does, turn the plugin off
(`MCP_RESOURCE_LINKS_DISABLED=1`) or uninstall it. Don't run both.

## Limits

- **Codex's own reader is still there.** The model may call
  `read_mcp_resource` for a link and get the base64 string, as before. The
  plugin's tool description and instructions point it to
  `read_resource_link` for links, and in every recorded run it went there. The
  plugin can't change `read_mcp_resource`.
- **Under `codex exec`, a read opens a new connection.** A resource that lives
  only inside one connection to a local (stdio) server, made by the tool call
  and kept in memory, can't be read there. In the terminal UI and the desktop
  app, the session's own connection is used.
- **The hook must be trusted.** Until it is, no link is read.
- **Plugin hooks in the desktop app** run only for a plugin installed there by
  hand ([host changes](../../../docs/host-changes.md)). Not tested in the
  desktop app.
- **Content for you only isn't shown to you either.** The model is told it's
  there and where, but no plugin can put a document in front of you in Codex.
- **Subscriptions.** The spec says a linked resource "can be subscribed to".
  The plugin doesn't subscribe.
- **Server names with `__`** are read wrongly from the tool's name
  (`mcp__<server>__<tool>`), and their links are refused.
- **Images**: PNG, JPEG, GIF and WebP, up to 5 MiB. Text: 200,000 characters.

## Security

The short version: a link is the server's output, so the plugin reads only
links a tool returned in your session, from the server that returned them
unless you say otherwise, and never anything a server marked for you only.
Codex does the reading with its own sign-in, and the plugin answers no
question for you. [SECURITY.md](SECURITY.md) has the rest, with a threat
table.

## Spec and conformance

The spec puts no MUST or SHOULD on a client about resource links. What the
plugin follows, and where:

| Spec text (2025-11-25) | What the plugin does | Test |
|---|---|---|
| A link "can be … fetched by the client" | Reads it with `resources/read`, through Codex | `mcp-test.ts` |
| A link has `uri`, `name`, and optional `mimeType`, `size`, `annotations` | Notes those; skips blocks without `uri` and `name` | `links-test.ts` |
| Links "are not guaranteed to appear in … `resources/list`" | Reads unlisted links | `mcp-test.ts`: "a link to an unlisted resource" |
| Annotations: `audience` is who the resource is for | A link without `"assistant"` isn't given to the model | `links-test.ts`, `mcp-test.ts` |
| Clients SHOULD "validate tool results before passing to LLM" | Type and size checks, origin line, one-line server text | `links-test.ts` |
| Clients SHOULD "prompt for user confirmation on sensitive operations" | Asks before a cross-server read | `mcp-test.ts`, live run |

### A recorded session

[`live/runs/proof/`](live/runs/proof/), made by
[`live/take-proof.sh`](live/take-proof.sh) on Codex 0.172.0 (macOS), in a
throwaway Codex home, with the fixture server as `docs` and `other`. That run
was made with the Codex sign-in file copied into the throwaway home. The
script no longer does that: it has you sign in there yourself
([how](live/README.md#signing-in)).

| Screen | What happens |
|---|---|
| [`00-hooks-need-review`](live/runs/proof/00-hooks-need-review.txt), [`01-the-plugins-hook`](live/runs/proof/01-the-plugins-hook.txt), [`02-trusted`](live/runs/proof/02-trusted.txt) | Codex asks to review the plugin's hook; it's trusted |
| [`03-image`](live/runs/proof/03-image.txt) | `image_link`, then `read_resource_link`: "Returned image", and the model describes the blue and yellow halves |
| [`04-text`](live/runs/proof/04-text.txt) | `text_link`, then the report's secret word, read from the link |
| [`05-question`](live/runs/proof/05-question.txt), [`06-choose-read-it`](live/runs/proof/06-choose-read-it.txt), [`07-cross-server`](live/runs/proof/07-cross-server.txt) | `peer_link` links to the other server's note; the plugin's question, "Read it", and the note |
| `exec-image-*.txt`, [`session-records.txt`](live/runs/proof/session-records.txt) | `codex exec` on three models: each reads the link with `read_resource_link`, and Codex's session record shows an image in the tool output given to the model |
| [`exec-peer.txt`](live/runs/proof/exec-peer.txt) | `codex exec`, cross-server: Codex declines the question, nothing is read |
| [`exec-unlinked.txt`](live/runs/proof/exec-unlinked.txt) | `codex exec`, a URI no tool returned: refused |
| [`mcp-resource-links.log`](live/runs/proof/mcp-resource-links.log) | The plugin's log: each link noted, each read and through which connection |

### Tests

```bash
npm ci && npm run typecheck && npm test
```

Tests run against the fixture server and a stand-in for Codex's app server
([`test/fake-app-server.ts`](test/fake-app-server.ts)), over stdio and as the
daemon on a Unix socket. The hook is tested as Codex runs it, on the built
bundle.

## Development

The plugin folder is [`mod/`](mod/): its manifest, `.mcp.json`, the hook's
`hooks/hooks.json`, and `dist/`, built from [`src/`](src/) and
[`../core/src/`](../core/src/) by `npm run build`. `dist/` is committed, and a
test fails when it's stale. The bundle has no third-party packages
([`mod/THIRD_PARTY_LICENSES.txt`](mod/THIRD_PARTY_LICENSES.txt)).

| File | What it is |
|---|---|
| [`src/hook.ts`](src/hook.ts) | The `PostToolUse` hook |
| [`src/helper.ts`](src/helper.ts), [`src/mcp.ts`](src/mcp.ts) | The MCP server and `read_resource_link` |
| [`src/app.ts`](src/app.ts) | The tool's steps: session, rules, question, read |
| [`src/appserver.ts`](src/appserver.ts) | Codex's app server, through the daemon or over stdio |
| [`src/notes.ts`](src/notes.ts) | The per-session notes |

## Licence

Apache-2.0, like the rest of the repository.
