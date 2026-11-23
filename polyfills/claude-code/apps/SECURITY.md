# Security

Please report security issues privately, through this repository's
**Security → Report a vulnerability** form on GitHub, rather than in a
public issue. Include what an attacker controls (an MCP server, an app's
page, another local program) and what they gain.

The plugin runs each MCP App's page in a sandboxed iframe inside a dedicated
headless Chrome, under the app's Content Security Policy. Its helper answers
only requests that carry its per-session token. [docs/DESIGN.md](docs/DESIGN.md)
describes the isolation in detail.
