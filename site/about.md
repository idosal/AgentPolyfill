---
description: Who makes AgentPolyfill, its licence, and what it is not affiliated with.
aside: false
---

# About

AgentPolyfill is a community project by
[Ido Salomon](https://github.com/idosal): polyfills for agent protocols. They
bring more of MCP to the clients you already use, before those clients
support it. Today that's four MCP extensions and one open draft beyond MCP.
What runs in each host:

- **Claude Code:** Events, Server Cards, Apps and ARD. Skills needs no
  polyfill there: Claude Code lists skills from MCP servers itself, in beta
  from 2.1.332.
- **Codex:** Events, Skills, Server Cards and ARD.
- **Pi:** Events, Skills, Server Cards and ARD, as Pi extensions. Apps has no
  Pi form.
- **OpenCode:** Events, Skills, Server Cards and ARD, as OpenCode plugins.
  Apps has no OpenCode form.
- **Antigravity:** Events, Skills, Server Cards and ARD, as Antigravity
  plugins. Apps has no Antigravity form: the App renders MCP Apps itself.

See [Getting started](/guide/getting-started) for installation. In Pi,
`pi install git:github.com/idosal/AgentPolyfill` installs Events, Skills and
Server Cards together. A clone is the alternative for one form, and the way
to install ARD separately: its search sends your request's words to a registry
after asking each time, so it is left out as it is from the Claude Code bundle.
Nothing for Pi is published to npm or Pi's package gallery.
Nothing for OpenCode is published to npm either; OpenCode installs each plugin
from the repository on GitHub, with Git.
Nothing is published to Antigravity's Marketplace either; its plugins install
from a clone, with the Antigravity CLI (the App doesn't ship `agy`).

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
