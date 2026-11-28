import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { agentDir, parseEntry, piRunsMcp, readPiEntries } from '../../../events/pi/src/pi-config.ts';
import { TaskApp, TOOLS, type WakeResult } from '../../core/src/app.ts';
import type { ToolAnswer } from '../../core/src/host.ts';
import { isHttp, type ServerTable } from '../../core/src/upstream.ts';
import { secrets } from '../../core/src/untrusted.ts';
import { askPi } from './forms.ts';

const VERSION = '0.1.0';
const empty: ServerTable = { servers: {}, skipped: {} };

function servers(pi: ExtensionAPI, ctx: ExtensionContext): ServerTable {
    if (!piRunsMcp(pi.getCommands())) return empty;
    const options = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), registered: pi.getMcpServers() };
    const result: ServerTable = { servers: {}, skipped: {} };
    for (const [name, { config }] of readPiEntries(options).entries) {
        const entry = parseEntry(name, config, { cwd: ctx.cwd, env: process.env, runCommand: () => undefined });
        if (!entry) continue;
        if ('skip' in entry) {
            result.skipped[name] = entry.skip;
            continue;
        }
        result.servers[name] = entry;
    }
    return result;
}

function asPiResult(answer: ToolAnswer) {
    const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        { type: 'text', text: secrets.scrub(answer.text) }
    ];
    let omitted = false;
    for (const block of answer.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: secrets.scrub(block.text) });
        else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string' && !secrets.holds(block)) {
            content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        } else if (block.type === 'resource_link' || (block.type === 'resource' && typeof (block.resource as { text?: unknown })?.text === 'string')) {
            content.push({ type: 'text', text: secrets.scrub(JSON.stringify(block)) });
        } else omitted = true;
    }
    if (omitted) content.push({ type: 'text', text: 'A result block could not be represented in Pi.' });
    return { content, details: {}, ...(answer.isError ? { isError: true } : {}) };
}

export default function mcpTasks(pi: ExtensionAPI) {
    if (process.env.MCP_TASKS_OFF === '1') return;
    let current: { id: string; app: TaskApp; timer: NodeJS.Timeout } | undefined;
    const pendingWakes = new Map<string, (result: WakeResult) => void>();
    pi.on('message_end', ({ message }) => {
        if (message.role === 'custom' && message.customType === 'mcp-tasks' && typeof message.content === 'string') {
            pendingWakes.get(message.content)?.({ ok: true });
        }
    });
    const normalize = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');
    const toolIsExposed = (server: string, tool: string, callable: readonly { name: string }[]) => {
        const name = `mcp__${normalize(server)}__${normalize(tool)}`;
        return pi.getAllTools().some((entry) => entry.name === name && entry.sourceInfo.path === 'builtin:mcp' &&
            entry.namespace?.aliases?.includes(server) && entry.exposure !== 'hidden') && callable.some((entry) => entry.name === name);
    };

    for (const tool of TOOLS) {
        pi.registerTool({
            name: tool.name,
            label: tool.title ?? tool.name,
            description: tool.description,
            parameters: tool.inputSchema as never,
            ...(tool.name === 'list_task_servers' || tool.name === 'start_task' ? { reachesTools: () => 'all' as const } : {}),
            ...(tool.name === 'start_task' || tool.name === 'provide_task_input' ? { executionMode: 'sequential' as const } : {}),
            async execute(_id, args, signal, _update, ctx) {
                const active = current;
                if (!active || !piRunsMcp(pi.getCommands())) return asPiResult({ text: 'MCP Tasks is unavailable in this Pi session.', isError: true });
                return asPiResult(await active.app.call(tool.name, (args ?? {}) as Record<string, unknown>, {
                    ask: askPi(ctx, signal), signal, meta: {}, revision: '2026-07-28',
                    toolAllowed: (server, name) => toolIsExposed(server, name, ctx.tools)
                }, active.id));
            }
        });
    }

    pi.on('session_start', (_event, ctx) => {
        if (!piRunsMcp(pi.getCommands())) return;
        const id = ctx.sessionManager.getSessionId();
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
        const table = servers(pi, ctx);
        for (const cfg of Object.values(table.servers)) {
            if (isHttp(cfg)) {
                const url = new URL(cfg.url);
                secrets.add(...Object.values(cfg.headers ?? {}), url.username, url.password, ...url.searchParams.values());
            } else secrets.add(...Object.values(cfg.env ?? {}));
        }
        const app = new TaskApp({
            host: 'Pi', table, requireOwner: true, clientInfo: { name: 'mcp-tasks-pi', version: VERSION },
            base: process.env.MCP_TASKS_STATE || join(agentDir(), 'mcp-tasks'),
            holdsSecret: (value) => secrets.holds(value),
            serverAllowed: (name, config) => JSON.stringify(servers(pi, ctx).servers[name]) === JSON.stringify(config),
            async wake(thread, content) {
                if (current?.id !== thread || current.app !== app) return { ok: false, why: 'this Pi session is closed' };
                return new Promise((resolve) => {
                    const done = (result: WakeResult) => {
                        clearTimeout(timeout);
                        pendingWakes.delete(content);
                        resolve(result);
                    };
                    const timeout = setTimeout(() => done({ ok: false, why: 'Pi did not acknowledge the wake' }), 30_000);
                    timeout.unref();
                    pendingWakes.set(content, done);
                    try {
                        pi.sendMessage({ customType: 'mcp-tasks', content, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
                    } catch {
                        done({ ok: false, why: 'Pi refused the wake' });
                    }
                });
            }
        });
        const timer = setInterval(() => app.recheck(), 5000);
        timer.unref();
        current = { id, app, timer };
        app.noteTurn(id, { visible: false });
    });
    pi.on('input', (event, ctx) => {
        if (current && ctx.hasUI && event.source !== 'extension') current.app.noteTurn(current.id, { visible: true, userStarted: true });
    });
    pi.on('session_shutdown', async () => {
        const old = current;
        current = undefined;
        for (const done of pendingWakes.values()) done({ ok: false, why: 'this Pi session is closed' });
        if (old) {
            clearInterval(old.timer);
            await old.app.stop();
        }
    });
}
