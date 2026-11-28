import { createHash } from 'node:crypto';

const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const MAX_RETRY_AFTER_MS = 3600000;

export class RoutineError extends Error {
    constructor(message, { status = null, retryable = false, ambiguous = false, retryAfterMs = null } = {}) {
        super(message);
        this.name = 'RoutineError';
        this.status = status;
        this.retryable = retryable;
        this.ambiguous = ambiguous;
        this.retryAfterMs = retryAfterMs;
    }
}

export function parseRetryAfter(value, now = Date.now()) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (/^\d+$/.test(trimmed)) {
        const ms = Number(trimmed) * 1000;
        return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : null;
    }
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return null;
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

function errorCodeOf(error) {
    return error?.cause?.code ?? error?.code;
}

export function destination(env, post = fetch) {
    if (!env.GROK_ROUTINE_URL || !env.GROK_ROUTINE_KEY?.trim())
        throw Error('Set GROK_ROUTINE_URL and GROK_ROUTINE_KEY.');
    let url;
    try {
        url = new URL(env.GROK_ROUTINE_URL);
    } catch {
        throw Error('Expected an HTTPS Grok routine URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw Error('Expected an HTTPS Grok routine URL.');
    return {
        identity: createHash('sha256').update(url.href).digest('hex'),
        async send(batch) {
            let response;
            try {
                response = await post(url, {
                    method: 'POST',
                    redirect: 'error',
                    signal: AbortSignal.timeout(15000),
                    headers: { authorization: 'Bearer ' + env.GROK_ROUTINE_KEY, 'content-type': 'application/json' },
                    body: JSON.stringify({ source: 'mcp-events', batch })
                });
            } catch (error) {
                const code = errorCodeOf(error);
                const preSend = typeof code === 'string' && PRE_SEND_CODES.has(code);
                throw new RoutineError('Routine request failed.', {
                    status: null,
                    retryable: true,
                    ambiguous: !preSend
                });
            }
            await response.body?.cancel();
            if (response.status === 200) return;
            const retryable = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600);
            throw new RoutineError('Routine returned HTTP ' + response.status, {
                status: response.status,
                retryable,
                ambiguous: false,
                retryAfterMs: retryable ? parseRetryAfter(response.headers?.get?.('retry-after')) : null
            });
        }
    };
}
