// The connection of the mod's own to one MCP server is ../../core/src/wire.ts,
// shared with the Codex adapter. Here it is made with what the Claude Code mod
// says about itself: its client name and version, and how it words a server
// that needs a sign-in.
import { Connection as CoreConnection } from '../../core/src/wire.ts';
import type { UpstreamConfig } from '../../core/src/upstream.ts';
import { VERSION } from './version.ts';

export * from '../../core/src/wire.ts';

export class Connection extends CoreConnection {
    constructor(label: string, cfg: UpstreamConfig) {
        super(label, cfg, {
            client: { name: 'mcp-skills-polyfill', version: VERSION },
            signInNote: "it needs a sign-in this mod cannot do (it has no access to Claude Code's own sign-in): give the server a header or a headersHelper in its configuration"
        });
    }
}
