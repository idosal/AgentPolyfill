// Cursors are opaque to clients (SEP-3415, Cursor Lifecycle). Here each one is base64url JSON that
// says where the subscription stands in its upstream feed. The server keeps nothing: everything it
// needs to answer the next poll is in the cursor the client sends back.
//
// A cursor is bound to its event type and to a short hash of its arguments, so a cursor taken from
// one subscription is refused on another instead of silently replaying the wrong feed.

export const MAX_CURSOR_CHARS = 4096;

export class CursorError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
    const t = s.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const base64url = { encode: b64url, decode: unb64url };

/** Canonical JSON: keys sorted, so equal arguments give equal text. */
export function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(',')}}`;
}

/** A short, stable hash of a subscription's arguments (FNV-1a, 32 bits, base36). Not a security boundary. */
export function argsHash(args: Record<string, unknown>): string {
    let h = 0x811c9dc5;
    for (const b of enc.encode(canonical(args))) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

export type CursorBody = { k: string; h: string; [field: string]: unknown };

export function encodeCursor(body: CursorBody): string {
    return b64url(enc.encode(JSON.stringify(body)));
}

/** Reads a cursor for event type `k` with arguments hash `h`. Throws CursorError when it is not one of ours. */
export function decodeCursor(cursor: string, k: string, h: string): CursorBody {
    if (cursor.length > MAX_CURSOR_CHARS) throw new CursorError('cursor is too long');
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorError('cursor is not one this server issued');
    let body: unknown;
    try {
        body = JSON.parse(dec.decode(unb64url(cursor)));
    } catch {
        throw new CursorError('cursor is not one this server issued');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CursorError('cursor is not one this server issued');
    const b = body as CursorBody;
    if (b.k !== k) throw new CursorError('cursor belongs to a different event type');
    if (b.h !== h) throw new CursorError('cursor belongs to a subscription with different arguments');
    return b;
}
