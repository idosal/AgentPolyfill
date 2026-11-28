// Pure Web Crypto helpers for Cloudflare Workers: timing-safe comparison and Standard Webhooks HMAC-SHA256.

const enc = new TextEncoder();

export const FRESHNESS_S = 5 * 60;

export function randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Base64Url(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return bytesToBase64Url(new Uint8Array(digest));
}

export function randomBase64Url(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return bytesToBase64Url(buf);
}

/** `whsec_` + base64 of 32 random bytes (SEP-3415 / Standard Webhooks). */
export function newWebhookSecret(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return 'whsec_' + bytesToBase64(buf);
}

/** Constant-time byte equality. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
}

/** Constant-time string comparison via SHA-256 digests. */
export async function sameText(a: string, b: string): Promise<boolean> {
    const [x, y] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(a)),
        crypto.subtle.digest('SHA-256', enc.encode(b))
    ]);
    return sameBytes(new Uint8Array(x), new Uint8Array(y));
}

export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
    const keyBytes = base64ToBytes(secret.slice('whsec_'.length));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`));
    return 'v1,' + bytesToBase64(new Uint8Array(mac));
}

export type VerifyResult = { ok: true; id: string; timestamp: number } | { ok: false; reason: string; stale?: boolean };

/** Verifies Standard Webhooks `webhook-id`, `webhook-timestamp`, and `webhook-signature` (`v1,`) headers. */
export async function verifyWebhook(
    secret: string,
    headers: Headers,
    body: string,
    nowS = Math.floor(Date.now() / 1000)
): Promise<VerifyResult> {
    const id = headers.get('webhook-id')?.trim() ?? '';
    const rawTs = headers.get('webhook-timestamp')?.trim() ?? '';
    const ts = rawTs ? Number(rawTs) : NaN;
    const sigs = (headers.get('webhook-signature') ?? '').split(' ').filter(Boolean);
    if (!id || !Number.isFinite(ts) || sigs.length === 0) {
        return { ok: false, reason: 'missing Standard Webhooks headers' };
    }
    if (nowS - ts > FRESHNESS_S) return { ok: false, reason: 'timestamp more than 5 minutes old', stale: true };
    if (ts - nowS > FRESHNESS_S) return { ok: false, reason: 'timestamp more than 5 minutes ahead' };
    const expected = base64ToBytes((await signWebhook(secret, id, ts, body)).slice(3));
    for (const s of sigs) {
        if (!s.startsWith('v1,')) continue;
        try {
            const got = base64ToBytes(s.slice(3));
            if (sameBytes(got, expected)) return { ok: true, id, timestamp: ts };
        } catch {
            // malformed base64 signature token; continue checking any remaining v1 signatures
        }
    }
    return { ok: false, reason: 'no matching v1 signature' };
}
