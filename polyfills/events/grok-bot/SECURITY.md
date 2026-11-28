# Security

Keep the profile directory (`GROK_EVENTS_HOME`, mode `0700`), `reader.key` (mode `0600`), event spool, routine URL, routine key, and upstream source credentials private. Run only trusted stdio commands.

## Transport & authentication

- **Routine wakes:** Sent strictly over HTTPS with `redirect: 'error'` and a 15-second timeout. The webhook body contains only `{ "source": "mcp-events", "batch": "<inbox>.e<first>-e<last>" }`—never untrusted event payloads or secrets.
- **MCP connector (`/mcp`):** Authenticated via timing-safe comparison against `Authorization: Bearer <reader key>`. Keep `GROK_EVENTS_READER_KEY` separate from `GROK_ROUTINE_KEY` and upstream credentials.
- **DNS rebinding protection:** If `GROK_EVENTS_READER_ORIGIN` is set, only that exact `https://` origin is accepted. If unset, any request carrying a browser `Origin` header is rejected with HTTP `403`, while server-to-server MCP clients (which send no `Origin`) remain reachable.
- **Health endpoint (`/health`):** Unauthenticated `GET /health` returns liveness, watch count, and delivery/spool counters only—never secrets, server URLs, or event payloads.

## Untrusted server data & tool scope

- Server descriptions, event metadata, and event payloads are untrusted external data returned under `untrustedEvents` (or explicitly labeled as untrusted data). Receiving an event does not grant permission to execute actions.
- In integrated `start` mode, `watch_event` and `unwatch_event` can only subscribe to servers explicitly configured by the operator in `config.json`. The connector cannot add new upstream URLs or stdio commands at runtime.
- Logs scrub known routine, reader, and upstream credentials. Keep logs private as they contain batch references and watch IDs.

Report vulnerabilities through the [repository security process](../../../SECURITY.md).
