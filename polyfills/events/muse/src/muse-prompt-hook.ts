import { readFileSync } from 'node:fs';
import { LINE_PREFIX } from '../../core/src/format.ts';
import { serverEnabled } from './muse-config.ts';
import { confirmFromPrompt } from './muse-confirm.ts';
import { applyPluginSettings, INBOX_MAX_CHARS, museStateDir, SESSION_ID, takeStored } from './muse.ts';
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
    // With the plugin's MCP server not turned on in Muse (rejected, or never approved), nothing of it runs: neither does this.
    if (!serverEnabled(env, env.MUSE_PLUGIN_ID || 'mcp-event-monitor', 'mcp-events')) return;
    const base = museStateDir(env);
    // The same settings file as the helper's: Muse passes hooks no variables of the person's either.
    applyPluginSettings(env, base);
    if (env.MCP_EVENTS_OFF === '1') return;
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const parts: string[] = [];
    let systemMessage: string | undefined;
    const yes = confirmFromPrompt(base, session, prompt);
    if (yes?.verb === 'watch' || yes?.verb === 'unwatch') {
        const tool = yes.verb === 'watch' ? 'watch_event' : 'unwatch_event';
        parts.push(`${LINE_PREFIX} The user's own message is the confirmation ${tool} asked for: they approve "${yes.summary}". Call ${tool} again with the same arguments to ${yes.verb === 'watch' ? 'start it' : 'stop it'}.`);
        systemMessage = `mcp-events: you approved: ${yes.summary}`;
    }
    const lines = takeStored(base, session, { max: INBOX_MAX_CHARS });
    if (lines) parts.push([WAKE_HEADER, ...lines].join('\n'));
    if (!parts.length) return;
    process.stdout.write(JSON.stringify({ ...(systemMessage ? { systemMessage } : {}), hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } }));
}

try {
    main();
} catch {
    // a hook that fails must not stop the person's message
}
