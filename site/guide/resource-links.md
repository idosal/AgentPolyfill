---
description: Resource links are a core MCP feature, a tool result that points at a resource. Claude Code handles them itself. In Codex, mcp-resource-links reads them through Codex so the model sees linked images as images, and asks before reading a link from another server.
---

# Resource links

An MCP tool can answer with a link to a resource instead of the resource
itself: a `resource_link` block with a URI, a name and, often, a MIME type.
The client then reads the resource with `resources/read` when it's needed.
That's part of the core spec, not an extension:
[MCP 2025-11-25, Server > Tools > Tool Result > Resource Links](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#resource-links),
the same text as 2025-06-18. So the polyfill names that spec revision where
the others name a SEP.

What matters is whether the model gets to see what the link points at. Both
hosts were measured with a test server whose tools return links to text, an
image, binary data, a resource on another server, and one marked for the
user only
([findings](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/resource-links/docs/findings.md)):

| | Claude Code 2.1.331 | Codex 0.172.0 |
|---|---|---|
| Linked text | Read, with Claude Code's own tool | Read, with Codex's own tool |
| Linked image | Seen: saved to a file and opened as an image | Handed over as base64 text; whether the model sees it depends on the model |
| A link to another server's resource | Read with nothing asked | Read with nothing asked |
| A link marked for the user only | Read like any other | Read like any other |
| What to install | Nothing | `mcp-resource-links` |

Pi and OpenCode weren't measured.

## Install

::: code-group

```txt [Claude Code]
Nothing to install: Claude Code handles resource links itself.
```

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-resource-links@agent-polyfill
```

:::

### In Codex

Codex 0.172.0 or newer, and Node 20 or newer on your `PATH`. The next time
Codex starts, it says **Hooks need review**: the plugin brings one hook,
which notes the links tools return. Choose **Review hooks**, select the
`PostToolUse` hook from `mcp-resource-links`, and press `t` to trust it, or
do it later in `/hooks`. Until you do, the plugin can't see links, and its
tool says so.

To remove it:

```bash
codex plugin remove mcp-resource-links@agent-polyfill
```

That leaves `$CODEX_HOME/mcp-resource-links/` (`~/.codex/mcp-resource-links/`):
the links noted per session and the plugin's log, with URIs and server names
and no contents. Delete it to remove them. The install, a run of the hook and
the removal were checked in a throwaway Codex home
([run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/resource-links/codex/live/runs/install/install.txt)).

### In Claude Code

There's no plugin. Claude sees each link as a line of text with its name,
URI and description, and reads it with Claude Code's own
`ReadMcpResourceTool`, which is allowed by default. Images are saved to a
file and opened as images. Three things it doesn't do, listed as
[host changes](./how-it-works) rather than worked around:

- It drops the link's MIME type, size and annotations from what Claude sees.
- It reads a resource the server marked for the user only.
- It reads a link to another server's resource without asking.

## Try it

With the test server from a clone of the repository (Node 22.18 or newer):

```bash
codex mcp add docs -- node <clone>/polyfills/resource-links/core/test/fixture-links-server.ts
```

Then ask:

> Use the docs server's image_link tool and tell me what the chart looks like.

Codex calls `image_link`, which returns a link to a PNG, then
`read_resource_link`, and describes a chart split into blue and yellow
halves. The same works in Claude Code with `claude mcp add` and no plugin.

## How it works in Codex

1. **A tool returns a link.** After every MCP tool call, Codex runs the
   plugin's hook with the result. The hook notes each `resource_link` for
   that session and prints nothing, so the result reaches the model as it
   was.
2. **The model wants it.** It calls `read_resource_link` with the server and
   the URI. A link that server's tool returned is read with nothing asked. A
   link another server's tool returned is a question to you first. A link
   marked for you only isn't read, and the model is told why. Anything else
   is refused.
3. **Codex reads it.** The plugin sends `mcpServer/resource/read` to Codex's
   app server. In the terminal UI that uses the session's own connection to
   the server. Under `codex exec` Codex opens a connection of its own for the
   read. Either way it's Codex's configuration and sign-in, OAuth included;
   the plugin never sees a credential and connects to no server itself.
4. **The model gets it**: text as text, marked with its server and URI as
   data; PNG, JPEG, GIF and WebP as images; anything else described in one
   line.

### What you're asked

| When | Question |
|---|---|
| Once, when Codex starts after you install or update the plugin | Codex's own: trust the plugin's hook |
| The model reads a link from a different server than the one whose tool returned it | "The MCP server docs returned a link to `fixture://other/note.txt`. Codex wants to read it from other, a different server. Read it from other?", with **Don't read it** first |

Under `codex exec`, Codex declines every question, so cross-server links
aren't read there.

## Settings

| Variable | What it does |
|---|---|
| `MCP_RESOURCE_LINKS_DISABLED=1` | Turns the plugin off: no tool listed, nothing noted |
| `MCP_RESOURCE_LINKS_STATE` | Where the notes and the log go (default `$CODEX_HOME/mcp-resource-links`) |
| `CODEX_CLI_PATH` | Which `codex` to start for `codex app-server` |

## Limits

- **Codex's own reader is still there.** The model can still call
  `read_mcp_resource` and get the base64 string, and Codex reads any URI from
  any server through it with nothing asked. In every recorded run the model
  used the plugin's tool for links.
- **Under `codex exec`, a read opens a new connection,** so a resource that
  lives only inside the session's connection to a local server can't be read.
- **Content for you only isn't shown to you.** The model is told it's there;
  no plugin can put it in front of you in Codex.
- **No subscriptions.** The plugin doesn't subscribe to linked resources.
- **The desktop app wasn't tested.**

## Security

A link is the server's output, so the plugin reads only links a tool returned
in your session, from the server that returned them unless you say
otherwise, and never anything a server marked for you only. It answers no
question for you, and reads no credential: Codex does the reading. The
[Codex `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/resource-links/codex/SECURITY.md)
has the threat table, and the
[conformance table](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/resource-links/codex/docs/conformance.md)
has each spec rule and its test.

## When Codex supports this itself

Codex has no flag that says its reader returns images as images, so the
plugin can't tell. When it does, remove the plugin or set
`MCP_RESOURCE_LINKS_DISABLED=1`.

## More

- [Codex form](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/resource-links/codex)
- [Claude Code: why nothing is installed](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/resource-links/claude-code)
- [Design](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/resource-links/DESIGN.md)
