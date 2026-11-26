import { join } from 'node:path';
import { copilotHome, readCopilotServers, type Configured } from '../../../events/copilot/src/copilot-config.ts';
import { isThePersons, sendWake, type Sender } from '../../../events/copilot/src/waker.ts';
import { TaskApp, TOOLS } from '../../core/src/app.ts';
import { supportsForm, validateFormAnswer } from '../../core/src/forms.ts';
import { type AskForm, type FormAnswer, type ToolAnswer } from '../../core/src/host.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { secrets } from '../../core/src/untrusted.ts';

type Json = Record<string, unknown>;
type Elicit = (params: { message: string; requestedSchema: Json }) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Json }>;
type Invocation = { sessionId: string; signal?: AbortSignal; agentId?: string };
type Session = Sender & {
    sessionId: string;
    on(type: string, handler: (event: { type: string; data?: Json; agentId?: unknown }) => void): () => void;
    rpc?: { mcp?: { listConfigured?: () => Promise<{ servers: Configured[] }> } };
    ui?: { elicitation?: Elicit };
    capabilities?: { ui?: { elicitation?: boolean } };
};
export type Join = (options: {
    hooks?: { onSessionStart: () => Promise<{ additionalContext: string }> };
    tools?: { name: string; description: string; parameters: Json; skipPermission?: boolean; handler: (args: Json, invocation: Invocation) => Promise<ReturnType<typeof result>> }[];
}) => Promise<Session>;
const VERSION = '0.1.0';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function result(answer: ToolAnswer) {
    const textResultForLlm = [answer.text, ...(answer.content ?? []).map((block) => block.type === 'text' ? String(block.text ?? '') :
        block.type === 'resource_link' || (block.type === 'resource' && typeof (block.resource as Json | undefined)?.text === 'string')
            ? JSON.stringify(block) : 'A result block could not be represented by this Copilot adapter.')].join('\n');
    return { textResultForLlm: secrets.scrub(textResultForLlm), resultType: answer.isError ? 'failure' as const : 'success' as const };
}

function ask(session: Session, signal: AbortSignal): AskForm {
    return async (message, schema, kind, original) => {
        if (session.capabilities?.ui?.elicitation !== true || !session.ui?.elicitation) return { unavailable: 'this Copilot surface cannot show an interactive form' };
        if (secrets.holds(message) || secrets.holds(schema)) return { unavailable: 'the question contains a value that cannot be shown' };
        const ui = session.ui;
        const elicit = async (params: Parameters<Elicit>[0]) => {
            signal.throwIfAborted();
            let abort!: () => void;
            const cancelled = new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            });
            try {
                return await Promise.race([ui.elicitation!(params), cancelled]);
            } finally {
                signal.removeEventListener('abort', abort);
            }
        };
        try {
            if (kind === 'input') {
                if (!supportsForm(original ?? schema)) return { unavailable: 'this form cannot be represented safely in Copilot' };
                const answer = await elicit({ message, requestedSchema: schema });
                if (answer.action !== 'accept') return answer;
                const content = validateFormAnswer(answer.content, original ?? schema);
                return content ? { action: 'accept', content } : { unavailable: 'the answer did not match the requested form' };
            }
            // Copilot's terminal can clip long prompts. Review the complete question in pages
            // before the Start or Accept choice appears.
            const lines = message.split('\n').flatMap((line) => line.match(/.{1,52}/gu) ?? ['']);
            const pages = Math.ceil(lines.length / 5);
            for (let page = 0; page < pages; page++) {
                const last = page === pages - 1;
                const positive = last ? (kind === 'start' ? 'Start it' : 'Accept') : 'Continue review';
                const answer = await elicit({
                    message: `MCP Tasks (${page + 1}/${pages})\n${lines.slice(page * 5, page * 5 + 5).join('\n')}`,
                    requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['Decline', positive] } }, required: ['decision'] }
                });
                if (answer.action !== 'accept') return answer;
                if (answer.content?.decision !== positive) return { action: 'decline' };
            }
            const approved: FormAnswer = { action: 'accept', content: { decision: kind === 'start' ? 'start' : 'accept' } };
            return approved;
        } catch {
            return { unavailable: 'Copilot did not display or complete the question' };
        }
    };
}

export async function start(joinSession: Join, env: NodeJS.ProcessEnv = process.env) {
    // The extension itself requires experimental mode, which also enables native
    // SEP-2663 in stock CLI 1.0.115 and 1.0.116. Join without tools by default.
    if (env.MCP_TASKS_OFF === '1' || env.MCP_TASKS_FALLBACK !== '1') {
        await joinSession({});
        return { stop: async () => {} };
    }
    let id: string | undefined;
    let session: Session;
    let app: TaskApp | undefined;
    let table: ServerTable = { servers: {}, skipped: {} };
    let refreshPending: Promise<void> | undefined;
    const refresh = () => refreshPending ??= (async () => {
        let configured;
        try { configured = (await session.rpc?.mcp?.listConfigured?.())?.servers; } catch { /* No trusted config snapshot. */ }
        const snapshot = readCopilotServers({ ...env, MCP_EVENTS_CONFIG: undefined }, () => {}, { configured });
        for (const entry of Object.values(snapshot.servers)) {
            if ('url' in entry) {
                if (URL.canParse(entry.url)) {
                    const url = new URL(entry.url);
                    secrets.add(url.username, url.password, ...url.searchParams.values());
                }
                secrets.add(...Object.values(entry.headers ?? {}));
            } else secrets.add(...Object.values(entry.env ?? {}));
        }
        secrets.add(...snapshot.expanded);
        if (snapshot.skipped['(all servers)']) snapshot.skipped['(all servers)'] = 'Copilot did not report which MCP servers this session uses.';
        table = snapshot;
    })().finally(() => { refreshPending = undefined; });

    let ready!: () => void;
    const joined = new Promise<void>((resolve) => { ready = resolve; });
    session = await joinSession({
        hooks: { onSessionStart: async () => ({ additionalContext: 'Use list_task_servers to find MCP tools that can run as tasks. Read their results with get_task_result, and use provide_task_input when the plugin says a task is waiting for the user.' }) },
        tools: TOOLS.map((tool) => ({
            name: tool.name, description: tool.description, parameters: tool.inputSchema,
            ...(tool.annotations?.readOnlyHint === true ? { skipPermission: true } : {}),
            handler: async (args: Json, invocation: Invocation) => {
                await joined;
                if (!id || !app || invocation?.sessionId?.toLowerCase() !== id || invocation.agentId) {
                    return result({ text: 'MCP Tasks needs a call from the joined Copilot session’s main agent.', isError: true });
                }
                await refresh();
                const deadline = AbortSignal.timeout(120000);
                const signal = invocation.signal ? AbortSignal.any([deadline, invocation.signal]) : deadline;
                const askForm = ask(session, signal);
                return result(await app.call(tool.name, args ?? {}, {
                    meta: {}, revision: '2025-11-25', signal,
                    async ask(...params) {
                        const answer = await askForm(...params);
                        await refresh();
                        return answer;
                    }
                }, id));
            }
        }))
    });
    const joinedId = env.SESSION_ID || session.sessionId;
    if (UUID.test(joinedId)) id = joinedId.toLowerCase();
    await refresh();
    if (id) {
        app = new TaskApp({
            base: env.MCP_TASKS_STATE || join(copilotHome(env), 'mcp-tasks'),
            host: 'GitHub Copilot', table, requireOwner: true,
            clientInfo: { name: 'mcp-tasks-copilot', version: VERSION },
            holdsSecret: (value) => secrets.holds(value),
            serverAllowed: (name, config) => JSON.stringify(table.servers[name]) === JSON.stringify(config),
            async wake(thread, text) {
                if (thread !== id) return { ok: false, why: 'Copilot is no longer joined to the session' };
                return sendWake({ send: (options) => session.send({
                    ...options, source: 'automation-mcp-tasks', clientTurnId: options.clientTurnId?.replace(/^mcp-events-/, 'mcp-tasks-')
                }) }, text);
            }
        });
        app.noteTurn(id, { visible: session.capabilities?.ui?.elicitation === true });
    }
    ready();
    const unlisten = session.on('user.message', (event) => {
        if (id && isThePersons(event.data, event.agentId)) app?.noteTurn(id, { visible: true, userStarted: true });
    });
    const configListener = session.on('session.mcp_server_status_changed', () => { void refresh(); });
    const poll = setInterval(() => { void refresh().then(() => app?.recheck()); }, 5000);
    poll.unref();
    return { async stop() {
        clearInterval(poll);
        unlisten();
        configListener();
        await app?.stop();
    } };
}
