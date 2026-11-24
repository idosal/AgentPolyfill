// A public https address for the local webhook receiver, for use without a relay:
// a forwarder of your own that sends /hooks/* to the receiver.
//
//   MCP_EVENTS_PUBLIC_URL      the forwarder's address
//   MCP_EVENTS_RECEIVER_PORT   the local port it forwards to
//
// The plugin opens nothing public itself.

import { CLAUDE_CODE, host } from './host.ts';
import { LocalError } from './untrusted.ts';

export type PublicAddress = { url: string; kind: 'configured' };

/** What Claude Code's mod says; each host's own words are `host.noPublicUrl`. */
export const NO_PUBLIC_URL = CLAUDE_CODE.noPublicUrl;

export function publicAddress(env: NodeJS.ProcessEnv = process.env): PublicAddress {
    if (!env.MCP_EVENTS_PUBLIC_URL) throw new LocalError(host.noPublicUrl);
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
