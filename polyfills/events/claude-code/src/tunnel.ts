// A public https address for the local webhook receiver, for use without a relay:
// a forwarder of your own that sends /hooks/* to the receiver.
//
//   MCP_EVENTS_PUBLIC_URL      the forwarder's address
//   MCP_EVENTS_RECEIVER_PORT   the local port it forwards to
//
// The plugin opens nothing public itself.

import { LocalError } from './untrusted.ts';

export type PublicAddress = { url: string; kind: 'configured' };

export const NO_PUBLIC_URL =
    'This event type is delivered by webhook only, so the server needs a public https address to deliver to, and none is set up. There are three ways, for the user to choose between: ' +
    '(1) Set up a relay of their own on their Cloudflare account with /mcp-events:relay-setup; it also keeps events while Claude Code is closed, and nobody else sees them. ' +
    '(2) Use the public relay by setting MCP_EVENTS_RELAY=public: it is run by the author of this mod, and event payloads pass through that server and are kept there for up to 24 hours until collected. ' +
    '(3) Set MCP_EVENTS_PUBLIC_URL to a forwarder of their own that sends /hooks/* to the port in MCP_EVENTS_RECEIVER_PORT. ' +
    'Then restart Claude Code.';

export function publicAddress(env: NodeJS.ProcessEnv = process.env): PublicAddress {
    if (!env.MCP_EVENTS_PUBLIC_URL) throw new LocalError(NO_PUBLIC_URL);
    // This address is given to MCP servers and shown in messages: no credentials, query or fragment in it.
    let u: URL;
    try {
        u = new URL(env.MCP_EVENTS_PUBLIC_URL);
    } catch {
        throw new LocalError('MCP_EVENTS_PUBLIC_URL is not an address.');
    }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    // A webhook address must be https (SEP-3415). Plain http on this machine is for testing only (MCP_EVENTS_DEV=1).
    if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || (env.MCP_EVENTS_DEV === '1' && u.protocol === 'http:' && local))) {
        throw new LocalError('MCP_EVENTS_PUBLIC_URL must be a plain https address, with no user name, password, query or fragment.');
    }
    return { url: (u.origin + u.pathname).replace(/\/$/, ''), kind: 'configured' };
}
