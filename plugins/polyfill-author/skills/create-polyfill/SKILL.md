---
name: create-polyfill
description: Use when asked to add support for an MCP extension or SEP (Events, Skills, Apps, Tasks, Server Cards, or a new one) to a host that has not shipped it, such as Claude Code, Cursor, Codex or ChatGPT; when someone asks to polyfill, backport or shim a protocol feature as a plugin, mod or gateway server; or when changing or reviewing an existing polyfill.
---

# Create a polyfill

A polyfill implements the client side of one published extension inside a host
that lacks it, exactly as the spec says, and steps aside when the host ships
the extension. Servers change nothing.

**The spec is the feature list.** What the polyfill does is the set of client
rules in the spec. That is what lets it be deleted later without anyone
noticing.

## What you produce

A polyfill has these seven parts. Each is required; the work is done when all
seven exist.

| # | Part | What it is |
|---|---|---|
| 1 | **Spec record** | The extension's identifier, the spec's name and revision (for example "SEP-3415, Final"), and a link. In the README. |
| 2 | **Client-rule checklist** | A table with one row for each rule the spec puts on a client or host (every MUST, MUST NOT, SHOULD): the rule in a few words, where it is in the spec, the test that covers it, and its state (met, not met, not applicable and why). |
| 3 | **Route table** | For each thing the extension needs on the wire (each method, each notification, the server's declaration, the client's declaration, each `_meta` field): how this host lets you reach it, and what that route cannot do. See "Routes". |
| 4 | **Implementation** | Code for the rows of part 2, over the routes of part 3. |
| 5 | **Stand-down** | What makes the polyfill do nothing when the host supports the extension. See "Stand-down". |
| 6 | **Proof** | A test per row of part 2; a run against a server you did not write; a recorded run in the real host. |
| 7 | **Limits and host changes** | In the README: what it does not do on this host, and for each limit the change in the host that would remove it. |

Write parts 1 to 3 before any code. They are short, and they decide the design.

A deadline changes how many rows of part 2 are met, never which parts exist.
Ship with rows marked "not met" and say so; do not drop the checklist, the
stand-down or the proof.

## Sources

Work from the primary text, fetched now, and record the revision or commit you
read. Do not work from memory, a blog post or another client's behaviour: the
specs change, and summaries drop the rules that matter.

| For | Read |
|---|---|
| The extension's rules | Its SEP in `modelcontextprotocol/modelcontextprotocol` under `seps/`, and its spec in its `ext-*` repository under `specification/<stage>/` (the stage is experimental, beta or stable). In full. |
| The base protocol it builds on | The core specification at modelcontextprotocol.io for the protocol revision the host negotiates. How capabilities are declared and where they travel differs between revisions, so check the one in use. |
| How extensions are identified, declared and negotiated | SEP-2133 (Extensions). |
| The extension's stage and what may still change | SEP-3392 (Extension Lifecycle) and the extensions page on modelcontextprotocol.io. An experimental or beta extension can change incompatibly: pin what you implemented. |
| Which hosts already support it | The extension support matrix on modelcontextprotocol.io, then the host's own documentation and changelog. |
| Conformance | `modelcontextprotocol/conformance` (`npx @modelcontextprotocol/conformance list` shows the scenarios; `client --command …` runs a client against them). |
| Existing implementations to test against | The implementations list in the extension's repository, and the official SDKs. |

A polyfill conforms to the core spec as well as to the extension: it is an MCP
client, so the base rules for initialisation, capability negotiation, errors,
cancellation and transports apply to its own connection. Where the spec and an
implementation disagree, follow the spec and note the disagreement.

If what is wanted is not in any published spec, stop and use the
`design-extension` skill. It does not go into a polyfill.

## Scope: three lists

Sort everything anyone asks for into one of three lists, and put the lists in
the README.

- **In the polyfill:** client behaviour the spec defines.
- **Host presentation:** how the host shows what the spec defines (a tool the
  model calls, a row in the UI, the line that wakes a session). Needed, but
  keep it to the minimum that makes the spec's behaviour usable.
- **Not in the polyfill:** everything else, however useful. Dashboards, drift
  checks, summaries injected into the prompt, approval prompts of your own,
  rate limits of your own, auto-configuration. Name each and say it belongs in
  a separate plugin.

When a request says "add whatever would be useful", the useful thing is the
third list, written down.

## A server that does not follow the spec

If a server deviates from the spec (an older draft, different error codes, a
capability under another key), the polyfill refuses it and tells the user why.

Supporting such a server is a setting the user sets, naming that server, off by
default (for example `MCP_EVENTS_PRE_STANDARD=cloudflare`). The README lists it
as an exception to the spec. The polyfill does not detect and adapt by itself:
an adapter that switches on silently makes the non-standard form the one
servers keep shipping.

The setting is for a form you can name: an earlier draft of the spec, or a
vendor's documented variant. Behaviour that matches no published form is a bug
in the server. Refuse it, and report it to the server's author with the
evidence.

## Routes

For each wire need, find the route in this order and record it in part 3.

1. **The host's own connection.** It carries the user's sign-in and the host's
   policy. Read the host's extension API for the installed version before
   deciding it cannot do something: capabilities hide in unexpected places
   (in Claude Code, a mod can read MCP resources by calling the built-in
   resource tools, though not through `$.mcp`).
2. **A connection of the polyfill's own**, opened by a helper process, to the
   servers the host is configured with and would itself use. It can send any
   method. It has only what is in the user's config (static headers, including
   `${VAR}`), so it does not reach servers behind an interactive sign-in.
3. **Not reachable.** Record it as a limit (part 7).

A feature that would break a client rule on route 1 (for example sending the
extension's methods without having seen the server's declaration) is left out
on that route.

**Sign-in.** The polyfill never reads the host's stored credentials. Whether it
may run a sign-in of its own (a second grant per server, tokens in the OS
keychain) is the user's decision, made knowingly, and off by default. Until
they make it, "servers behind OAuth: not supported" is a limit in part 7 with
its host change, which is the honest state.

If the servers the user cares about are the ones the polyfill cannot reach,
say so before building, with their options (a static token, if the server
issues one; their decision on a sign-in of the polyfill's own; waiting for the
host change).

Decide this per row of the route table, not for the extension as a whole. A
need that does not travel over the signed-in connection (a public document
fetched by URL, a resource the host's own tools can read) works for those
servers, and the README says which parts do.

When a limit stops something for a particular server, tell the user at that
moment in the host's ordinary way (the tool's result, a notice), naming the
server and the reason. The README alone is not enough.

**Policy.** What a server sends is data from that server, treated as the host
treats a tool result. Receiving it grants nothing; what happens next goes
through the host's own permissions. Follow the safety rules the spec gives
(they are rows in part 2). Add none of your own.

## Stand-down

Part 5 is one of these, in order of preference, and the README says which:

1. A check for native support that you have verified against the host (a
   capability the host declares, a version, a built-in tool that now exists).
2. A setting that turns the polyfill fully off (registers nothing, starts
   nothing), with a line in the README saying that detection is not possible
   yet and why.

"It will turn itself off if the host supports this" with no named mechanism is
not a stand-down.

## Proof

- **Per rule:** each row of part 2 names a test. A fixture server of your own
  is right for edge cases (bad digests, expired subscriptions, malformed
  input).
- **Someone else's server:** run against an implementation you did not write
  (a reference server in the extension's repo, an SDK's implementation, a
  vendor's). Your own fixture agrees with your own reading of the spec, so it
  cannot catch a misreading.
- **The real host:** install the polyfill the way a user would and record the
  behaviour working. Tests of the helper alone do not show that the host loads
  it, lists its tools, or wakes.
- **Upstream conformance:** if the MCP conformance suite has client scenarios
  for the extension, run them; if it has none, the README says so.

Report what was verified and what was not, separately.

## Claude Code

Check everything here against the mod API types for the installed version
(the `plugin-authoring` skill names the file); the API is early access and
changes.

A polyfill is a mod: a hooks module that runs inside Claude Code, and usually
one helper process, because a hooks module has no network or process of its
own.

| Need | In a mod |
|---|---|
| Tools the model calls | `$.tool.register`, answered by a hook on the tool |
| Wake an idle session with something that arrived | `$.prompt.submit` |
| Add a catalog to the session's instructions | a `prompt.compose` hook |
| Call a server's tool with Claude Code's sign-in | `$.mcp.call(server, tool, args)` |
| Ask whether Claude Code would use a server (approved, enabled, allowed by policy) | `$.mcp.connect(server)`; use its verdict instead of reading config and policy files |
| Read a resource with Claude Code's sign-in | `$.tool.call` on `ReadMcpResourceTool` / `ListMcpResourcesTool` (no `_meta`) |
| Any other MCP method, the server's capabilities, notifications | not over Claude Code's connection: the helper's own connection |

Layout that two polyfills have converged on: `hooks/hooks.json`,
`hooks/register.ts`, `hooks/tools.ts`, `src/helper.ts` and the protocol client
beside it, bundled into `dist/` so an installed copy needs no install step,
`.claude-plugin/plugin.json`. Check it with `claude plugin validate .` and
`claude plugin test .`.

## Hosts with no in-process extension layer

Where third-party code cannot run in the host or cannot reach its connection,
the only route is a gateway: an MCP server that presents the extension as
plain tools. Parts 1, 2, 6 and 7 apply unchanged. Part 3 records what the
gateway form loses (for Events: the model must poll, and nothing wakes it).
Say in the README that it is the gateway form.

## Common mistakes

| Mistake | What to do |
|---|---|
| A panel, a slash command, a prompt summary or a drift check "because it helps" | Third list. The polyfill is the spec's client rules. |
| Detecting a draft-form server and adapting automatically | Refuse by default; a per-server setting the user sets. |
| Approval prompts or rate limits of the polyfill's own | The host's permissions are the boundary; the spec's safety rules are rows in part 2. |
| Probing a server to see what it supports | Read its declaration. The spec says what a client may send before seeing it. |
| Going straight to a second connection | Route 1 first; record why it was not enough. |
| Running an OAuth flow because the user's servers need sign-in | The user's decision, off by default. Until then it is a stated limit. |
| "Conformance suite" with no list of rules | Part 2: one row per rule, each with its test. |
| Tested only against your own fixture | Part 6: a server you did not write. |
| No spec revision named | Part 1. |
