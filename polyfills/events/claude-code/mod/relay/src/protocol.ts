// What the relay and the plugin say to each other. Shared by both sides: the
// plugin imports this file too, so keep it free of Workers-only and Node-only APIs.
//
// A mailbox belongs to whoever holds its key. The mailbox's public name is the
// SHA-256 of that key, so the relay stores no credential and needs no sign-up:
// presenting a key whose hash is the name in the address proves ownership.
//
//   POST /hooks/<mailbox>/<hook>          an MCP server's webhook delivery
//   GET  /mailboxes/<mailbox>/socket      the plugin's WebSocket (subprotocols below)
//
// The socket carries JSON text frames, plus the bare strings "ping" and "pong".

export const SUBPROTOCOL = 'mcp-events-relay.v1';
/** Subprotocol entries that carry credentials: `key.<mailbox key>` and `access.<relay access key>`. */
export const KEY_PREFIX = 'key.';
export const ACCESS_PREFIX = 'access.';

export const HOOKS_PATH = '/hooks/';
export const MAILBOX_RE = /^[A-Za-z0-9_-]{43}$/;
export const HOOK_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const KEY_RE = /^[A-Za-z0-9_-]{43,128}$/;
/** Access keys travel as a WebSocket subprotocol, so they are limited to these characters. */
export const ACCESS_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** A delivery's Standard Webhooks headers, exactly as the MCP server sent them. */
export type DeliveryHeaders = {
    'webhook-id': string;
    'webhook-timestamp': string;
    'webhook-signature': string;
    'x-mcp-subscription-id'?: string;
};

/** Plugin to relay. `n` numbers a request; the relay answers `ok` or `error` with the same `n`. */
export type ClientMessage =
    /** Start (or resume) receiving for a hook. The relay answers `ok`, then sends what it holds for the hook. */
    | { t: 'add'; n: number; hook: string }
    /** Stop a hook for good: its queue is dropped and later deliveries get 410. */
    | { t: 'remove'; n: number; hook: string }
    /** These deliveries are safely written down (or were rejected); the relay may forget them. */
    | { t: 'ack'; seqs: number[] }
    /** The answer to an `ask`: the HTTP status and body the relay returns to the MCP server. */
    | { t: 'answer'; id: string; status: number; body?: string };

/** Relay to plugin. */
export type RelayMessage =
    | { t: 'hello'; v: 1; now: number }
    /** `queued`: after an `add`, how many held deliveries follow. */
    | { t: 'ok'; n: number; queued?: number }
    | { t: 'error'; n?: number; message: string }
    /** A stored delivery. `body` is the request body unchanged; `receivedAt` is when the relay got it (Unix seconds). */
    | { t: 'delivery'; seq: number; hook: string; headers: DeliveryHeaders; body: string; receivedAt: number }
    /** A request that needs an answer now (a verification challenge). It is never stored. */
    | { t: 'ask'; id: string; hook: string; headers: DeliveryHeaders; body: string; receivedAt: number };

/** The mailbox a key opens: base64url(SHA-256(key)). */
export async function mailboxIdOf(key: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
