// mcp-skills in Muse: where the plugin keeps its state, and the person's yes to a load, typed as
// a message of their own (`load <code>`; the shared mechanism is mcp-events' muse-confirm.ts). On
// its own so the UserPromptSubmit hook bundles nothing else.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { askTyped, CONFIRM_TTL_MS, confirmFromPrompt as confirmTyped, confirmPhrase as typedPhrase } from '../../../events/codex/src/muse-confirm.ts';
import type { Ask } from './app.ts';

export { CONFIRM_TTL_MS };

/** The plugin's store in Muse: the data folder Muse gives the plugin (removed with `muse plugins remove --delete-data`). */
export function museStoreDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.MCP_SKILLS_STATE) return resolve(env.MCP_SKILLS_STATE);
    if (env.MUSE_PLUGIN_DATA_DIR && isAbsolute(env.MUSE_PLUGIN_DATA_DIR)) return env.MUSE_PLUGIN_DATA_DIR;
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(env.HOME || homedir(), '.local', 'share');
    return join(data, 'muse', 'plugins', 'data', 'mcp-skills');
}

/** What the person types to load a skill: the whole message, nothing else. */
export const confirmPhrase = (code: string) => typedPhrase('load', code);

/**
 * The question to the person, in Muse. The first time, it is recorded for this session with a new
 * code, and the answer says what the person types. Once a message of theirs was exactly that
 * phrase (the hook records it), the same question is answered "load", once. "Show me its SKILL.md
 * first" is never offered: Muse has no way to show the person text the model doesn't see.
 */
export function museAsk(dir: string, session: string | undefined, now: () => number = Date.now): Ask {
    return async (message) => {
        const r = askTyped(dir, session, 'load', message, now());
        if ('approved' in r) return { decision: 'load' };
        if ('unavailable' in r) return { unavailable: r.unavailable };
        return {
            pending: [
                'The skill is not loaded yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:',
                '',
                message,
                '',
                `To load it, they send a message that is exactly: ${r.pending}`,
                'When they have, call load_skill again with the same server and uri. If they say no, or send anything else, do not load it.'
            ].join('\n')
        };
    };
}

/** Called by the hook with the person's own message: the first line of the load it approves, or undefined. */
export function confirmFromPrompt(dir: string, session: string, prompt: string, now = Date.now()): string | undefined {
    const r = confirmTyped(dir, session, prompt, now);
    return r?.verb === 'load' ? r.summary : undefined;
}
