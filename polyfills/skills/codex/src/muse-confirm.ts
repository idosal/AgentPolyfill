// mcp-skills in Muse: the person's yes, typed as a message of their own (see muse.ts), and
// where the plugin keeps it. On its own so the UserPromptSubmit hook bundles nothing else.

import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Ask } from './app.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The plugin's store in Muse: the data folder Muse gives the plugin (removed with `muse plugins remove --delete-data`). */
export function museStoreDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.MCP_SKILLS_STATE) return resolve(env.MCP_SKILLS_STATE);
    if (env.MUSE_PLUGIN_DATA_DIR && isAbsolute(env.MUSE_PLUGIN_DATA_DIR)) return env.MUSE_PLUGIN_DATA_DIR;
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(env.HOME || homedir(), '.local', 'share');
    return join(data, 'muse', 'plugins', 'data', 'mcp-skills');
}

// ---- The person's yes, typed ----

/** How long a question waits for the person's `load <code>`, and how long their yes waits for the next load_skill. */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;
const CONFIRM_FILE = 'muse-confirm.json';
type Pending = { code: string; key: string; summary: string; at: number; approvedAt?: number };

function readPending(dir: string): Record<string, Pending> {
    try {
        const j = JSON.parse(readFileSync(join(dir, CONFIRM_FILE), 'utf8')) as unknown;
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, Pending>) : {};
    } catch {
        return {};
    }
}

function writePending(dir: string, all: Record<string, Pending>, now: number): void {
    for (const [k, v] of Object.entries(all)) if (now - (v.approvedAt ?? v.at) > CONFIRM_TTL_MS) delete all[k];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${CONFIRM_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, join(dir, CONFIRM_FILE));
}

/** What the person types to say yes: the whole message, nothing else. */
export const confirmPhrase = (code: string) => `load ${code}`;

/**
 * The question to the person, in Muse. The first time, it is recorded for this session with a new
 * code, and the answer says what the person types. Once the person's own message was exactly that
 * phrase (the hook records it), the same question is answered "load", once.
 */
export function museAsk(dir: string, session: string | undefined, now: () => number = Date.now): Ask {
    return async (message) => {
        if (!session) return { unavailable: 'Muse did not say which session this is (MUSE_SESSION_ID), so the person cannot confirm by typing' };
        const all = readPending(dir);
        const key = sha256(message);
        const t = now();
        const mine = all[session];
        if (mine && mine.key === key && mine.approvedAt !== undefined && t - mine.approvedAt <= CONFIRM_TTL_MS) {
            delete all[session];
            writePending(dir, all, t);
            return { decision: 'load' };
        }
        const code = mine && mine.key === key && mine.approvedAt === undefined && t - mine.at <= CONFIRM_TTL_MS ? mine.code : String(randomInt(1000, 10000));
        all[session] = { code, key, summary: message.split('\n')[0]!.slice(0, 300), at: t };
        writePending(dir, all, t);
        return {
            pending: [
                `The skill is not loaded yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:`,
                '',
                message,
                '',
                `To load it, they send a message that is exactly: ${confirmPhrase(code)}`,
                'When they have, call load_skill again with the same server and uri. If they say no, or send anything else, do not load it.'
            ].join('\n')
        };
    };
}

/**
 * Called by the hook with the person's own message: when it is exactly the phrase of this
 * session's waiting question, that question is approved. Returns the question's first line, or
 * undefined.
 */
export function confirmFromPrompt(dir: string, session: string, prompt: string, now = Date.now()): string | undefined {
    const all = readPending(dir);
    const mine = all[session];
    if (!mine || mine.approvedAt !== undefined || now - mine.at > CONFIRM_TTL_MS) return undefined;
    if (prompt.trim().toLowerCase() !== confirmPhrase(mine.code)) return undefined;
    mine.approvedAt = now;
    writePending(dir, all, now);
    return mine.summary;
}
