---
description: How to report a problem, add a new polyfill or bring one to another host, and list your own in the community directory.
---

# Contributing

Bug reports, fixes, new polyfills and existing polyfills brought to another
host are welcome. For a bug or a question,
[open an issue](https://github.com/idosal/AgentPolyfill/issues) and name the
polyfill it concerns. For anything larger than a fix, open an issue first, so
the design can be agreed before the work. For a security problem, see
[Security](./security) instead. A polyfill you keep in your own repository can be
listed in the [community directory](#listing-a-polyfill-in-the-community-directory).

## Adding a polyfill

A polyfill implements the client side of one published MCP extension inside one
host that has not shipped it, and does nothing once the host supports the
extension itself. Each one is a folder in the repository.

### 1. Meet the contract

Every polyfill meets [the contract](./build-a-polyfill#the-contract): one
published extension and nothing else, a named spec revision, a test for each
client rule plus a run against a server someone else wrote, a stand-down, stated
limits, and server content treated as untrusted data. The `create-polyfill`
skill walks an agent through building one to that contract:

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

If what you want is not in any spec, the `design-extension` skill in the same
plugin covers that case: a polyfill never adds behaviour of its own.

### 2. Put it in its folder

Each extension has one folder, and one plugin that serves every host it
supports:

```
polyfills/<extension>/
  core/          the host-neutral logic and its tests of the spec's rules
  claude-code/   the Claude Code adapter
  codex/         the Codex adapter
```

- `<extension>` is the extension's short name: `apps`, `events`, `skills`,
  `server-cards`, `ard`.
- `core/` holds what does not depend on the host; `claude-code/` and `codex/`
  each hold the adapter for that host.

Inside an adapter's folder, the installable plugin goes in a subfolder (`mod/`
in the Apps polyfill), holding the host's manifest and only what the plugin
runs; tests, build scripts, benchmarks and design notes go beside it. The
plugin folder is self-contained: Claude Code and Codex copy only that folder,
so code from `core/` reaches it by bundling, never by an import from outside
it. One plugin folder can carry both `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json`. The plugin's name is unique in the repository, and
an extension keeps one name in every host. No large files in git: nothing over
about 1 MB unless the plugin or its tests cannot work without it. The repository
is Apache-2.0, and so is every contribution; keep the notices of third-party
code the polyfill ships in a `THIRD_PARTY_LICENSES.txt` in its folder.

### 3. Write its README

For someone who has never seen the repository:

- **The extension:** its identifier, the spec's name and revision, and a link.
- **The client rules:** a checklist with one row for each rule the spec puts on
  a client (each MUST and SHOULD), the test that covers it, and its state.
- **Stand-down:** how it detects native support, or, until it can, the setting
  that turns it off.
- **Limits:** what it cannot do on this host, and for each limit the host change
  that would remove it (added to `docs/host-changes.md` too).
- **Requirements, install and use:** the one-line install first (in Claude
  Code `/plugin install <plugin> --marketplace idosal/AgentPolyfill`; in Codex
  `codex plugin marketplace add idosal/AgentPolyfill && codex plugin add <plugin>@agent-polyfill`), then every
  step and question a new user meets between that line and the extension
  working, with what happens when they say no.
- **Privacy and security:** what it sends where, and what it stores.

### 4. Add it to the marketplace

Each host has its own marketplace file. For Claude Code, add an entry to
`.claude-plugin/marketplace.json`, add the plugin's name to the `dependencies`
of the `agent-polyfill` plugin and to the list in its README (CI fails until the
two lists match). For Codex, add an entry to `.agents/plugins/marketplace.json`
(a `local` source with the plugin folder's path). Then add it to the polyfills
table in the repository's README, in its host's column.

### 5. Add its CI

Every push and pull request runs the repository checks: valid manifests,
`claude plugin validate` for the marketplace and every plugin, and the bundle
depending on every polyfill. Add the polyfill's own tests as
`.github/workflows/<plugin>-test.yml`, filtered to its folder. A polyfill that
ships built files also gets a release workflow, run on its own tags,
`<plugin>-v<version>`.

### 6. Before you open the pull request

```bash
claude plugin validate .
claude plugin validate polyfills/<extension>/<host>/<plugin subfolder>
```

Run the polyfill's tests, and do one recorded run in the real host against a
server you did not write. Say in the pull request what you ran and what you saw.

The full text, with the marketplace entry's format and the workflow files to
copy, is
[`CONTRIBUTING.md`](https://github.com/idosal/AgentPolyfill/blob/main/CONTRIBUTING.md).

## Bringing a polyfill to another host

An extension keeps one folder and one plugin name; each host gets an adapter
beside the others. Events and Skills are the examples: one `core/`, a
`claude-code/` mod and a `codex/` plugin.

1. **Find the host's way in.** What can third-party code do there: run code
   inside the host or beside it (Claude Code mods; a Codex plugin's MCP server
   and skills), call tools, ask the user, start a turn in an idle session? Each
   wire need of the extension is reached one of those ways, or it is a limit,
   written down with the host change that would remove it. The
   `create-polyfill` skill walks through this for a named host.
2. **Share the core.** If the host-neutral logic still lives inside the first
   host's adapter, move it into `polyfills/<extension>/core/` first, with its
   rule tests, in its own pull request.
3. **Write the adapter** in `polyfills/<extension>/<host>/`: a self-contained
   plugin folder with that host's manifest, `core/` bundled into it, the host's
   own tests beside it.
4. **Meet the contract in that host:** its own README with that host's install
   line, requirements, limits and stand-down, its own `SECURITY.md`, and a
   recorded run in the real host against a server you did not write.
5. **List it** in that host's marketplace file, add its CI, and add it to the
   README's table in that host's column.

## Listing a polyfill in the community directory

A polyfill you build and keep in your own repository can be listed without
moving its code: a pull request that adds one entry to
[`community/polyfills.json`](https://github.com/idosal/AgentPolyfill/blob/main/community/polyfills.json). The
[Community](./community) page shows the list, and
[`community/README.md`](https://github.com/idosal/AgentPolyfill/blob/main/community/README.md) has the fields and
the rules. Listed polyfills are not reviewed, built or shipped by this project.
