# Discovery and connection approval

Discovery retrieves publisher-controlled documents. Review the destination and the publisher’s identity before connecting a server. The shared discovery parser validates card structure, handles redirects and bounds retrieved content. A valid card describes the publisher’s claims.

The add tool can check an existing entry with `muse mcp get`. It returns a quoted command for you to review and run. Both the agent and the person may have access to a shell under the host’s ordinary permission settings. The handoff alone cannot guarantee who ran the command. Keep the host’s permission policy in force.

Supply credentials directly through Muse. A secret that Muse cannot represent safely causes the handoff to be refused. See [the shared discovery security notes](../codex/SECURITY.md).
