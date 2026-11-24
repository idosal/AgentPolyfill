---
description: The create-polyfill and design-extension skills, and the contract every AgentPolyfill polyfill meets.
---

# Build a polyfill

Two skills, in one plugin, walk an agent through the work:

- **`create-polyfill`** builds client support for a published MCP extension
  inside a host that has not shipped it, to the contract below.
- **`design-extension`** designs new behaviour on top of MCP the way the
  protocol's extension rules expect, starting by checking whether an existing
  slot or proposal already covers it.

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```

Then ask for the extension you want, for example "polyfill MCP Server Cards in
Claude Code". The skill points the agent at the primary sources (the SEP, the
extension's spec, the core spec for the revision in use, the conformance suite)
and has it work from those.

Both skills are plain `SKILL.md` files
([create-polyfill](https://github.com/idosal/AgentPolyfill/blob/main/plugins/polyfill-author/skills/create-polyfill/SKILL.md),
[design-extension](https://github.com/idosal/AgentPolyfill/blob/main/plugins/polyfill-author/skills/design-extension/SKILL.md)),
so other agents that read skills can use them too.

## The contract

Every polyfill in this repository meets these rules. Where one does not yet, its
README says so. The full text is in
[`docs/polyfill-contract.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/polyfill-contract.md).

1. **One published extension, client side, and nothing else.** It adds no
   methods, fields, capabilities or policy of its own. One exception is allowed:
   an earlier form of the same extension that servers in real use still speak,
   mapped onto the spec's behaviour, with one setting that turns it off, and
   stated in its README.
2. **A named revision.** Its README names the spec and revision it implements
   (for example "SEP-3415, Final").
3. **Tested against the spec and against someone else's server.** One test for
   each rule the spec puts on a client (each MUST and SHOULD that can be
   tested), an interop run against a server
   implementation the polyfill's author did not write, and the upstream MCP
   conformance suite where it has client scenarios for the extension.
4. **It stands down.** When the host supports the extension natively, the
   polyfill does nothing. Until there is a sound way to detect it, it has a
   setting that turns it off and says so.
5. **It says what it cannot do.** For each host: what works, what does not, and
   which change in the host would close each gap.
6. **Server content is untrusted data.** What a server sends is data from that
   server, treated the way the host treats a tool result. Receiving it grants
   nothing, and a polyfill never reads the host's stored credentials.

## `create-polyfill`

**The spec is the feature list.** What the polyfill does is the set of client
rules in the spec. That is what lets it be deleted later without anyone
noticing.

The skill asks for seven parts, and the work is done when all seven exist:

| # | Part | What it is |
|---|---|---|
| 1 | Spec record | The extension's identifier, the spec's name and revision, and a link. |
| 2 | Client-rule checklist | One row for each rule the spec puts on a client or host (every MUST, MUST NOT, SHOULD): where it is in the spec, the test that covers it, and its state. |
| 3 | Route table | For each thing the extension needs on the wire, how this host lets you reach it, and what that route cannot do. |
| 4 | Implementation | Code for the rows of part 2, over the routes of part 3. |
| 5 | Stand-down | What makes the polyfill do nothing when the host supports the extension. |
| 6 | Proof | A test per row of part 2; a run against a server you did not write; a recorded run in the real host. |
| 7 | Limits and host changes | What it does not do on this host, and for each limit the change in the host that would remove it. |

Parts 1 to 3 come before any code. A deadline changes how many rows of part 2
are met, never which parts exist.

Along the way it covers:

- **Sources.** Work from the primary text, fetched now, with the revision or
  commit recorded: the SEP and the extension's spec in full, the core
  specification for the revision the host negotiates, SEP-2133 (Extensions),
  SEP-3392 (Extension Lifecycle), the extension support matrix, and the
  conformance suite.
- **Scope, as three lists.** In the polyfill: client behaviour the spec defines.
  Host presentation: the minimum that makes it usable. Not in the polyfill:
  everything else, however useful, named and left for a separate plugin.
- **A server that does not follow the spec** is refused, and the user is told
  why. Supporting one is a per-server setting the user sets, off by default.
- **Routes,** in order: the host's own connection, then a connection of the
  polyfill's own to the servers the host would itself use, then "not reachable",
  recorded as a limit. The polyfill never reads the host's stored credentials.
- **Stand-down:** a verified check for native support, or a setting that turns
  the polyfill fully off, with the reason detection is not possible yet.
- **Proof** per rule, against someone else's server, in the real host, and with
  upstream conformance where it exists, reported separately as verified and not
  verified.
- **Hosts with no in-process extension layer**, where the only route is a
  gateway: an MCP server that presents the extension as plain tools, with what
  that form loses written down.

## `design-extension`

A polyfill implements a published spec exactly. When what someone wants is not
in any spec, it does not go into a polyfill. It becomes its own extension, with
its own identifier, that the other side can ignore safely, and that can be
proposed for adoption later. **First find out whether it needs to exist.**

**Step 1: look before designing.** Check, in order and from the primary
sources, for a slot in what is already published (a tool's arguments, a
resource, a namespaced `_meta` key), for an existing extension or proposal, and
for a vendor's unofficial extension, and write down what you found. Then:

| What you found | What to do |
|---|---|
| A slot exists | Use it. No extension, and no change to any polyfill. If more than one side is meant to use it the same way, write that down as a convention. |
| An extension or proposal covers it | Implement that (as a polyfill if the host lacks it), or take part in the proposal. |
| It is an addition to someone else's extension | Raise it with that extension's maintainers or working group; to ship before they decide, layer your own extension beside theirs. |
| Nothing covers it | Design a new extension. |

**Step 2: what a new extension consists of.** An identifier under a reversed
domain you control (never `io.modelcontextprotocol/`), a declaration, its wire
surface, defined behaviour when the other side lacks it, safety, a written spec
that says plainly it is unofficial, two implementations, and tests of all four
negotiation combinations.

**Getting it adopted.** Until it goes through the MCP process it is an
unofficial extension. The skill summarises SEP-2133 and SEP-3392: bring it to a
working group or interest group first; experimental work can live in an
`experimental-ext-*` repository; Beta takes an Extensions Track SEP and a
reference implementation in an official SDK; Stable takes a second SEP, two
independent implementations that interoperate, and a conformance scenario.

## An existing polyfill in another host

A polyfill is one folder per extension: the host-neutral part (the protocol,
the spec's client rules and their tests) in `core/`, and one adapter beside it
for each host, which wires that core into what the host lets third-party code
do. Events and Skills are built that way: one `core/`, a `claude-code/` mod and
a `codex/` plugin. Bringing one to another host is a new adapter: find how the
host lets a plugin reach the wire (a connection of its own, a tool call, a way
to wake an idle session), meet the contract there, say what that host cannot
do, and add the plugin to that host's marketplace.
[Contributing](./contributing#bringing-a-polyfill-to-another-host) has the
steps; `create-polyfill` covers it too ("polyfill MCP Apps in Codex").

## Your own, listed in the community directory

A polyfill you keep in your own repository can be listed in the
[community directory](./community) by pull request. Listed polyfills are not
reviewed or shipped by this project; one that meets the contract can move into
the repository after review.

## Adding it to this repository

[Contributing](./contributing) covers the folder layout, the README a polyfill
needs, the marketplace entries, and CI.
