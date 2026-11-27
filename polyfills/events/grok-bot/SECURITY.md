# Security

Keep the profile, event spool, routine URL, routine key and source credentials private. Run only trusted stdio commands. The sidecar sends the routine a batch reference over HTTPS and rejects redirects. The webhook key stays in the sidecar's environment.

Server metadata and event contents are untrusted. The routine should validate the batch reference, use a fixed reader command with one argument, and apply only user-approved actions. Source payloads remain in the spool until read by the routine.

Report vulnerabilities through the [repository security process](../../../SECURITY.md).
