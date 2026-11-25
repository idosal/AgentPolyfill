// mcp-skills for Muse: the UserPromptSubmit hook (bundled to mod/muse/hooks/user-prompt-submit.mjs).
//
// Muse runs it before each message the person sends (and not for a turn Muse's timers or a model
// start), with the hook input on standard input: `session_id`, `prompt`, … (Claude Code's shape;
// the input ends without a newline). When the message is exactly the `load <code>` that load_skill
// asked for in this session, the question is approved (muse.ts), and the model is told so as context
// added to the message. Anything else: it prints nothing, and never stops the message.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverEnabled } from '../../../events/codex/src/muse-config.ts';
import { confirmFromPrompt, museStoreDir } from './muse-confirm.ts';

function main(): void {
    let input: { session_id?: unknown; prompt?: unknown };
    try {
        input = JSON.parse(readFileSync(0, 'utf8')) as typeof input;
    } catch {
        return;
    }
    const session = typeof input.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.session_id) ? input.session_id.toLowerCase() : undefined;
    if (!session || typeof input.prompt !== 'string') return;
    // With the plugin's MCP server not turned on in Muse (rejected, or never approved), nothing of it runs: neither does this.
    if (!serverEnabled(process.env, process.env.MUSE_PLUGIN_ID || 'mcp-skills')) return;
    const dir = museStoreDir(process.env);
    try {
        if ((JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { off?: unknown }).off === true) return;
    } catch {
        // no settings: on
    }
    const approved = confirmFromPrompt(dir, session, input.prompt);
    if (!approved) return;
    process.stdout.write(
        JSON.stringify({
            systemMessage: `mcp-skills: you approved: ${approved}`,
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: `[mcp-skills] The user's own message is the confirmation load_skill asked for: they approve "${approved}". Call load_skill again with the same server and uri to load it.`
            }
        })
    );
}

try {
    main();
} catch {
    // a hook that fails must not stop the person's message
}
