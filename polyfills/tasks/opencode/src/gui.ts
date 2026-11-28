import { createKeyed, Plugin } from '@opencode/plugin/gui';
import { onCleanup } from 'solid-js';
import { Dialog } from './rpc.ts';

export default Plugin.define({
    setup(ctx) {
        createKeyed(() => ctx.sessions.current(), session => {
            const rpc = session.server.client.rpc(Dialog);
            const current = () => ctx.sessions.current()?.visit === session.visit && document.hasFocus();
            onCleanup(rpc.events.on('wake', event => {
                if (typeof event.data.message === 'string' && event.data.sessionID === session.id && event.location?.directory === session.directory && current()) {
                    ctx.toast.show({ title: 'MCP Tasks', description: event.data.message });
                }
            }));
            const show = async (ticket: string) => {
                if (!current()) return;
                const sessionID = session.id;
                const location = { directory: session.directory };
                const options = () => ({ location, signal: AbortSignal.timeout(5000) });
                const question = await rpc.question({ sessionID, ticket }, options()) as Partial<{ proof: string; input: boolean; title: string; message: string }>;
                if (!question.proof) return;
                let action: 'cancel' | 'accept' | 'decline' = 'cancel';
                let value: string | undefined;
                try {
                    if (!question.title || !question.message || !current()) return;
                    if (question.input) {
                        value = await ctx.dialogs.prompt({ title: question.title, description: question.message, placeholder: 'JSON object' });
                        if (value !== undefined && current()) action = 'accept';
                    } else {
                        const yes = await ctx.dialogs.confirm({ title: question.title, description: question.message, confirm: 'Approve', cancel: 'Decline', danger: true });
                        if (current()) action = yes ? 'accept' : 'decline';
                    }
                } finally {
                    await rpc.reply({ sessionID, ticket, proof: question.proof, action, ...(action === 'accept' && value !== undefined ? { value } : {}) }, options());
                }
            };
            onCleanup(rpc.events.on('question', async event => {
                if (event.data.sessionID === session.id && typeof event.data.ticket === 'string' &&
                    event.location?.directory === session.directory) await show(event.data.ticket);
            }));
            // A newly created session may emit the question before its screen mounts.
            const check = async () => {
                if (!current()) return;
                const result = await rpc.pending({ sessionID: session.id }, { location: { directory: session.directory }, signal: AbortSignal.timeout(5000) }) as { ticket?: string };
                if (result.ticket) await show(result.ticket);
            };
            const refresh = () => { void check().catch(() => {}); };
            window.addEventListener('focus', refresh);
            onCleanup(() => window.removeEventListener('focus', refresh));
            refresh();
        });
    }
});
