# Security

Keep the profile, event spool, routine URL, routine key and source credentials private. Run only trusted stdio commands. The sidecar sends the routine a batch reference over HTTPS and rejects redirects. The webhook key stays in the sidecar's environment.

Server metadata and event contents are untrusted. The routine should validate the batch reference, use a fixed reader command with one argument, and apply only user-approved actions. Source payloads remain in the spool until read by the routine.

For a remote reader, keep its bearer key separate from the routine key and source credentials. Requests are scoped to one profile chosen at startup. Serve the loopback reader behind HTTPS and have Grok invoke the configured connector with the supplied batch. The credential allows access to published events in that profile; the batch reference is not an access credential. Reader logs contain batch references and page counts. Keep them private. The tool returns server-provided data under `untrustedEvents`.

Report vulnerabilities through the [repository security process](../../../SECURITY.md).
