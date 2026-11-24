# Skills core

The host-neutral client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final), shared by the two adapters:

- [`../claude-code`](../claude-code/): the Claude Code mod (`mcp-skills`);
- [`../codex`](../codex/): the Codex plugin (`mcp-skills`).

| File | What it is |
|---|---|
| [`src/skills.ts`](src/skills.ts) | The extension's logic and nothing else: which servers may be asked, what a valid entry is, what is verified and when, what a loaded skill may read, the held entry. No I/O of its own: it talks to a server through the `Wire` interface. |
| [`src/wire.ts`](src/wire.ts) | A connection of the polyfill's own to one MCP server (MCP SDK 2.4.0), bounded and patient, reporting the capabilities exactly as the server sent them. Each adapter says which client it is. |
| [`src/untrusted.ts`](src/untrusted.ts) | Errors in the polyfill's own words, one-line server text, secret scrubbing. |
| [`src/upstream.ts`](src/upstream.ts) | How to reach a server, as an adapter read it from its host's configuration. |

Nothing here is installed on its own: each adapter's build bundles it into
that adapter's plugin folder, which then runs with no imports from outside it.
The rules are tested through each adapter (`npm test` in either), against a
hand-written server that shares no code with this.

```bash
npm ci
npm run typecheck
```
