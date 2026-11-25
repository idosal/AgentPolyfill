import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Delivery } from '../../core/src/delivery.ts';
import { Spool } from '../../core/src/store.ts';
import { conversationId } from './conversation.ts';
import { milliseconds } from './settings.ts';
import { writePrivate, type Surface } from '../../../server-cards/antigravity/src/gate.ts';

export const requestsDir = (base: string) => join(base, 'wake-requests');

/**
 * Where a conversation lives, as its hook last said. Only the App runs
 * sidecars, and agentapi reaches only the App's conversations: only a
 * conversation recorded as the App's is sent a wake. A
 * CLI, IDE or unknown one waits for its next model call.
 */
export function recordSurface(base: string, id: string, surface: Surface) {
    if (!conversationId(id)) return;
    const dir = join(base, 'sessions', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(join(dir, 'surface.json'), JSON.stringify({ surface }));
}
export function surfaceOfSession(base: string, id: string): Surface {
    try {
        const s: unknown = JSON.parse(readFileSync(join(base, 'sessions', id, 'surface.json'), 'utf8')).surface;
        return s === 'app' || s === 'cli' || s === 'ide' ? s : 'unknown';
    } catch { return 'unknown'; }
}
export const wakeable = (base: string, id: string) => surfaceOfSession(base, id) === 'app';
/** Coalesced hint, never a second copy of a server payload. Reconciled with the spool. */
export function requestWake(base: string, id: string, env: NodeJS.ProcessEnv) {
    if (!conversationId(id) || !wakeable(base, id)) return;
    mkdirSync(requestsDir(base), { recursive: true, mode: 0o700 });
    const file = join(requestsDir(base), `${id}.json`);
    const now = Date.now();
    let after = now + milliseconds(env.MCP_EVENTS_BATCH_MS, 1000);
    try { const old = JSON.parse(readFileSync(file, 'utf8')).after; if (typeof old === 'number' && old > now) after = Math.min(after, old); } catch {}
    writePrivate(file, JSON.stringify({ conversationId: id, after }));
}

/** Reopen for each read: another process may have advanced delivered.pos. */
export function pending(base: string, id: string) {
    if (!conversationId(id) || !existsSync(join(base, 'sessions', id, 'events.jsonl'))) return;
    const spool = new Spool(base, id);
    return { spool, delivery: new Delivery(spool) }; // Payload values never go into injected steps.
}
export function readNumber(file: string): number {
    try {
        const n: unknown = JSON.parse(readFileSync(file, 'utf8')).bytes;
        return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } catch { return 0; }
}
