# Hermes Agent: shared code and test harness

What the Hermes forms of the polyfills (`polyfills/*/hermes`) share.

## In every plugin

Each Hermes plugin is a Python half (`plugin/__init__.py`, which Hermes loads
in its gateway) and a Node helper (`plugin/dist/helper.mjs`) bundled from the
polyfill's existing TypeScript, so each spec's client rules have one
implementation across hosts. A plugin folder is installed on its own, so the
shared modules are copied into it by its build, and a test fails when a copy
differs:

- [`shared/_helper.py`](shared/_helper.py): starts the helper with Node 20+ and
  speaks newline-delimited JSON-RPC to it, requests both ways.
- [`shared/bridge.ts`](shared/bridge.ts): the same line, on the helper's side.
- [`shared/_servers.py`](shared/_servers.py): which MCP servers a plugin may
  connect to, read from `config.yaml` as written (`hermes_cli.config.read_raw_config`):
  only those named in the plugin's own settings,
  `plugins.entries.<plugin>.settings.servers` (`ctx.get_config("servers")`),
  never one that signs in through Hermes, and none whose entry takes `${VAR}`
  from `.env`; and whether Hermes approves without asking in a session
  (`approvals_bypassed`), where the forms refuse a step that needs the
  person's own yes. `shared/test_servers.py` tests it.
- [`shared/_card_config.py`](shared/_card_config.py),
  [`shared/_card_runtime.py`](shared/_card_runtime.py),
  [`card_client.ts`](card_client.ts), [`build-cards.mjs`](build-cards.mjs):
  what Server Cards and ARD share (writing `mcp_servers` with Hermes's config
  API, the approval for add, remove and search).

## The test harness

The end-to-end tests run a real Hermes, never the one you use:

- [`setup.sh`](setup.sh) puts Hermes **v0.23.4** (commit `8fc0374`) in
  `.hermes-test/` here, from a shallow clone of its release tag and its
  locked dependencies (`uv sync --frozen`). It's not the curl installer, and
  it writes nothing outside that folder. Set `HERMES_PYTHON` and `HERMES_SRC`
  to use another copy. Run that copy only through the harness, or with
  `HOME` and `HERMES_HOME` set to folders of its own: run bare, even for
  `hermes --version`, it makes `~/.hermes` with its default contents in your
  real home.
- [`harness.py`](harness.py): `World` makes a temporary `HOME` and
  `HERMES_HOME` for every run, installs the plugins under test, writes
  `config.yaml`, and starts Hermes's stdio gateway (`tui_gateway.entry`), the
  JSON-RPC its TUI speaks ([`gateway.py`](gateway.py)). It answers Hermes's
  approval requests as the test says. Hermes gets an allowlist of the
  environment (`gateway.py`, `PASSED`: the system's basics, nothing else).
  `World.oneshot` runs `hermes -z` in the same home, the same way.
- [`fake_model.py`](fake_model.py): an OpenAI-compatible model on loopback that
  answers by rules the test sets, so every turn is deterministic and no API
  key is used.
- [`offline/sitecustomize.py`](offline/sitecustomize.py): by default Hermes's
  own Python processes may reach loopback only (it checks for releases in the
  background). That fence doesn't cover the Node helpers, the fixture servers
  or a model's subprocesses; [`run_card_e2e.py`](run_card_e2e.py) also fences
  every process on macOS (`sandbox-exec`), and nothing is fenced that way on
  Linux, in CI included. The interop scripts, which need the network, opt out.
- [`approval_stub.py`](approval_stub.py): stands in for Hermes's approval
  modules in unit tests, which run without Hermes, so a test can say how
  Hermes would answer (`hermes_approval(yolo=True)` and the like).
- [`shared_gateway.py`](shared_gateway.py): the same, through the shared
  gateway that `hermes`, the TUI and Desktop attach to
  (`hermes gateway attach --json --start`, then its WebSocket). Used by the
  Events form's `test/e2e_shared_gateway.py`; it stops the gateway it started.
