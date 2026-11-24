# Contributing

Bug reports, fixes, new polyfills and existing polyfills brought to another
host are welcome.

- For a bug or a question, open an issue and name the polyfill, and the host,
  it concerns.
- For anything larger than a fix, open an issue first, so the design can be
  agreed before the work.
- A polyfill you keep in your own repository can be
  [listed in the community directory](#listing-a-polyfill-in-the-community-directory)
  instead.

## Adding a polyfill

A polyfill implements the client side of one published MCP extension inside
one host that hasn't shipped it, and does nothing once the host supports the
extension itself. Each one is a folder in this repository.

### 1. Meet the contract

Every polyfill here meets [`docs/polyfill-contract.md`](docs/polyfill-contract.md):

- one published extension and nothing else;
- a named spec revision;
- a test for each client rule, plus a run against a server someone else
  wrote;
- a stand-down;
- stated limits;
- server content treated as untrusted data.

The `create-polyfill` skill walks an agent through building one to that
contract. Install it with:

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

Then ask for the extension and host you want, for example "polyfill MCP
Server Cards in Claude Code". If what you want isn't in any spec, the
`design-extension` skill in the same plugin covers that case, because a
polyfill never adds behaviour of its own.

### 2. Put it in its folder

Each extension has one folder, and one plugin that serves every host it
supports:

```
polyfills/<extension>/
  core/          the host-neutral logic and its tests of the spec's rules
  claude-code/   the Claude Code adapter
  codex/         the Codex adapter
  copilot/       the GitHub Copilot CLI adapter
```

- `<extension>` is the extension's short name: `apps`, `events`, `skills`,
  `server-cards`, `ard`.
- `core/` holds what doesn't depend on the host: the protocol, the spec's
  client rules and the tests for each rule. A polyfill for a single host can
  start without it.
- `claude-code/`, `codex/` and `copilot/` each hold a host adapter: the code that wires
  `core/` into that host, with the host's own tests. A host's folder is named
  after it, in lower case with hyphens.

The Apps polyfill, [`polyfills/apps/claude-code`](polyfills/apps/claude-code),
is a complete example of one adapter. Inside an adapter's folder:

- **The installable plugin goes in a subfolder** (`mod/` in the Apps
  polyfill). It holds the host's manifest and only what the plugin runs.
  Tests, build scripts, benchmarks and design notes go beside it, not in it.
  If the plugin's own top folder holds a `package.json`, Claude Code runs
  `npm install` there when someone installs it, so keep any `package.json`
  out of that top folder.
- **The plugin folder is self-contained.** Claude Code and Codex copy only
  that folder when someone installs the plugin, so nothing in it may import
  from outside it. Code from `core/` reaches it by bundling, a build step that
  writes the bundle into the plugin folder. Never use an import that reaches
  out of it.
- **One plugin folder can serve both hosts.** It can carry
  `.claude-plugin/plugin.json` for Claude Code and `.codex-plugin/plugin.json`
  for Codex side by side, with the same plugin name.
- **The plugin's name** is unique in this repository. The same name is used
  in the marketplace entries, in release tags and in the workflow files. An
  extension keeps one name in every host. Existing names: `mcp-events`,
  `mcp-apps-cli`, `mcp-skills`, `mcp-server-cards`, `ard-discovery`,
  `agent-polyfill`, `polyfill-author`.
- **No large files in git.** Nothing over about 1 MB, unless the plugin or its
  tests can't work without it. Attach videos and other large media to a
  release instead, and link them from the README.
- **Licences.** The repository is Apache-2.0 ([LICENSE](LICENSE)), and so is
  every contribution. Don't add another copy of the licence. Do keep the
  notices of third-party code the polyfill ships (a
  `THIRD_PARTY_LICENSES.txt`) in its folder.
- **Paths** in its scripts and docs are relative to its own folder, so they
  keep working wherever the repository is checked out. Say so where a reader
  might assume the repository's root.

### 3. Write its README

The polyfill's `README.md` sits at the top of its folder. Write it for someone
who has never seen this repository, in this order: what it does, install, try
it, how it works, settings, limits, security, spec and conformance,
development. Where the extension runs in more than one host, each host's
README follows the same order, describes shared behaviour in the same words,
and links the other host's README near the top.

It states:

- **The extension:** its identifier, the spec's name and revision (for
  example "SEP-3415, Final") and a link to the spec.
- **Requirements, install and use.** Put the one-line install first.
  - In Claude Code: `/plugin install <plugin> --marketplace idosal/AgentPolyfill`,
    and in a terminal
    `claude plugin install <plugin> --marketplace idosal/AgentPolyfill`. Then
    the two-step form: `/plugin marketplace add idosal/AgentPolyfill`, then
    `/plugin install <plugin>@agent-polyfill`.
  - In Codex:
    `codex plugin marketplace add idosal/AgentPolyfill && codex plugin add <plugin>@agent-polyfill`.
  - In Copilot CLI: `copilot plugin marketplace add idosal/AgentPolyfill`,
    then `copilot plugin install <plugin>@agent-polyfill`.
  - Then what else it needs, and every step and question a new user meets
    between that line and the extension working, with what happens when they
    say no. Anything beyond "install, add a server, ask" needs a reason.
- **Stand-down:** how it detects that the host supports the extension
  natively, or, until it can, the setting that turns it off.
- **Limits:** what it can't do on this host, and for each limit the change in
  the host that would remove it. Add any such change to
  [`docs/host-changes.md`](docs/host-changes.md) too.
- **Privacy and security:** what it sends where, and what it stores.
- **The client rules:** a checklist with one row for each rule the spec puts
  on a client (each MUST and SHOULD), the test that covers it, and its state:
  met, not met, or not applicable and why. It can be a separate file the
  README links.

If a contract rule isn't met yet, the README says so.

### 4. Add it to the marketplace

Each host has its own marketplace file in this repository. For Claude Code,
add an entry to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json):

```json
{
  "name": "<plugin>",
  "description": "<Extension>: what it does, in one sentence",
  "source": "./polyfills/<extension>/<host>/<plugin subfolder>"
}
```

A relative `source` installs the plugin straight from this repository. A
plugin that ships built files (binaries, a bundle) uses an `archive` source
instead: a zip attached to a release of this repository, pinned by its
SHA-256, which a release workflow produces (step 5). A `git-subdir` or `url`
source takes a full `https://` git URL. The `owner/repo` shorthand there is
cloned over SSH, which fails on a machine without GitHub SSH keys.

For Codex, add an entry to
[`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json):

```json
{
  "name": "<plugin>",
  "source": { "source": "local", "path": "./polyfills/<extension>/codex/<plugin subfolder>" },
  "policy": { "installation": "AVAILABLE" },
  "category": "Developer Tools"
}
```

For Copilot CLI, add an entry to
[`.github/plugin/marketplace.json`](.github/plugin/marketplace.json), which
Copilot reads before `.claude-plugin/marketplace.json` (so Copilot users see
only the plugins that run there). Keep its `version` equal to the plugin's:

```json
{
  "name": "<plugin>",
  "description": "…",
  "version": "<the plugin.json version>",
  "source": "./polyfills/<extension>/copilot/<plugin subfolder>"
}
```

In Claude Code, add the plugin's name to the `dependencies` of the
`agent-polyfill` plugin
([`plugins/agent-polyfill/.claude-plugin/plugin.json`](plugins/agent-polyfill/.claude-plugin/plugin.json)),
which installs every polyfill in one step, and to the list in its
[README](plugins/agent-polyfill/README.md). CI fails until the two lists
match. Add the polyfill to the table in the [README](README.md) as well, in
its host's column.

### 5. Add its CI

Every push and pull request runs [`ci.yml`](.github/workflows/ci.yml). It
checks that:

- every manifest is valid JSON;
- `claude plugin validate` passes for the marketplace and for every plugin in
  the repository;
- each relative marketplace entry points at a plugin that is there;
- the `agent-polyfill` bundle depends on every polyfill.

Your plugin is included automatically.

Add the polyfill's own tests as `.github/workflows/<plugin>-test.yml`,
filtered to its folder. Copy
[`mcp-apps-cli-test.yml`](.github/workflows/mcp-apps-cli-test.yml) and change
the paths, the working directory and the commands. Keep it cheap: it runs on
every change in the folder. For a Claude Code mod that is usually
`claude plugin test <plugin subfolder>` and the tests of any helper.

A polyfill that ships built files also gets
`.github/workflows/<plugin>-release.yml`. It runs only when what goes into
those files changes, and on its own tags, `<plugin>-v<version>`. Tags carry
the plugin's name so that each polyfill releases on its own. See
[`mcp-apps-cli-release.yml`](.github/workflows/mcp-apps-cli-release.yml): it
builds on each platform and packs the zip on every run. On a tag, it also
publishes the release and opens a pull request that updates only that
plugin's marketplace entry.

### 6. Before you open the pull request

```bash
claude plugin validate .
```

```bash
claude plugin validate polyfills/<extension>/<host>/<plugin subfolder>
```

Run the polyfill's tests, and do one recorded run in the real host against a
server you didn't write. Say in the pull request what you ran and what you
saw.

## Bringing a polyfill to another host

An extension keeps one folder and one plugin name, and each host gets an
adapter beside the others. Events is the fullest example: one `core/`, a
`claude-code/` mod, a `codex/` plugin and a `copilot/` extension
([`polyfills/events`](polyfills/events), [`polyfills/skills`](polyfills/skills)).

1. **Find the host's way in.** What can third-party code do there? It may run
   code inside the host or beside it (Claude Code mods; a Codex plugin's MCP
   server and skills), call tools, ask the user, or start a turn in an idle
   session. Each wire need of the extension is reached one of those ways, or
   it is a limit, written down with the host change that would remove it
   ([`docs/host-changes.md`](docs/host-changes.md)). The `create-polyfill`
   skill walks through this for a named host.
2. **Share the core.** If the host-neutral logic still lives inside the first
   host's adapter, move it into `polyfills/<extension>/core/` first, with its
   rule tests, in its own pull request. That way the existing host's behaviour
   is checked unchanged before a second host depends on it.
3. **Write the adapter** in `polyfills/<extension>/<host>/`, under the rules
   in [step 2](#2-put-it-in-its-folder): a self-contained plugin folder with
   that host's manifest, `core/` bundled into it, and the host's own tests
   beside it.
4. **Meet the contract in that host.** It needs its own README (step 3), with
   that host's install line, requirements, limits and stand-down, its own
   `SECURITY.md`, and a recorded run in the real host against a server you
   didn't write.
5. **List it** in that host's marketplace file (step 4), and add its CI
   (step 5). Add it to the polyfills table in the [README](README.md), in that
   host's column.

## Listing a polyfill in the community directory

A polyfill you build and maintain in your own repository can be listed in
[`community/`](community/) without moving its code here. Open a pull request
that adds one entry to [`community/polyfills.json`](community/polyfills.json).
[`community/README.md`](community/README.md) has the fields and the rules.

Listed polyfills aren't reviewed, built or shipped by this project, and aren't
in its marketplaces. One that meets the contract can be proposed for
`polyfills/` later, by an issue.

## Security

Report a security issue privately, through this repository's
**Security → Report a vulnerability** form on GitHub, not in a public issue.
A polyfill whose README links another repository takes its reports there.
