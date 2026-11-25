# Skills core

The client side of the MCP Skills extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2eb3a8e345aaee53461a3c5c5f6900659d3ecb27/seps/2640-skills-extension.md),
Final) that doesn't depend on a host. The adapters share it:

- [`../codex`](../codex/): `mcp-skills` for Codex, a plugin;
- [`../pi`](../pi/): `mcp-skills` for Pi, an extension;
- [`../opencode`](../opencode/): `mcp-skills` for OpenCode, a plugin.

| File | What it is |
|---|---|
| [`src/skills.ts`](src/skills.ts) | The extension's logic and nothing else: which servers may be asked, what a valid entry is, what is verified and when, what a loaded skill may read, and the held entry. It does no I/O of its own: it talks to a server through the `Wire` interface. |
| [`src/wire.ts`](src/wire.ts) | A connection of the polyfill's own to one MCP server (MCP SDK 2.4.0), bounded and patient. It reports the capabilities exactly as the server sent them. Each adapter says which client it is. |
| [`src/untrusted.ts`](src/untrusted.ts) | Errors in the polyfill's own words, one-line server text, and secret scrubbing. |
| [`src/upstream.ts`](src/upstream.ts) | How to reach a server, as an adapter read it from its host's configuration. |
| [`docs/sep-2640-client-rules.md`](docs/sep-2640-client-rules.md) | Every client rule of SEP-2640 with its id and text. Each adapter's `docs/conformance.md` says, by these ids, what that adapter does about each one. |
| [`test-fixtures/`](test-fixtures/) | What the adapters' tests share: a Skills server written by hand from the SEP, which shares no code with `src/` and serves whatever a scenario file says ([`fixture-skills-server.ts`](test-fixtures/fixture-skills-server.ts)), and builders for skills with correct digests ([`harness.ts`](test-fixtures/harness.ts)). They import nothing that needs installing. |

Nothing here is installed on its own. Each adapter's build bundles `src/` into
that adapter's plugin folder, which then runs with no imports from outside it.
The rules are tested through the adapters (`npm test` in the Codex and Pi
folders goes through them rule by rule; OpenCode's tests run the bundled
plugin in OpenCode), against the hand-written server in `test-fixtures/`.

Until November 2026 there was a fourth adapter, for Claude Code. It was
removed when Claude Code began listing skills from MCP servers itself;
[`polyfills/claude-code/skills`](../../claude-code/skills/README.md) says
what moved here from it.

```bash
npm ci
npm run typecheck
```
