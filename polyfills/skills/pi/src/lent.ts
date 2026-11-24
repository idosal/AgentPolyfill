// The connection Pi holds to a server, when Pi lends it to extensions.
//
// Pi 1.6.0 does not: its built-in MCP extension keeps its connections to
// itself. A change to Pi, prototyped against 1.6.0 and not yet proposed, adds
// `pi.getMcpServerSession(name)`: it waits for the server to connect and
// returns a handle that sends any MCP method over Pi's own connection (with
// Pi's sign-in), passes on the server's notifications, and says what the
// server advertised. This file finds that function if it is there, and turns a
// handle into the Skills core's Wire. On a Pi without it, nothing here is used,
// and the extension opens connections of its own.

import type { Wire } from '../../core/src/wire.ts';

type Json = Record<string, unknown>;

/** What the proposed `pi.getMcpServerSession()` returns. */
export interface McpServerSession {
    readonly name: string;
    readonly protocolVersion: string | undefined;
    readonly serverCapabilities: Json | undefined;
    readonly serverInfo: { name: string; version: string } | undefined;
    readonly authenticated: boolean;
    /** Whether Pi's connection is open now. */
    readonly connected?: boolean;
    request(method: string, params?: Json, options?: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; onRequestId?: (id: string | number) => void }): Promise<unknown>;
    onNotification(method: string, listener: (params: unknown) => void): () => void;
}

export type SessionLender = (name: string, options?: { signal?: AbortSignal }) => Promise<McpServerSession | undefined>;

/** The lender, if this Pi has one. */
export function lenderOf(pi: unknown): SessionLender | undefined {
    const fn = (pi as { getMcpServerSession?: unknown }).getMcpServerSession;
    return typeof fn === 'function' ? (fn.bind(pi) as SessionLender) : undefined;
}

/** Pi's connection as the Skills core speaks to a server. Closing it only stops this extension using it: the connection is Pi's. */
export function wireOf(session: McpServerSession): Wire & { readonly connected: boolean; close(): Promise<void>; readonly viaHost: true } {
    let closed = false;
    return {
        label: session.name,
        viaHost: true,
        get revision() {
            return session.protocolVersion;
        },
        get capabilities() {
            return session.serverCapabilities;
        },
        get connected() {
            return !closed && session.connected !== false;
        },
        async request(method, params, options) {
            const r = await session.request(method, params, { signal: options?.signal, timeoutMs: options?.timeoutMs });
            return (typeof r === 'object' && r !== null ? r : {}) as Json;
        },
        async close() {
            closed = true;
        }
    };
}
