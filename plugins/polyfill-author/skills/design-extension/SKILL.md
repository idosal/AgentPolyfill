---
name: design-extension
description: Designs new protocol behaviour on top of MCP the way the protocol's own extension rules expect, starting by checking whether an existing slot or proposal already covers it. Use when someone wants behaviour that no published MCP extension defines; wants to add to, change or build on an existing MCP extension or SEP; wants to design a new extension, capability or convention on top of MCP; or asks to put such a feature into a polyfill or a server so that it just works.
---

# Design an extension on top of MCP

A polyfill implements a published spec exactly. When what someone wants is not
in any spec, it does not go into a polyfill. It becomes its own extension,
with its own identifier, that the other side can ignore safely, and that can be
proposed for adoption later.

**First find out whether it needs to exist.** Most "new features" already have
a slot in the protocol, or a proposal in progress.

## Step 1: look before designing

Check these, in order, from the primary sources (see "Sources" in the
`create-polyfill` skill), and write down what you found:

1. **A slot in what is already published.** Read the base spec and the
   extension concerned for a place meant for this: a tool's or event type's
   `inputSchema` arguments, a resource, a prompt, a settings object, a
   namespaced `_meta` key. Use a primitive for what the spec says it is for.
   Example: filtering which events a subscription receives is what an event
   type's subscription arguments are for; it needs no extension.
2. **An existing extension or proposal.** The extensions page, the `ext-*` and
   `experimental-ext-*` repositories, open and closed SEPs, and the working
   group's discussions.
3. **A vendor's unofficial extension** that already does it.

Then choose one outcome and say which:

| What you found | What to do |
|---|---|
| A slot exists | Use it. No extension, and no change to any polyfill: what travels in a published slot is already within the spec. If more than one server or client is meant to use the slot the same way (an argument's name, a small grammar), write that down as a convention: a short document, with no identifier and no negotiation. |
| An extension or proposal covers it | Implement that (as a polyfill if the host lacks it), or take part in the proposal. |
| It is an addition to someone else's extension | Raise it with that extension's maintainers or working group. To ship before they decide, layer your own extension beside theirs (below); never change their messages or reuse their identifier. |
| Nothing covers it | Design a new extension (below). |

A convention over existing primitives is a complete answer, not a second-best
one. It ships without waiting for anyone, and nothing has to be negotiated.
What it still needs is the written convention, and a check that clients and
servers which know nothing about it behave exactly as before.

What the written record of step 1 looks like:

```
Presence (who is active in a document)
- Slot in what is published: resources (current state) with resource
  subscriptions (changes). Covers it: yes, as a convention.
- Existing extension or proposal: none found on the extensions page, in the
  ext-* and experimental-ext-* repositories, or in open SEPs (searched
  "presence").
- Vendor extension: none found.
Outcome: a slot exists. A convention document; no extension.
```

## Step 2: what a new extension consists of

This step applies only when step 1 ended at "nothing covers it", or when you
are layering beside someone else's extension. Each part is required.

| # | Part | What it is |
|---|---|---|
| 1 | **Identifier** | `{vendor-prefix}/{extension-name}`, where the prefix is a reversed domain you control (`com.example/presence`). `io.modelcontextprotocol/` is for official extensions only. A breaking change later means a new identifier. |
| 2 | **Declaration** | How each side advertises it under `extensions` in its capabilities, and the schema of its settings object (an empty object if none). Check the base spec for the protocol revision in use: where capabilities travel differs between revisions. |
| 3 | **Wire surface** | Every method, notification and `_meta` key it adds, with schemas. New names live under your own prefix or method namespace. It adds nothing to another spec's messages except through a namespaced `_meta` key. |
| 4 | **Behaviour without it** | What each side does when the other has not declared it: fall back to core behaviour, or refuse with a stated error. Neither side sends the extension's messages before seeing the other's declaration. |
| 5 | **Safety** | What in it is untrusted input and how it is bounded and validated; what a server could learn or cause that it could not before; what needs the user's consent. |
| 6 | **Spec text** | One document, written with MUST / SHOULD / MAY as the core spec uses them, covering parts 1 to 5. It carries a version, and says plainly that it is an unofficial extension, not recognised by MCP governance. |
| 7 | **Two implementations** | A client and a server that interoperate, each off by default and switched on explicitly. |
| 8 | **Negotiation tests** | All four combinations (both sides have it, only the client, only the server, neither) pass, and the two without it behave exactly as before the extension existed. |

Keep the design small. Every method and field is something another
implementer has to build to adopt it.

## Where it lives

- **Not in a polyfill.** A polyfill of a published extension stays exact, so
  its conformance claim stays true. The new extension is a separate plugin (and
  a separate server module) that can sit beside it.
- **Client side in a host that does not support it:** build it the way a
  polyfill is built (the `create-polyfill` skill: routes, stand-down, proof).
  The spec it is tested against is your own part 6.
- **Naming:** an identifier or project name must not suggest that it is an
  official MCP extension or endorsed by the MCP project.

## Getting it adopted

State the honest position first: until it goes through the MCP process it is
an unofficial extension, and other hosts and servers have no reason to
implement it. The steps below summarise SEP-2133 (Extensions) and SEP-3392
(Extension Lifecycle); read their current text before relying on any of them.

- Bring it to the relevant working group or interest group before writing a
  SEP. An extension has to stay associated with one.
- Experimental work can live in an `experimental-ext-*` repository, which a
  maintainer creates.
- Entering Beta takes an Extensions Track SEP and a reference implementation in
  an official SDK.
- Stable takes a second SEP, two independent implementations (at least one
  client and one server) that interoperate, and a conformance scenario.
- If it is accepted, the identifier changes to the official one. Plan for that
  as a breaking change: both identifiers for a while, then the old one removed.

Real usage is the evidence at every stage, so the list of who implements it,
and what they reported, is worth keeping from the first day.

## Common mistakes

| Mistake | What to do |
|---|---|
| Adding a parameter or field to a published extension's request | Its own method, or a namespaced `_meta` key, declared under your own identifier. |
| Designing before checking for an existing slot or proposal | Step 1, written down. |
| Putting the feature into the polyfill "for now" | A separate plugin. The polyfill stays exact. |
| An identifier under `io.modelcontextprotocol/` | A reversed domain you control. |
| Sending the new messages and seeing whether the other side copes | Declaration first; part 4. |
| Client-side fallback that hides whether the extension is in use | Say which path ran; test the four combinations. |
| "We'll write the spec once it works" | Part 6 before part 7. The two implementations are tests of the text. |
