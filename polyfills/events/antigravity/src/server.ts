import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { ProjectState, Spool } from '../../core/src/store.ts';
import { createTools, type Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { serve } from '../../codex/src/mcp-server.ts';
import { ownArgs } from '../../../server-cards/antigravity/src/gate.ts';
import { readServers } from './config.ts';
import { redeemConversation } from './conversation.ts';
import { pending, recordSurface, requestWake } from './pending.ts';
import { milliseconds, settings } from './settings.ts';
import { wakeAvailability } from './sidecar.ts';
import { INSTRUCTIONS, TOOLS, VERSION } from './words.ts';

export function logger(base: string) {
    const file = join(base, 'mcp-events.log');
    return (line: string) => {
        try {
            if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
            if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
            appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(line), 600)}\n`);
        } catch {}
    };
}

export function runServer(base: string, env: NodeJS.ProcessEnv, log: (s: string) => void) {
    const off = () => settings(base).MCP_EVENTS_OFF === '1';
    const table = off() ? { servers: {}, skipped: {} } : readServers(env);
    const connections = new Map<string, EventsConnection>();
    const unavailable: Unavailable[] = Object.entries(table.skipped).map(([name, why]) => ({ name, why }));
    const timeout = Math.max(1, milliseconds(env.MCP_EVENTS_CONNECT_TIMEOUT_MS, 10000));
    const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
    secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
    for (const cfg of Object.values(table.servers)) {
        if (isHttp(cfg)) {
            secrets.add(...Object.values(cfg.headers ?? {}));
            try { const u = new URL(cfg.url); secrets.add(u.username, u.password, ...u.searchParams.values()); } catch {}
        } else secrets.add(...Object.values(cfg.env ?? {}));
    }
    let discovering: Promise<void> | undefined;
    let stopping = false;
    const discover = () => discovering ??= Promise.all(Object.entries(table.servers).map(async ([name, cfg]) => {
        const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
        c.log = log;
        try {
            await c.connect(timeout);
            if (!c.declaration) {
                if (c.outsideTheSpec) unavailable.push({ name, why: c.outsideTheSpec });
                await c.close(); return;
            }
            await c.list();
            if (stopping || off()) { await c.close(); return; }
            connections.set(name, c);
        } catch (e) {
            unavailable.push({ name, why: c.error ?? describeError(e) });
            await c.close();
        }
    })).then(() => {});

    const sessions = new Map<string, { manager: WatchManager; tools: ReturnType<typeof createTools> }>();
    const session = (id: string) => {
        let s = sessions.get(id);
        if (!s) {
            const project = new ProjectState(base, `Antigravity conversation ${id}`, { dir: join(base, 'threads', id) });
            const spool = new Spool(base, id);
            const manager = new WatchManager({ connections, project, spool, session: id, env, log, connectTimeoutMs: timeout, redact: secrets });
            spool.onAppend = () => { try { requestWake(base, id, env); } catch { log('could not write a wake request; events remain stored'); } };
            s = { manager, tools: createTools(() => [...connections.values()], () => unavailable, manager) };
            sessions.set(id, s);
        }
        s.manager.start();
        if (pending(base, id)?.delivery.pending) requestWake(base, id, env);
        return s;
    };
    const names = new Set(TOOLS.map(t => t.name));
    const server = serve({
        name: 'mcp-events', title: 'MCP Events', version: VERSION,
        instructions: off() ? 'mcp-events is turned off (MCP_EVENTS_OFF=1).' : `${INSTRUCTIONS}\n${wakeAvailability(base)}`,
        tools: () => off() ? [] : TOOLS,
        log, onClose: () => void stop(),
        async call(name, args) {
            if (off() || !names.has(name)) return { text: 'mcp-events is turned off or has no tool by that name.', isError: true };
            const ticket = redeemConversation(base, name, args);
            if (!ticket.ok) return { text: `Call refused: ${ticket.why}.`, isError: true };
            await discover();
            if (stopping || off()) return { text: 'mcp-events is turned off.', isError: true };
            const id = ticket.conversationId;
            try { recordSurface(base, id, ticket.surface); } catch { log('could not record where the conversation lives'); }
            const r = await session(id).tools.call(name, ownArgs(args));
            if (name !== 'list_watches' && name !== 'watch_event') return r;
            let last = '';
            try { const error = JSON.parse(readFileSync(join(base, 'sessions', id, 'wake-error.json'), 'utf8')); if (typeof error.why === 'string') last = ` Last wake: ${oneLine(error.why, 200)}.`; } catch {}
            return { ...r, text: `${r.text}\n\n${wakeAvailability(base, Date.now(), ticket.surface)}${last}` };
        }
    });
    const parent = process.ppid;
    const tick = setInterval(() => {
        if (process.ppid !== parent) return void stop();
        if (off()) {
            void Promise.all([...sessions.values()].map(s => s.manager.stop())).then(() => sessions.clear());
            void Promise.all([...connections.values()].map(c => c.close()));
            return;
        }
        for (const [id, s] of sessions) {
            if (!s.manager.owner) session(id);
        }
    }, 5000);
    tick.unref();
    async function stop() {
        if (stopping) return;
        stopping = true; clearInterval(tick); server.close();
        setTimeout(() => process.exit(0), 8000).unref();
        await Promise.all([...sessions.values()].map(s => s.manager.stop().catch(() => {})));
        await Promise.all([...connections.values()].map(c => c.close().catch(() => {})));
        log('stopped'); process.exit(0);
    }
    process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop()); process.on('SIGHUP', () => void stop());
    process.on('unhandledRejection', e => log(`unexpected failure: ${describeError(e)}`));
    log(`mcp-events ${VERSION} for Antigravity started${off() ? ' (turned off)' : ''}`);
}
