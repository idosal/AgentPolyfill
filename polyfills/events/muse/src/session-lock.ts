import { join } from 'node:path';
import { ProjectState } from '../../core/src/store.ts';

export const coordinationDir = (base: string, session: string) => join(base, 'threads', session, 'muse-lock');

// Both the MCP server and prompt hooks can open the same session concurrently.
export function withSessionLock<T>(base: string, session: string, run: (dir: string) => T): T | undefined {
    const dir = coordinationDir(base, session);
    const state = new ProjectState(base, session, { dir });
    if (!state.claim(session).owner) return undefined;
    try { return run(dir); }
    finally { state.release(); }
}
