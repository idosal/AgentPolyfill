import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { destination as routineUrl } from './deliver.ts';

export function destination(env, post = fetch) {
    let urlValue = env.GROK_ROUTINE_URL,
        key = env.GROK_ROUTINE_KEY;
    if (env.GROK_ROUTINE_FILE) {
        if (!isAbsolute(env.GROK_ROUTINE_FILE)) throw Error('Use an absolute routine credential file path.');
        const fd = openSync(env.GROK_ROUTINE_FILE, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
                throw Error('Use a private routine credential file owned by this account (chmod 600).');
            const contents = readFileSync(fd, 'utf8');
            try {
                ({ url: urlValue, key } = JSON.parse(contents));
            } catch {
                throw Error('Invalid JSON in the private routine credential file.');
            }
        } finally {
            closeSync(fd);
        }
    }
    if (!urlValue) throw Error('Set the URL and key for the configured routine.');
    const url = routineUrl(urlValue);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._~+/=-]{12,512}$/.test(key)) throw Error('Set a valid routine key.');
    return {
        identity: createHash('sha256').update(url.href).digest('hex'),
        async send(body) {
            const response = await post(url, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
                headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
                body
            }).catch(() => {
                throw Error('Routine request failed.');
            });
            await response.body?.cancel();
            if (response.status !== 200) throw Error('Routine returned HTTP ' + response.status);
        }
    };
}

const identifier = (value) => {
    if (Number.isSafeInteger(value)) return String(value);
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/.test(value) ? value : undefined;
};
export function notification(batch, records, settings, summary) {
    const body = { source: 'mcp-events', batch };
    if (!summary) return body;
    body.events = records.map((r) => {
        const policy = settings.get(r.watch);
        const entry = { source: r.server, watch: r.note || r.watch, handle: r.id, eventId: identifier(r.eventId) };
        if (policy) {
            const data = r.data ?? {};
            entry.ticketId = identifier(data[policy.idField ?? 'id']);
            if (policy.includeTitle && typeof data.title === 'string')
                entry.title = Array.from(data.title.replace(/[\p{C}\p{Z}]+/gu, ' ').trim())
                    .slice(0, 160)
                    .join('');
        }
        return entry;
    });
    return body;
}
