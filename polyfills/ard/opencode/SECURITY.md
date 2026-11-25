# Security

This covers ard-discovery for OpenCode. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

The plugin is one bundled file (`plugin/server.js`) that OpenCode loads into
its own server. It carries the Server Cards modules, so everything
[mcp-server-cards for OpenCode's SECURITY.md](../../server-cards/opencode/SECURITY.md)
says about fetching, showing and adding a server holds here too. What ARD
adds is the registry search.

## The search

- **It goes to a third party.** A registry is a service someone else runs,
  and it sees the query.
- **You choose the registry.** The plugin ships with none. A search goes to
  the registry the request names, or to `ARD_DISCOVERY_REGISTRY`; with
  neither, it's refused and nothing is sent.
- **OpenCode's rules decide before anything is sent.** The action is
  `ard_search`, on the registry hosts; the request carries the exact query
  and the endpoints. Nothing is saved by "Allow always".
- **It's asked about by default.** OpenCode's shipped default allows every
  action. For this plugin's own actions only (`ard_search`,
  `mcp_server_cards_add`, `mcp_server_cards_remove`), its `evaluate` hook
  turns that `allow` into `ask`, unless you set `askByDefault` to `false`. It
  never turns anything into `allow`, and a configured `deny` is settled
  before it runs. With nobody there to answer, OpenCode refuses the
  question, so no search is sent unattended.
- **What is sent is what is shown.** A query is one line, at most 300
  characters, with no control characters, direction marks or markup. A
  registry is named exactly as it is searched, at most 200 characters, and an
  endpoint holding markup or a user before its host is refused.
- **At most three registries,** and their referrals one hop deep, under the
  same address rules as every fetch. Each referred registry is put to
  OpenCode's rules (`ard_search` on its host) before the query goes there, so
  your `allow` and `deny` rules hold for it too; one that isn't allowed gets
  nothing, and OpenCode's refusal is passed on.
- **Results are claims.** A registry's order is relevance, not trust. A result
  is confirmed only when its publisher's own catalog lists it.

## What it does not protect against

- **What OpenCode's TUI shows in the prompt.** OpenCode 2.4.1's TUI shows a
  request for this plugin's action as "Call tool ard_search", without the
  resource or metadata it carries. You read the query and the registry on the
  model's call line above it. When that registry is a domain, the endpoints
  its catalog lists are in the request only. **A registry a referral names is
  asked about in a prompt of its own, and in the TUI nothing on screen names
  it**: there is no mitigation for that in the TUI. OpenCode Desktop shows a
  plugin action's resource, the registry's host here, in its prompt (seen for
  Events and Skills; ARD there wasn't tried). Rejecting a prompt you can't
  read sends nothing to that registry.
- **Turning asking off.** With `askByDefault: false` or
  `ARD_DISCOVERY_ASK_BY_DEFAULT=0`, OpenCode's rules alone decide, and under
  its default a search is sent without a prompt.
- **A registry you chose,** which sees your query and ranks other people's
  servers.
- **Other plugins.** A plugin runs inside OpenCode's server with the same
  access as this one.

## Reporting

Report a vulnerability privately, through this repository's **Security →
Report a vulnerability** form on GitHub, not in a public issue. Name
`ard-discovery` for OpenCode.
