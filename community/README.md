# Community directory

Polyfills that other people build and keep in their own repositories, listed
here so you can find them. Each entry points at its author's repository. The
code isn't copied here, and this project doesn't review, build or ship it.
Listed polyfills aren't in this repository's marketplaces or in the
`agent-polyfill` bundle or Pi's one-line install. Follow its author's
install instructions, whether from a marketplace, a Git repository or a local
clone.

The list is [`polyfills.json`](polyfills.json). It is also shown on
[agentpolyfill.com/guide/community](https://agentpolyfill.com/guide/community).

## Adding yours

Open a pull request that adds one object to the `polyfills` array:

```json
{
  "name": "mcp-example",
  "extension": "Example",
  "id": "io.modelcontextprotocol/example",
  "spec": "SEP-0000, Final",
  "specUrl": "https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/0000-example.md",
  "hosts": ["Claude Code"],
  "summary": "What it lets the agent do, in one sentence.",
  "repository": "https://github.com/you/mcp-example",
  "install": "/plugin install mcp-example --marketplace you/mcp-example",
  "maintainer": "you",
  "contract": {
    "clientRules": "tested",
    "otherServer": true,
    "standDown": "setting",
    "limits": true
  }
}
```

- **`name`**: the plugin's name. It must be unique in this list and not one of
  this repository's.
- **`extension`**, **`id`** (optional), **`spec`** and **`specUrl`**: the
  extension it implements, its identifier, and the exact spec revision, with a
  link to it.
- **`hosts`**: an array naming each host it runs in. Examples:

  | Host | Value |
  |---|---|
  | Claude Code | `"Claude Code"` |
  | Codex | `"Codex"` |
  | Pi | `"Pi"` |
  | OpenCode | `"OpenCode"` |
  | Muse Code | `"Muse Code"` |

  Other hosts are welcome too.
- **`summary`**: one plain sentence.
- **`repository`** and **`install`**: where it lives, and the command or steps
  that install it. For a Pi extension, give its tested `pi install` command;
  if it needs a clone, include the clone steps and local path. For an
  OpenCode plugin, give the `opencode plugin add` line, or the folder to put
  in `plugins` in `opencode.json`. For a Muse Code plugin, give its
  marketplace and the `muse plugins install` and `muse plugins approve`
  lines. The repository's README states the spec revision, its limits and
  what it sends where.
- **`maintainer`**: your GitHub handle.
- **`contract`**: where it stands on this project's
  [contract](../docs/polyfill-contract.md), as you state it:
  - `clientRules`: `"tested"` (a test for each client rule), `"partial"`, or
    `"no"`;
  - `otherServer`: whether it was run against a server its author didn't
    write;
  - `standDown`: `"detects"` (it detects native support), `"setting"` (a
    setting turns it off), or `"no"`;
  - `limits`: whether its README says what it can't do in each host.

Entries stay in the order they were added. The site's build checks each one
for these fields.

This repository's Pi forms are in `polyfills/<polyfill>/pi/`, with the
installable extension in `extension/`. They cover Events, Skills, Server
Cards and ARD; Apps has no Pi form.
`pi install git:github.com/idosal/AgentPolyfill` installs Events, Skills and
Server Cards together. A clone is the alternative for one form, and the
way to install ARD: its search sends the words of your request to a registry
after asking each time, so it is left out of the one-line install as it is
from the Claude Code bundle. Nothing for Pi here is published to npm or
Pi's package gallery. The [root README](../README.md#install) has the steps.

This repository's OpenCode forms are in `polyfills/<polyfill>/opencode/`,
with the installable plugin in `plugin/`. They cover Events, Skills, Server
Cards and ARD; Apps has no OpenCode form. Nothing for OpenCode here is
published to npm: `opencode plugin add` installs each one from GitHub. The
[root README](../README.md#install) has the tested install lines.

This repository's Muse Code forms are the Codex plugin folders, each with a
`.muse-plugin/plugin.json`. Their docs are in `polyfills/<polyfill>/muse/`.
They cover Events, Skills, Server Cards and ARD; Apps has no Muse form. Muse
installs them from this repository's marketplace with
`muse plugins install <name>@agent-polyfill`, then `muse plugins approve
<name>`.

## What gets listed

- It implements the client side of a published extension, in a host that
  hasn't shipped it. The extension can be an MCP extension or an open draft
  such as Agentic Resource Discovery. A gateway, a fork of an extension, or a
  vendor addition isn't a polyfill.
- Its repository is public, with a licence and a README a newcomer can follow.
- It doesn't ask for, read or send credentials it doesn't need.

A listing can be removed if the repository goes away, stops matching its
entry, or is reported as harmful. Report a harmful one privately, through this
repository's Security tab.

## Moving into this repository

A listed polyfill that meets the whole [contract](../docs/polyfill-contract.md)
can be proposed for `polyfills/` by opening an issue.
[`CONTRIBUTING.md`](../CONTRIBUTING.md) says what that takes.
