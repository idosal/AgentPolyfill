# polyfill-author

Two skills for agents:

- `create-polyfill` builds client support for a published MCP extension inside
  a host that has not shipped it, to the
  [polyfill contract](../../docs/polyfill-contract.md).
- `design-extension` designs new behaviour on top of MCP the way the
  protocol's extension rules expect, starting by checking whether an existing
  slot or proposal already covers it.

```
/plugin install polyfill-author --marketplace idosal/AgentPolyfill
```
