---
name: create-polyfill
description: Builds client support for a published MCP extension or SEP inside a host that has not shipped it (a polyfill), working from the spec's client rules and proving the result against them. Use when asked to add support for an MCP extension (Events, Skills, Apps, Tasks, Server Cards, or a new SEP) to Claude Code, Cursor, Codex, Pi, Muse Code, ChatGPT or another host; to polyfill, backport or shim a protocol feature as a plugin, mod, extension or gateway server; or to change or review an existing polyfill. Not for JavaScript or browser polyfills.
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

### What parts 2 and 3 look like

Rows from a polyfill of the Events extension in Claude Code, to show the
shape. Yours come from the spec you are implementing.

Part 2, the client-rule checklist:

| Rule | In the spec | Test | State |
|---|---|---|---|
| Send no `events/*` method to a server that has not declared the extension | Capability declaration | `refuses a server without the declaration` | met |
| When a poll result says more events are waiting, poll again at once | Polling | `polls again immediately while more are waiting` | met |
| Check each webhook delivery's signature before acting on it | Webhook delivery | `rejects a delivery with a bad signature` | met |
| Show the user why a subscription ended | Termination | none yet | not met |

Part 3, the route table:

| Need | Route on this host | What that route cannot do |
|---|---|---|
| The server's declaration | The polyfill's own connection (a mod cannot read capabilities from Claude Code's connection) | Reach servers behind an interactive sign-in |
| `events/poll`, `events/subscribe` | The polyfill's own connection (Claude Code's carries tool calls only) | The same |
| Whether Claude Code would use this server | Claude Code's own verdict, asked from the mod | Nothing: this is the host's answer |
| Receiving a webhook | A relay the user deploys (a laptop has no public address) | Work with nothing deployed |

Part 7, limits and host changes:

| Limit on this host | The host change that would remove it |
|---|---|
| Servers behind an interactive sign-in are not reached | Sending any MCP method over the host's own connection |
| Push delivery needs the polyfill's own connection | Delivering a request's notifications to the plugin |
| Events arrive only while a session is open | Running extension code in sessions with nobody at the keyboard |

Every limit gets a row, not only the one about sign-in.

A plan or a README that only promises these tables has not done parts 2, 3
and 7. The rows are the work: writing them is how gaps in the design show up
before any code exists. When you cannot read the spec yet, write the rows you
can and mark the rest as to be filled from the spec text.

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
default. The README lists it as an exception to the spec. The polyfill does not
detect and adapt by itself: an adapter that switches on silently makes the
non-standard form the one servers keep shipping.

The setting is for a form you can name: an earlier draft of the spec, or a
vendor's documented variant. Behaviour that matches no published form is a bug
in the server. Refuse it, and report it to the server's author with the
evidence.

One exception may be on by default: an earlier form of the same extension that
servers in real use still speak. It is the polyfill owner's decision, made
explicitly and written down, never adopted because one server needs it. The
polyfill maps that form onto the spec's behaviour and adds nothing of its own,
one setting turns it off (and with it off the polyfill follows the spec
exactly), and the README says that this goes beyond the spec. Example:
`mcp-events` uses servers that advertise events in the form from before
SEP-3415 unless `MCP_EVENTS_PRE_STANDARD=off`.

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

## The host

How a polyfill is built depends on what the host lets third-party code do.

- **Claude Code:** read [references/claude-code.md](references/claude-code.md)
  before writing part 3. It lists what a mod can and cannot reach, and the
  layout existing polyfills use.
- **Pi:** a Pi extension in `polyfills/<polyfill>/pi/`, with its installable
  manifest and bundle in `extension/`. Read the existing Pi forms' README,
  SECURITY.md and `docs/conformance.md` before writing part 3. Events,
  Skills, Server Cards and ARD have Pi forms; Apps does not. The forms were
  tested with Pi 1.6.0 and require Node 22 or newer. Install from a local
  clone with `pi install ./polyfills/<polyfill>/pi/extension`; nothing for
  Pi is published to npm or Pi's package gallery.
- **Muse Code:** a plugin that is the Codex plugin's folder with a
  `.muse-plugin/plugin.json` beside its Codex manifest (Muse reads the Codex
  marketplace), and docs in `polyfills/<polyfill>/muse/`. Read the existing
  Muse forms' README, SECURITY.md and `docs/conformance.md` before writing
  part 3.
  - **No way to ask.** Muse gives a plugin no way to ask the person: its MCP
    client offers no elicitation, and a non-read-only tool call or a hook's
    `ask` goes to its approval judge, a model. So a consequential step waits
    for a phrase the person types, read by a `UserPromptSubmit` hook
    (`polyfills/events/codex/src/muse-confirm.ts`), or is a command the person
    runs.
  - **No environment.** Muse passes plugin servers and hooks no environment
    variables; settings go in a file in the plugin's data folder.
  - **Tested with** Muse Code 1.4.25, Node 20 or newer, checked with
    `muse plugins validate <folder> --json`.
- **Another host with an in-process extension layer:** read its extension API
  for the installed version and build the route table from that. Do not assume
  it matches Claude Code's.
- **A host with no in-process extension layer:** the gateway form, below.

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
| Detecting a draft-form server and adapting automatically | Refuse by default; a per-server setting the user sets. The one exception (an earlier form still in real use, mapped onto the spec, one off setting, stated in the README) is the owner's explicit decision, not a fix for one server. |
| Approval prompts or rate limits of the polyfill's own | The host's permissions are the boundary; the spec's safety rules are rows in part 2. |
| Probing a server to see what it supports | Read its declaration. The spec says what a client may send before seeing it. |
| Going straight to a second connection | Route 1 first; record why it was not enough. |
| Running an OAuth flow because the user's servers need sign-in | The user's decision, off by default. Until then it is a stated limit. |
| "Conformance suite" with no list of rules | Part 2: one row per rule, each with its test. |
| Tested only against your own fixture | Part 6: a server you did not write. |
| No spec revision named | Part 1. |
