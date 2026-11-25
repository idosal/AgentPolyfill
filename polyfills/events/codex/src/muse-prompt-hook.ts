// mcp-events for Muse: the UserPromptSubmit hook (bundled to plugin/muse/hooks/user-prompt-submit.mjs).
//
// Muse runs it before each message the person sends, with the hook input on standard input
// (Claude Code's shape: `session_id`, `prompt`, …; the input ends without a newline). It gives the
// model what is new for this session, as context added to the message: by default the events the
// helper stored since the last hand-over (it records how far it got), and any batch waiting in the
// session's inbox (where waking through `muse attach` failed). It also stamps the time, which tells
// the helper the person is back.
//
// A turn the plugin itself started (waking through `muse attach`, experimental) begins with
// "[mcp-events]": that is not the person speaking, so it is not stamped. It prints nothing when
// there is nothing to hand over, and never stops the message: any failure ends quietly.

import { readFileSync } from 'node:fs';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { applyPluginSettings, INBOX_MAX_CHARS, museStateDir, readMuseServers, SESSION_ID, stampSpoke, takeInbox, takeStored, wakeMode } from './muse.ts';
import { WAKE_HEADER } from './header.ts';

function main(): void {
    let input: { session_id?: unknown; prompt?: unknown };
    try {
        input = JSON.parse(readFileSync(0, 'utf8')) as typeof input;
    } catch {
        return;
    }
    const session = typeof input.session_id === 'string' && SESSION_ID.test(input.session_id) ? input.session_id.toLowerCase() : undefined;
    if (!session) return;
    const env = process.env;
    const base = museStateDir(env);
    // The same settings file as the helper's: Muse passes hooks no variables of the person's either.
    applyPluginSettings(env, base);
    if (env.MCP_EVENTS_OFF === '1') return;
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trimStart().startsWith(LINE_PREFIX)) {
        try {
            stampSpoke(base, session);
        } catch {
            // the helper has not made the session's folder yet: nothing waits there
        }
    }
    const parts: string[] = [];
    const waiting = takeInbox(base, session);
    if (waiting) parts.push(waiting);
    if (wakeMode(env) === 'inbox') {
        const values = env.MCP_EVENTS_WAKE_VALUES === '1';
        if (values) {
            // A few payload fields go in the lines: what the helper keeps out of them, this keeps out too.
            for (const cfg of Object.values(readMuseServers(env).servers)) secrets.add(...Object.values(isHttp(cfg) ? (cfg.headers ?? {}) : (cfg.env ?? {})));
        }
        const lines = takeStored(base, session, { values, max: INBOX_MAX_CHARS });
        if (lines) parts.push([WAKE_HEADER, ...lines].join('\n'));
    }
    if (!parts.length) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } }));
}

try {
    main();
} catch {
    // a hook that fails must not stop the person's message
}
