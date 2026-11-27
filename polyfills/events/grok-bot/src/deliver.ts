import { createHash } from 'node:crypto';
import { open, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export function destination(value: string) {
    const url = new URL(value);
    if (url.origin !== 'https://api2.cursor.sh' || url.username || url.password || url.search || url.hash ||
        !/^\/automations\/webhook\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(url.pathname)) throw Error('Use the HTTPS URL copied from the Grok test routine.');
    return url;
}
export function receiptFor(url: URL, directory: string) {
    return join(directory, createHash('sha256').update(url.href).digest('hex') + '.json');
}
export async function deliverOnce(url: URL, key: string, directory: string, send = fetch) {
    if (!/^[A-Za-z0-9._~+/=-]{12,512}$/.test(key)) throw Error('Invalid routine key.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
        throw Error('Use a private receipt directory owned by the watcher account (chmod 700).');
    }
    const receipt = await open(receiptFor(url, directory), 'wx', 0o600);
    try { await receipt.writeFile(JSON.stringify({ reservedAt: new Date().toISOString() })); await receipt.sync(); }
    finally { await receipt.close(); }
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    // Any subsequent failure is ambiguous. Keep the reservation, including on transport errors.
    const response = await send(url, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + key }, body: '', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    return response.status;
}
