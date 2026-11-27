import { createHash, randomUUID } from 'node:crypto';
import { TasksConnection } from '../../core/src/connection.ts';
import { TERMINAL, TOOL_NAME, type TaskState } from '../../core/src/protocol.ts';
import type { Tool } from '../../../server-cards/codex/src/mcp.ts';
import { launch, schema, settings, sourceUrl, stringField, text } from '../../../../tools/muse-grok/runtime.ts';

const cfg = settings({ sources: {}, tools: {} });
for (const [source, names] of Object.entries(cfg.tools ?? {})) {
    sourceUrl(cfg, source);
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string' && TOOL_NAME.test(n))) throw Error('Configure a list of allowed tool names for each source');
}
const allowed = (source: string) => Object.hasOwn(cfg.tools ?? {}, source) ? cfg.tools![source]! : [];
async function connect(source: string) {
    const wire = new TasksConnection(source, { url: sourceUrl(cfg, source) }, { name: 'agentpolyfill-task-monitor', version: '0.1.0' });
    await wire.connect(10000);
    if (wire.offersTasks) return wire;
    await wire.close();
    throw Error('This source does not offer SEP-2663 on a supported revision.');
}

type RecordEntry = { source: string; wire: TasksConnection; state: TaskState; expires: number; next: number; busy: boolean };
const entries = new Map<string, RecordEntry>();
let starting = 0;
function result(handle: string, entry: RecordEntry) {
    const s = entry.state;
    return text({ handle, source: entry.source, status: s.status, retryAfterMs: Math.max(0, entry.next - Date.now()),
        ...(s.result && { result: s.result }), ...(s.error && { error: s.error }),
        ...(s.status === 'input_required' && { detail: 'The publisher needs input. This adapter supports checking or cancelling this task.' }) });
}
function remember(entry: RecordEntry, state: TaskState) {
    entry.state = state;
    const created = Date.parse(state.createdAt);
    entry.expires = Math.min(created + 3600000, created + (state.ttlMs ?? 3600000));
    entry.next = Date.now() + Math.max(250, state.pollIntervalMs ?? 1000);
    if (TERMINAL.has(state.status)) {
        entry.expires = Math.min(entry.expires, Date.now() + 600000);
        void entry.wire.close();
    }
}
function lookup(handle: unknown) {
    const entry = entries.get(String(handle));
    if (!entry || entry.expires <= Date.now()) throw Error('Unknown or expired handle.');
    return entry;
}
setInterval(() => {
    for (const [key, entry] of entries) if (!entry.busy && entry.expires <= Date.now()) {
        entries.delete(key);
        void entry.wire.close();
    }
}, 30000).unref();

async function startJob(label: string, name: string, argumentsObject: unknown) {
    sourceUrl(cfg, label);
    if (!allowed(label).includes(name)) throw Error('Select a tool enabled for this source: ' + allowed(label).join(', '));
    if (!argumentsObject || typeof argumentsObject !== 'object' || Array.isArray(argumentsObject)) throw Error('Supply an arguments object.');
    if (entries.size + starting >= 64) throw Error('Task limit reached.');
    starting++;
    let wire: TasksConnection | undefined;
    try {
        wire = await connect(label);
        const outcome = await wire.callTool(name, argumentsObject as Record<string, unknown>, 30000);
        if (outcome.kind === 'result') return text({ source: label, status: 'completed', result: outcome.result });
        if (outcome.kind !== 'task') throw Error('The tool returned an unsupported response. Do not automatically retry.');
        const handle = randomUUID();
        const entry = { source: label, wire, state: outcome.task, expires: Date.now() + 3600000, next: 0, busy: false };
        remember(entry, outcome.task);
        entries.set(handle, entry);
        wire = undefined;
        return result(handle, entry);
    } finally { starting--; if (wire) await wire.close(); }
}

// Give models the publisher's actual input schema under a source-specific tool name.
// If discovery is slow, the generic start and status tools remain available.
async function jobTools(source: string): Promise<Tool[]> {
    const names = allowed(source);
    if (!names.length) return [];
    let wire: TasksConnection | undefined;
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            (async (): Promise<Tool[]> => {
                wire = await connect(source);
                if (expired) { await wire.close(); return []; }
                const tools = await wire.listTools();
                return tools.filter(t => names.includes(t.name) && t.inputSchema && typeof t.inputSchema === 'object').map(t => {
                    const rawName = ('job_' + source + '_' + t.name).replace(/[^A-Za-z0-9_]/g, '_');
                    const suffix = createHash('sha256').update(JSON.stringify([source, t.name])).digest('hex').slice(0, 10);
                    return {
                        name: rawName.slice(0, 50) + '_' + suffix,
                        description: 'Run the enabled ' + t.name + ' job on ' + source + '. Use check_task on its returned handle.',
                        inputSchema: t.inputSchema as Record<string, unknown>,
                        run: args => startJob(source, t.name, args)
                    };
                });
            })(),
            new Promise<Tool[]>(ok => { timer = setTimeout(() => { expired = true; ok([]); }, 3500); })
        ]);
    } catch { return []; }
    finally { if (timer) clearTimeout(timer); if (wire) await wire.close(); }
}

const labels = Object.keys(cfg.sources);
const names = [...new Set(labels.flatMap(allowed))];
const toolName = names.length ? { type: 'string', enum: names } : stringField;
const source = labels.length ? { type: 'string', enum: labels } : stringField;
const directJobs = (await Promise.all(labels.map(jobTools))).flat();
launch('mcp-task-monitor', 'Use the named job tool when available. Use list_task_tools to find operator-enabled jobs. Use run_task once and check_task with the returned handle until it finishes. Do not restart a job after an ambiguous failure. Cancel only when asked.', [
    ...directJobs,
    {
        name: 'list_task_tools', description: 'List permitted tools and their schemas on a Tasks publisher.',
        inputSchema: schema({ source }), annotations: { readOnlyHint: true },
        async run(args) {
            const label = String(args.source), wire = await connect(label);
            try { return text((await wire.listTools()).filter(t => allowed(label).includes(t.name))); }
            finally { await wire.close(); }
        }
    },
    {
        name: 'run_task', description: 'Start one operator-enabled job. Keep its handle for status checks.',
        inputSchema: schema({ source, tool: toolName, arguments: { type: 'object', additionalProperties: true, description: 'Arguments to the publisher tool, using the property names from list_task_tools.' } }),
        run(args) { return startJob(String(args.source), String(args.tool), args.arguments); }
    },
    {
        name: 'check_task', description: 'Check a previously started task using its private handle.',
        inputSchema: schema({ handle: stringField }), annotations: { readOnlyHint: true },
        async run(args) {
            const handle = String(args.handle), e = lookup(handle);
            if (e.busy || TERMINAL.has(e.state.status) || Date.now() < e.next) return result(handle, e);
            e.busy = true;
            e.next = Date.now() + Math.max(250, e.state.pollIntervalMs ?? 1000);
            try {
                const state = await e.wire.getTask(e.state.taskId, e.state.status);
                if ('invalid' in state) throw Error('The publisher returned invalid task state.');
                remember(e, state);
                return result(handle, e);
            } finally { e.busy = false; }
        }
    },
    {
        name: 'cancel_task', description: 'Request cancellation of one task when its owner asks.',
        inputSchema: schema({ handle: stringField }),
        async run(args) {
            const handle = String(args.handle), e = lookup(handle);
            if (TERMINAL.has(e.state.status)) return result(handle, e);
            if (e.busy) throw Error('A task request is in progress.');
            e.busy = true;
            try { await e.wire.cancelTask(e.state.taskId); return text({ handle, cancellationRequested: true }); }
            finally { e.busy = false; }
        }
    }
]);
