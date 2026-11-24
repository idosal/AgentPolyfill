// Demo-button channels. A channel id is 9 random bytes and the time it was made, signed with the
// server's CHANNEL_SECRET: unguessable (so strangers cannot press each other's buttons or read each
// other's presses), unforgeable (so nobody can make a channel that outlives its hour), and checkable
// without storing anything. Nothing about the visitor goes into it.

import { base64url } from './cursor.ts';

export const CHANNEL_TTL_MS = 60 * 60_000;
export const CHANNEL_RE = /^b[A-Za-z0-9_-]{30}$/;

async function key(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function tag(secret: string, body: Uint8Array): Promise<string> {
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), body));
    return base64url.encode(sig.slice(0, 9));
}

export async function mintChannel(secret: string, now: number): Promise<string> {
    const body = new Uint8Array(13);
    crypto.getRandomValues(body.subarray(0, 9));
    new DataView(body.buffer).setUint32(9, Math.floor(now / 1000));
    return `b${base64url.encode(body)}${await tag(secret, body)}`;
}

export type ChannelCheck = { ok: true; madeAt: number; expiresAt: number } | { ok: false; why: 'invalid' | 'expired'; expiresAt?: number };

export async function checkChannel(secret: string, id: string, now: number): Promise<ChannelCheck> {
    if (!CHANNEL_RE.test(id)) return { ok: false, why: 'invalid' };
    let body: Uint8Array;
    try {
        body = base64url.decode(id.slice(1, 19));
    } catch {
        return { ok: false, why: 'invalid' };
    }
    if (body.length !== 13) return { ok: false, why: 'invalid' };
    const want = await tag(secret, body);
    // Constant-time comparison of the signature.
    const got = id.slice(19);
    let diff = want.length ^ got.length;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
    if (diff !== 0) return { ok: false, why: 'invalid' };
    const madeAt = new DataView(body.buffer, body.byteOffset).getUint32(9) * 1000;
    const expiresAt = madeAt + CHANNEL_TTL_MS;
    if (madeAt > now + 60_000) return { ok: false, why: 'invalid' };
    if (now >= expiresAt) return { ok: false, why: 'expired', expiresAt };
    return { ok: true, madeAt, expiresAt };
}
