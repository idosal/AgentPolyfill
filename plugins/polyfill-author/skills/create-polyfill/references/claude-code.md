# Polyfills in Claude Code

What a polyfill can reach from inside Claude Code, and how existing ones are
laid out. This was checked against the mod API types for Claude Code 2.1.330.
The mod API is early access, so check each row against the types for the
installed version before relying on it (the `plugin-authoring` skill names the
file).

A polyfill is a mod: a hooks module that runs inside Claude Code, and usually
one helper process, because a hooks module has no network or process of its
own.

| Need | In a mod |
|---|---|
| Tools the model calls | `$.tool.register`, answered by a hook on the tool |
| Wake an idle session with something that arrived | `$.prompt.submit` |
| Add a catalog to the session's instructions | a `prompt.compose` hook |
| Call a server's tool with Claude Code's sign-in | `$.mcp.call(server, tool, args)` |
| Ask whether Claude Code would use a server (approved, enabled, allowed by policy) | `$.mcp.connect(server)`; use its verdict instead of reading config and policy files |
| Read a resource with Claude Code's sign-in | `$.tool.call` on `ReadMcpResourceTool` / `ListMcpResourcesTool` (no `_meta`) |
| Any other MCP method, the server's capabilities, notifications | not over Claude Code's connection: the helper's own connection |

Layout that two polyfills have converged on: `hooks/hooks.json`,
`hooks/register.ts`, `hooks/tools.ts`, `src/helper.ts` and the protocol client
beside it, bundled into `dist/` so an installed copy needs no install step,
`.claude-plugin/plugin.json`. Check it with `claude plugin validate .` and
`claude plugin test .`.
