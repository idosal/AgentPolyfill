import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AskForm } from '../../core/src/host.ts';
import { exact, secrets } from '../../core/src/untrusted.ts';

import { supportsForm, validateFormAnswer } from '../../core/src/forms.ts';

async function choose(ctx: ExtensionContext, title: string, text: string, accept: string, signal?: AbortSignal) {
    const cancel = 'Decline';
    const ask = async (heading: string, text: string, yes: string) => {
        const answer = await ctx.ui.select(`${heading}\n${text}`, [cancel, yes], { signal });
        return signal?.aborted || answer === undefined ? 'cancel' : answer === yes ? 'accept' : 'decline';
    };
    if (ctx.mode !== 'tui') return ask(title, text, accept);
    const lines = text.split('\n').flatMap((line) => line.match(/.{1,34}/gu) ?? ['']);
    const pages = Math.ceil(lines.length / 4);
    for (let page = 0; page < pages; page++) {
        const decision = page === pages - 1 ? accept : 'Continue review';
        const heading = `${title} (${page + 1}/${pages})`;
        const answer = await ask(heading, lines.slice(page * 4, page * 4 + 4).join('\n'), decision);
        if (answer !== 'accept') return answer;
    }
    return 'accept';
}

export function askPi(ctx: ExtensionContext, signal?: AbortSignal): AskForm {
    return async (message, schema, kind, originalSchema) => {
        if (!ctx.hasUI || signal?.aborted) return { unavailable: 'Pi has no interactive question in this mode' };
        const requested = originalSchema ?? schema;
        if (kind !== 'start' && !supportsForm(requested)) {
            return { unavailable: 'the server requested a form Pi cannot represent safely' };
        }
        const title = kind === 'start' ? 'Start MCP task' : 'MCP task input';
        if (kind !== 'input') {
            const action = await choose(ctx, title, secrets.scrub(message), kind === 'start' ? 'Start it' : 'Accept', signal);
            return action === 'accept' ? { action, content: { decision: kind === 'start' ? 'start' : 'accept' } } : { action };
        }
        const displayed = exact(JSON.stringify(schema, null, 2)).text;
        if (displayed.length + message.length > 6000) return { unavailable: 'the form is too long to display' };
        const action = await choose(ctx, title, `${secrets.scrub(message)}\n\nEnter a JSON object using this schema if you continue:\n${displayed}`, 'Enter answer', signal);
        if (action !== 'accept') return { action };
        const input = await ctx.ui.input('Answer for the MCP server (JSON)', '{}', { signal });
        if (signal?.aborted || input === undefined) return { action: 'cancel' };
        let data: unknown;
        try { data = input.length <= 6000 ? JSON.parse(input) : undefined; } catch { data = undefined; }
        const content = validateFormAnswer(data, requested);
        return content ? { action: 'accept', content } : { unavailable: 'the answer did not match the requested form' };
    };
}
