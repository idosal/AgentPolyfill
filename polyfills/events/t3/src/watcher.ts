// The watcher: one process per state folder that runs the watches of every T3 Code
// thread, and wakes a thread with `t3 thread send` when its events arrive.
//
// Why a process of its own: T3 Code closes a thread's agent session when the thread has
// been idle for a while, and the agent stops the MCP servers it started for the thread
// with it. Watches have to outlive that, so they run here. The server the agent starts
// for each thread (server.ts) only passes its tools' calls on to this process, starting
// it if it isn't running.
//
// It starts with the first call that needs it, resumes every thread's saved watches,
// and ends by itself when no thread has a watch and nobody has asked anything for a
// minute (`--stop` ends it at once). Its MCP servers are those in the agent's
// configuration when it started: after changing that configuration, stop it, and the
// next call starts it again with the new one.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { readCodexServers } from '../../codex/src/codex-config.ts';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { configureHost } from '../../core/src/host.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { ask, readRequest, socketPath, type Answer, type Request } from './ipc.ts';
import { openLog, stateDir } from './state.ts';
import { ThreadSession } from './threads.ts';
import { VERSION } from './version.ts';
import { findT3, sendMessage, t3NotFound, THREAD_ID, type Wake } from './waker.ts';
import { T3_CODE, TOOLS } from './words.ts';

const IDLE_EXIT_MS = 60000;

/** This server, wherever it is: the running bundle itself, a checkout's bundle or source, or an installed copy. */
export function isSelf(arg: string, self: string = process.argv[1] ?? ''): boolean {
    if (self && resolve(arg) === resolve(self)) return true;
    return /[\\/]events[\\/]t3[\\/](?:plugin[\\/]dist[\\/]server\.js|src[\\/]server\.ts)$/.test(arg) || /mcp-events-t3[^\\/]*(?:[\\/][^\\/]+){0,3}[\\/]dist[\\/]server\.js$/.test(arg);
}
/** Tests only (MCP_EVENTS_DEV=1): how long the watcher waits, with nothing watched, before it ends. */
const idleExitMs = (env: NodeJS.ProcessEnv) => (env.MCP_EVENTS_DEV === '1' && Number(env.MCP_EVENTS_WATCHER_IDLE_MS) > 0 ? Number(env.MCP_EVENTS_WATCHER_IDLE_MS) : IDLE_EXIT_MS);
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

export async function runWatcher(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    configureHost(T3_CODE);
    const base = stateDir(env);
    const log = openLog(base, 'mcp-events.log', 'watcher');
    process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));
    const path = socketPath(base);

    // One watcher per state folder: if one answers at the socket, this one has nothing to do.
    try {
        await ask(path, { op: 'ping' }, 3000);
        log('another watcher already runs; this one ends');
        return;
    } catch {
        // nobody there: a socket left by a watcher that ended without removing it is removed
        if (process.platform !== 'win32' && existsSync(path)) {
            try {
                unlinkSync(path);
            } catch {
                // listen says so below
            }
        }
    }

    // ---- Which servers ----

    const table = readCodexServers(env, log);
    // This polyfill's own entry in the configuration: connecting to it would start another of these.
    for (const [name, cfg] of Object.entries(table.servers)) {
        if (!isHttp(cfg) && [cfg.command, ...(cfg.args ?? [])].some((a) => isSelf(a))) delete table.servers[name];
    }
    secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
    for (const cfg of Object.values(table.servers)) {
        if (isHttp(cfg)) {
            secrets.add(...Object.values(cfg.headers ?? {}));
            try {
                const u = new URL(cfg.url);
                secrets.add(u.password, u.username, ...[...u.searchParams.values()]);
            } catch {
                // not an address: it will fail to connect
            }
        } else secrets.add(...Object.values(cfg.env ?? {}));
    }
    const unavailable: Unavailable[] = Object.entries(table.skipped).map(([name, why]) => ({ name, why }));
    const connections = new Map<string, EventsConnection>();
    const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
    const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);

    const probeFile = join(base, 'servers-without-events.json');
    const without: Record<string, number> = (() => {
        try {
            const j = JSON.parse(readFileSync(probeFile, 'utf8')) as unknown;
            return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, number>) : {};
        } catch {
            return {};
        }
    })();
    const remember = (fingerprint: string, has: boolean) => {
        if (has && !(fingerprint in without)) return;
        if (has) delete without[fingerprint];
        else without[fingerprint] = Date.now();
        for (const [k, at] of Object.entries(without)) if (Date.now() - at >= PROBE_TTL_MS) delete without[k];
        try {
            writeFileSync(probeFile, JSON.stringify(without), { mode: 0o600 });
        } catch {
            // asked again next time
        }
    };

    /** Every thread with saved watches: its id (from the folder's project.json) and the servers its watches name. */
    const saved = (): { id: string; servers: string[] }[] => {
        const out: { id: string; servers: string[] }[] = [];
        const root = join(base, 'threads');
        for (const dir of existsSync(root) ? readdirSync(root) : []) {
            try {
                const meta = JSON.parse(readFileSync(join(root, dir, 'project.json'), 'utf8')) as { for?: unknown };
                const id = typeof meta.for === 'string' && meta.for.startsWith('t3 thread ') ? meta.for.slice('t3 thread '.length) : '';
                if (!THREAD_ID.test(id)) continue;
                const j = JSON.parse(readFileSync(join(root, dir, 'watches.json'), 'utf8')) as { watches?: { server?: unknown }[] };
                const servers = (j.watches ?? []).map((w) => w.server).filter((s): s is string => typeof s === 'string');
                if (servers.length) out.push({ id, servers });
            } catch {
                // no watches there
            }
        }
        return out;
    };

    let discovery: Promise<void> | undefined;
    const discover = (): Promise<void> =>
        (discovery ??= (async () => {
            const watched = new Set(saved().flatMap((t) => t.servers));
            await Promise.all(
                Object.entries(table.servers).map(async ([name, cfg]) => {
                    const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
                    c.log = log;
                    if (!watched.has(name) && typeof without[c.fingerprint] === 'number' && Date.now() - without[c.fingerprint]! < PROBE_TTL_MS) return;
                    try {
                        await c.connect(timeout);
                    } catch {
                        if (c.needsSignIn) unavailable.push({ name, why: c.error ?? 'needs sign-in' });
                        log(`${name}: not connected: ${c.error}`);
                        return;
                    }
                    if (!c.declaration) {
                        const why = c.outsideTheSpec;
                        if (why) {
                            unavailable.push({ name, why });
                            log(`${name}: ${why}`);
                        } else remember(c.fingerprint, false);
                        await c.close();
                        return;
                    }
                    try {
                        await c.list();
                        remember(c.fingerprint, true);
                        connections.set(name, c);
                        log(`${name}: ${c.eventTypes.length} event type(s) (protocol revision ${c.revision}${c.declaration === 'pre-standard' ? '; it advertises events in the form from before the standard' : ''})`);
                    } catch (e) {
                        unavailable.push({ name, why: `events/list failed: ${describeError(e)}` });
                        await c.close();
                    }
                })
            );
        })());

    // ---- Threads ----

    const t3 = findT3(env);
    if (!t3) log(`${t3NotFound()}; events are stored, but cannot wake a thread`);
    const wakeEnv = { ...env };
    delete wakeEnv.T3CODE_THREAD_ID;
    const wake: Wake = async (thread, text) => (t3 ? sendMessage(t3, thread, text, wakeEnv) : { ok: false, why: t3NotFound() });

    const sessions = new Map<string, ThreadSession>();
    const sessionFor = (id: string): ThreadSession => {
        let s = sessions.get(id);
        if (!s) {
            s = new ThreadSession(id, { base, connections, unavailable: () => unavailable, wake, log, env, connectTimeoutMs: timeout });
            sessions.set(id, s);
            s.start();
        }
        return s;
    };

    const names = new Set(TOOLS.map((t) => t.name));
    let lastAsked = Date.now();
    let server: Server | undefined;
    let stopping = false;
    let tick: NodeJS.Timeout | undefined;

    const handle = async (req: Request): Promise<Answer> => {
        lastAsked = Date.now();
        if (req.op === 'ping') return { pong: true, pid: process.pid, version: VERSION };
        if (req.op === 'stop') {
            setTimeout(() => void stop('asked to stop'), 10).unref();
            return { stopping: true };
        }
        if (req.op !== 'call' || typeof req.thread !== 'string' || !THREAD_ID.test(req.thread)) return { text: 'mcp-events-t3 needs the T3 Code thread this call is from.', isError: true };
        if (!names.has(req.name)) return { text: 'mcp-events-t3 has no tool by that name.', isError: true };
        log(`${req.name} from thread …${req.thread.slice(-8)}`);
        await Promise.race([discover(), new Promise((r) => setTimeout(r, timeout + 5000).unref())]);
        const s = sessionFor(req.thread);
        if (!s.manager.owner) s.start();
        const args = typeof req.args === 'object' && req.args !== null && !Array.isArray(req.args) ? req.args : {};
        return s.call(req.name, args);
    };

    server = createServer((sock) => readRequest(sock, handle));
    await new Promise<void>((done, fail) => {
        server!.once('error', fail);
        server!.listen(path, () => {
            server!.off('error', fail);
            done();
        });
    });
    log(`mcp-events ${VERSION} for T3 Code: watcher started (${table.servers ? Object.keys(table.servers).length : 0} configured server(s))`);

    // Saved threads that ended long ago have nobody left to read their events.
    try {
        const gone = pruneSessions(base, '');
        if (gone) log(`removed the stored events of ${gone} thread(s) not heard from in two weeks`);
        const root = join(base, 'threads');
        for (const dir of existsSync(root) ? readdirSync(root) : []) {
            const p = join(root, dir);
            let any = false;
            try {
                any = ((JSON.parse(readFileSync(join(p, 'watches.json'), 'utf8')) as { watches?: unknown[] }).watches ?? []).length > 0;
            } catch {
                // none saved
            }
            if (!any && Date.now() - statSync(p).mtimeMs > 14 * 24 * 3600 * 1000) rmSync(p, { recursive: true, force: true });
        }
    } catch {
        // best effort
    }

    // Watches saved by a watcher that ended (a restart, a reboot) start again now, not at the thread's next call.
    const resume = saved();
    if (resume.length) {
        await discover();
        for (const t of resume) sessionFor(t.id);
        log(`resumed the watches of ${resume.length} thread(s)`);
    }

    tick = setInterval(() => {
        const watching = [...sessions.values()].reduce((n, s) => n + s.watching, 0);
        if (!watching && Date.now() - lastAsked > idleExitMs(env)) void stop('no thread has a watch');
    }, Math.min(5000, idleExitMs(env)));

    async function stop(why: string): Promise<void> {
        if (stopping) return;
        stopping = true;
        clearInterval(tick);
        server?.close();
        setTimeout(() => process.exit(0), 8000).unref();
        await Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})));
        await Promise.all([...connections.values()].map((c) => c.close().catch(() => {})));
        if (process.platform !== 'win32') {
            try {
                unlinkSync(path);
            } catch {
                // already gone
            }
        }
        log(`stopped (${why})`);
        process.exit(0);
    }
    process.on('SIGTERM', () => void stop('SIGTERM'));
    process.on('SIGHUP', () => {
        // The terminal or agent that started it went away: it keeps running, that is its purpose.
    });
    process.on('SIGINT', () => void stop('SIGINT'));
}
