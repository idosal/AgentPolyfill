# Security

There's no Claude Code form of the resource-links polyfill, so nothing from
it runs in Claude Code. Claude Code reads resource links itself
([README](README.md)).

What that means for you, as measured on Claude Code 2.1.331
([findings](../docs/findings.md)):

| | What a server can do with a link today | What decides it |
|---|---|---|
| 1 | Point Claude at another connected server's resource, which Claude then reads with no question | Claude Code's permission for `ReadMcpResourceTool`, which is allowed by default. To be asked, add an `ask` rule for `ReadMcpResourceTool` in your settings |
| 2 | Mark a resource for you only (`audience: ["user"]`) and still have Claude read it | Nothing: Claude Code drops the annotation |
| 3 | Link to a very large resource | Claude Code saves it to a file and shows Claude a 2 KB preview |
| 4 | Link to a binary file | Claude Code saves it to a file. Opening it takes a command, which goes through your permissions for that command |

None of these needs a mod to fix. Each is a host change, listed in
[`docs/host-changes.md`](../../../docs/host-changes.md). The Codex form, which
does run, has its own [SECURITY.md](../codex/SECURITY.md).

## Reporting a problem

See the repository's [SECURITY.md](../../../SECURITY.md).
