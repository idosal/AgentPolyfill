// The links tools returned in each Codex session, as the hook noted them: one
// JSON line per link in <state>/sessions/<session id>.jsonl. The hook appends,
// the plugin's server reads. Nothing else of a tool's result is kept.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, type NotedLink } from '../../core/src/links.ts';

/** How long a session's notes are kept after their last change. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const fileOf = (state: string, session: string) => join(state, 'sessions', `${session}.jsonl`);

/** Whether a session id is one the store will use as a file name. */
export const validSession = (session: unknown): session is string => typeof session === 'string' && ID.test(session);

export function readNotes(state: string, session: string): NotedLink[] {
    if (!validSession(session)) return [];
    let raw: string;
    try {
        raw = readFileSync(fileOf(state, session), 'utf8');
    } catch {
        return [];
    }
    const out: NotedLink[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            const l = JSON.parse(line) as NotedLink;
            if (typeof l.server === 'string' && typeof l.uri === 'string' && typeof l.name === 'string') out.push(l);
        } catch {
            // a line cut short by a crash: skipped
        }
    }
    return out;
}

/** Appends links to a session's notes, up to LIMITS.linksPerSession, and removes notes older than KEEP_MS. */
export function addNotes(state: string, session: string, links: readonly NotedLink[], now = Date.now()): number {
    if (!validSession(session) || !links.length) return 0;
    const dir = join(state, 'sessions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const room = Math.max(0, LIMITS.linksPerSession - readNotes(state, session).length);
    const kept = links.slice(0, room);
    if (kept.length) appendFileSync(fileOf(state, session), kept.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
    prune(dir, now);
    return kept.length;
}

function prune(dir: string, now: number): void {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = join(dir, n);
        try {
            if (now - statSync(f).mtimeMs > KEEP_MS) rmSync(f, { force: true });
        } catch {
            // gone already
        }
    }
}
