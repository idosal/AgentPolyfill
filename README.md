Open MCP Apps in Pi’s terminal with `/mcp-app`. The Apps-only Git package installs its renderer dependencies with the extension.

```sh
pi install git:github.com/idosal/AgentPolyfill@pi-mcp-apps-v0.1.0
```

Restart Pi after installation. Use an interactive Node build of Pi 1.6.0, 1.6.1 or 1.7.0 and a local Chrome or Chromium browser. If needed, set `MCP_APPS_CLI_CHROME` to its executable.

Call an MCP tool that returns an app, then run `/mcp-app`. Pi asks before inspecting the app and again before sharing the tool input and result. Review the requested access to open it. The viewer supports terminal images and character-cell rendering.

[Walkthroughs and full-bundle installation](https://github.com/idosal/AgentPolyfill/blob/00d15ea027f43198902ea9d1bdc9dc73810f017f/polyfills/apps/pi/README.md) · [Feature coverage and host limits](https://github.com/idosal/AgentPolyfill/blob/00d15ea027f43198902ea9d1bdc9dc73810f017f/polyfills/apps/pi/COMPLIANCE.md)
