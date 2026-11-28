# ARD domain discovery for Muse Code

Install from a checkout of this branch. From the repository root, run

```sh
muse plugins install "$PWD/polyfills/ard/codex/plugin"
muse plugins approve ard-discovery
```

Start a fresh Muse session in a trusted workspace. Ask which MCP server a known domain publishes and select a remote. Muse shows the endpoint, headers and a quoted `muse mcp add` command. Review and run that command yourself. Supply credentials through Muse. Remove a connection with `muse mcp remove <name>` and remove the plugin with `muse plugins remove ard-discovery`.

This plugin reads a known domain’s ARD v0.91 directory and ARD page links alongside the AI Catalog. Registry search is outside this adapter’s scope.

The bundle lives beside the Codex bundle and has its own Muse manifest. Development uses `npm ci` in the matching Codex folder and `npm test` here. See the [host setup and evidence](../../../docs/muse-grok.md), [conformance notes](docs/conformance.md) and [security model](SECURITY.md).
