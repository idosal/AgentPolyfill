# Contributing

Bug reports, fixes and new polyfills are welcome. For a bug or a question,
open an issue and name the polyfill it concerns. For anything larger than a
fix, open an issue first, so the design can be agreed before the work.

## Adding a polyfill

A polyfill implements the client side of one published MCP extension inside
one host that has not shipped it, and does nothing once the host supports the
extension itself. Each one is a folder in this repository.

### 1. Meet the contract

Every polyfill here meets [`docs/polyfill-contract.md`](docs/polyfill-contract.md):
one published extension and nothing else, a named spec revision, a test for
each client rule plus a run against a server someone else wrote, a
stand-down, stated limits, and server content treated as untrusted data.

The `create-polyfill` skill walks an agent through building one to that
contract. Install it with:

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

Then ask for the extension and host you want, for example "polyfill MCP
Server Cards in Claude Code". If what you want is not in any spec, the
`design-extension` skill in the same plugin covers that case: a polyfill never
adds behaviour of its own.

### 2. Put it in its folder

```
polyfills/<host>/<extension>/
```

- `<host>` is the host it runs in, in lower case with hyphens:
  `claude-code`.
- `<extension>` is the extension's short name: `apps`, `events`, `skills`,
  `server-cards`.

The Apps polyfill, [`polyfills/claude-code/apps`](polyfills/claude-code/apps),
is a complete example.

Inside the folder:

- **The installable plugin goes in a subfolder** (`mod/` in the Apps
  polyfill), holding `.claude-plugin/plugin.json` and only what the plugin
  runs. Tests, build scripts, benchmarks and design notes go beside it, not
  in it. If the plugin's own top folder holds a `package.json`, Claude Code
  runs `npm install` there when someone installs it, so keep any
  `package.json` out of that top folder.
- **The plugin's name** is unique in this repository, and the same name is
  used in the marketplace entry, in release tags and in the workflow files.
  Existing names: `mcp-apps-cli`, `mcp-events`, `mcp-skills`,
  `polyfill-author`.
- **No large files in git.** Nothing over about 1 MB unless the plugin or its
  tests cannot work without it. Attach videos and other large media to a
  release instead, and link them from the README.
- **Licences.** The repository is Apache-2.0 ([LICENSE](LICENSE)), and so is
  every contribution. Do not add another copy of the licence; do keep the
  notices of third-party code the polyfill ships (a
  `THIRD_PARTY_LICENSES.txt`) in its folder.
- **Paths** in its scripts and docs are relative to its own folder, so they
  keep working wherever the repository is checked out. Say so where a reader
  might assume the repository's root.

### 3. Write its README

The polyfill's `README.md`, at the top of its folder, states:

- **The extension:** its identifier, the spec's name and revision (for
  example "SEP-3415, Final") and a link to the spec.
- **The client rules:** a checklist with one row for each rule the spec puts
  on a client (each MUST and SHOULD), the test that covers it, and its state:
  met, not met, or not applicable and why. It can be a separate file the
  README links.
- **Stand-down:** how it detects that the host supports the extension
  natively, or, until it can, the setting that turns it off.
- **Limits:** what it cannot do on this host, and for each limit the change
  in the host that would remove it. Add any such change to
  [`docs/host-changes.md`](docs/host-changes.md) too.
- **Requirements, install and use:** the one-line install first
  (`/plugin install <plugin> --marketplace idosal/AgentPolyfill`, and in a
  terminal `claude plugin install <plugin> --marketplace idosal/AgentPolyfill`),
  then the two-step form (`/plugin marketplace add idosal/AgentPolyfill`, then
  `/plugin install <plugin>@agent-polyfill`); what else it needs; and every
  step and question a new user meets between that line and the extension
  working, with what happens when they say no. Anything beyond "install,
  add a server, ask" needs a reason.
- **Privacy and security:** what it sends where, and what it stores.

Write for someone who has never seen this repository. If a contract rule is
not met yet, the README says so.

### 4. Add it to the marketplace

Add an entry to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json):

```json
{
  "name": "<plugin>",
  "description": "<Extension>: what it does, in one sentence",
  "source": "./polyfills/<host>/<extension>/<plugin subfolder>"
}
```

A relative `source` installs the plugin straight from this repository. A
plugin that ships built files (binaries, a bundle) instead uses an `archive`
source: a zip attached to a release of this repository, pinned by its
SHA-256, which a release workflow produces (step 5). A `git-subdir` or
`url` source takes a full `https://` git URL: the `owner/repo` shorthand
there is cloned over SSH, which fails on a machine without GitHub SSH keys.

Then add the plugin's name to the `dependencies` of the `agent-polyfill` plugin
([`plugins/agent-polyfill/.claude-plugin/plugin.json`](plugins/agent-polyfill/.claude-plugin/plugin.json)),
which installs every polyfill in one step, and to the list in its
[README](plugins/agent-polyfill/README.md). CI fails until the two lists match.
Add a row to the polyfills table in the [README](README.md) as well.

### 5. Add its CI

Every push and pull request runs [`ci.yml`](.github/workflows/ci.yml): every
manifest is valid JSON, `claude plugin validate` passes for the marketplace
and for every plugin in the repository, and each relative marketplace entry
points at a plugin that is there, and the `agent-polyfill` bundle depends on
every polyfill. Your plugin is included automatically.

Add the polyfill's own tests as `.github/workflows/<plugin>-test.yml`,
filtered to its folder. Copy
[`mcp-apps-cli-test.yml`](.github/workflows/mcp-apps-cli-test.yml) and change
the paths, the working directory and the commands. Keep it cheap: it runs on
every change in the folder. For a Claude Code mod that is usually
`claude plugin test <plugin subfolder>` and the tests of any helper.

A polyfill that ships built files also gets
`.github/workflows/<plugin>-release.yml`, run only when what goes into those
files changes, and on its own tags, `<plugin>-v<version>`. Tags carry the
plugin's name so that each polyfill releases on its own. See
[`mcp-apps-cli-release.yml`](.github/workflows/mcp-apps-cli-release.yml): it
builds on each platform, packs the zip on every run, and on a tag publishes
the release and opens a pull request that updates only that plugin's
marketplace entry.

### 6. Before you open the pull request

```bash
claude plugin validate .
```

```bash
claude plugin validate polyfills/<host>/<extension>/<plugin subfolder>
```

Run the polyfill's tests, and do one recorded run in the real host against a
server you did not write. Say in the pull request what you ran and what you
saw.

## Security

Report a security issue privately, through this repository's **Security →
Report a vulnerability** form on GitHub, not in a public issue. A polyfill
whose README links another repository takes its reports there.
