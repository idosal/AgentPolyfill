# Security

The extension uses Pi's built-in MCP configuration, the current project trust verdict, and Pi's callable tool list. A separate connection lets it send the Tasks capability to a server. Only the per-start Pi dialog authorizes the resulting call. Declining, cancelling or having no dialog stops the request. The first choice declines. The confirmation includes the server, tool, and all arguments as sent, with hidden characters shown explicitly.

A task's wire ID remains in private local state and is sent only to the server that issued it. Wakes contain the extension's local ID and configured server name. Tool results are presented as server data and give no authority for a later tool call. Each input answer comes from Pi's user dialog, is checked against the form, and is sent to the task's server.

The extension does not read Pi's sign-in files. URLs or configuration values may contain credentials supplied by the person. Known configured secrets are removed from displayed outputs, and arguments containing a known secret are refused before approval.

Task state includes the local and server task IDs, approved arguments, progress, questions and results. Files are private to the account running Pi. A process with access to that account can read them. Delete the `mcp-tasks` state directory to remove this data after removing the extension.

For reporting, see the repository's [security policy](../../../SECURITY.md).
