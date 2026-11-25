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
skill walks an agent through building one to that contract. In Claude Code,
install the authoring plugin:

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

If what you want is not in any spec, the `design-extension` skill in the same
plugin covers that case: a polyfill never adds behaviour of its own.

### 2. Put it in its folder

Each extension has one folder, with an adapter and installable form for each
host it supports:

```
polyfills/<extension>/
  core/          the host-neutral logic and its tests of the spec's rules
  claude-code/   the Claude Code adapter
  codex/         the Codex adapter
  pi/            the Pi adapter
  antigravity/   the Antigravity adapter
```

- `<extension>` is the extension's short name: `apps`, `events`, `skills`,
  `server-cards`, `ard`.
- `core/` holds what does not depend on the host; each host folder holds its
  adapter. Events and Skills use this layout. Apps has no Pi form, and no
  Antigravity form: the Antigravity App renders MCP Apps itself.

Inside an adapter's folder, the installable form goes in a subfolder (`mod/`
in the Apps polyfill, `extension/` in Pi, `plugin/` in Antigravity), holding
the host's manifest and only what it runs; tests, build scripts, benchmarks
and design notes go beside it. The folder is self-contained, so code from `core/` reaches it by
bundling, never by an import from outside it. Installation differs by host:

- **Claude Code:** copies only the plugin folder.
- **Codex:** copies only the plugin folder.
- **Pi:** loads `extension/` from its local path; it is not copied. The
  folder holds a manifest and one bundled file, with nothing for the user
  to build. The clone must stay in place.
- **Antigravity:** `agy plugin install` copies `plugin/` to
  `~/.gemini/config/plugins/<name>`, which the App and the CLI both read.
  The folder holds the MCP server (`mcp_config.json`) and the hooks
  (`hooks.json`).

One plugin folder can carry both `.claude-plugin/plugin.json` and
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
- **Requirements, install and use:** the tested install steps first, then
  every step and question a new user meets before the extension works,
  with what happens when they say no. Include how to disable and uninstall it,
  and what data remains.
- **Privacy and security:** what it sends where, and what it stores.

Install instructions depend on the host:

- **Claude Code:** `/plugin install <plugin> --marketplace idosal/AgentPolyfill`.
- **Codex:** `codex plugin marketplace add idosal/AgentPolyfill && codex plugin add <plugin>@agent-polyfill`.
- **Pi:** clone the repository, then
  `pi install ./polyfills/<extension>/pi/extension`. State Pi 1.6.0 as the
  tested version and Node 22 or newer as the requirement. Nothing for Pi is
  published to npm or Pi's package gallery; don't offer a package install.
  [Getting started](./getting-started#pi) has the tested steps.
- **Antigravity:** clone the repository, then
  `agy plugin install ./polyfills/<extension>/antigravity/plugin`. State
  Node 20 or newer on `PATH` as the requirement, and the App and CLI versions
  it was run with. Nothing is published to Antigravity's Marketplace.
  [Getting started](./getting-started#antigravity) has the steps.

### 4. List it for its host

- **Claude Code:** add an entry to `.claude-plugin/marketplace.json`, add the
  plugin's name to the `dependencies` of the `agent-polyfill` plugin and to
  the list in its README (CI fails until the two lists match).
- **Codex:** add an entry to `.agents/plugins/marketplace.json` (a `local`
  source with the plugin folder's path).
- **Pi:** document the local `extension/` install path. There is no Pi
  bundle, and none of these forms is published to npm or Pi's package
  gallery.
- **Antigravity:** document the local `plugin/` install path and
  `agy plugin uninstall <plugin>`. None of these forms is published to
  Antigravity's Marketplace.

Then add it to the polyfills table in the repository's README, in its host's
column.

### 5. Add its CI

Every push and pull request runs the repository checks: valid manifests,
`claude plugin validate` for the marketplace and every plugin, and the bundle
depending on every polyfill. Add the polyfill's own tests as
`.github/workflows/<plugin>-test.yml`, filtered to its folder. A polyfill that
ships built files also gets a release workflow, run on its own tags,
`<plugin>-v<version>`.

### 6. Before you open the pull request

For a Claude Code form, validate its marketplace and plugin:

```bash
claude plugin validate .
claude plugin validate polyfills/<extension>/<host>/<plugin subfolder>
```

Run the polyfill's tests, and do one recorded run in the real host against a
server you did not write. Say in the pull request what you ran and what you saw.
Keep a live run separate from tests with a scripted model. For example, Pi's
ARD live run showed discovery and registry-search approval but did not
complete an addition; its add flow is covered by real-Pi tests with a
scripted model and a local server.

The full text, with the marketplace entry's format and the workflow files to
copy, is
[`CONTRIBUTING.md`](https://github.com/idosal/AgentPolyfill/blob/main/CONTRIBUTING.md).

## Bringing a polyfill to another host

An extension keeps one folder and one polyfill name; each host gets an adapter
beside the others. Events and Skills share one `core/`, with these forms:

- **Claude Code:** a mod in `claude-code/`.
- **Codex:** a plugin in `codex/`.
- **Pi:** an extension in `pi/`, with the installable bundle in `extension/`.
- **Antigravity:** a plugin in `antigravity/`, with the installable folder in
  `plugin/`.

1. **Find the host's way in.** What can third-party code do there: run code
   inside the host or beside it, call tools, ask the user, start a turn in an
   idle session? [How it works](./how-it-works) lists each host's APIs. Each
   wire need of the extension is reached one of those ways, or it is a limit,
   written down with the host change that would remove it. The
   `create-polyfill` skill walks through this for a named host.
2. **Share the core.** If the host-neutral logic still lives inside the first
   host's adapter, move it into `polyfills/<extension>/core/` first, with its
   rule tests, in its own pull request.
3. **Write the adapter** in `polyfills/<extension>/<host>/`: a self-contained
   installable folder with that host's manifest, `core/` bundled into it,
   the host's own tests beside it.
4. **Meet the contract in that host:** its own README with that host's install
   steps, requirements, limits and stand-down, its own `SECURITY.md`, and a
   recorded run in the real host against a server you did not write.
5. **Document installation** for that host and list it in its marketplace
   file where one is used. Add its CI and add it to the README's table in that
   host's column. Say plainly where a form is not published.

## Listing a polyfill in the community directory

A polyfill you build and keep in your own repository can be listed without
moving its code: a pull request that adds one entry to
[`community/polyfills.json`](https://github.com/idosal/AgentPolyfill/blob/main/community/polyfills.json). The
[Community](./community) page shows the list, and
[`community/README.md`](https://github.com/idosal/AgentPolyfill/blob/main/community/README.md) has the fields and
the rules. Listed polyfills are not reviewed, built or shipped by this project.
