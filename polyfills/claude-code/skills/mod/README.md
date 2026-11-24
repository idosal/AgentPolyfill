# mcp-skills

The client side of the MCP Skills extension (SEP-2640) for Claude Code. Skills
served by your MCP servers appear in Claude's skill listing; Claude loads one
when a task needs it, after you approve that skill once, and every file is
checked against the server's manifest. `/mcp-skills` lists what your servers
serve.

Needs Claude Code 2.1.329 or newer, and Node 20 or newer (or Bun) on your PATH.
It does not reach servers behind Claude Code's OAuth sign-in.

Setup, settings, limits and security:
https://github.com/idosal/MCPolyfill/tree/main/polyfills/claude-code/skills

Licence: Apache-2.0. The bundled helper's third-party licences are in
`THIRD_PARTY_LICENSES.txt`.
