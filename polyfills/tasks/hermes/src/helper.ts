import { Bridge } from '../../../../tools/hermes/shared/bridge.ts';
import { TaskApp } from '../../core/src/app.ts';
import { supportsForm, validateFormAnswer } from '../../core/src/forms.ts';
import type { FormAnswer } from '../../core/src/host.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { secrets } from '../../core/src/untrusted.ts';

let app: TaskApp | undefined;
let thread = '';
let table: ServerTable = { servers: {}, skipped: {} };
const bridge = new Bridge(async (method, params) => {
    if (method === 'initialize' && !app) {
        thread = String(params.thread);
        table = params.table as ServerTable;
        for (const server of Object.values(table.servers)) {
            if ('url' in server) {
                const u = new URL(server.url);
                secrets.add(u.username, u.password, ...u.searchParams.values(), ...Object.values(server.headers ?? {}));
            } else secrets.add(...Object.values(server.env ?? {}));
        }
        app = new TaskApp({
            base: String(params.base), host: 'Hermes', requireOwner: true, table,
            clientInfo: { name: 'mcp-tasks-hermes', version: '0.1.0' },
            holdsSecret: value => secrets.holds(value),
            serverAllowed: (name, cfg) => table.servers[name] === cfg,
            wake: async (target, text) => target === thread && await bridge.request('wake', { text }) === true
                ? { ok: true, resumed: true } : { ok: false, why: 'Hermes could not reach this session.' }
        });
        app.resumeAll();
        app.noteTurn(thread, { visible: true, userStarted: true });
        return {};
    }
    if (method !== 'call' || !app) throw Error('Unexpected Hermes Tasks request');
    app.noteTurn(thread, { visible: true, userStarted: true });
    return app.call(String(params.tool), params.args as Record<string, unknown>, {
        meta: {}, revision: '2026-07-28', signal: AbortSignal.timeout(120000),
        async ask(message, schema, kind, original) {
            const requested = original ?? schema;
            if (secrets.holds(message) || (kind === 'input' && !supportsForm(requested))) {
                return { unavailable: 'This question cannot be shown safely.' };
            }
            const reply = await bridge.request('ask', { id: params.id, kind, message, schema }, 115000) as FormAnswer;
            if (kind === 'input' && 'action' in reply && reply.action === 'accept' &&
                (!validateFormAnswer(reply.content, requested) || secrets.holds(reply.content))) {
                return { unavailable: 'The answer did not match the form or contained a configured secret.' };
            }
            return reply;
        }
    }, thread);
});
bridge.onClose = () => { void app?.stop().finally(() => process.exit(0)); };
