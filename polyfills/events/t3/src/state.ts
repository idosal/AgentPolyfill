// Where this polyfill keeps its state, and its log.
//
// The state is the watches and events of every thread, and the watcher's log. It sits
// in the agent's home, next to the configuration its servers come from:
// MCP_EVENTS_STATE, else <CODEX_HOME>/mcp-events-t3 (CODEX_HOME, else ~/.codex). So
// two Codex homes (two T3 Code provider instances with their own) get a watcher each.

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome } from '../../codex/src/codex-config.ts';
import { oneLine } from '../../core/src/format.ts';
import { secrets } from '../../core/src/untrusted.ts';

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.MCP_EVENTS_STATE?.trim() || join(codexHome(env), 'mcp-events-t3');
}

const MAX_LOG = 2 * 1024 * 1024;

/** A log for the user: private to them, kept to a few megabytes, with known secrets taken out. */
export function openLog(base: string, file: string, who: string): (s: string) => void {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const path = join(base, file);
    try {
        if (existsSync(path) && statSync(path).size > MAX_LOG) renameSync(path, path + '.1');
        if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
        chmodSync(path, 0o600);
    } catch {
        // logging is best effort
    }
    let n = 0;
    return (s: string) => {
        try {
            if (++n % 200 === 0 && statSync(path).size > MAX_LOG) {
                renameSync(path, path + '.1');
                writeFileSync(path, '', { mode: 0o600 });
            }
            appendFileSync(path, `${new Date().toISOString()} [${who} ${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
        } catch {
            // state dir not ready
        }
    };
}
