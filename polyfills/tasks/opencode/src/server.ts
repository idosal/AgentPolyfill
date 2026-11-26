import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Plugin } from '@opencode/plugin';
import { OpenCodeServers } from '../../../events/opencode/src/config.ts';
import type { Context } from '../../../events/opencode/src/opencode.ts';
import { TaskApp, TOOLS } from '../../core/src/app.ts';
import { supportsForm, validateFormAnswer } from '../../core/src/forms.ts';
import type { AskForm, FormAnswer, ToolAnswer } from '../../core/src/host.ts';
import { TaskStore } from '../../core/src/store.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { exact, secrets } from '../../core/src/untrusted.ts';
import { Dialog } from './rpc.ts';

type Json = Record<string, unknown>;
type Reply = { action: 'accept' | 'decline' | 'cancel'; value?: string };
type Question = {
    ticket: string; proof?: string; title: string; message: string; input: boolean;
    finish: (answer: Reply | { unavailable: string }) => void;
};
const VERSION = '0.1.0';
const SESSION_ID = /^ses_[A-Za-z0-9]{10,80}$/;

function asText(answer: ToolAnswer): string {
    const content = (answer.content ?? []).map((block) => block.type === 'text' ? String(block.text ?? '') :
        block.type === 'resource_link' || (block.type === 'resource' && typeof (block.resource as Json | undefined)?.text === 'string')
            ? JSON.stringify(block) : 'A result block could not be represented by this OpenCode adapter.');
    return secrets.scrub([answer.text, ...content].join('\n'));
}

export default Plugin.define({
    id: 'mcp-tasks-opencode',
    async setup(ctx) {
        if (process.env.MCP_TASKS_OFF === '1') return;
        const pending = new Map<string, Question>();
        const rpc = await ctx.rpc.register(Dialog, {
            async question(raw) {
                const { sessionID, ticket } = raw as { sessionID: string; ticket: string };
                const q = pending.get(sessionID);
                if (!q || q.ticket !== ticket || q.proof) return {};
                q.proof = randomUUID();
                return { title: q.title, message: q.message, input: q.input, proof: q.proof };
            },
            async reply(raw) {
                const { sessionID, ticket, proof, action, value } = raw as Reply & { sessionID: string; ticket: string; proof: string };
                const q = pending.get(sessionID);
                if (q?.ticket === ticket && q.proof === proof) q.finish({ action, value });
                return {};
            }
        });

        const ask = (sessionID: string, signal: AbortSignal): AskForm =>
            async (message, schema, kind, original) => {
                if (signal.aborted) return { action: 'cancel' };
                if (pending.has(sessionID)) return { unavailable: 'another Tasks dialog is already open for this session' };
                const title = kind === 'start' ? 'Start MCP task' : 'MCP task input';
                const input = kind === 'input';
                const requested = original ?? schema;
                if (input && !supportsForm(requested)) return { unavailable: 'this form cannot be represented safely in OpenCode' };
                const question = input ? `${message}\n\nEnter a JSON object with these fields:\n${exact(JSON.stringify(schema, null, 2)).text}` : message;
                if (question.length > 7200 || secrets.holds(question)) return { unavailable: 'the complete question cannot be shown' };

                const ticket = randomUUID();
                const reply = await new Promise<Reply | { unavailable: string }>((resolve) => {
                    const finish: Question['finish'] = (value) => {
                        clearTimeout(timeout);
                        signal.removeEventListener('abort', cancel);
                        if (pending.get(sessionID)?.ticket === ticket) pending.delete(sessionID);
                        resolve(value);
                    };
                    const cancel = () => finish({ action: 'cancel' });
                    const timeout = setTimeout(() => finish({ unavailable: 'no answer from an OpenCode terminal showing this session' }), 90_000);
                    signal.addEventListener('abort', cancel, { once: true });
                    pending.set(sessionID, { ticket, title, message: question, input, finish });
                    void rpc.events.emit('question', { sessionID, ticket }).catch(() => finish({ unavailable: 'OpenCode could not send the question to its terminal' }));
                });
                if ('unavailable' in reply) return reply;
                if (reply.action !== 'accept') return { action: reply.action };
                if (!input) return { action: 'accept', content: { decision: kind === 'start' ? 'start' : 'accept' } };
                let value: unknown;
                try { value = reply.value && reply.value.length <= 6000 ? JSON.parse(reply.value) : undefined; } catch { /* Invalid input. */ }
                const content = validateFormAnswer(value, requested);
                const answer: FormAnswer = content ? { action: 'accept', content } : { unavailable: 'the answer did not match the requested form' };
                return answer;
            };

        const servers = new OpenCodeServers(ctx as unknown as Context);
        let table: ServerTable = { servers: {}, skipped: {} };
        let refreshing: Promise<void> | undefined;
        const refresh = () => refreshing ??= (async () => {
            const snapshot = await servers.table();
            const statuses = (await ctx.mcp.list()).data;
            for (const [name, entry] of Object.entries(snapshot.servers)) {
                const status = statuses.find((next) => next.name === name)?.status;
                if (status?.status !== 'connected' && status?.status !== 'pending') {
                    snapshot.skipped[name] = 'OpenCode has not enabled a usable connection to this server in the session’s location';
                    delete snapshot.servers[name];
                    continue;
                }
                if ('url' in entry) {
                    if (URL.canParse(entry.url)) {
                        const url = new URL(entry.url);
                        secrets.add(url.username, url.password, ...url.searchParams.values());
                    }
                    secrets.add(...Object.values(entry.headers ?? {}));
                } else secrets.add(...Object.values(entry.env ?? {}));
            }
            table = snapshot;
        })().catch(() => { table = { servers: {}, skipped: { '(all servers)': 'OpenCode did not report the MCP server configuration' } }; })
            .finally(() => { refreshing = undefined; });
        const location = createHash('sha256').update(ctx.location.directory).digest('hex').slice(0, 24);
        const base = join(process.env.MCP_TASKS_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode', 'mcp-tasks'), location);
        let app: TaskApp | undefined;
        const tasks = (async () => {
            await servers.applied();
            await refresh();
            app = new TaskApp({
                base,
                host: 'OpenCode', sessionId: SESSION_ID, requireOwner: true,
                table, clientInfo: { name: 'mcp-tasks-opencode', version: VERSION },
                holdsSecret: (value) => secrets.holds(value),
                serverAllowed: (name, config) => JSON.stringify(table.servers[name]) === JSON.stringify(config),
                async wake(sessionID, text) {
                    try {
                        await ctx.session.synthetic({ sessionID, text, description: 'MCP Tasks', metadata: { source: 'mcp-tasks' }, delivery: 'queue', resume: true });
                        return { ok: true, resumed: true };
                    } catch {
                        return { ok: false, why: 'OpenCode did not admit the task notification' };
                    }
                }
            });
            app.resumeAll();
            return app;
        })();

        const tools = await ctx.tool.transform((editor) => {
            editor.namespace({ name: 'mcp_tasks', description: 'Start and follow tasks on MCP servers that offer the MCP Tasks extension.' });
            for (const tool of TOOLS) editor.add({
                name: tool.name, description: tool.description,
                input: tool.inputSchema as never, options: { namespace: 'mcp_tasks', codemode: false },
                async execute(input, call) {
                    const runtime = await tasks;
                    await refresh();
                    runtime.noteTurn(call.sessionID, { visible: true, userStarted: true });
                    const askInTerminal = ask(call.sessionID, call.signal);
                    const answer = await runtime.call(tool.name, (input ?? {}) as Json, {
                        meta: {}, revision: '2026-07-28', signal: call.signal,
                        async ask(...params) {
                            const result = await askInTerminal(...params);
                            await refresh();
                            return result;
                        }
                    }, call.sessionID);
                    return { content: asText(answer) };
                }
            });
        });
        const prompt = await ctx.session.hook('prompt', async (event) => {
            if (SESSION_ID.test(event.sessionID) && TaskStore.exists(base, event.sessionID)) {
                (await tasks).noteTurn(event.sessionID, { visible: true, userStarted: true });
            }
        });
        const timer = setInterval(() => { void refresh().then(() => app?.recheck()); }, 5000);
        timer.unref();
        return async () => {
            clearInterval(timer);
            for (const q of pending.values()) q.finish({ action: 'cancel' });
            await prompt.dispose();
            await tools.dispose();
            await rpc.dispose();
            await (await tasks).stop();
        };
    }
});
