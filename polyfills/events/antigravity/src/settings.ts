import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYS = new Set(['OFF', 'PRE_STANDARD', 'SERVERS', 'SKIP', 'CONFIG', 'BATCH_MS', 'WAKE_GAP_S', 'WAKES_PER_HOUR', 'MIN_POLL_MS', 'CONNECT_TIMEOUT_MS', 'RELAY', 'RELAY_URL', 'RELAY_ACCESS_KEY', 'RELAY_FILE', 'PUBLIC_URL', 'RECEIVER_PORT'].map(k => `MCP_EVENTS_${k}`));

/** Shared by the server, hooks and sidecar. No host configuration is written. */
export function settings(base: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    let saved: Record<string, string> = {};
    try {
        const value: unknown = JSON.parse(readFileSync(join(base, 'settings.json'), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        saved = Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => KEYS.has(e[0]) && typeof e[1] === 'string'));
    } catch (e) {
        // An unreadable settings file may contain stand-down: fail closed.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') saved.MCP_EVENTS_OFF = '1';
    }
    return { MCP_EVENTS_RELAY_FILE: join(base, 'relay.json'), ...saved, ...env };
}

export const milliseconds = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v?.trim() && Number.isFinite(n) && n >= 0 ? Math.min(n, 2 ** 31 - 1) : fallback;
};
