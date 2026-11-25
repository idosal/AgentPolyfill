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

A polyfill implements the client side of one published extension inside one
host that has not shipped it, and does nothing once the host supports the
extension itself. The extension is an MCP extension, or a spec for agents
published outside MCP, such as ARD. Each one is a folder in the repository.

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
  opencode/      the OpenCode adapter
  copilot/       the GitHub Copilot CLI adapter
```

- `<extension>` is the extension's short name: `apps`, `events`, `skills`,
  `server-cards`, `ard`.
- `core/` holds what does not depend on the host; each host folder holds its
  adapter. Events and Skills use this layout. Apps has no Pi or OpenCode
  form. Skills and Apps have no Copilot form: Copilot has them built in.

Inside an adapter's folder, the installable form goes in a subfolder (`mod/`
in the Apps polyfill, `extension/` in Pi, `plugin/` in OpenCode and Copilot
CLI), holding the host's manifest and only what it runs; tests, build
scripts, benchmarks and design notes go beside it. The folder is self-contained, so code from
`core/` reaches it by bundling, never by an import from outside it.
Installation differs by host:

- **Claude Code:** copies only the plugin folder.
- **Codex:** copies only the plugin folder.
- **Pi:** the Git install clones the repository under `~/.pi/agent/git/`
  and loads the three extensions from there. A local install loads
  `extension/` where it is, so that clone must stay. The folder holds a
  manifest and one bundled file, with nothing for the user to build.
- **OpenCode:** loads `plugin/` itself, fetched from GitHub by the folder's
  path (`opencode plugin add`, with Git) or from a clone's folder named in
  `plugins` in `opencode.json`. The folder holds one bundled file,
  `server.js`, and a small `package.json` that names it, plus licence notices
  where the bundle holds other packages' code (the Events and Skills forms).
- **Copilot CLI:** loads a plugin from a local marketplace where it is,
  without copying it, so the clone must stay. From a marketplace on GitHub,
  Copilot keeps its own copy.

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
- **Pi:** lead with `pi install git:github.com/idosal/AgentPolyfill`, which
  installs Events, Skills and Server Cards together. Keep the clone path,
  `pi install ./polyfills/<extension>/pi/extension`, as the alternative for
  one form. ARD is installed separately from a clone because its search
  sends your request's words to a registry after asking each time, the same
  reason it is left out of the Claude Code bundle. State Pi 1.6.0 as the
  tested version and Node 22 or newer as the requirement. Nothing for Pi is
  published to npm or Pi's package gallery. Document
  `pi update --extensions` for installed packages and
  `pi remove git:github.com/idosal/AgentPolyfill` to remove all three and
  Pi's repository copy. For a local install, use
  `pi remove ./polyfills/<extension>/pi/extension` from the same clone.
  Use one way per form: repository addresses and local paths identify
  separate packages, so installing both loads a form twice. Removal leaves
  `mcp-events/` and `mcp-skills/` in Pi's agent folder and added servers in
  `mcp.json`. [Getting started](./getting-started#pi) has the steps,
  including one run without installing.
- **OpenCode:**
  `opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/<extension>/opencode/plugin'`,
  removed with `opencode plugin remove` and the same text. State OpenCode
  2.4 as the requirement and 2.4.1 as the tested version; OpenCode runs the
  plugin, so no Node. Nothing is published to npm. Give the clone's form too,
  the folder in `plugins` in `opencode.json`, and say what stays after
  removal. [Getting started](./getting-started#opencode) has the tested
  steps; `tools/opencode/install-check.ts` repeats the install from GitHub in
  a throwaway home.
- **Copilot CLI:** `copilot plugin marketplace add idosal/AgentPolyfill`,
  then `copilot plugin install <plugin>@agent-polyfill`. Until the plugin is
  on the repository's default branch, the tested install is from a clone:
  `copilot plugin marketplace add ./AgentPolyfill`. Say if it needs
  experimental mode (every Copilot extension does).
  [Getting started](./getting-started#github-copilot-cli) has the tested
  steps.

### 4. List it for its host

- **Claude Code:** add an entry to `.claude-plugin/marketplace.json`, add the
  plugin's name to the `dependencies` of the `agent-polyfill` plugin and to
  the list in its README (CI fails until the two lists match).
- **Codex:** add an entry to `.agents/plugins/marketplace.json` (a `local`
  source with the plugin folder's path).
- **Pi:** add `./polyfills/<extension>/pi/extension/dist/index.js` to the
  root `package.json`'s `pi.extensions` to include a new form in the
  one-line install. ARD is left out on purpose because of its registry
  search. Keep the local `extension/` install path documented too. None of
  these forms is published to npm or Pi's package gallery.
- **OpenCode:** there is no marketplace file and no bundle. Each plugin is
  installed from GitHub by its folder's path, so the install line in its
  README is its listing. Nothing is published to npm.
- **Copilot CLI:** add an entry to `.github/plugin/marketplace.json`, which
  Copilot reads before `.claude-plugin/marketplace.json`. Keep its `version`
  equal to the plugin's.

Then add it to the polyfills table in the repository's README, in its host's
column.

### 5. Add its CI

Every push and pull request runs the repository checks: valid manifests,
`claude plugin validate` for the marketplace and every plugin, and the bundle
depending on every polyfill. Add the polyfill's own tests as a workflow in
`.github/workflows/`, filtered to its folder, named by host:

- **Claude Code:** `<plugin>-test.yml`.
- **Codex:** `codex-<extension>-test.yml`.
- **Pi:** `pi-<extension>-test.yml`.
- **OpenCode:** `opencode-<extension>-test.yml`. It runs the form's tests in
  a real OpenCode, the release pinned in `tools/opencode`, in a throwaway
  home with a scripted stand-in for a model, on Linux, macOS and Windows,
  and checks that the committed `plugin/server.js` is what its sources build.
- **Copilot CLI:** `copilot-<extension>-test.yml`.

A polyfill that ships built files also gets a release workflow, run on its
own tags, `<plugin>-v<version>`.

### 6. Before you open the pull request

For a Claude Code form, validate its marketplace and plugin:

```bash
claude plugin validate .
claude plugin validate polyfills/<extension>/<host>/<plugin subfolder>
```

For an OpenCode form, run `npm run check` in its folder: it fails when the
committed `plugin/server.js` isn't what the sources build.

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

- **Claude Code:** a mod in `claude-code/` (Events has one; Skills doesn't,
  because Claude Code lists served skills itself).
- **Codex:** a plugin in `codex/`.
- **Pi:** an extension in `pi/`, with the installable bundle in `extension/`.
- **OpenCode:** a V2 server plugin in `opencode/`, with the bundle in
  `plugin/`.
- **Copilot CLI:** a plugin in `copilot/`, installed from `plugin/` (Events
  has one; Skills doesn't, because Copilot has Skills built in).

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
