# polyfill-author

Two skills for extending MCP support in hosts that have not shipped an
extension yet.

- `create-polyfill` walks an agent through building a polyfill: the client
  side of one published MCP extension, inside a host that lacks it, held to the
  repository's contract (the spec's client rules as a checklist, a run against
  a server someone else wrote, stand-down, stated limits).
- `design-extension` covers behaviour no spec has yet: check whether the
  protocol already has a place for it, and if not, shape it as its own
  extension and take it to the working group.

Ask for what you want, for example "polyfill MCP Server Cards in Claude Code".

More: https://github.com/idosal/MCPolyfill
