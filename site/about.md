---
description: Who makes AgentPolyfill, its licence, and what it is not affiliated with.
aside: false
---

# About

AgentPolyfill is a community project by
[Ido Salomon](https://github.com/idosal): polyfills for agent protocols. They
bring more of MCP to the clients you already use, before those clients
support it. Today that's four MCP extensions, one core MCP feature (resource
links) and one open draft beyond MCP. What runs in each host:

- **Claude Code:** Events, Skills, Server Cards, Apps and ARD. Resource links
  need nothing: Claude Code handles them itself.
- **Codex:** Events, Skills, Server Cards, ARD and resource links.
- **Pi:** Events, Skills, Server Cards and ARD, as Pi extensions. Apps has no
  Pi form.
- **OpenCode:** Events, Skills, Server Cards and ARD, as OpenCode plugins.
  Apps has no OpenCode form.

See [Getting started](/guide/getting-started) for installation. Nothing for Pi
is published to npm or Pi's package gallery; install from a repository clone.
Nothing for OpenCode is published to npm either; OpenCode installs each plugin
from the repository on GitHub, with Git.

## Not affiliated

AgentPolyfill isn't part of the MCP specification, and it isn't affiliated
with or endorsed by the MCP project, the Agentic AI Foundation, the Linux
Foundation, Anthropic, OpenAI or any other host vendor, or the authors of
Agentic Resource Discovery. The author works in the MCP Apps working group;
this isn't working-group output.

Model Context Protocol and MCP are trademarks of LF Projects, LLC. Claude and
Claude Code are trademarks of Anthropic, PBC. OpenAI and Codex are trademarks
of OpenAI.

## Licence

Apache-2.0. See
[LICENSE](https://github.com/idosal/AgentPolyfill/blob/main/LICENSE). Each
polyfill that ships third-party code includes its notices in its folder.

## Source

The plugins and extensions, their docs and this site are in one repository:
[github.com/idosal/AgentPolyfill](https://github.com/idosal/AgentPolyfill). This
site is built with VitePress from the `site/` folder, from the repository's own
READMEs, with a launch video and one recording per polyfill made for the site.

## Contact

Problems and questions:
[open an issue](https://github.com/idosal/AgentPolyfill/issues). Security
problems: see [Security](/guide/security).
