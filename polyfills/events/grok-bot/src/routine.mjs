import { createHash } from 'node:crypto';

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
            const response = await post(url, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
                headers: { authorization: 'Bearer ' + env.GROK_ROUTINE_KEY, 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'mcp-events', batch })
            }).catch(() => { throw Error('Routine request failed.'); });
            await response.body?.cancel();
            if (response.status !== 200) throw Error('Routine returned HTTP ' + response.status);
        }
    };
}
