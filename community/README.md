# Community directory

Polyfills that other people build and keep in their own repositories, listed
here so they can be found. Each entry points at its author's repository: the
code is not copied here, and this project does not review, build or ship it.
Listed polyfills are not in this repository's marketplaces or in the
`agent-polyfill` bundle; you install one from its author's marketplace, with
its author's install line.

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

- **`name`**: the plugin's name, unique in this list and not one of this
  repository's.
- **`extension`**, **`id`** (optional), **`spec`** and **`specUrl`**: the
  extension it implements, its identifier, and the exact spec revision, with a
  link to it.
- **`hosts`**: the hosts it runs in (`"Claude Code"`, `"Codex"`, or another).
- **`summary`**: one plain sentence.
- **`repository`** and **`install`**: where it lives, and the one line that
  installs it. The repository's README states the spec revision, its limits
  and what it sends where.
- **`maintainer`**: your GitHub handle.
- **`contract`**: where it stands on this project's
  [contract](../docs/polyfill-contract.md), as you state it:
  - `clientRules`: `"tested"` (a test for each client rule), `"partial"`, or
    `"no"`;
  - `otherServer`: whether it was run against a server its author did not
    write;
  - `standDown`: `"detects"` (it detects native support), `"setting"` (a
    setting turns it off), or `"no"`;
  - `limits`: whether its README says what it cannot do in each host.

Entries stay in the order they were added. The site's build checks each one
for these fields.

## What gets listed

- It implements the client side of a published extension (an MCP extension,
  or an open draft such as Agentic Resource Discovery), in a host that has
  not shipped it. A gateway, a fork of an extension, or a vendor addition is
  not a polyfill.
- Its repository is public, with a licence and a README a newcomer can follow.
- It does not ask for, read or send credentials it does not need.

A listing can be removed if the repository goes away, stops matching its
entry, or is reported as harmful. Report a harmful one privately through this
repository's Security tab.

## Moving into this repository

A listed polyfill that meets the whole [contract](../docs/polyfill-contract.md)
can be proposed for `polyfills/` by opening an issue.
[`CONTRIBUTING.md`](../CONTRIBUTING.md) says what that takes.
