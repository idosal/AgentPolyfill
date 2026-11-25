# Security

This covers `mcp-resource-links` for Codex. Claude Code needs no plugin for
resource links, so there is no Claude Code form to secure. Its page says why:
[SECURITY.md](../claude-code/SECURITY.md).

A resource link is something an MCP server put in a tool's result. The
plugin reads what the link points at and gives it to a model that can run
commands on your machine. So a link gets no more trust than the server that
sent it, and Codex's own approvals stay the boundary. This page says what the
plugin assumes, what it does, and what it doesn't protect against. The design
is in [`../DESIGN.md`](../DESIGN.md).

## What is trusted

- **You**, and your Codex config. The plugin reads only through Codex, so only
  servers Codex itself would use, with the sign-in Codex holds.
- **Codex**: its hook review, how it shows the plugin's question and returns
  your answer, its app server, and its approvals for everything the model
  does.
- **Not the servers.** A link, its name and description, its annotations and
  the contents behind it are the server's to choose.

## What the plugin does

### What it can see

Its hook sees each tool call's result after the call, as every `PostToolUse`
hook does. From an MCP tool's result it keeps only the `resource_link`
blocks: the server, the tool, the URI, and the link's `name`, `mimeType`,
`size` and `audience`. It prints nothing, so it can't change what the model
sees. It skips every tool that isn't an MCP tool, and its own.

Codex runs the hook only after you trust it. Codex asks you to review it when
it starts after the plugin is installed or changed ("Hooks need review"), or
in `/hooks`. Until you do, the plugin notes nothing and reads nothing.

### What it reads, and from where

`read_resource_link {server, uri}` reads a resource only when a tool returned
a link to that exact URI **in the same Codex session**, as the hook noted it.
Codex names the session in each tool call (`x-codex-turn-metadata`). A call
without a session is refused.

- **From the server whose tool returned it**: read with nothing asked, as Codex
  reads a resource with its own `read_mcp_resource`.
- **From another server**: the plugin asks you first, each time, through Codex
  (an MCP elicitation, "Don't read it" first). Under `codex exec` nobody can
  be asked and Codex declines, so nothing is read.
- **Marked for the user only** (`annotations.audience` without `"assistant"`):
  not read. The model is told the server meant it for you, and where it is.
- **A URI no tool returned as a link** (in text, made up, or from another
  session): refused.

The read is Codex's. The plugin sends `mcpServer/resource/read` to Codex's
app-server daemon with the session's thread, so Codex uses that session's
connection. Where the daemon doesn't have the session (`codex exec`), it
sends it to a `codex app-server` it starts, without a thread, and Codex
opens a connection of its own for the read. The plugin connects to no MCP
server itself and never sees a credential. It doesn't read Codex's stored
credentials, its session records, or any file but its own notes.

### What reaches the model

- Text, cut at 200,000 characters, after a line naming the server and URI and
  saying the content is the server's data, not instructions.
- PNG, JPEG, GIF and WebP images up to 5 MiB, as image content, only when the
  bytes begin as that format does. An SVG isn't shown (it's a document a
  browser runs, not an image here).
- Other types: one line with the type and size, not the bytes.
- At most 8 contents of one read.

Nothing the plugin returns is a resource link, and `resources/read` returns
contents, never content blocks. So reading one link can't hand the model
another to follow. A new read needs a new link from a tool.

Wherever the plugin quotes server text in its own words (a URI or server name
in a question, an error), it's cut to one line, with control, zero-width and
direction characters removed.

### What you're asked, and when

| When | Asked by | Question |
|---|---|---|
| Once, after installing or updating the plugin | Codex | Review and trust the plugin's hook |
| A link read from a different server than the one that returned it | the plugin, through Codex | "The MCP server A returned a link to `<uri>`. Codex wants to read it from B, a different server. Read it from B?" |
| Running `read_resource_link` | Codex, by your approval settings | The tool is marked read-only (`readOnlyHint`), so in Codex's default mode it runs without asking, as `read_mcp_resource` does |

The plugin answers no question for you, and doesn't change how Codex approves
any tool. Its app-server client answers every request Codex's app server
sends it (an approval, a question) with an error ("mcp-resource-links does
not answer this"), so nothing is decided in your place there either.

### What is kept

- `$CODEX_HOME/mcp-resource-links/sessions/<session id>.jsonl`: the links noted
  in each session, at most 500 per session, removed 7 days after the session's
  last link. Folder `0700`, files `0600`.
- `$CODEX_HOME/mcp-resource-links/mcp-resource-links.log`: what was noted,
  read, refused or asked, with URIs and server names. No contents.

Uninstalling the plugin leaves that folder (checked with `codex plugin
remove` on Codex 0.172.0). Delete it to remove the notes and the log.

## Threats

| | Threat | What stops it | Tested in |
|---|---|---|---|
| T1 | A server's link makes the model read another server's resource (a note on your mail server, say) without you knowing | A cross-server read is a question to you, each time; declined, unanswerable and `codex exec` all mean no | `mcp-test.ts`: "only when the person says Read it", "Don't read it … nothing is read"; live: [`runs/proof`](live/runs/proof/) |
| T2 | The model is talked into reading a URI no tool linked to, through the plugin | Only URIs a tool returned as a `resource_link` in this session are read | `links-test.ts`, `mcp-test.ts`: "a URI no tool returned is refused"; live: [`exec-unlinked`](live/runs/proof/exec-unlinked.txt) |
| T3 | Links from one session are used in another | Notes are per session, keyed by Codex's session id; a call must carry one | `mcp-test.ts`: "links noted in another session don't count", "a call without a session id" |
| T4 | A session id from Codex is used as a path (`../`) | Only `[A-Za-z0-9_-]{1,128}` is used as a file name | `hook-test.ts`: "a session id that is not a plain id" |
| T5 | Content a server meant only for you reaches the model | A link whose audience leaves out `"assistant"` isn't read | `links-test.ts`, `mcp-test.ts`: "marked for the user only" |
| T6 | A read chains into more reads without end | The plugin's results hold no links, and read results can't hold content blocks | `links-test.ts`: "nothing in what the model is given is a resource link" |
| T7 | A huge resource fills the model's context or the plugin's memory | Text cut at 200,000 characters, images over 5 MiB not shown, 8 contents per read, 500 links per session, 64 MiB hook input, 64 MiB frames from the daemon | `links-test.ts`, `hook-test.ts` |
| T8 | A server labels a file `image/png` to get other bytes shown as an image, or sends an SVG | The first bytes must be the format's; only PNG, JPEG, GIF, WebP | `links-test.ts`: "bytes are not its type", "JPEG, GIF and WebP" |
| T9 | Text in a link or URI poses as the plugin's own words (new lines, direction marks) in the question or a refusal | Server text there is one cleaned, bounded line; contents come after a line naming their origin | `links-test.ts`: "one bounded line" |
| T10 | The hook changes or blocks a tool's result | It prints nothing and always exits 0 | `hook-test.ts` |
| T11 | The plugin's credentials or a connection of its own widen what a server gets | There are none. The plugin connects to no MCP server: Codex reads, with its own connection and sign-in (the session's connection on the daemon; under `codex exec`, a connection Codex opens for the read) | `appserver-test.ts`: only `initialize`, `initialized` and `mcpServer/resource/read` are sent, with the session's thread on the daemon; `no-credentials-test.ts`: no code names a credential store |
| T12 | The plugin answers an approval in your place on Codex's app server | Every request from the app server is answered with an error, never a result | `appserver-test.ts`: "a question from Codex's app server (an approval) is answered with an error" |

## What it does not protect against

- **Codex's own reader.** The model can still call `read_mcp_resource` with
  any server and URI, and Codex reads it with nothing asked. That's how Codex
  works with or without the plugin. The plugin can't remove it or put rules on
  it. The cross-server question protects only reads made through the plugin.
- **A server that serves harmful content from its own resources.** Reading a
  link from the server that sent it is no question, as in Codex. What the
  content says is that server's.
- **A local process that can reach Codex's app-server socket** can drive
  every session, with or without the plugin (see
  [Host changes](../../../docs/host-changes.md)). The plugin uses the socket
  only to read, and only for the session that called it.
- **Notes written by something else.** Any program running as you can write
  into `$CODEX_HOME/mcp-resource-links`, as it can into `~/.codex` itself.
- **Server names that contain `__`.** The hook takes the server from
  `mcp__<server>__<tool>`, up to the first `__`. Such a server's links are
  noted under the wrong name and then refused. They're never read from a
  server that didn't send them.

## Reporting a problem

See the repository's [SECURITY.md](../../../SECURITY.md).
