# Resource links in Claude Code

There's no plugin to install. Claude Code already handles resource links in
tool results, so this polyfill stands aside here, as the
[contract](../../../docs/polyfill-contract.md) says a polyfill must when the
host supports the feature.

For Codex, which doesn't show linked images to the model reliably, there's
[mcp-resource-links for Codex](../codex/README.md).

## What Claude Code does

Measured on Claude Code 2.1.331 against a test server whose tools return
resource links ([findings](../docs/findings.md), with each run kept in
[`../probe/runs/before/`](../probe/runs/before/)):

- **Claude sees the link**, as a line of text: `[Resource link: report.txt]
  fixture://docs/report.txt (The full text of the report)`. That gives the
  name, URI and description.
- **Claude reads it** with Claude Code's own `ReadMcpResourceTool`, naming the
  server from the tool it called (`mcp__docs__…`). Text comes back as text.
  Links to resources the server doesn't list work too.
- **Images work.** The read saves the image to a file and says where, and
  Claude opens it with `Read`, which shows it as an image. In the recorded run
  ([`claude-image_link-plain-request.txt`](../probe/runs/before/claude-image_link-plain-request.txt))
  Claude described the test chart's two colours and where they are.
- **Binary files** are saved to a file, which Claude can open with a command
  if it needs to.
- **Large resources** are saved to a file with a 2 KB preview.
- **Missing resources** fail with "Resource not found".

## What it doesn't do

These are host behaviour, so they're listed as host changes in
[`docs/host-changes.md`](../../../docs/host-changes.md), not worked around
with a mod:

- **The MIME type, size, title and annotations are dropped** from what Claude
  sees of the link. Claude doesn't know a link is an image, or how large it
  is, until it reads it. Hooks and the transcript keep the whole link
  (`tool_use_result.resourceLinks`).
- **`audience: ["user"]` isn't honoured.** Claude never sees the annotation,
  and reads the resource like any other.
- **A link to another server's resource is read with nothing asked.** In the
  test, server `docs` returned a link to a note on server `other`, and Claude
  read it from `other`. `ReadMcpResourceTool` is allowed by default.

A mod could rewrite the text of the link, or ask before a cross-server read,
but it would be a second handler for something Claude Code already handles,
and the two could disagree. If Claude Code drops one of these behaviours, or
the gap grows, this is the place for a mod.

## Try it

With the test server from this repository (Node 22.18 or newer):

```bash
claude mcp add docs -- node <clone>/polyfills/resource-links/core/test/fixture-links-server.ts
```

> Use the docs server's image_link tool and tell me what the chart looks like.

[`../probe/run.sh`](../probe/run.sh) repeats the measurements for both hosts,
in throwaway configurations.
