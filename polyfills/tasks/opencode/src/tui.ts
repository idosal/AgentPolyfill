import { Plugin } from '@opencode/plugin/tui';
import { Dialog } from './rpc.ts';

function pages(text: string): string[] {
    const lines = text.split('\n').flatMap((line) => line.match(/.{1,52}/gu) ?? ['']);
    return Array.from({ length: Math.ceil(lines.length / 4) }, (_, page) =>
        lines.slice(page * 4, page * 4 + 4).join('\n'));
}

export default Plugin.define({
    id: 'mcp-tasks-opencode',
    setup(ctx) {
        const rpc = ctx.client.rpc(Dialog);
        const isCurrent = (sessionID: string) => {
            const route = ctx.ui.router.current();
            return route.type === 'session' && route.sessionID === sessionID;
        };
        return rpc.events.on('question', async (event) => {
            const { sessionID, ticket } = event.data as { sessionID: string; ticket: string };
            if (!isCurrent(sessionID)) return;
            const location = event.location ? { directory: event.location.directory } : undefined;
            try {
                const question = await rpc.question({ sessionID, ticket }, { location, signal: AbortSignal.timeout(5000) }) as { title?: string; message?: string; input?: boolean; proof?: string };
                if (!question.proof || !question.title || !question.message || !isCurrent(sessionID)) return;
                let action: 'accept' | 'decline' | 'cancel' = 'cancel';
                let value: string | undefined;
                const review = pages(question.message);
                for (const [index, text] of review.entries()) {
                    const last = index === review.length - 1;
                    const option = last ? (question.input ? 'Enter answer' : 'Approve') : 'Continue review';
                    const choice = await ctx.ui.dialog.select({
                        title: `${question.title} (${index + 1}/${review.length})\n${text}`,
                        options: [{ title: 'Decline', value: false }, { title: option, value: true }]
                    });
                    if (!isCurrent(sessionID) || choice === undefined) break;
                    if (!choice) { action = 'decline'; break; }
                    if (last) {
                        if (question.input) {
                            value = await ctx.ui.dialog.prompt({ title: 'Answer for the MCP server (JSON)' });
                            if (value !== undefined && isCurrent(sessionID)) action = 'accept';
                        } else action = 'accept';
                    }
                }
                await rpc.reply({ sessionID, ticket, proof: question.proof, action, ...(value === undefined ? {} : { value }) }, { location, signal: AbortSignal.timeout(5000) });
            } catch {
                // The server expires unanswered questions. Nothing is approved on transport errors.
            }
        });
    }
});
