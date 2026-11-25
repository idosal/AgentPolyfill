# Conformance: resource links, for Codex

This Codex plugin implements the client side of resource links in tool
results, from the core MCP spec: **MCP 2025-11-25, Server > Tools > Tool
Result > Resource Links**, which reads the same as 2025-06-18. The spec is
pinned at commit `9850cae` of
[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol).
Resource links are part of the core spec, not an extension, so there is no
SEP and no extension identifier to declare.

The spec puts no MUST or SHOULD on a client about resource links themselves.
The rows below are every statement in the spec that bears on what a client
does with a `resource_link`: the section itself, the resource annotations it
points to, `resources/read`, and the client SHOULDs in Tools > Security
Considerations. Each is **met**, **not applicable**, or an **exception**
with the reason. Rules L-1 to L-6 come from the Resource Links section and
the annotations; S-1 to S-6 from the security considerations.

**Links** means [`links-test.ts`](../test/links-test.ts), **MCP** means
[`mcp-test.ts`](../test/mcp-test.ts), **hook** means
[`hook-test.ts`](../test/hook-test.ts), **reader** means
[`appserver-test.ts`](../test/appserver-test.ts). The live runs are in
[`live/runs/`](../live/runs/).

| Rule | Spec text | Status | How | Tests |
|---|---|---|---|---|
| L-1 | A tool returns "a URI that can be … fetched by the client" | met | `read_resource_link {server, uri}` fetches it with `resources/read`, sent by Codex's own app server (`mcpServer/resource/read`). | MCP: "a text link a tool of the same server returned is read"; reader: all; live: [`proof/03-image`](../live/runs/proof/03-image.txt), [`04-text`](../live/runs/proof/04-text.txt) |
| L-2 | A link has `type: "resource_link"`, `uri` and `name`, and optional `title`, `description`, `mimeType`, `size` and annotations | met | The hook keeps blocks of that shape (string `uri` and `name`) and skips the rest. It notes `uri`, `name`, `mimeType`, `size` and `audience`; the model already sees the whole block in Codex. | Links: "linksIn keeps only blocks of the spec shape" |
| L-3 | Links "are not guaranteed to appear in the results of a `resources/list` request" | met | A link is read whether or not the server lists it. The tool's `uri` parameter says it "need not be one list_mcp_resources lists", because Codex's own `read_mcp_resource` tells the model only listed URIs can be read. | MCP: "a link to an unlisted resource is read" |
| L-4 | A URI "can be subscribed to" | exception | The plugin doesn't subscribe. Codex's app server has no request for a plugin to subscribe over Codex's connection, or to receive `notifications/resources/updated`. Listed as a limit in the [README](../README.md#limits). | none |
| L-5 | Annotations: `audience` is "the intended audience(s) for this resource"; "clients can use these annotations to filter resources based on their intended audience" | met | A link whose `audience` leaves out `"assistant"` isn't read for the model; the model is told the server meant it for the person, and where it is. An invalid `audience` is ignored. Showing the content to the person instead isn't possible from a Codex plugin ([README](../README.md#limits)). | Links: "a link marked for the user only is not given to the model", "keeps a valid audience annotation and drops an invalid one"; MCP: "a link marked for the user only is not read" |
| L-6 | Annotations: `priority` and `lastModified` | not applicable | They are hints. The model sees them in the link Codex shows it; the plugin has nothing to rank or refresh. | none |
| R-1 | `resources/read` returns `contents`, each with `uri` and `text`, or `blob` (base64) | met | The result is checked before use: contents without a `uri`, or with a blob that isn't base64, are left out. Text goes to the model as text; PNG, JPEG, GIF and WebP blobs whose first bytes match go as image blocks; other types are described in one line. | Links: "contentsOf accepts a resources/read result and nothing else", "a blob that is not base64 is left out", "a PNG is given as an image content block", "JPEG, GIF and WebP", "other binary content is described" |
| R-2 | A URI names no server; a link is a server's tool output | met | The plugin reads a link from the server whose tool returned it. Reading it from any other server asks the person first, through Codex (an MCP elicitation, "Don't read it" first). | Links: "a link is read from the server whose tool returned it", "reading a link from another server … is a question"; MCP: "only when the person says Read it", "Don't read it … nothing is read"; live: [`proof/05-question`](../live/runs/proof/05-question.txt) to [`07-cross-server`](../live/runs/proof/07-cross-server.txt), [`exec-peer`](../live/runs/proof/exec-peer.txt) |
| S-1 | Clients SHOULD "prompt for user confirmation on sensitive operations" | met | A cross-server read is put to the person, each time (R-2). A same-server read asks nothing, as Codex's own `read_mcp_resource` asks nothing; the tool is marked read-only and Codex's approval settings decide whether it runs. | as R-2; MCP: "tools/list lists read_resource_link, read-only" |
| S-2 | Clients SHOULD "show tool inputs to the user before calling the server" | met by Codex | Codex shows the `read_resource_link` call and its arguments (server and URI) in the session, as for any tool. | live: [`proof/03-image`](../live/runs/proof/03-image.txt) |
| S-3 | Clients SHOULD "validate tool results before passing to LLM" | met | Only URIs a tool returned as a link in this session are read; contents are checked (R-1); text is cut at 200,000 characters and marked with its server and URI as data; images are capped at 5 MiB, contents at 8 per read; server text in the plugin's own words is one bounded, cleaned line; nothing returned is a link, so reads can't chain. | Links: "text longer than the limit is cut", "an image whose bytes are not its type, or that is too large", "at most LIMITS.contents", "server text … is one bounded line", "nothing in what the model is given is a resource link"; MCP: "a URI no tool returned is refused" |
| S-4 | Clients SHOULD "implement timeouts for tool calls" | met | A read waits at most 60 s for Codex's app server, and `initialize` 20 s; then the model is told the read got no answer. Codex's own timeout applies to the tool call. | Checked in code (`appserver.ts`, `TIMEOUT_MS`); no test waits out the timeout |
| S-5 | Clients SHOULD "log tool usage for audit purposes" | met | `$CODEX_HOME/mcp-resource-links/mcp-resource-links.log` records each link noted, each read (and through which connection), refusal and question, with URIs and server names, never contents. | live: [`proof/mcp-resource-links.log`](../live/runs/proof/mcp-resource-links.log) |
| S-6 | Clients SHOULD provide tool execution errors to language models | met | A failed read is returned as a tool error, with the server's error in one line. | MCP: "a read that fails says so in one line" |

## How it reads

The plugin connects to no MCP server and holds no credential. Codex reads:

- In the terminal UI, the session runs in Codex's app-server daemon. The
  plugin sends `mcpServer/resource/read` there with the session's thread id,
  and Codex reads over that session's own connection to the server.
- Under `codex exec`, the daemon doesn't have the session. The plugin starts
  `codex app-server` and sends the read without a thread; Codex opens a
  connection of its own for it, with its own configuration and sign-in. A
  resource that exists only inside the session's connection to a local server
  can't be read there.
- The Codex desktop app wasn't tested.

Reader tests: "when the daemon has the session, the read goes there with the
session's thread id", "when the daemon doesn't have the session (codex exec),
the read falls back to a stdio app server", and "only `initialize`,
`initialized` and `mcpServer/resource/read` are sent".

## Switching it off

`MCP_RESOURCE_LINKS_DISABLED=1` lists no tool and notes nothing (hook:
"MCP_RESOURCE_LINKS_DISABLED turns the hook off"; MCP: "turned off … no tool
is listed and none runs"). Codex has no flag that says it reads images as
images, so the plugin can't step aside by itself; the
[README](../README.md#when-codex-supports-this-itself) says when to turn it
off.

## What can't be met from a plugin

- **Subscriptions** (L-4), as above.
- **Content for the person only** (L-5) isn't shown to the person.
- **Codex's own reader stays.** The model can still call `read_mcp_resource`,
  which reads any URI from any server with no question and returns images as
  base64 text. The cross-server question covers only reads through the
  plugin. [`docs/host-changes.md`](../../../../docs/host-changes.md#in-codex)
  lists what Codex would change.
