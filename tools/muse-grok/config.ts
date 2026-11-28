import { readFileSync } from 'node:fs';

export function readConfig(file: string) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        // Parser diagnostics can contain fragments of a credential-bearing settings file.
        throw Error('Could not read configuration as JSON.');
    }
}

export function securePublisher(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (loopback && url.protocol === 'http:'));
}
